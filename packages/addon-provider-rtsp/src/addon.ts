import { userError } from '@camstack/types'
import type {
  ConfigUISchema,
  CreateDeviceSpec,
  DeviceConstructor,
  FieldProbeResult,
  IConnectionTestProvider,
  IDevice,
  ProviderRegistration,
  StreamQuality,
} from '@camstack/types'
import {
  BaseDeviceProvider,
  classifyStreams,
  connectionTestCapability,
  DeviceType,
  maskUrlCredentials,
} from '@camstack/types'
import { RtspCamera, type RtspStreamEntry, rtspCameraSchema } from './rtsp-camera.js'
import { buildRtspConnectionTestProvider } from './rtsp-connection-test.js'

function getString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key]
  return typeof v === 'string' ? v : ''
}

function getStringArray(obj: Record<string, unknown>, key: string): readonly string[] {
  const v = obj[key]
  if (!Array.isArray(v)) return []
  return v
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Build the creation form schema. Hand-written ConfigUISchema instead of
 * converting from Zod — this lets us expose probe-typed fields (live
 * ffprobe "Test" button) that the automatic converter doesn't emit.
 *
 * `streams` is a single probe field rendered as a `multiple` array —
 * 1..3 instances; the backend probes each via the kernel's
 * `StreamProbeService` and publishes them to the stream-broker, which
 * decides the (high / mid / low) profile mapping by resolution.
 */
function buildCreationFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'identity',
        title: 'Camera',
        titleKey: 'provider-rtsp:creation.s_identity.title',
        columns: 1,
        fields: [
          {
            type: 'text',
            key: 'name',
            label: 'Name',
            labelKey: 'provider-rtsp:creation.s_identity.name.label',
            required: true,
            placeholder: 'Living room',
          },
        ],
      },
      {
        id: 'streams',
        title: 'RTSP Streams',
        titleKey: 'provider-rtsp:creation.s_streams.title',
        description:
          '1–3 RTSP URLs; the broker assigns the high / mid / low profiles by resolution.',
        descriptionKey: 'provider-rtsp:creation.s_streams.description',
        columns: 1,
        fields: [
          {
            type: 'probe',
            key: 'streams',
            label: 'RTSP stream URL',
            labelKey: 'provider-rtsp:creation.s_streams.streams.label',
            required: true,
            placeholder: 'rtsp://user:pass@host:554/Streaming/Channels/101',
            inputType: 'url',
            multiple: {
              min: 1,
              max: 3,
              addLabel: 'Add stream',
              itemLabel: 'Stream ${n}',
              itemDefault: '',
            },
          },
        ],
      },
      {
        id: 'snapshot',
        title: 'Snapshot',
        titleKey: 'provider-rtsp:creation.s_snapshot.title',
        columns: 1,
        fields: [
          {
            type: 'probe',
            key: 'snapshotUrl',
            label: 'Snapshot URL',
            labelKey: 'provider-rtsp:creation.s_snapshot.snapshotUrl.label',
            placeholder: 'http://host/ISAPI/Streaming/channels/101/picture',
            inputType: 'url',
          },
        ],
      },
      {
        id: 'credentials',
        title: 'Credentials',
        titleKey: 'provider-rtsp:creation.s_credentials.title',
        description:
          'Optional. If the RTSP URL already contains user:pass@ you can leave these empty.',
        descriptionKey: 'provider-rtsp:creation.s_credentials.description',
        columns: 2,
        fields: [
          {
            type: 'text',
            key: 'username',
            label: 'Username',
            labelKey: 'provider-rtsp:creation.s_credentials.username.label',
          },
          {
            type: 'password',
            key: 'password',
            label: 'Password',
            labelKey: 'provider-rtsp:creation.s_credentials.password.label',
            showToggle: true,
          },
        ],
      },
    ],
  }
}

export class RtspProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = 'provider-rtsp'
  protected readonly providerName = 'RTSP'
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Camera]: RtspCamera,
  }

  constructor() {
    super({})
  }

  protected override async onInitialize(): Promise<ProviderRegistration[]> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())
    // NOTE: `device.online` is NO LONGER mirrored from stream-broker health.
    // `online` must reflect CONTROL-PLANE reachability — an on-demand RTSP
    // camera with no consumer attached is reachable yet has no active stream,
    // and mirroring broker health falsely marked it OFFLINE. Each `RtspCamera`
    // now runs a control-plane reachability poll (an RTSP `OPTIONS`/TCP-connect
    // probe every 30s, see `startReachabilityPolling`) that drives `online`.
    // The stream-broker health signal remains available as the separate
    // `camera-streams` runtime-state slice ("is the video flowing").
    return [
      ...regs,
      { capability: connectionTestCapability, provider: this.buildConnectionTestProvider() },
    ]
  }

  /**
   * The stream-URL probe, DECLARED. It used to be the backend's default branch
   * for every integration in the system; it now answers only for this addon,
   * and only when the settings actually carry a URL.
   */
  private buildConnectionTestProvider(): IConnectionTestProvider {
    return buildRtspConnectionTestProvider({
      getStreamProbe: () => this.ctx.kernel.streamProbe ?? null,
      logger: this.ctx.logger,
    })
  }

  // ── Creation ─────────────────────────────────────────────────────────

  protected async onGetCreationSchema(type: DeviceType): Promise<ConfigUISchema | null> {
    if (type !== DeviceType.Camera) return null
    return buildCreationFormSchema()
  }

  protected async onCreateDevice(
    type: DeviceType,
    config: Record<string, unknown>,
  ): Promise<CreateDeviceSpec> {
    if (type !== DeviceType.Camera) {
      throw new Error(`RTSP provider does not support device type: ${type}`)
    }

    const name = getString(config, 'name').trim()
    if (!name) throw userError('rtsp.camera-name-required', undefined, 'Camera name is required')

    const rawStreams = getStringArray(config, 'streams')
    if (rawStreams.length === 0)
      throw userError('rtsp.stream-required', undefined, 'At least one RTSP stream URL is required')
    if (rawStreams.length > 3)
      throw userError(
        'rtsp.too-many-streams',
        undefined,
        'At most 3 RTSP stream URLs are supported',
      )

    const streamProbe = this.ctx.kernel.streamProbe
    if (!streamProbe) throw new Error('ctx.kernel.streamProbe unavailable — cannot probe streams')
    const probed = await Promise.all(
      rawStreams.map(async (url) => {
        try {
          const metadata = await streamProbe.probe(url, { force: false })
          return { url, metadata, ok: true as const }
        } catch (err) {
          this.ctx.logger.warn('[rtsp-create] probe failed — publishing without probed metadata', {
            meta: {
              url: maskUrlCredentials(url),
              error: err instanceof Error ? err.message : String(err),
            },
          })
          return { url, metadata: undefined, ok: false as const }
        }
      }),
    )

    const classified = classifyStreams(
      probed.map((p) => ({ url: p.url, metadata: p.metadata ?? {} })),
    )
    const hintByUrl = new Map<string, StreamQuality>(classified.map((c) => [c.url, c.quality]))

    const streams: RtspStreamEntry[] = probed.map((p, i): RtspStreamEntry => {
      const entry: RtspStreamEntry = { id: `stream-${i + 1}`, url: p.url }
      const hint = hintByUrl.get(p.url)
      if (hint) entry.profileHint = hint
      if (p.metadata?.width && p.metadata?.height) {
        entry.resolution = { width: p.metadata.width, height: p.metadata.height }
      }
      return entry
    })

    const parsed = rtspCameraSchema.parse({
      streams,
      snapshotUrl: getString(config, 'snapshotUrl'),
      username: getString(config, 'username'),
      password: getString(config, 'password'),
    })

    return {
      meta: { type: DeviceType.Camera, name },
      config: parsed,
    }
  }

  // ── Field probing ────────────────────────────────────────────────────

  override async testCreationField(input: {
    type: DeviceType
    key: string
    value: unknown
  }): Promise<FieldProbeResult> {
    if (input.type !== DeviceType.Camera) {
      return { status: 'error', error: `Unsupported device type: ${input.type}` }
    }
    const streamProbe = this.ctx.kernel.streamProbe
    if (!streamProbe) {
      return {
        status: 'error',
        error: 'ctx.kernel.streamProbe unavailable — cannot reach kernel probe',
      }
    }
    return streamProbe.probeField(input.key, input.value)
  }

  // ── Restore ──────────────────────────────────────────────────────────
  //
  // `BaseDeviceProvider.onRestoreDevices` default impl iterates
  // `savedDevices`, looks up the right class via `deviceClasses`,
  // and calls `kernel.devices.create()`. The stream-broker pulls each
  // camera's `stream-catalog` cap (on start / poll / device events) to
  // build its cam-stream registry — no per-provider push needed here.
}
