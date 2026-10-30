import type {
  ConfigUISchema,
  CreateDeviceSpec,
  DeviceConstructor,
  DeviceSummary,
  DiscoveryCandidate,
  DiscoveryHit,
  DiscoveryMode,
  FieldProbeResult,
  IDevice,
  ProviderRegistration,
} from '@camstack/types'
import {
  BaseDeviceProvider,
  clipEventLabelDepsFromApi,
  DeviceType,
  memoizePinnedFfmpeg,
  userError,
  videoclipsCapability,
  widenDeviceConstructor,
  withClipEventLabels,
} from '@camstack/types'
import { AmcrestCamera } from './amcrest-camera.js'
import { AmcrestCgiClient } from './amcrest-cgi-client.js'
import {
  AMCREST_DISCOVERY_MODES,
  amcrestFromHttpHits,
  amcrestFromWsdHits,
  type DiscoveredAmcrestCamera,
  slugifyAmcrestHost,
} from './amcrest-discovery.js'
import { type ClipService, createClipService } from './clips/clip-service.js'
import { AMCREST_ADDON_ID, amcrestCameraSchema } from './schema.js'

function getString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key]
  return typeof v === 'string' ? v : ''
}

function getBoolean(obj: Record<string, unknown>, key: string): boolean {
  return obj[key] === true
}

function getNumber(obj: Record<string, unknown>, key: string, fallback: number): number {
  const v = obj[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/**
 * Add-Device creation form — connection + credentials + a single `host`
 * probe that runs `magicBox.cgi?action=getSystemInfo` so the operator
 * gets immediate confirmation the camera responds before saving.
 */
function buildCreationFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'identity',
        title: 'Camera',
        titleKey: 'provider-amcrest:creation.s_identity.title',
        columns: 1,
        fields: [
          {
            type: 'text',
            key: 'name',
            label: 'Name',
            labelKey: 'provider-amcrest:creation.s_identity.name.label',
            required: true,
            placeholder: 'Driveway',
          },
        ],
      },
      {
        id: 'credentials',
        title: 'Credentials',
        titleKey: 'provider-amcrest:creation.s_credentials.title',
        columns: 2,
        fields: [
          {
            type: 'text',
            key: 'username',
            label: 'Username',
            labelKey: 'provider-amcrest:creation.s_credentials.username.label',
            default: 'admin',
            required: true,
          },
          {
            type: 'password',
            key: 'password',
            label: 'Password',
            labelKey: 'provider-amcrest:creation.s_credentials.password.label',
            required: true,
            showToggle: true,
          },
        ],
      },
      {
        id: 'connection',
        title: 'Connection',
        titleKey: 'provider-amcrest:creation.s_connection.title',
        description: 'Use 443 with HTTPS for cameras with TLS enabled.',
        descriptionKey: 'provider-amcrest:creation.s_connection.description',
        columns: 2,
        fields: [
          {
            type: 'probe',
            key: 'host',
            label: 'Camera IP',
            labelKey: 'provider-amcrest:creation.s_connection.host.label',
            required: true,
            placeholder: '192.168.10.100',
            inputType: 'text',
          },
          {
            type: 'number',
            key: 'port',
            label: 'Port',
            labelKey: 'provider-amcrest:creation.s_connection.port.label',
            default: 80,
            min: 1,
            max: 65535,
            step: 1,
          },
          {
            type: 'boolean',
            key: 'https',
            label: 'Use HTTPS',
            labelKey: 'provider-amcrest:creation.s_connection.https.label',
            default: false,
            style: 'switch',
          },
        ],
      },
    ],
  }
}

/**
 * Extra per-scan inputs for Amcrest discovery. Like Hikvision, a Dahua
 * camera needs CREDENTIALS to be created (CGI probe), so the scan form
 * collects them and bakes them into each candidate for a one-click adopt.
 * Discovery itself (ONVIF WS-Discovery multicast) needs no credentials.
 */
function buildDiscoveryParamsFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'credentials',
        title: 'Credentials',
        titleKey: 'provider-amcrest:discoveryParams.s_credentials.title',
        description: 'Assumes all cameras share these credentials.',
        descriptionKey: 'provider-amcrest:discoveryParams.s_credentials.description',
        columns: 2,
        fields: [
          {
            type: 'text',
            key: 'username',
            label: 'Username',
            labelKey: 'provider-amcrest:discoveryParams.s_credentials.username.label',
            default: 'admin',
            required: true,
          },
          {
            type: 'password',
            key: 'password',
            label: 'Password',
            labelKey: 'provider-amcrest:discoveryParams.s_credentials.password.label',
            required: true,
            showToggle: true,
          },
        ],
      },
    ],
  }
}

/** True when the string looks like a real hardware identifier — not an
 *  all-zeros / all-`F` placeholder. */
function isMeaningfulIdentifier(s: string): boolean {
  if (!s || s.length < 6) return false
  const distinct = new Set(
    s
      .toLowerCase()
      .split('')
      .filter((c) => c !== '0' && c !== 'f'),
  )
  return distinct.size >= 1
}

export class AmcrestProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = AMCREST_ADDON_ID
  protected readonly providerName = 'Amcrest'
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    // `AmcrestCamera`'s config schema is smaller than Hikvision's, but the
    // variance check between `DeviceConfig<typeof amcrestCameraSchema>` and
    // the erased `IDevice` constructor shape still needs the same bridge the
    // Hikvision provider documents. The runtime types ARE assignable.
    [DeviceType.Camera]: widenDeviceConstructor(AmcrestCamera),
  }

  constructor() {
    super({})
  }

  /**
   * Amcrest stableId — `mac → host(IP)` chain. MAC is the connected
   * interface's `PhysicalAddress`, persisted into `deviceCache.mac` by
   * `onCreateDevice` (durable across DHCP renewals). Falls back to a host
   * slug when the network probe couldn't resolve a MAC.
   */
  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const cfg = config ?? {}
    const cache = (cfg['deviceCache'] as Record<string, unknown> | undefined) ?? {}
    const macRaw = typeof cache['mac'] === 'string' ? cache['mac'].trim() : ''
    const mac = macRaw.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
    if (isMeaningfulIdentifier(mac)) return `mac-${mac}`
    const host = typeof cfg['host'] === 'string' ? cfg['host'].trim() : ''
    if (host.length > 0) {
      const slug = slugifyAmcrestHost(host)
      if (slug.length > 0) return `host-${slug}`
    }
    throw new Error(
      `Amcrest: probe on ${host || '(unknown host)'} resolved neither mac nor host address — ` +
        'cannot persist a stable row key. Verify network reachability + credentials, then retry.',
    )
  }

  protected override async onInitialize(): Promise<ProviderRegistration[]> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())

    // NOTE: `device.online` is NO LONGER mirrored from the stream broker's
    // `camera-streams` health. `online` must reflect CONTROL-PLANE
    // reachability (can we talk to the camera's CGI API), not whether video
    // is currently flowing — an on-demand camera with no consumer is
    // reachable yet has no active stream. Each `AmcrestCamera` runs a
    // control-plane reachability poll (Dahua CGI `getDeviceInfo` every 30s,
    // see `startReachabilityPolling`) that drives `online`. The stream-broker
    // health remains available as the separate `camera-streams` slice.

    // ── The camera's own clips (D549) ────────────────────────────────────
    //
    // This addon is the DEVICE'S OWNER, so it is the one that can serve its
    // catalog (D224). The cap is a per-device COLLECTION: this provider is one
    // SOURCE of a camera, listed beside the analytics visits and never
    // substituted for them. A device that is not an Amcrest camera asks this
    // provider for its sources and gets `[]` — cheap and honest.
    //
    // Registered unconditionally: the provider gates itself per device rather
    // than per install, so there is no boot-order question to get wrong.
    //
    // The PINNED jellyfin build, never the host's `ffmpeg` on PATH
    // (`docs/architecture/ffmpeg.md`). This addon spawns ffmpeg on both clip
    // paths — the file re-index and the stream mux — and has always fallen
    // back to whatever the container happened to carry, which is a different
    // binary with different defaults on every node the provider runs on. The
    // same wiring miss D616 found in the Hikvision addon.
    //
    // A RESOLVER, asked by each pass, not a path captured here: a boot-time
    // miss (a download that was down) used to leave the clips refusing until
    // the runner restarted. The memo remembers only a success, so the next
    // clip asks again; each refusal is named per camera where it happens.
    this.clipService = createClipService({
      dataDir: this.ctx.dataDir,
      logger: this.ctx.logger,
      resolveFfmpeg: memoizePinnedFfmpeg(() => this.ctx.deps.ensureFfmpeg()),
      // The addon→addon byte transport (D613) — how a clip's bytes reach the
      // recorder's export without either side holding the payload.
      ...(this.ctx.peerBytes !== undefined ? { peerBytes: this.ctx.peerBytes } : {}),
      resolveCamera: async (deviceId) => {
        const device = this.ctx.kernel.deviceRegistry?.getById(deviceId)
        return device instanceof AmcrestCamera ? device.getClipCamera() : null
      },
    })
    // The camera's clips carry OUR detections too (D923): every listing is
    // joined with the object events that overlap each clip's window, by the
    // one overlap rule the recorder's visits use. The firmware's own types
    // stay in `nativeTypes`; a failed event read lists the clips unlabelled.
    regs.push({
      capability: videoclipsCapability,
      provider: withClipEventLabels(
        this.clipService.provider,
        clipEventLabelDepsFromApi(this.ctx.api, this.ctx.logger),
      ),
    })

    // The clip media plane. Bytes NEVER travel through a cap call (D9/D18):
    // the cap answers with a URL into this prefix and the addon serves the
    // bytes itself, with `Range` so the player seeks.
    //
    // `authenticated`, not `admin`, and NO TOKEN IN THE URL: the hub's
    // `/addon/<id>/<prefix>` proxy takes the session cookie (D549 22).
    //
    // Served HERE, in `onInitialize`, because the hub PULLS an addon's data
    // planes during the node-registration handshake — serving later misses the
    // pull and the route never registers.
    await this.serveClipPlane(this.clipService)

    return regs
  }

  /** The clip service: catalog, the player's file route, the export's bytes,
   *  and the forward-only stream the broker dials. */
  private clipService: ClipService | null = null

  protected override async onShutdown(): Promise<void> {
    // The clip stream dial listener (D597) is a loopback port this runner
    // owns; a respawn must not leave it bound.
    await this.clipService?.dispose().catch(() => {
      /* best-effort */
    })
    await super.onShutdown()
  }

  private async serveClipPlane(service: ClipService): Promise<void> {
    try {
      const media = await this.ctx.dataPlane?.serve({
        prefix: service.mediaPrefix,
        access: 'authenticated',
        handler: service.mediaHandler,
      })
      const thumb = await this.ctx.dataPlane?.serve({
        prefix: service.thumbPrefix,
        access: 'authenticated',
        handler: service.thumbHandler,
      })
      this.ctx.logger.info('Amcrest clip data planes served', {
        meta: {
          // The CLIENT path is the hub's reverse-proxy path, never the
          // internal 127.0.0.1 listener the handle reports.
          mediaPath: `/addon/${AMCREST_ADDON_ID}/${service.mediaPrefix}`,
          thumbPath: `/addon/${AMCREST_ADDON_ID}/${service.thumbPrefix}`,
          mediaServed: media !== undefined,
          thumbServed: thumb !== undefined,
        },
      })
    } catch (err: unknown) {
      // A branch that drops work says so: without this route every clip tile
      // renders and every play answers nothing, with no line anywhere (D391).
      this.ctx.logger.warn(
        'Amcrest clip data planes failed to serve — clips will not play and tiles will not render',
        {
          meta: { error: err instanceof Error ? err.message : String(err) },
        },
      )
    }
  }

  // ── Discovery ──────────────────────────────────────────────────────

  override async supportsDiscovery(): Promise<boolean> {
    return true
  }

  override async getDiscoveryParamsSchema(): Promise<ConfigUISchema | null> {
    return buildDiscoveryParamsFormSchema()
  }

  override async getDiscoveryModes(): Promise<readonly DiscoveryMode[]> {
    return AMCREST_DISCOVERY_MODES
  }

  /**
   * WS-Discovery answers name the vendor; CGI answers are confirmed with the scan-form
   * credentials, which exist only here (never in the engine's probe).
   */
  override async classifyDiscoveryHits(input: {
    hits: readonly DiscoveryHit[]
    params?: Record<string, unknown>
  }): Promise<readonly DiscoveryCandidate[]> {
    const p = input.params ?? {}
    const rawUser = typeof p['username'] === 'string' ? p['username'].trim() : ''
    const username = rawUser.length > 0 ? rawUser : 'admin'
    const password = typeof p['password'] === 'string' ? p['password'] : ''

    const ws = amcrestFromWsdHits(input.hits)
    const http = await amcrestFromHttpHits(
      input.hits,
      password.length > 0 ? { username, password } : null,
    )
    const byHost = new Map<string, DiscoveredAmcrestCamera>()
    for (const cam of [...ws, ...http]) if (!byHost.has(cam.host)) byHost.set(cam.host, cam)
    const cameras = [...byHost.values()]
    this.ctx.logger.info('Amcrest discovery classified', {
      meta: { count: cameras.length, ws: ws.length, httpConfirmed: http.length },
    })

    return cameras.map((c) => {
      const displayName = c.name ?? c.model ?? c.host
      return {
        stableId: `host-${slugifyAmcrestHost(c.host)}`,
        type: DeviceType.Camera,
        suggestedName: displayName,
        prefilledConfig: {
          name: displayName,
          host: c.host,
          port: c.port,
          ...(username ? { username } : {}),
          ...(password ? { password } : {}),
        },
      }
    })
  }

  override async adoptDiscoveredDevice(input: {
    candidate: DiscoveryCandidate
  }): Promise<DeviceSummary> {
    return this.createDevice({
      type: DeviceType.Camera,
      config: input.candidate.prefilledConfig,
    })
  }

  // ── Creation ────────────────────────────────────────────────────────

  protected async onGetCreationSchema(type: DeviceType): Promise<ConfigUISchema | null> {
    if (type !== DeviceType.Camera) return null
    return buildCreationFormSchema()
  }

  protected async onCreateDevice(
    type: DeviceType,
    config: Record<string, unknown>,
  ): Promise<CreateDeviceSpec> {
    if (type !== DeviceType.Camera) {
      throw new Error(`Amcrest provider does not support device type: ${type}`)
    }
    const name = getString(config, 'name').trim()
    if (!name) throw userError('amcrest.camera-name-required', undefined, 'Camera name is required')
    const host = getString(config, 'host').trim()
    if (!host) throw userError('amcrest.camera-ip-required', undefined, 'Camera IP is required')
    const password = getString(config, 'password')
    if (!password) throw userError('amcrest.password-required', undefined, 'Password is required')

    const username = getString(config, 'username').trim() || 'admin'
    const https = getBoolean(config, 'https')
    const port = getNumber(config, 'port', https ? 443 : 80)

    const client = new AmcrestCgiClient({
      host,
      port,
      https,
      username,
      password,
    })
    let info: Awaited<ReturnType<AmcrestCgiClient['getDeviceInfo']>>
    try {
      info = await client.getDeviceInfo()
    } catch (err) {
      throw new Error(
        `Amcrest probe failed at ${host}:${port}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }
    this.ctx.logger.info('Amcrest deviceInfo probe', {
      tags: { host },
      meta: {
        deviceType: info.deviceType ?? '?',
        serial: info.serialNumber ?? '?',
        firmware: info.softwareVersion ?? '?',
      },
    })

    // MAC probe — best-effort. A 4xx here leaves mac unresolved and
    // generateStableId falls back to the host slug.
    let probedMac: string | null = null
    try {
      probedMac = await client.resolveMac(host)
      this.ctx.logger.info('Amcrest network probe', {
        tags: { host },
        meta: { mac: probedMac ?? '(unset)' },
      })
    } catch (netErr) {
      this.ctx.logger.warn(
        'Amcrest network probe failed (non-fatal — stableId falls back to host)',
        {
          tags: { host },
          meta: {
            error: netErr instanceof Error ? netErr.message : String(netErr),
          },
        },
      )
    }

    // PTZ probe — persist so `features`/UI can reflect PTZ availability.
    let hasPtz = false
    try {
      const caps = await client.getPtzCaps(1)
      hasPtz = caps !== null && (caps.hasPan || caps.hasTilt || caps.hasZoom)
    } catch {
      // best-effort — non-PTZ models 404 or return no caps
    }

    const parsed = amcrestCameraSchema.parse({
      host,
      port,
      https,
      username,
      password,
      channel: 1,
      deviceCache: {
        ...(info.deviceType ? { deviceType: info.deviceType, model: info.deviceType } : {}),
        ...(info.serialNumber ? { serialNumber: info.serialNumber } : {}),
        ...(info.softwareVersion ? { firmwareVersion: info.softwareVersion } : {}),
        ...(info.hardwareVersion ? { hardwareVersion: info.hardwareVersion } : {}),
        ...(info.processor ? { processor: info.processor } : {}),
        ...(probedMac ? { mac: probedMac } : {}),
        hasPtz,
        probedAt: Date.now(),
      },
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
    formValues?: Record<string, unknown>
  }): Promise<FieldProbeResult> {
    if (input.key !== 'host') {
      return { status: 'ok', labels: ['no probe available'] }
    }
    const form = input.formValues ?? {
      host: typeof input.value === 'string' ? input.value : '',
    }
    const host = getString(form, 'host').trim()
    const password = getString(form, 'password')
    if (!host)
      return {
        status: 'error',
        error: 'Provide a host before running the test',
      }
    if (!password)
      return {
        status: 'error',
        error: 'Enter a password before running the test',
      }
    const username = getString(form, 'username').trim() || 'admin'
    const https = getBoolean(form, 'https')
    const port = getNumber(form, 'port', https ? 443 : 80)

    try {
      const client = new AmcrestCgiClient({
        host,
        port,
        https,
        username,
        password,
      })
      const info = await client.getDeviceInfo()
      const labels: string[] = []
      if (info.deviceType) labels.push(info.deviceType)
      if (info.softwareVersion) labels.push(`Firmware: ${info.softwareVersion}`)
      labels.push(`${https ? 'HTTPS' : 'HTTP'} :${port}`)
      return { status: 'ok', labels }
    } catch (err) {
      return {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
}
