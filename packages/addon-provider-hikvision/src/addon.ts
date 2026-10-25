import { userError } from '@camstack/types'
import type {
  ConfigUISchema,
  CreateDeviceSpec,
  DeviceConstructor,
  DeviceSummary,
  DiscoveryCandidate,
  FieldProbeResult,
  IDevice,
  ProviderRegistration,
} from '@camstack/types'
import {
  BaseDeviceProvider,
  clipEventLabelDepsFromApi,
  DeviceType,
  failureContributionCapability,
  memoizePinnedFfmpeg,
  videoclipsCapability,
  widenDeviceConstructor,
  withClipEventLabels,
} from '@camstack/types'
import { createClipService, type ClipService } from './clips/clip-service.js'
import { HikvisionCamera, hikvisionCameraSchema, HIKVISION_ADDON_ID } from './hikvision-camera.js'
import { HikvisionIsapiClient } from './hikvision-isapi-client.js'
import { intercomFailureReport } from './intercom/intercom-failure-report.js'
import {
  discoverHikvisionCameras,
  discoverHikvisionViaHttpScan,
  slugifyHikvisionHost,
  type DiscoveredHikvisionCamera,
} from './hikvision-discovery.js'

function getString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key]
  return typeof v === 'string' ? v : ''
}

function getBoolean(obj: Record<string, unknown>, key: string): boolean {
  const v = obj[key]
  return v === true
}

function getNumber(obj: Record<string, unknown>, key: string, fallback: number): number {
  const v = obj[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/**
 * Build the Add-Device creation form. One section per logical block —
 * connection, credentials, optional HTTPS — and a single `host` probe
 * that runs `/ISAPI/System/deviceInfo` so the operator gets immediate
 * confirmation the camera responds before saving.
 */
function buildCreationFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'identity',
        title: 'Camera',
        titleKey: 'provider-hikvision:creation.s_identity.title',
        columns: 1,
        fields: [
          {
            type: 'text',
            key: 'name',
            label: 'Name',
            labelKey: 'provider-hikvision:creation.s_identity.name.label',
            required: true,
            placeholder: 'Driveway',
          },
        ],
      },
      {
        id: 'credentials',
        title: 'Credentials',
        titleKey: 'provider-hikvision:creation.s_credentials.title',
        columns: 2,
        fields: [
          {
            type: 'text',
            key: 'username',
            label: 'Username',
            labelKey: 'provider-hikvision:creation.s_credentials.username.label',
            default: 'admin',
            required: true,
          },
          {
            type: 'password',
            key: 'password',
            label: 'Password',
            labelKey: 'provider-hikvision:creation.s_credentials.password.label',
            required: true,
            showToggle: true,
          },
        ],
      },
      {
        id: 'connection',
        title: 'Connection',
        titleKey: 'provider-hikvision:creation.s_connection.title',
        description: 'Use 443 with HTTPS for cameras with TLS enabled.',
        descriptionKey: 'provider-hikvision:creation.s_connection.description',
        columns: 2,
        fields: [
          {
            type: 'probe',
            key: 'host',
            label: 'Camera IP',
            labelKey: 'provider-hikvision:creation.s_connection.host.label',
            required: true,
            placeholder: '192.168.10.100',
            inputType: 'text',
          },
          {
            type: 'number',
            key: 'port',
            label: 'Port',
            labelKey: 'provider-hikvision:creation.s_connection.port.label',
            default: 80,
            min: 1,
            max: 65535,
            step: 1,
          },
          {
            type: 'boolean',
            key: 'https',
            label: 'Use HTTPS',
            labelKey: 'provider-hikvision:creation.s_connection.https.label',
            default: false,
            style: 'switch',
          },
        ],
      },
    ],
  }
}

/**
 * Extra per-scan inputs for Hikvision discovery. Like Reolink, a Hikvision camera needs CREDENTIALS
 * to be created (ISAPI probe), so the scan form collects them and bakes them into each candidate for
 * a one-click adopt. Discovery itself (ONVIF WS-Discovery multicast) needs no credentials.
 */
function buildDiscoveryParamsFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'credentials',
        title: 'Credentials',
        titleKey: 'provider-hikvision:discoveryParams.s_credentials.title',
        description: 'Assumes all cameras share these credentials.',
        descriptionKey: 'provider-hikvision:discoveryParams.s_credentials.description',
        columns: 2,
        fields: [
          {
            type: 'text',
            key: 'username',
            label: 'Username',
            labelKey: 'provider-hikvision:discoveryParams.s_credentials.username.label',
            default: 'admin',
            required: true,
          },
          {
            type: 'password',
            key: 'password',
            label: 'Password',
            labelKey: 'provider-hikvision:discoveryParams.s_credentials.password.label',
            required: true,
            showToggle: true,
          },
        ],
      },
      {
        id: 'scan',
        title: 'Scan options',
        titleKey: 'provider-hikvision:discoveryParams.s_scan.title',
        description:
          "Leave blank to scan the hub's own subnet; enter the CIDR if the cameras are on another one (e.g. 192.168.60.0/24).",
        descriptionKey: 'provider-hikvision:discoveryParams.s_scan.description',
        columns: 1,
        fields: [
          {
            type: 'text',
            key: 'networkCidr',
            label: 'Network (CIDR) — required if cameras are on a different subnet than the hub',
            labelKey: 'provider-hikvision:discoveryParams.s_scan.networkCidr.label',
            required: false,
            placeholder: '192.168.60.0/24',
          },
          {
            type: 'number',
            key: 'timeoutMs',
            label: 'WS-Discovery timeout (ms)',
            labelKey: 'provider-hikvision:discoveryParams.s_scan.timeoutMs.label',
            min: 1_000,
            max: 30_000,
            default: 5_000,
          },
        ],
      },
    ],
  }
}

/** True when the string looks like a real hardware identifier — not
 *  an all-zeros / all-`F` placeholder. Mirrors the Reolink helper. */
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

export class HikvisionProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = HIKVISION_ADDON_ID
  protected readonly providerName = 'Hikvision'
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    // `HikvisionCamera`'s config schema has 30+ explicitly-typed fields.
    // The variance check between `DeviceConfig<typeof hikvisionCameraSchema>`
    // (concrete shape) and `DeviceConfig<z.ZodObject<core.$ZodLooseShape>>`
    // (the IDevice shape) causes TS2589 "Type instantiation is excessively
    // deep" before TS can prove the assignment. The runtime types ARE
    // assignable; this cast tells TS to skip the deep variance check.
    // Reolink/ONVIF have smaller schemas and pass without it.
    [DeviceType.Camera]: widenDeviceConstructor(HikvisionCamera),
  }

  constructor() {
    super({})
  }

  /**
   * Hikvision stableId derivation — uniform `mac → host(IP)` chain,
   * matching the Reolink provider's pattern.
   *
   * Priority:
   *   1. mac  — hardware MAC from `/ISAPI/System/Network/interfaces/1`,
   *             persisted into `deviceCache.mac` by `onCreateDevice`.
   *             Durable across firmware updates + DHCP renewals.
   *   2. host — operator-typed IP/hostname (DHCP-reservable). Always
   *             present on Hikvision adds (`onCreateDevice` validates
   *             host is non-empty before this code path).
   *
   * No addon-id prefix — the deviceMeta row key already namespaces by
   * addon (`<addonId>:<stableId>`).
   */
  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const cfg = config ?? {}
    const cache = (cfg['deviceCache'] as Record<string, unknown> | undefined) ?? {}
    const macRaw = typeof cache['mac'] === 'string' ? cache['mac'].trim() : ''
    const mac = macRaw.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
    if (isMeaningfulIdentifier(mac)) return `mac-${mac}`
    const host = typeof cfg['host'] === 'string' ? cfg['host'].trim() : ''
    if (host.length > 0) {
      const slug = slugifyHikvisionHost(host)
      if (slug.length > 0) return `host-${slug}`
    }
    const hostLabel = host || '(unknown host)'
    const reason = `Hikvision probe on ${hostLabel} resolved neither mac nor host address — cannot persist a stable row key. Verify network reachability + credentials, then retry.`
    try {
      const now = Date.now()
      void this.ctx.api?.alerts?.emit?.mutate?.({
        id: `hikvision-no-stableid-${now}`,
        category: 'addon.error',
        severity: 'error',
        title: `Hikvision: missing identifier on ${hostLabel}`,
        message: reason,
        status: 'active',
        read: false,
        createdAt: now,
        updatedAt: now,
        source: { type: 'addon', id: this.addonId },
        metadata: { host: hostLabel },
      })
    } catch {
      /* alerts cap optional */
    }
    throw new Error(`Hikvision: ${reason}`)
  }

  protected override async onInitialize(): Promise<ProviderRegistration[]> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())

    // The broker PULLS each camera's `stream-catalog` cap to (re)build
    // its registry — no provider-side re-publish on broker ready. The
    // pull cadence covers boot-order races + broker restart on its own.

    // NOTE: `device.online` is NO LONGER mirrored from the stream broker's
    // `camera-streams` health here. `online` must reflect CONTROL-PLANE
    // reachability, not whether video happens to be flowing — an on-demand
    // camera with no consumer is fully reachable yet has no active stream.
    // Each `HikvisionCamera` now runs a control-plane reachability poll
    // (ISAPI `getDeviceInfo` every 30s, see `startReachabilityPolling`) that
    // drives `online`. The stream-broker health signal remains available as
    // the separate `camera-streams` slice ("is the video flowing").

    // This addon's own talk-back LOSSES, per camera, with their denominator.
    // The rate-mismatch drop shipped with one warn and no counter, so "how
    // much is 102 losing" meant grepping Loki; every `pushTalkAudio` outcome
    // is now noted from the one place that decides it. Read (never drained)
    // through `system.getFailureContributions`.
    regs.push({
      capability: failureContributionCapability,
      provider: { list: () => intercomFailureReport.list() },
    })

    // ── The camera's own clips (D549) ────────────────────────────────────
    //
    // This addon is the DEVICE'S OWNER, so it is the one that can serve its
    // catalog (D224). The cap is a per-device COLLECTION: this provider is one
    // SOURCE of a camera, listed beside the analytics visits and never
    // substituted for them. A device that is not a Hikvision camera asks this
    // provider for its sources and gets `[]` — cheap and honest.
    //
    // Registered unconditionally: the provider gates itself per device rather
    // than per install, so there is no boot-order question to get wrong.
    this.clipService = createClipService({
      dataDir: this.ctx.dataDir,
      logger: this.ctx.logger,
      // The PINNED jellyfin build, never the host's `ffmpeg` on PATH
      // (`docs/architecture/ffmpeg.md`). This addon has always spawned ffmpeg
      // — the clip file mux, the clip stream mux — and has always fallen back
      // to whatever the container happened to carry, which is a different
      // binary with different defaults on every node the provider runs on.
      // A RESOLVER, asked by each pass — never a path captured at init: a
      // boot-time miss used to leave every clip refusing until the runner
      // restarted. The memo keeps only a success; each refusal is named per
      // camera where it happens.
      resolveFfmpeg: memoizePinnedFfmpeg(() => this.ctx.deps.ensureFfmpeg()),
      // The addon→addon byte transport (D613) — how a clip's bytes reach the
      // recorder's export without either side holding the payload.
      ...(this.ctx.peerBytes !== undefined ? { peerBytes: this.ctx.peerBytes } : {}),
      resolveCamera: async (deviceId) => {
        const device = this.ctx.kernel.deviceRegistry?.getById(deviceId)
        return device instanceof HikvisionCamera ? device.getClipCamera() : null
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

    // The three clip planes. Bytes NEVER travel through a cap call (D9/D18): the
    // cap answers with a URL into these prefixes and the addon serves the
    // bytes itself, with `Range` on the media plane so the player seeks.
    //
    // `authenticated`, not `admin`, and NO TOKEN IN EITHER URL: the hub's
    // `/addon/<id>/<prefix>` proxy takes the session cookie (D549 22).
    //
    // Served HERE, in `onInitialize`, because the hub PULLS an addon's data
    // planes during the node-registration handshake — serving later misses the
    // pull and the route never registers.
    await this.serveClipPlanes(this.clipService)

    return regs
  }

  /** The clip service: catalog, the player's file route, the broker's dial. */
  private clipService: ClipService | null = null

  private async serveClipPlanes(service: ClipService): Promise<void> {
    try {
      const media = await this.ctx.dataPlane?.serve({
        prefix: service.mediaPrefix,
        access: 'authenticated',
        handler: service.mediaHandler,
      })
      const stream = await this.ctx.dataPlane?.serve({
        prefix: service.streamPrefix,
        access: 'authenticated',
        handler: service.streamHandler,
      })
      const thumb = await this.ctx.dataPlane?.serve({
        prefix: service.thumbPrefix,
        access: 'authenticated',
        handler: service.thumbHandler,
      })
      this.ctx.logger.info('Hikvision clip data planes served', {
        meta: {
          // The CLIENT path is the hub's reverse-proxy path, never the
          // internal 127.0.0.1 listener the handle reports.
          mediaPath: `/addon/${HIKVISION_ADDON_ID}/${service.mediaPrefix}`,
          streamPath: `/addon/${HIKVISION_ADDON_ID}/${service.streamPrefix}`,
          thumbPath: `/addon/${HIKVISION_ADDON_ID}/${service.thumbPrefix}`,
          mediaServed: media !== undefined,
          streamServed: stream !== undefined,
          thumbServed: thumb !== undefined,
        },
      })
    } catch (err: unknown) {
      this.ctx.logger.warn('Hikvision clip data planes failed to serve — clips will not render', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  protected override async onShutdown(): Promise<void> {
    // The clip stream dial listener (D597) is a loopback port this runner
    // owns; a respawn must not leave it bound.
    await this.clipService?.disposeClipStreamDial().catch(() => {
      /* best-effort */
    })
    await super.onShutdown()
  }

  // ── Discovery: ONVIF WS-Discovery filtered to Hikvision devices ────

  override async supportsDiscovery(): Promise<boolean> {
    return true
  }

  override async getDiscoveryParamsSchema(): Promise<ConfigUISchema | null> {
    return buildDiscoveryParamsFormSchema()
  }

  override async discoverDevices(input?: {
    params?: Record<string, unknown>
  }): Promise<readonly DiscoveryCandidate[]> {
    const p = input?.params ?? {}
    // Username defaults to `admin` (the Hikvision default) — the scan form shows `admin` as a field
    // default, but a FormBuilder default is NOT written into params unless the operator edits the
    // field, so relying on the passed value would skip the HTTP scan whenever they only typed the
    // password. Gate the HTTP scan on the PASSWORD only.
    const rawUser = typeof p['username'] === 'string' ? p['username'].trim() : ''
    const username = rawUser.length > 0 ? rawUser : 'admin'
    const password = typeof p['password'] === 'string' ? p['password'] : ''
    const networkCidr = typeof p['networkCidr'] === 'string' ? p['networkCidr'].trim() : ''
    const timeoutMs = typeof p['timeoutMs'] === 'number' ? p['timeoutMs'] : 5_000

    // Two mechanisms, merged by host: WS-Discovery (multicast — works only where the runner receives
    // multicast, NOT on a macvlan/br0 hub) and an ISAPI subnet scan (unicast — reliable from any
    // network, but needs a password). Run the HTTP scan whenever a password is supplied.
    const results = await Promise.all([
      discoverHikvisionCameras(timeoutMs).catch(() => [] as readonly DiscoveredHikvisionCamera[]),
      password
        ? discoverHikvisionViaHttpScan({
            username,
            password,
            ...(networkCidr ? { networkCidr } : {}),
          }).catch(() => [] as readonly DiscoveredHikvisionCamera[])
        : Promise.resolve([] as readonly DiscoveredHikvisionCamera[]),
    ])
    const byHost = new Map<string, DiscoveredHikvisionCamera>()
    for (const cam of results.flat()) if (!byHost.has(cam.host)) byHost.set(cam.host, cam)
    const cameras = [...byHost.values()]
    this.ctx.logger.info('Hikvision discovery complete', {
      meta: { count: cameras.length, ws: results[0].length, httpScan: results[1].length },
    })

    return cameras.map((c) => {
      const displayName = c.name ?? c.model ?? c.host
      return {
        // Best-effort: the authoritative id is `mac-<mac>` (learned during the ISAPI probe at adopt
        // time). Discovery has no MAC, so the host slug keys the candidate.
        stableId: `host-${slugifyHikvisionHost(c.host)}`,
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
    // Reuse the manual-creation path: onCreateDevice runs the ISAPI probe against the discovered
    // host with the scan-form credentials in prefilledConfig.
    return this.createDevice({
      type: DeviceType.Camera,
      config: input.candidate.prefilledConfig,
    })
  }

  // ── Creation ─────────────────────────────────────────────────────

  protected async onGetCreationSchema(type: DeviceType): Promise<ConfigUISchema | null> {
    if (type !== DeviceType.Camera) return null
    return buildCreationFormSchema()
  }

  protected async onCreateDevice(
    type: DeviceType,
    config: Record<string, unknown>,
  ): Promise<CreateDeviceSpec> {
    if (type !== DeviceType.Camera) {
      throw new Error(`Hikvision provider does not support device type: ${type}`)
    }
    const name = getString(config, 'name').trim()
    if (!name)
      throw userError('hikvision.camera-name-required', undefined, 'Camera name is required')
    const host = getString(config, 'host').trim()
    if (!host) throw userError('hikvision.camera-ip-required', undefined, 'Camera IP is required')
    const password = getString(config, 'password')
    if (!password) throw userError('hikvision.password-required', undefined, 'Password is required')

    const username = getString(config, 'username').trim() || 'admin'
    const https = getBoolean(config, 'https')
    const port = getNumber(config, 'port', https ? 443 : 80)

    const isapi = new HikvisionIsapiClient({ host, port, https, username, password })
    let info: Awaited<ReturnType<HikvisionIsapiClient['getDeviceInfo']>>
    try {
      info = await isapi.getDeviceInfo()
    } catch (err) {
      throw new Error(
        `Hikvision probe failed at ${host}:${port}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }
    this.ctx.logger.info('Hikvision deviceInfo probe', {
      tags: { host },
      meta: {
        model: info.model ?? '?',
        serial: info.serialNumber ?? '?',
        firmware: info.firmwareVersion ?? '?',
        deviceType: info.deviceType ?? '?',
      },
    })

    // Host network probe — fetches the canonical interface MAC so
    // `generateStableId` can derive `mac-<mac>` (durable across DHCP
    // renewals). Best-effort: a 4xx here leaves probedMac=null and
    // generateStableId falls back to host slug.
    let probedMac: string | null = null
    try {
      const net = await isapi.getNetworkInterfaceInfo()
      probedMac = net.mac
      this.ctx.logger.info('Hikvision network probe', {
        tags: { host },
        meta: { mac: net.mac ?? '(unset)', ip: net.ip ?? '(unset)' },
      })
    } catch (netErr) {
      this.ctx.logger.warn(
        'Hikvision network probe failed (non-fatal — stableId will fall back to host)',
        {
          tags: { host },
          meta: { error: netErr instanceof Error ? netErr.message : String(netErr) },
        },
      )
    }

    const parsed = hikvisionCameraSchema.parse({
      host,
      port,
      https,
      username,
      password,
      rtspTransport: 'unicast',
      deviceCache: {
        deviceType: 'camera',
        ...(info.model ? { model: info.model } : {}),
        ...(info.serialNumber ? { serialNumber: info.serialNumber } : {}),
        ...(info.firmwareVersion ? { firmwareVersion: info.firmwareVersion } : {}),
        ...(info.firmwareVersionInfo ? { firmwareVersionInfo: info.firmwareVersionInfo } : {}),
        ...(info.hardwareVersion ? { hardwareVersion: info.hardwareVersion } : {}),
        ...(info.deviceType ? { isapiDeviceType: info.deviceType } : {}),
        ...(probedMac ? { mac: probedMac } : {}),
        probedAt: Date.now(),
      },
    })

    return {
      meta: { type: DeviceType.Camera, name },
      config: parsed,
    }
  }

  // ── Field probing ────────────────────────────────────────────────

  override async testCreationField(input: {
    type: DeviceType
    key: string
    value: unknown
    formValues?: Record<string, unknown>
  }): Promise<FieldProbeResult> {
    if (input.key !== 'host') {
      return { status: 'ok', labels: ['no probe available'] }
    }
    const form = input.formValues ?? { host: typeof input.value === 'string' ? input.value : '' }
    const host = getString(form, 'host').trim()
    const password = getString(form, 'password')
    if (!host) return { status: 'error', error: 'Provide a host before running the test' }
    if (!password) return { status: 'error', error: 'Enter a password before running the test' }
    const username = getString(form, 'username').trim() || 'admin'
    const https = getBoolean(form, 'https')
    const port = getNumber(form, 'port', https ? 443 : 80)

    try {
      const isapi = new HikvisionIsapiClient({ host, port, https, username, password })
      const info = await isapi.getDeviceInfo()
      const labels: string[] = []
      if (info.model) labels.push(info.model)
      if (info.deviceType) labels.push(info.deviceType)
      if (info.firmwareVersion) labels.push(`Firmware: ${info.firmwareVersion}`)
      labels.push(`${https ? 'HTTPS' : 'HTTP'} :${port}`)
      return { status: 'ok', labels }
    } catch (err) {
      return {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  // ── Restore ──────────────────────────────────────────────────────
  //
  // Default `BaseDeviceProvider.onRestoreDevices` impl iterates
  // saved rows and dispatches via `deviceClasses` map. The device's
  // `onActivate` lifecycle hook (see `HikvisionCamera`) primes the
  // local stream catalog + opens the alarm subscription; the broker
  // PULLS the catalog itself via the `stream-catalog` cap — no
  // provider-side push, so no override is needed here.
}
