import {
  type AutoDetectResult,
  autoDetectDeviceType,
  type DiscoveryOptions,
  discoverReolinkDevices,
} from '@apocaliss92/nodelink-js'
import type {
  AddonContext,
  AddonInitResult,
  ConfigUISchema,
  CreateDeviceSpec,
  DeviceConstructor,
  DeviceRestoreReport,
  DeviceSummary,
  DiscoveryCandidate,
  DiscoveryMode,
  DurableState,
  FieldProbeResult,
  IDevice,
  IDeviceAdoptionProvider,
  IScopedLogger,
  LogChannelsProviderHandle,
  ProviderRegistration,
  SavedDevice,
  SystemEvent,
  IntegrationInstanceRef,
} from '@camstack/types'
import {
  BaseDeviceProvider,
  clipEventLabelDepsFromApi,
  createLogChannelsProvider,
  DeviceType,
  deviceAdoptionCapability,
  errMsg,
  EventCategory,
  failureContributionCapability,
  logChannelsCapability,
  memoizePinnedFfmpeg,
  userError,
  videoclipsCapability,
  withClipEventLabels,
} from '@camstack/types'
import { z } from 'zod'
import {
  CLIP_CATALOG_REFRESH_MINUTES_KEY,
  CLIP_CATALOG_REFRESH_MINUTES_MIN,
  ClipCatalogRefreshScheduler,
  type ClipRefreshTarget,
  resolveClipCatalogForcedWake,
  resolveClipCatalogRefreshMinutes,
} from './clips/clip-refresh.js'
import { buildClipRefreshSettingsSchema } from './clips/clip-refresh-settings.js'
import { type ClipService, createClipService } from './clips/clip-service.js'
import { type ReolinkDebugActions, reolinkDebugActions } from './debug-actions.js'
import { intercomFailureReport } from './intercom-failure-report.js'
import type { RawReadInput, RawReadResult } from './raw-read.js'
import { REOLINK_ADDON_ID, ReolinkCamera, reolinkCameraSchema } from './reolink-camera.js'
// Importing the module is what RUNS the declarations. Never drop it as an
// "unused import": the channels vanish from the cluster if you do.
import './log-channels.js'
import { AutodetectCache } from './autodetect-cache.js'
import {
  BAICHUAN_WEBHOOK_SECTION_IDS,
  buildBaichuanWebhookSettingsSchema,
} from './baichuan-webhook-schema.js'
import { ReolinkBaichuanWebhookServer } from './baichuan-webhook-server.js'
import { buildCreationFormSchema, buildDiscoveryParamsFormSchema } from './creation-schema.js'
import { buildEmailPushSettingsSchema, EMAIL_PUSH_SECTION_IDS } from './email-push-schema.js'
import { ReolinkEmailPushServer } from './email-push-server.js'
import { listLanHosts } from './email-push-shared.js'
import { readEmailPushStore } from './email-push-store.js'
import {
  mapReolinkDiscoveryToCandidates,
  type OnboardedReolinkDevice,
  slugifyReolinkHost,
} from './reolink-discovery-map.js'
import {
  REOLINK_DISCOVERY_MODES,
  scanReolinkSubnets,
  subnetsFromParams,
} from './reolink-subnet-scan.js'
import { buildHubInstanceSchema, isHubIntegration } from './hub-connection.js'
import { buildReolinkAdoptionProvider } from './reolink-adoption-provider.js'
import { createReolinkHubManager, type ReolinkHubManager } from './reolink-hub-manager.js'
import {
  type HubMigrationPorts,
  type PendingHubRetirement,
  planHubMigration,
  retireMigratedHubs,
} from './reolink-hub-migration.js'
import { reolinkHubSessions } from './reolink-hub-session.js'

/**
 * Adapt a camstack scoped logger to the lib's `Logger` shape (just
 * `log(...)`). Lib lines are prefixed with `[AutoDetect]` /
 * `[BaichuanClient]` / etc. — we forward them at info level on the
 * caller's scope so any tags bound on `scopedLogger` (`addonId`,
 * `requestId` for the Add-Device modal) propagate to every emitted
 * entry. Mirrors `ReolinkCamera.libLoggerAdapter` but with structured
 * forwarding instead of stringifying everything as one info line.
 */
function buildAutodetectLibLogger(scopedLogger: IScopedLogger): {
  log: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
} {
  const fwd =
    (level: 'info' | 'warn' | 'error' | 'debug') =>
    (...args: unknown[]) => {
      const message = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
      scopedLogger[level](message)
    }
  return {
    log: fwd('info'),
    info: fwd('info'),
    warn: fwd('warn'),
    error: fwd('error'),
    debug: fwd('debug'),
  }
}

function getString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key]
  return typeof v === 'string' ? v : ''
}

function getNumber(obj: Record<string, unknown>, key: string, fallback: number): number {
  const v = obj[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

type TransportMode = 'auto' | 'tcp' | 'udp'

function getTransportMode(obj: Record<string, unknown>): TransportMode {
  const v = obj['transport']
  return v === 'tcp' || v === 'udp' || v === 'auto' ? v : 'auto'
}

function buildAutodetectInputs(form: Record<string, unknown>): {
  readonly host: string
  readonly username: string
  readonly password: string
  readonly uid: string | undefined
  readonly transport: TransportMode
  readonly port: number
} {
  const host = getString(form, 'host').trim()
  const username = (getString(form, 'username') || 'admin').trim()
  const password = getString(form, 'password')
  const rawUid = getString(form, 'uid').trim()
  const uid = rawUid.length > 0 ? rawUid : undefined
  const transport = getTransportMode(form)
  const port = getNumber(form, 'port', 9000)
  return { host, username, password, uid, transport, port }
}

function buildAutodetectLabels(result: AutoDetectResult): string[] {
  const labels: string[] = []
  const model = result.deviceInfo?.type
  if (model && model.length > 0) labels.push(model)
  labels.push(formatDeviceTypeLabel(result.type))
  if (result.type === 'nvr' && typeof result.channelNum === 'number' && result.channelNum > 0) {
    labels.push(`${result.channelNum} channels`)
  }
  labels.push(`Transport: ${result.transport.toUpperCase()}`)
  if (result.transport === 'udp' && result.udpDiscoveryMethod) {
    labels.push(`UDP via ${result.udpDiscoveryMethod}`)
  }
  if (result.uid && result.uid.length > 0 && result.transport === 'udp') {
    labels.push(`UID ${result.uid.slice(0, 4)}…${result.uid.slice(-4)}`)
  }
  return labels
}

/**
 * Pick a sensible default device name from a successful autodetect probe.
 * Order: model name (`deviceInfo.type`, e.g. "RLC-810A") → device-type label
 * → bare host. The dialog merges this only when the operator hasn't typed
 * a name yet; never overwrites manual input.
 */
function buildAutodetectSuggestedName(result: AutoDetectResult, host: string): string {
  const model = result.deviceInfo?.type
  if (typeof model === 'string' && model.trim().length > 0) return model.trim()
  const typeLabel = formatDeviceTypeLabel(result.type)
  if (host && host.trim().length > 0) return `${typeLabel} (${host})`
  return typeLabel
}

function formatDeviceTypeLabel(type: AutoDetectResult['type']): string {
  switch (type) {
    case 'camera':
      return 'Camera (TCP)'
    case 'udp-camera':
      return 'Camera (UDP)'
    case 'battery-cam':
      return 'Battery camera'
    case 'nvr':
      return 'NVR / Hub'
    case 'multifocal':
      return 'Multi-focal camera'
  }
}

/** True when the string looks like a real hardware identifier — not a
 *  placeholder. Reolink firmware sometimes reports `"00000000000000"`
 *  as serialNumber on Home Hub, or all-`F` macs when the network
 *  interface isn't probed yet. Generic guard: ≥6 chars AND ≥2 distinct
 *  non-zero characters (filters out '00000000000000', 'ffffffffffff',
 *  empty strings, single-char strings, …). */
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

/**
 * Patch `detection.deviceInfo` + `hostNetworkInfo` in-place with the
 * post-login HOST identifiers. Two distinct gaps to fill:
 *
 *   1. The lib's TCP autodetect path tries `getInfo` (cmd 80, host) and
 *      `getSupportInfo` (cmd 199, host) on a fresh socket. When these
 *      hit ECONNRESET (frequent on Reolink Home Hub firmwares whose
 *      pre-login Baichuan stack flaps mid-handshake), the lib falls
 *      back to `getInfo cmd 318 ch=0` — which returns the FIRST
 *      sub-channel's info, NOT the host's. Result: `detection.deviceInfo`
 *      ends up with `type: "Argus 3E"` / `serialNumber: <camera serial>`
 *      for a Reolink Home Hub. We MUST re-fetch the host probe
 *      post-login (channel=undefined ⇒ cmd 80) and overwrite to get
 *      the actual host's identity.
 *
 *   2. The lib's TCP autodetect path leaves `hostNetworkInfo` undefined
 *     (the UDP path fetches it but TCP comments are explicit at
 *     `autodetect.ts:723/740/754`). Post-login `getNetworkInfo()`
 *     (cmd 76 + 93, no channel) gives the host's `mac` reliably for
 *     both hubs and cameras.
 *
 * Both calls pass `channel = undefined` — that's the HOST. Passing `0`
 * would target sub-channel zero (a camera attached to the hub), which
 * is exactly the bug that polluted `detection.deviceInfo` upstream.
 *
 * Best-effort: failure on either call leaves whatever autodetect wrote
 * in place. `generateStableId` still throws cleanly when truly nothing
 * usable is on record.
 */
async function enrichHostIdentifiersFromLiveApi(
  detection: AutoDetectResult,
  logger: import('@camstack/types').IScopedLogger,
): Promise<void> {
  const api = detection.api as {
    getInfo?: (
      channel?: number,
      opts?: { timeoutMs?: number },
    ) => Promise<
      | {
          type?: string
          serialNumber?: string
          firmwareVersion?: string
          hardwareVersion?: string
          itemNo?: string
          name?: string
        }
      | undefined
    >
    getNetworkInfo?: (
      channel?: number,
      opts?: { timeoutMs?: number },
    ) => Promise<{ ip?: string; mac?: string; activeLink?: string } | undefined>
  }

  // Post-login HOST getInfo (cmd 80, no channel). ALWAYS overwrite —
  // even if autodetect populated `deviceInfo`, we can't trust it on the
  // TCP path (may be channel-0 fallback data). Post-login on a stable
  // socket the host probe consistently succeeds.
  try {
    const hostInfo = await api.getInfo?.(undefined, { timeoutMs: 4000 })
    if (hostInfo && (hostInfo.type || hostInfo.serialNumber)) {
      const previousType = detection.deviceInfo?.type ?? '(unset)'
      const previousSerial = detection.deviceInfo?.serialNumber ?? '(unset)'
      detection.deviceInfo = { ...detection.deviceInfo, ...hostInfo }
      if (previousType !== hostInfo.type || previousSerial !== hostInfo.serialNumber) {
        logger.info('autodetect: deviceInfo refreshed from post-login host probe (cmd 80)', {
          meta: {
            previousType,
            resolvedType: hostInfo.type ?? '(unset)',
            previousSerial,
            resolvedSerial: hostInfo.serialNumber ?? '(unset)',
          },
        })
      }
    }
  } catch (err) {
    logger.debug('autodetect: post-login host getInfo probe failed', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    })
  }

  // Post-login HOST getNetworkInfo (cmd 76 + 93, no channel). Autodetect's
  // TCP path doesn't fetch this — `hostNetworkInfo` is undefined.
  if (!detection.hostNetworkInfo?.mac) {
    try {
      const net = await api.getNetworkInfo?.(undefined, { timeoutMs: 3000 })
      if (net?.mac || net?.ip) {
        detection.hostNetworkInfo = { ...detection.hostNetworkInfo, ...net }
        logger.info('autodetect: hostNetworkInfo resolved via post-login probe (cmd 76+93)', {
          meta: { ip: net.ip ?? '(unset)', mac: net.mac ?? '(unset)' },
        })
      }
    } catch (err) {
      logger.debug('autodetect: post-login getNetworkInfo probe failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }
}

export class ReolinkProviderAddon extends BaseDeviceProvider {
  /** The email-push SMTP password is hidden state — kept in the keychain (D787). */
  protected override readonly secretStatePaths = ['emailPushAuthPassword']
  protected readonly addonId = REOLINK_ADDON_ID
  protected readonly providerName = 'Reolink'
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Camera]: ReolinkCamera,
  }

  /**
   * Short-lived cache that bridges `testCreationField` and
   * `onCreateDevice` — Slice 15 socket reuse. Both code paths key off
   * `AutodetectCache.keyFor({host, username, password, uid, transport})`
   * so a Test click and the subsequent Save share one Baichuan login.
   */
  private readonly autodetectCache = new AutodetectCache()

  /**
   * Provider-level singleton SMTP intake for battery-cam motion push
   * (`email-push-server.ts`). Lazily constructed in `onInitialize` once
   * the addon context is available; started/stopped with the provider
   * lifecycle and restarted on settings change.
   */
  private hubManager: ReolinkHubManager | null = null
  private emailPushServer: ReolinkEmailPushServer | undefined
  private baichuanWebhookServer: ReolinkBaichuanWebhookServer | undefined

  /** The `log-channels` provider for this process. Stopped on shutdown so a
   *  diagnostic timer is never the reason a runner refuses to exit. */
  private logChannels: LogChannelsProviderHandle | undefined

  constructor() {
    super({})
  }

  /**
   * Reduce this addon's live devices to the identities a network scan can produce, so
   * {@link mapReolinkDiscoveryToCandidates} can recognise a device it already owns.
   */
  private listOnboardedForDiscovery(): readonly OnboardedReolinkDevice[] {
    const all = this.ctx.kernel.deviceRegistry?.getAll() ?? []
    const onboarded: OnboardedReolinkDevice[] = []
    for (const d of all) {
      if (!(d instanceof ReolinkCamera)) continue
      const values = d.config.values
      const host = typeof values.host === 'string' && values.host !== '' ? values.host : undefined
      const uid = typeof values.uid === 'string' && values.uid !== '' ? values.uid : undefined
      if (host === undefined && uid === undefined) continue
      onboarded.push({
        deviceId: d.id,
        name: d.name,
        ...(host !== undefined ? { host } : {}),
        ...(uid !== undefined ? { uid } : {}),
      })
    }
    return onboarded
  }

  /**
   * Enumerate this addon's live `ReolinkCamera` instances from the
   * global device registry. Used by the email-push server to resolve
   * recipients + route inbound motion. Returns `[]` when the registry
   * isn't available (worker context — providers are hub-only here).
   */
  private listReolinkCameras(): readonly ReolinkCamera[] {
    const all = this.ctx.kernel.deviceRegistry?.getAll() ?? []
    const emailServer = this.emailPushServer
    const webhookServer = this.baichuanWebhookServer
    const cameras: ReolinkCamera[] = []
    for (const d of all) {
      if (d instanceof ReolinkCamera) {
        // Idempotently wire the per-camera Auto-configure resolvers to the
        // servers' manager-params builders. Done here (rather than at
        // create/restore) so every enumeration self-heals — the camera
        // never needs a direct provider reference.
        if (emailServer) {
          d.setEmailPushParamsResolver(() => emailServer.buildCameraSetupParams(d))
        }
        if (webhookServer) {
          d.setBaichuanWebhookParamsResolver(() => webhookServer.buildCameraSetupParams(d))
        }
        cameras.push(d)
      }
    }
    return cameras
  }

  /**
   * Bootstrapped SMTP AUTH credentials — Zod-validated durable handles
   * over the SAME two store keys the raw writer used. Built lazily
   * (needs `this.ctx`) and memoised.
   */
  private _emailPushAuthUsernameState: DurableState<string> | null = null
  private _emailPushAuthPasswordState: DurableState<string> | null = null

  private get emailPushAuthUsernameState(): DurableState<string> {
    if (!this._emailPushAuthUsernameState) {
      this._emailPushAuthUsernameState = this.state<string>('emailPushAuthUsername', z.string(), '')
    }
    return this._emailPushAuthUsernameState
  }

  private get emailPushAuthPasswordState(): DurableState<string> {
    if (!this._emailPushAuthPasswordState) {
      this._emailPushAuthPasswordState = this.state<string>('emailPushAuthPassword', z.string(), '')
    }
    return this._emailPushAuthPasswordState
  }

  /** Lazily build the email-push server, wiring its provider deps. */
  private ensureEmailPushServer(): ReolinkEmailPushServer {
    if (!this.emailPushServer) {
      this.emailPushServer = new ReolinkEmailPushServer({
        logger: this.ctx.logger.child('email-push'),
        listCameras: () => this.listReolinkCameras(),
        // The raw store holds the password's keychain MARKER; the durable
        // handle resolves it (D787).
        readStore: () =>
          readEmailPushStore({
            readRaw: () => this.resolveGlobalStore(),
            readPassword: () => this.emailPushAuthPasswordState.get(),
          }),
        // The server writes ONLY the bootstrapped AUTH credential keys
        // (see `resolveSettings`) — route each through its durable handle
        // so no raw store write leaves the addon.
        writeStore: async (patch) => {
          const username = patch['emailPushAuthUsername']
          if (typeof username === 'string') {
            await this.emailPushAuthUsernameState.set(username)
          }
          const password = patch['emailPushAuthPassword']
          if (typeof password === 'string') {
            await this.emailPushAuthPasswordState.set(password)
          }
        },
      })
    }
    return this.emailPushServer
  }

  /** Lazily build the HaCfg webhook intake, wiring its provider deps. */
  private ensureBaichuanWebhookServer(): ReolinkBaichuanWebhookServer {
    if (!this.baichuanWebhookServer) {
      this.baichuanWebhookServer = new ReolinkBaichuanWebhookServer({
        logger: this.ctx.logger.child('baichuan-webhook'),
        listCameras: () => this.listReolinkCameras(),
        readStore: async () => await this.resolveGlobalStore(),
      })
    }
    return this.baichuanWebhookServer
  }

  /**
   * Reolink stableId derivation — uniform `mac → host(IP)` chain for
   * every device type (camera, NVR, Home Hub).
   *
   * Priority:
   *   1. mac  — hardware MAC from post-login `getNetworkInfo` (cmd 76+93,
   *             no channel → host's interface). Durable across firmware
   *             updates + DHCP renewals. Persisted in `deviceCache.mac`
   *             by `onCreateDevice` AFTER `enrichHostIdentifiersFromLiveApi`.
   *   2. host — operator-typed IP/hostname (DHCP-reservable). Always
   *             present on Reolink adds (`onCreateDevice` validates
   *             `persistHost` is non-empty before this code path).
   *
   * The legacy uid / serialNumber / autodetect deviceInfo data are NOT
   * used for the stable key — they're often unreliable on the lib's
   * TCP path (e.g. Home Hub returns `serialNumber: "00000000000000"`
   * sentinel + the lib substitutes channel-0 data into `deviceInfo`
   * when host probes flap mid-handshake). The mac/host chain is uniform
   * and works on every Reolink device the lib supports.
   *
   * Re-adopt safety: re-adding the same physical device with its mac
   * resolved reuses the same row. If the mac wasn't resolved (rare —
   * `getNetworkInfo` works on every Reolink firmware we've tested),
   * the host fallback at least gives a stable row per IP — operator
   * can DHCP-reserve to make this durable.
   */
  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const cfg = config ?? {}
    const cache = (cfg['deviceCache'] as Record<string, unknown> | undefined) ?? {}
    const macRaw = typeof cache['mac'] === 'string' ? cache['mac'].trim() : ''
    const mac = macRaw.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
    // No addon-id prefix — the deviceMeta row key already namespaces by
    // addon (`<addonId>:<stableId>`), so prepending the addon id inside
    // the stable id duplicates it.
    if (isMeaningfulIdentifier(mac)) return `mac-${mac}`
    const host = typeof cfg['host'] === 'string' ? cfg['host'].trim() : ''
    if (host.length > 0) {
      // Sanitize host (replace dots/colons with dashes) so the row key
      // stays a flat slug — keeps DB inspection + log scans readable.
      const slug = slugifyReolinkHost(host)
      if (slug.length > 0) return `host-${slug}`
    }
    // Both mac and host missing — happens only when upstream validation
    // skipped (shouldn't reach here in normal flows). Emit alert so the
    // operator sees the failure mode + throw to refuse the row.
    const hostLabel = host || '(unknown host)'
    const reason = `Reolink autodetect on ${hostLabel} resolved neither mac nor host address — cannot persist a stable row key. Verify network reachability + credentials, then retry.`
    try {
      const now = Date.now()
      void this.ctx.api?.alerts?.emit?.mutate?.({
        id: `reolink-no-stableid-${now}`,
        category: 'addon.error',
        severity: 'error',
        title: `Reolink: missing identifier on ${hostLabel}`,
        message: reason,
        status: 'active',
        read: false,
        createdAt: now,
        updatedAt: now,
        source: { type: 'addon', id: this.addonId },
        metadata: { host: hostLabel },
      })
    } catch {
      /* alerts cap optional — never block the throw */
    }
    throw new Error(`Reolink: ${reason}`)
  }

  protected override async onShutdown(): Promise<void> {
    if (this.clipRefreshTimer) {
      clearInterval(this.clipRefreshTimer)
      this.clipRefreshTimer = null
    }
    this.logChannels?.stop()
    // The clip stream dial listener (D597) is a loopback port this runner
    // owns; a respawn must not leave it bound.
    await this.clipService?.disposeClipStreamDial().catch(() => {
      /* best-effort */
    })
    // Stop the SMTP intake first — its bus subscription routes into
    // camera instances that may be torn down on shutdown. We do NOT call
    // `super.onShutdown()`: the Reolink provider intentionally keeps its
    // device decommission flow lightweight (autodetect-cache dispose
    // only), matching the pre-existing override.
    await this.emailPushServer?.stop().catch(() => {
      /* best-effort */
    })
    await this.baichuanWebhookServer?.stop().catch(() => {
      /* best-effort */
    })
    await this.hubManager?.shutdown().catch((err: unknown) => {
      this.ctx.logger.warn('Reolink NVR sessions did not close cleanly', {
        meta: { error: errMsg(err) },
      })
    })
    this.hubManager = null
    reolinkHubSessions.clear()
    await this.autodetectCache.dispose()
  }

  // ── NVR / Home Hub integrations (D985) ───────────────────────────────

  /**
   * Make the hub sessions match the live integration list: one per enabled integration with a
   * host. Idempotent; runs at boot, after a migration and on every lifecycle event. When any
   * integration's settings cannot be read the whole pass is skipped — an unreadable list must
   * never close a healthy session.
   */
  private async reconcileIntegrations(): Promise<void> {
    const manager = this.hubManager
    if (manager === null) return
    try {
      const all = await this.ctx.api.integrations.list.query()
      const mine = all.filter((i) => i.addonId === this.ctx.id && i.enabled)
      const withSettings: {
        id: string
        name: string
        settings: Record<string, unknown>
      }[] = []
      for (const integration of mine) {
        const settings = await this.ctx.api.integrations.getSettings.query({
          id: integration.id,
        })
        withSettings.push({
          id: integration.id,
          name: integration.name,
          settings,
        })
      }
      await manager.reconcile(withSettings)
    } catch (err) {
      this.ctx.logger.warn('Reolink integration reconcile failed — sessions left as they were', {
        meta: { error: errMsg(err) },
      })
    }
  }

  private subscribeIntegrationLifecycle(): void {
    const handler = (event: SystemEvent): void => {
      const addonId = event.data['addonId']
      if (typeof addonId === 'string' && addonId !== this.ctx.id) return
      void this.reconcileIntegrations()
    }
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationEnabled }, handler)
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationDisabled }, handler)
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationDeleted }, handler)
  }

  private buildAdoptionProvider(): IDeviceAdoptionProvider {
    return buildReolinkAdoptionProvider({
      getSession: (integrationId) => this.hubManager?.get(integrationId) ?? null,
      listIntegrations: () => this.hubManager?.list() ?? [],
      listAdopted: async () => {
        const reg = this.ctx.kernel.deviceRegistry
        if (!reg) return []
        const out: { id: number; config: Record<string, unknown> }[] = []
        for (const d of reg.getAllForAddon(this.addonId)) {
          if (d instanceof ReolinkCamera) out.push({ id: d.id, config: { ...d.config.values } })
        }
        return out
      },
      adoptCamera: async ({ integrationId, channel, connection, name }) => {
        const devices = this.ctx.kernel.devices
        if (!devices) throw new Error('reolink adopt: kernel.devices unavailable')
        const config = {
          host: connection.host,
          port: connection.port,
          username: connection.username,
          transport: connection.transport,
          ...(channel.uid ? { uid: channel.uid } : {}),
          channel: channel.channel,
          integrationId,
          deviceCache: {
            deviceType: 'camera' as const,
            channelCount: 1,
            ...(channel.model ? { model: channel.model } : {}),
            hasBattery: channel.isBattery,
            hasDoorbell: channel.isDoorbell,
            // NOT `probedAt`: the discovery snapshot has no hasPtz / hasIntercom / ...; setting
            // it would stop `ensureFeaturesProbed()` from running the live probe.
          },
        }
        const stableId = `${integrationId}-${channel.childNativeId}`
        const device = await devices.create(stableId, ReolinkCamera, config, null, {
          type: DeviceType.Camera,
          name,
          integrationId,
        })
        const children = await devices.getChildren(device.id)
        return {
          deviceId: device.id,
          accessoryDeviceIds: children.map((c) => c.id),
        }
      },
      removeDevice: async (id) => {
        await this.ctx.kernel.devices?.remove(id)
      },
      findDeviceConfig: async (id) => {
        const devices = this.ctx.kernel.devices
        if (!devices) return null
        return devices.loadConfig(id).catch((): null => null)
      },
      logger: this.ctx.logger,
    })
  }

  private buildMigrationPorts(): HubMigrationPorts {
    const devices = this.ctx.kernel.devices
    if (!devices) throw new Error('reolink hub migration: kernel.devices unavailable')
    return {
      addonId: this.ctx.id,
      logger: this.ctx.logger,
      listIntegrations: async () =>
        (await this.ctx.api.integrations.list.query()).map((i) => ({
          id: i.id,
          addonId: i.addonId,
          name: i.name,
          info: i.info,
          ...(i.originStableId !== undefined ? { originStableId: i.originStableId } : {}),
        })),
      createIntegration: async (input) => {
        const created = await this.ctx.api.integrations.create.mutate({
          addonId: input.addonId,
          name: input.name,
          info: { ...input.info },
          originStableId: input.originStableId,
          settings: { ...input.settings },
          secretKeys: [...input.secretKeys],
        })
        return { id: created.id }
      },
      setIntegrationId: async (deviceId, integrationId) => {
        await this.ctx.api.deviceManager.setIntegrationId.mutate({
          deviceId,
          integrationId,
        })
      },
      persistConfig: async (stableId, config) => {
        await devices.persistInitialConfig(stableId, config)
      },
      childIdsOf: async (parentDeviceId) =>
        (await this.ctx.api.deviceManager.getChildren.query({ parentDeviceId })).map((c) => c.id),
      removeDevice: async (deviceId) => {
        await this.ctx.api.deviceManager.remove.mutate({ deviceId })
      },
    }
  }

  /**
   * Boot migration of the old Hub devices into integrations (D985), then the normal restore.
   * Order matters: the integration's session must exist BEFORE its cameras restore (a camera
   * borrows the session's socket), and the Hub device is retired only AFTER every child came back
   * un-parented — removing a parent cascades into its children.
   */
  protected override async onRestoreDevices(
    savedDevices: readonly SavedDevice[],
  ): Promise<DeviceRestoreReport | void> {
    let rows = savedDevices
    let retirements: readonly PendingHubRetirement[] = []
    if (savedDevices.some((row) => row.type === DeviceType.Hub)) {
      const ports = this.buildMigrationPorts()
      const plan = await planHubMigration(savedDevices, ports)
      rows = plan.rows
      retirements = plan.retirements
      if (retirements.length > 0) await this.reconcileIntegrations()
    }
    const report = await super.onRestoreDevices(rows)
    if (retirements.length > 0) await retireMigratedHubs(retirements, this.buildMigrationPorts())
    return report
  }

  /**
   * Settings changed → rebind the SMTP / HaCfg intakes so port/domain/auth
   * edits apply without a full addon restart. Best-effort: a bind failure is
   * logged inside the server and leaves it stopped until the next edit.
   */
  protected override async onConfigChanged(): Promise<void> {
    await this.refreshClipRefreshGlobalStore()
    await this.emailPushServer?.restart().catch((err: unknown) => {
      this.ctx.logger.warn('email-push: restart after settings change failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    })
    await this.baichuanWebhookServer?.restart().catch((err: unknown) => {
      this.ctx.logger.warn('baichuan-webhook: restart after settings change failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    })
  }

  // ── Email-push addon settings ────────────────────────────────────────

  /**
   * The addon's global settings schema.
   *
   * This used to override `getGlobalSettings()` wholesale, on the belief that a
   * dynamic `recommendedHost` could not come from a static schema declaration.
   * It can: `listLanHosts()` is synchronous, so the schema builder runs here
   * and `BaseAddon.getGlobalSettings` does the identical
   * `resolveGlobalStore` + `hydrateSchema` the override did by hand.
   *
   * Declaring the SCHEMA rather than overriding the GETTER is what lets core
   * serve `getIntegrationSettings()` — it selects the declared sections out of
   * this schema, so an addon that hides its schema behind a getter has nothing
   * for core to select from.
   */
  protected override globalSettingsSchema(): ConfigUISchema {
    const recommendedHost = listLanHosts()[0] ?? '127.0.0.1'
    return {
      sections: [
        ...buildEmailPushSettingsSchema(recommendedHost).sections,
        ...buildBaichuanWebhookSettingsSchema(recommendedHost).sections,
        // The clip-catalog refresh DEFAULT. Per-camera overrides live on the
        // device under the same key and resolve through
        // `resolveClipCatalogRefreshMinutes` — reset == unset == this value.
        ...buildClipRefreshSettingsSchema().sections,
      ],
    }
  }

  /**
   * Per-instance form (D985): an NVR / Home Hub integration shows its connection only; the
   * default integration keeps the full schema (`null`). A create wizard has no id yet and is
   * always setting up a NEW instance — the default one already exists — so it gets the hub form.
   */
  protected override async integrationSettingsSchema(
    instance: IntegrationInstanceRef,
  ): Promise<ConfigUISchema | null> {
    if (instance.integrationId === null) return buildHubInstanceSchema()
    try {
      const [integration, settings] = await Promise.all([
        this.ctx.api.integrations.get.query({ id: instance.integrationId }),
        this.ctx.api.integrations.getSettings.query({ id: instance.integrationId }),
      ])
      return isHubIntegration({
        originStableId: integration.originStableId,
        info: integration.info,
        settings,
      })
        ? buildHubInstanceSchema()
        : null
    } catch (err) {
      this.ctx.logger.warn('Reolink integration form: instance lookup failed — full schema shown', {
        meta: { integrationId: instance.integrationId, error: errMsg(err) },
      })
      return null
    }
  }

  /**
   * Email-push + HaCfg webhook sections ARE this integration's configuration —
   * one intake of each kind serving every Reolink camera. See
   * `email-push-schema.ts` / `baichuan-webhook-schema.ts`.
   */
  protected override integrationSettingSections(): readonly string[] {
    return [...EMAIL_PUSH_SECTION_IDS, ...BAICHUAN_WEBHOOK_SECTION_IDS]
  }

  // `updateGlobalSettings` intentionally NOT overridden: the base
  // implementation persists the patch (same bare keys) and invokes
  // `onConfigChanged()` — which rebinds the SMTP intake exactly like the
  // old hand-written override did. There is no integration-specific writer
  // either: integration-level settings are a SUBSET of these, so this one
  // path is the only writer and the store key cannot diverge.

  protected override async onInitialize(): Promise<ProviderRegistration[]> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())

    // Declare this addon's log channels to the cluster. Importing
    // `./log-channels.js` is what runs the declarations; the registration
    // below is what lets the hub ENUMERATE them and push an armed window back
    // into this process's gates. Without the second half a declared channel
    // would be a knob with nothing behind it (D62).
    this.logChannels = createLogChannelsProvider(this.ctx.logger.child('log-channels'))
    regs.push({ capability: logChannelsCapability, provider: this.logChannels })

    // This addon's own talk-back LOSSES, per camera, with their denominator.
    // The rate-mismatch drop shipped with one warn and no counter, so "how
    // much is 102 losing" meant grepping Loki; every `pushTalkAudio` outcome
    // is now noted from the one place that decides it. Read (never drained)
    // through `system.getFailureContributions`.
    regs.push({
      capability: failureContributionCapability,
      provider: { list: () => intercomFailureReport.list() },
    })

    // Native streams are exposed as `pull-rfc4571` — the broker pulls
    // from a loopback TCP server the camera spawns at publish time,
    // and the lib's RFC 4571 server manages its own upstream Baichuan
    // socket lifecycle (idle teardown after ~15s with no clients).
    //
    // On strict on-demand cycles the broker's loopback dial may hit
    // ECONNREFUSED — the lib's TCP listener idle-tore-down between
    // dials. The broker then emits `onRequestStreamSourceRefresh`;
    // we re-run `materializeStreamSocket` for the requested stream
    // (idempotent — `ensureRfc4571Server` self-heals if the cached
    // entry's `server.listening === false`, recreates on a fresh
    // ephemeral port, and re-publishes the new URL via
    // `streamBroker.publishCameraStream`). The broker's
    // `sourceProvider` resolver picks the fresh URL up on the next
    // reconnect tick.
    this.subscribe(
      { category: EventCategory.StreamBrokerOnRequestStreamSourceRefresh },
      (event) => {
        const data = event.data as { deviceId?: number; camStreamId?: string }
        const deviceId = typeof data.deviceId === 'number' ? data.deviceId : null
        if (deviceId === null) return
        void this.refreshDeviceStreams(deviceId, data.camStreamId).catch((err: unknown) => {
          this.ctx.logger.warn('refresh of Reolink stream failed', {
            tags: { deviceId },
            meta: {
              camStreamId: data.camStreamId ?? null,
              error: err instanceof Error ? err.message : String(err),
            },
          })
        })
      },
    )

    // ── External video clips (D549) ──────────────────────────────────────
    //
    // This addon is the DEVICE'S OWNER, so it is the one that can serve its
    // catalog (D224). The cap is a per-device COLLECTION: this provider is
    // one SOURCE of a camera (two on a hub child), listed beside the analytics
    // visits and never substituted for them. A camera that is not a Reolink
    // asks this provider for its sources and gets `[]` — cheap and honest.
    //
    // Registered unconditionally: `videoclips` is `defaultActive` on the
    // analytics side, and this provider gates itself per device rather than
    // per install, so there is no boot-order question to get wrong.
    // The PINNED ffmpeg (D540). This addon's clip mux and stream mux used to
    // spawn a bare `'ffmpeg'` — the HOST's binary — because nothing ever handed
    // them one. A RESOLVER, asked by each pass, so a boot-time miss does not
    // disable clips until a restart; each refusal is named where it happens.
    this.clipService = createClipService({
      dataDir: this.ctx.dataDir,
      logger: this.ctx.logger,
      resolveFfmpeg: memoizePinnedFfmpeg(() => this.ctx.deps.ensureFfmpeg()),
      // The addon→addon byte transport (D613) — how a clip's bytes reach the
      // recorder's export without either side holding the payload.
      ...(this.ctx.peerBytes !== undefined ? { peerBytes: this.ctx.peerBytes } : {}),
      resolveDevice: async (deviceId) => {
        const device = this.ctx.kernel.deviceRegistry?.getById(deviceId)
        return device instanceof ReolinkCamera ? device.getClipDeviceRef() : null
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

    // The periodic catalog refresh (D562). What a tick may DO differs by
    // topology by an order of magnitude — free through a hub, cheap on mains,
    // impossible on a standalone battery camera where a read is a wake — so
    // the scheduler resolves a mode per camera and the battery case is served
    // by `onWakeTransition` instead.
    await this.refreshClipRefreshGlobalStore()
    this.startClipCatalogRefresh(this.clipService)
    // Every camera gets the wake-side refresh wired — the half a timer cannot
    // do. Re-wired on re-registration below, because an addon-only redeploy
    // emits DeviceMetaChanged and not DeviceRegistered.
    this.wireClipCatalogRefreshers()

    // The two data planes. Bytes NEVER travel through a cap call (D9/D18):
    // the cap answers with a URL into these prefixes and the addon serves the
    // bytes itself, with `Range` on the media plane so the player seeks.
    //
    // `authenticated`, not `admin`, and NO TOKEN IN EITHER URL: the hub's
    // `/addon/<id>/<prefix>` proxy takes the session cookie, exactly as the
    // recorder's own playback plane already does (D549 22).
    //
    // Served HERE, in `onInitialize`, because the hub PULLS an addon's data
    // planes during the node-registration handshake — serving later misses
    // the pull and the route never registers (the recorder learned this).
    await this.serveClipPlanes(this.clipService)

    // Battery-cam motion intake: start the provider-level SMTP server
    // (no-op when disabled in settings). Cameras push motion emails here
    // while asleep; the server routes each into the matching camera's
    // `handleSimpleEvent` — the same path as native Baichuan motion.
    // Fire-and-forget so a bind failure never blocks provider init.
    void this.ensureEmailPushServer()
      .start()
      .catch((err: unknown) => {
        this.ctx.logger.warn('email-push: SMTP intake failed to start at init', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })

    void this.ensureBaichuanWebhookServer()
      .start()
      .catch((err: unknown) => {
        this.ctx.logger.warn('baichuan-webhook: HTTP intake failed to start at init', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })

    // Wire the per-camera Auto-configure resolvers (SMTP + HaCfg) into each
    // ReolinkCamera. We must cover EVERY way a camera becomes live in this
    // process, because the device lifecycle differs by what restarted:
    //   - Full hub start: the device-manager emits `DeviceRegistered` (first
    //     registration) once it instantiates the device.
    //   - THIS addon redeployed alone (the common dev case): the hub's
    //     device-manager already knows the device, so its re-registration is a
    //     SUBSEQUENT one and emits `DeviceMetaChanged`, NOT `DeviceRegistered`
    //     (device-manager.addon.ts: "emit DeviceRegistered ONLY on first
    //     registration"). Subscribing only to DeviceRegistered left every
    //     restored battery cam with an unwired resolver → "resolver not wired".
    // Both events carry `{ deviceId, providerId }`; wiring is idempotent
    // (just sets a field), so reacting to both — and to the chatty
    // DeviceMetaChanged — is safe.
    const wireSleepPushResolvers = (event: { data: unknown }, via: string): void => {
      const data = event.data as { deviceId?: number; providerId?: string }
      if (data.providerId !== this.addonId) return
      if (typeof data.deviceId !== 'number') return
      const dev = this.ctx.kernel.deviceRegistry?.getById(data.deviceId)
      if (dev instanceof ReolinkCamera) {
        const emailServer = this.ensureEmailPushServer()
        dev.setEmailPushParamsResolver(() => emailServer.buildCameraSetupParams(dev))
        const webhookServer = this.ensureBaichuanWebhookServer()
        dev.setBaichuanWebhookParamsResolver(() => webhookServer.buildCameraSetupParams(dev))
        // Same fan-out, same reason: a redeploy re-registers and the wake-side
        // clip refresh would otherwise be wired only on a cold hub start.
        this.wireClipCatalogRefreshers()
        // Debug, not info: DeviceMetaChanged re-fires on every meta refresh, so
        // re-wiring (idempotent) happens often — keep it out of the info stream.
        this.ctx.logger.debug('sleep-push: resolvers wired', {
          tags: { deviceId: data.deviceId },
          meta: { via },
        })
      }
    }
    this.subscribe({ category: EventCategory.DeviceRegistered }, (e) =>
      wireSleepPushResolvers(e, 'DeviceRegistered'),
    )
    this.subscribe({ category: EventCategory.DeviceMetaChanged }, (e) =>
      wireSleepPushResolvers(e, 'DeviceMetaChanged'),
    )

    // Belt-and-suspenders: wire any cameras ALREADY in the registry at init
    // (idempotent). On an addon-only redeploy the re-registration events above
    // are the reliable trigger; this catches any that are already live.
    this.listReolinkCameras()

    // NVR / Home Hub integrations (D985): one session per integration, rebuilt from the live
    // integration list at boot and on every lifecycle event, and the adoption surface for the
    // channels behind each.
    this.hubManager = createReolinkHubManager(
      {
        logger: this.ctx.logger,
        onConnectionChange: (integrationId, online) =>
          this.ctx.logger.info(`Reolink NVR socket ${online ? 'up' : 'down'}`, {
            meta: { integrationId },
          }),
      },
      reolinkHubSessions,
    )
    await this.reconcileIntegrations()
    this.subscribeIntegrationLifecycle()
    regs.push({
      capability: deviceAdoptionCapability,
      provider: this.buildAdoptionProvider(),
    })

    return regs
  }

  /** The clip catalog, its thumbnail cache and its two routes (D549). */
  private clipService: ClipService | null = null
  private clipRefreshTimer: NodeJS.Timeout | null = null
  /**
   * The addon store as the refresh timer last saw it.
   *
   * `listTargets` is synchronous on purpose — a tick that awaited a settings
   * read per camera would be a store round-trip per camera per tick — so the
   * global half of the cascade is mirrored here and refreshed at init and on
   * every `onConfigChanged`. An empty mirror resolves to the DEFAULT, never to
   * "off": a settings read that has not happened yet must not switch the timer
   * off for the whole fleet.
   */
  private clipRefreshGlobalStore: Record<string, unknown> = {}

  /**
   * Give every camera the wake-side refresh.
   *
   * Idempotent, and re-run on both device lifecycle events for the reason the
   * email-push resolver documents: an addon-only redeploy re-registers a
   * device the hub already knows, which emits `DeviceMetaChanged` and NOT
   * `DeviceRegistered`, and subscribing to one left every battery camera
   * unwired.
   */
  private wireClipCatalogRefreshers(): void {
    const service = this.clipService
    if (service === null) return
    for (const camera of this.listReolinkCameras()) {
      const deviceId = camera.getClipDeviceRef().deviceId
      camera.setClipCatalogRefresher(async () => {
        await service.refreshCatalog(deviceId)
      })
    }
  }

  /** Re-read the global half of the clip-refresh cascade. */
  private async refreshClipRefreshGlobalStore(): Promise<void> {
    try {
      this.clipRefreshGlobalStore = await this.resolveGlobalStore()
    } catch (err: unknown) {
      this.ctx.logger.warn(
        'videoclips: could not read the clip refresh default — keeping the last',
        {
          meta: { error: err instanceof Error ? err.message : String(err) },
        },
      )
    }
  }

  /**
   * Arm the clip-catalog refresh.
   *
   * The scheduler owns no clock: it is ticked, so its rules are testable from
   * COLD (`clip-refresh.spec.ts` — the discipline D561 cost us). The tick
   * cadence is the FLOOR of what any camera can be configured to, not the
   * interval itself; each camera's own interval is decided inside the tick
   * from the cascade, so changing a setting takes effect without re-arming.
   */
  private startClipCatalogRefresh(service: ClipService): void {
    const scheduler = new ClipCatalogRefreshScheduler({
      now: () => Date.now(),
      listTargets: () => this.clipRefreshTargets(),
      refresh: async (deviceId) => {
        await service.refreshCatalog(deviceId)
      },
      markStale: (deviceId) => {
        service.cache.markStale(deviceId)
      },
      wake: async (deviceId) => {
        const device = this.ctx.kernel.deviceRegistry?.getById(deviceId)
        if (!(device instanceof ReolinkCamera)) {
          throw userError(
            'reolink.clip-device-not-reolink',
            { deviceId: String(deviceId) },
            `clip refresh: device ${String(deviceId)} is not a Reolink camera here`,
          )
        }
        await device.wakeForClipCatalogRefresh()
      },
      // D549-16's prefetch, wired (D577). The scheduler is its home because it
      // is the only thing that already knows, per camera and per tick, WHICH
      // topology this is, that the catalog was really re-read, and whether an
      // operator is holding the host's lane.
      prefetchStills: async (deviceId) => service.prefetchThumbnails(deviceId),
      hostBusy: (hostKey) => service.hostBusy(hostKey),
      logger: this.ctx.logger,
    })
    this.clipRefreshTimer = setInterval(() => {
      void scheduler.tick().catch((err: unknown) => {
        this.ctx.logger.warn('videoclips: the catalog refresh tick failed', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      })
    }, CLIP_CATALOG_REFRESH_MINUTES_MIN * 60_000)
    if (typeof this.clipRefreshTimer.unref === 'function') this.clipRefreshTimer.unref()
  }

  /**
   * Every Reolink CAMERA this process owns, with its cascade resolved.
   *
   * Cameras only — an NVR / Home Hub is an integration, not a device; its catalog IS its
   * children's and is refreshed per child, on its one session. Accessories are not cameras.
   */
  private clipRefreshTargets(): readonly ClipRefreshTarget[] {
    const globalMinutes = this.clipRefreshGlobalStore[CLIP_CATALOG_REFRESH_MINUTES_KEY]
    const out: ClipRefreshTarget[] = []
    for (const device of this.listReolinkCameras()) {
      const ref = device.getClipDeviceRef()
      out.push({
        deviceId: ref.deviceId,
        hostKey: ref.hostKey,
        isHubChild: ref.isHubChild,
        isBattery: ref.isBattery,
        forcedWake: resolveClipCatalogForcedWake(device.getClipCatalogForcedWake()),
        intervalMinutes: resolveClipCatalogRefreshMinutes(
          globalMinutes,
          device.getClipCatalogRefreshMinutes(),
        ),
      })
    }
    return out
  }

  /**
   * Host the thumbnail and media planes, and never let a host without the
   * facility take the addon down with it — a data plane is an enhancement to
   * an addon that already works, so a failure here degrades the clip surface
   * and nothing else. It is logged, because a branch that drops work silently
   * reads as "never happened".
   */
  private async serveClipPlanes(service: ClipService): Promise<void> {
    try {
      const thumb = await this.ctx.dataPlane?.serve({
        prefix: service.thumbPrefix,
        access: 'authenticated',
        handler: service.thumbHandler,
      })
      const media = await this.ctx.dataPlane?.serve({
        prefix: service.mediaPrefix,
        access: 'authenticated',
        handler: service.playbackHandler,
      })
      // The streamed clip, beside the file (stage 1): a plain 200 stream,
      // no Range, nothing written. Provable with curl; no consumer is pointed
      // at it yet.
      const stream = await this.ctx.dataPlane?.serve({
        prefix: service.streamPrefix,
        access: 'authenticated',
        handler: service.streamHandler,
      })
      this.ctx.logger.info('Reolink clip data planes served', {
        meta: {
          // The CLIENT path is the hub's reverse-proxy path, never the
          // internal 127.0.0.1 listener the handle reports.
          thumbPath: `/addon/${REOLINK_ADDON_ID}/${service.thumbPrefix}`,
          mediaPath: `/addon/${REOLINK_ADDON_ID}/${service.mediaPrefix}`,
          streamPath: `/addon/${REOLINK_ADDON_ID}/${service.streamPrefix}`,
          thumbServed: thumb !== undefined,
          mediaServed: media !== undefined,
          streamServed: stream !== undefined,
        },
      })
    } catch (err: unknown) {
      this.ctx.logger.warn('Reolink clip data planes failed to serve — clips will not render', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  /**
   * Compose the provider registrations from `onInitialize()` with this
   * addon's customActions catalog. `BaseDeviceProvider.onInitialize` is
   * typed `ProviderRegistration[]` (eleven sibling providers push onto it),
   * so the catalog joins at the `initialize()` seam instead — the runner
   * consumes the merged `AddonInitResult` exactly as it does for
   * addon-benchmark / addon-notifiers.
   *
   * Admin-only debug surface (D346): `debugRawRead` returns the lib's
   * response for one snapshot slice UNPROJECTED, next to the persisted
   * snapshot + its freshness. Registered as an addon customAction because
   * `addons.custom` is the one operator surface that enforces the
   * per-action `auth: 'admin'` server-side and validates output —
   * `deviceManager.runDeviceAction` does neither. The hub reads the static
   * catalog from this bundle's `customActions` export (see `index.ts`);
   * the child registers the handlers returned here.
   */
  override async initialize(context: AddonContext): Promise<AddonInitResult<ReolinkDebugActions>> {
    const base = await super.initialize(context)
    const providers = base && base.providers ? base.providers : []
    return {
      providers,
      customActions: reolinkDebugActions,
      actionHandlers: {
        debugRawRead: (input) => this.debugRawRead(input),
      },
    }
  }

  /**
   * Route a `debugRawRead` custom action to the owning camera. Covers both
   * standalone cameras and NVR-adopted children — every live ReolinkCamera
   * in this runner is in the kernel device registry. Read-only end to end
   * (see `raw-read.ts`); a hub device or an unknown id refuses with a
   * message that names what it looked for.
   */
  private async debugRawRead(input: RawReadInput): Promise<RawReadResult> {
    const dev = this.ctx.kernel.deviceRegistry?.getById(input.deviceId)
    if (dev === undefined || dev === null) {
      throw new Error(
        `debugRawRead: device ${input.deviceId} not found in the reolink runner's registry`,
      )
    }
    if (!(dev instanceof ReolinkCamera)) {
      throw new Error(
        `debugRawRead: device ${input.deviceId} is not a ReolinkCamera (got ${dev.constructor.name}) — raw reads target cameras, not hubs/accessories`,
      )
    }
    return dev.debugRawRead(input.slice)
  }

  /**
   * Handle a broker-issued source-refresh request. With the lazy-publish
   * model the broker always emits this on first dial of a
   * `lazy:rfc4571:` placeholder URL — and re-emits it whenever the
   * upstream rfc4571 socket idle-tears-down between consumer windows.
   * We respond by materializing ONLY the requested camStream's upstream
   * Baichuan session (`materializeStreamSocket`) — never touching the
   * full stream list. That keeps the firmware-side session count at
   * "one per actively-watched (channel, profile) tuple" and avoids
   * burning sessions on unrelated streams.
   *
   * A refresh request without a `camStreamId` is a no-op: the broker
   * re-pulls the `stream-catalog` cap on its own reconcile cycle and
   * re-issues a per-stream refresh for whichever entry it dials next.
   */
  private async refreshDeviceStreams(
    deviceId: number,
    camStreamId: string | undefined,
  ): Promise<void> {
    const dev = this.ctx.kernel.deviceRegistry?.getById(deviceId)
    if (!dev || !(dev instanceof ReolinkCamera)) return
    if (!camStreamId) {
      this.ctx.logger.debug(
        'broker requested source refresh without a camStreamId — broker will re-pull the catalog',
        {
          tags: { deviceId },
        },
      )
      return
    }
    // The "materializing on demand" log lives INSIDE `materializeStreamSocket`,
    // AFTER its native-kind check: that method early-returns for non-native
    // (rtsp/rtmp) camStreamIds, so logging "materializing" here — before the
    // check — claimed work that never happened (a silent drop that read as a
    // successful refresh in the logs).
    await dev.materializeStreamSocket(camStreamId)
  }

  // ── Discovery: LAN scan via nodelink-js (UDP broadcast + ONVIF + HTTP) ──

  override async supportsDiscovery(): Promise<boolean> {
    return true
  }

  override async getDiscoveryParamsSchema(): Promise<ConfigUISchema | null> {
    return buildDiscoveryParamsFormSchema()
  }

  override async getDiscoveryModes(): Promise<readonly DiscoveryMode[]> {
    return REOLINK_DISCOVERY_MODES
  }

  override async discoverDevices(input?: {
    params?: Record<string, unknown>
  }): Promise<readonly DiscoveryCandidate[]> {
    const p = input?.params ?? {}
    const username = typeof p['username'] === 'string' ? p['username'].trim() : ''
    const password = typeof p['password'] === 'string' ? p['password'] : ''
    const subnets = subnetsFromParams(p)
    const enableOnvif = p['enableOnvif'] !== false // default on
    const timeoutMs = typeof p['timeoutMs'] === 'number' ? p['timeoutMs'] : undefined

    const baseOptions: DiscoveryOptions = {
      logger: buildAutodetectLibLogger(this.ctx.logger),
      enableOnvifDiscovery: enableOnvif,
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
      ...(timeoutMs !== undefined
        ? { udpBroadcastTimeoutMs: timeoutMs, onvifDiscoveryTimeoutMs: timeoutMs }
        : {}),
    }
    const devices = await scanReolinkSubnets({
      subnets,
      scan: (networkCidr) =>
        discoverReolinkDevices(networkCidr ? { ...baseOptions, networkCidr } : baseOptions),
      onError: (cidr, error) =>
        this.ctx.logger.warn('Reolink discovery: a subnet scan failed', {
          meta: {
            subnet: cidr ?? 'local',
            error: error instanceof Error ? error.message : String(error),
          },
        }),
    })
    this.ctx.logger.info('Reolink discovery complete', {
      meta: {
        count: devices.length,
        subnets: subnets.length > 0 ? subnets : ['local'],
        enableOnvif,
      },
    })

    // De-dupe by host + map to adoption candidates (pure — see reolink-discovery-map.ts). Credentials
    // from the scan form thread through so a one-click adopt yields a working camera.
    //
    // Devices this provider already owns are MARKED, not offered: a re-adopt rewrites the config
    // from scan-derived values, and that is how a Home Hub's Baichuan port became its ONVIF port.
    const onboarded = this.listOnboardedForDiscovery()
    const knownHubs = (this.hubManager?.list() ?? []).flatMap((id) => {
      const connection = this.hubManager?.get(id)?.connection
      return connection === undefined
        ? []
        : [
            {
              host: connection.host,
              ...(connection.uid ? { uid: connection.uid } : {}),
            },
          ]
    })
    const candidates = mapReolinkDiscoveryToCandidates(
      devices,
      { username, password },
      onboarded,
      knownHubs,
    )
    const owned = candidates.filter((c) => c.alreadyOnboarded === true).length
    if (owned > 0) {
      this.ctx.logger.info('Reolink discovery: candidates already owned by this provider', {
        meta: { owned, total: candidates.length },
      })
    }
    return candidates
  }

  override async adoptDiscoveredDevice(input: {
    candidate: DiscoveryCandidate
  }): Promise<DeviceSummary> {
    // Reuse the manual-creation path: onCreateDevice runs autodetect against the discovered host
    // (with the scan-form credentials in prefilledConfig) and routes to the right device factory.
    return this.createDevice({
      type: DeviceType.Camera,
      config: input.candidate.prefilledConfig,
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
      throw new Error(`Reolink provider does not support device type: ${type}`)
    }

    const name = getString(config, 'name').trim()
    const inputs = buildAutodetectInputs(config)

    if (!name) throw new Error('Camera name is required')
    if (!inputs.password) throw new Error('Password is required')
    if (!inputs.host && inputs.transport === 'tcp') {
      throw new Error('Camera IP is required for TCP mode')
    }
    if (!inputs.host && !inputs.uid) {
      throw new Error('Either a host or a UID is required')
    }

    // Reuse the autodetect result from a recent Test click when possible —
    // a fresh Baichuan login on every Save adds 1-3s of latency for no
    // benefit. Cache miss falls through to a server-side autodetect.
    const cacheKey = AutodetectCache.keyFor(inputs)
    let detection = this.autodetectCache.take(cacheKey)
    if (!detection) {
      this.ctx.logger.info('autodetect cache miss — running server-side', {
        tags: { host: inputs.host || '(uid-only)' },
        meta: { transport: inputs.transport, hasUid: Boolean(inputs.uid) },
      })
      detection = await autoDetectDeviceType({
        host: inputs.host,
        username: inputs.username,
        password: inputs.password,
        ...(inputs.uid ? { uid: inputs.uid } : {}),
        mode: inputs.transport,
      })
    } else {
      this.ctx.logger.info('autodetect cache hit — reusing api', {
        tags: { host: inputs.host || '(uid-only)' },
        meta: { type: detection.type, transport: detection.transport },
      })
    }

    // Surface the autodetect result so operators can diagnose why a
    // multi-channel device is being created as a single Camera (or
    // vice-versa). Critical when the autodetect runs on the Save
    // path with no probe logger wired — without this line there's
    // no record of what `detection.type` resolved to.
    this.ctx.logger.info('autodetect resolved', {
      tags: { host: inputs.host || '(uid-only)' },
      meta: {
        type: detection.type,
        transport: detection.transport,
        channelNum: detection.channelNum ?? null,
        model: detection.deviceInfo?.type ?? null,
        hasUid: Boolean(detection.uid),
      },
    })

    if (detection.type === 'multifocal') {
      try {
        await detection.api.close({ reason: 'unsupported-type' })
      } catch {
        /* ignore */
      }
      throw new Error(
        'Multi-focal cameras (autotrack / dual-lens) are not yet supported. The current build creates one device per camera; multi-focal needs per-lens device split (planned for a later slice).',
      )
    }

    await this.applyNvrCgiSanityCheck(detection, inputs.host || '(uid-only)')

    // ── Host identifier enrichment ─────────────────────────────────────
    // The lib's TCP autodetect can mis-attribute channel-0 data to the
    // host (when host cmd 80 + cmd 199 hit ECONNRESET on Reolink Home
    // Hub firmwares, the lib falls back to cmd 318 ch=0). It also
    // doesn't populate `hostNetworkInfo` on the TCP path. Re-probe the
    // HOST (channel=undefined ⇒ cmd 80, getNetworkInfo) post-login on
    // the stable socket so generateStableId reads the actual host's
    // identifiers, not a sub-channel's. See the function docblock for
    // the complete failure-mode breakdown.
    await enrichHostIdentifiersFromLiveApi(detection, this.ctx.logger)

    const transport: 'tcp' | 'udp' = detection.transport
    const detectedUid = detection.uid && detection.uid.length > 0 ? detection.uid : inputs.uid
    const channelCount =
      detection.type === 'nvr' && typeof detection.channelNum === 'number'
        ? Math.max(1, detection.channelNum)
        : 1

    const persistHost = (inputs.host || detection.hostNetworkInfo?.ip || '').trim()
    if (!persistHost) {
      try {
        await detection.api.close({ reason: 'no-host-resolvable' })
      } catch {
        /* ignore */
      }
      throw new Error('autodetect resolved the device but did not return a host address')
    }

    // An NVR / Home Hub is its own integration (D985), never a camera. Refuse by name instead
    // of creating one camera locked on channel 0 and hiding the other channels.
    if (detection.type === 'nvr') {
      try {
        await detection.api.close({ reason: 'nvr-needs-an-integration' })
      } catch {
        /* ignore */
      }
      throw userError(
        'reolink.nvr-needs-integration',
        undefined,
        'This is an NVR / Home Hub. Add it as its own Reolink integration; its channels are then adopted as cameras.',
      )
    }

    const parsed = reolinkCameraSchema.parse({
      host: persistHost,
      port: inputs.port,
      username: inputs.username,
      password: inputs.password,
      transport,
      ...(detectedUid ? { uid: detectedUid } : {}),
      ...(detection.udpDiscoveryMethod ? { udpDiscoveryMethod: detection.udpDiscoveryMethod } : {}),
      deviceCache: {
        deviceType: detection.type,
        channelCount,
        hasBattery: detection.hasBattery === true,
        ...(detection.deviceInfo?.type ? { model: detection.deviceInfo.type } : {}),
        ...(detection.deviceInfo?.serialNumber
          ? { serialNumber: detection.deviceInfo.serialNumber }
          : {}),
        ...(detection.deviceInfo?.firmwareVersion
          ? { firmwareVersion: detection.deviceInfo.firmwareVersion }
          : {}),
        ...(detection.deviceInfo?.hardwareVersion
          ? { hardwareVersion: detection.deviceInfo.hardwareVersion }
          : {}),
        ...(detection.hostNetworkInfo?.mac ? { mac: detection.hostNetworkInfo.mac } : {}),
        // NOTE: do NOT set `probedAt` here. `probedAt` is the gate
        // `ensureFeaturesProbed()` uses to decide whether the
        // post-login features probe has actually completed. Setting
        // it from the autodetect cache (which only knows the static
        // `deviceType` / `channelCount` and never resolves
        // `hasPtz` / `hasIntercom` / etc) locks out hub-children
        // forever — their `ensureApi()` short-circuits to the
        // parent's socket so the per-login probe path never fires,
        // and the NVR adopt flow's `ensureFeaturesProbed()` then
        // early-returns. Only `probeAndPersistFeatures` should
        // write `probedAt`, and only on a successful probe.
      },
    })

    // Capture the autodetect API + ctx in closure so the
    // `onAfterCreate` hook (fired by BaseDeviceProvider after the
    // device is fully registered + accessories spawned) can adopt
    // the live socket and seed the orchestrator. The stream catalog
    // is no longer pushed — the broker PULLS the camera's
    // `stream-catalog` cap (see `ReolinkCamera.onCreated()`).
    const detectedApi = detection.api
    const ctx = this.ctx

    return {
      meta: { type: DeviceType.Camera, name },
      config: parsed,
      onAfterCreate: async (device: IDevice) => {
        if (device instanceof ReolinkCamera) {
          device.adoptApi(detectedApi)
          // Wire sleep-push Auto-configure resolvers (idempotent; also
          // self-heals via `listReolinkCameras`).
          const emailServer = this.ensureEmailPushServer()
          device.setEmailPushParamsResolver(() => emailServer.buildCameraSetupParams(device))
          const webhookServer = this.ensureBaichuanWebhookServer()
          device.setBaichuanWebhookParamsResolver(() =>
            webhookServer.buildCameraSetupParams(device),
          )
        }
        // Seed the orchestrator's per-device settings with
        // `motionSources: ['onboard']`. Best-effort.
        void ctx.api?.pipelineOrchestrator?.applyDeviceSettingsPatch
          ?.mutate({
            deviceId: device.id,
            patch: { motionSources: ['onboard'] },
          })
          .catch((err: unknown) => {
            ctx.logger.debug('applyDeviceSettingsPatch motionSources seed failed', {
              tags: { deviceId: device.id },
              meta: { error: err instanceof Error ? err.message : String(err) },
            })
          })
      },
    }
  }

  // ── NVR / Hub CGI sanity check ───────────────────────────────────────
  //
  // Lib-side autodetect reads `support.channelNum` from
  // `getSupportInfo` (Baichuan cmd 199). On Reolink Home Hub firmwares
  // — and on any device whose Baichuan socket flaps mid-probe (the
  // ECONNRESET storm we sometimes see during `getSupportInfo` /
  // `getInfo cmd80`) — the lib falls back to channelNum=1 and
  // classifies as a "regular camera". The CGI `GetChannelstatus` is
  // the authoritative channel count and survives socket flap because
  // it's HTTP, not Baichuan. When the lib classified as
  // `camera` / `battery-cam` but CGI reports >1 channel, override
  // to NVR so it is refused (an NVR is an integration, D985) instead
  // of being created as a single-stream camera locked on channel 0.
  //
  // Used by both `onCreateDevice` (Save path) AND `testCreationField`
  // (Test button) so the modal preview matches the Save outcome.
  private async applyNvrCgiSanityCheck(
    detection: AutoDetectResult,
    hostLabel: string,
  ): Promise<void> {
    if (detection.type !== 'camera' && detection.type !== 'battery-cam') return
    try {
      const summary = await detection.api.getNvrChannelsSummary({ source: 'cgi', timeoutMs: 4000 })
      if (summary.channels.length > 1) {
        this.ctx.logger.info('autodetect: CGI override → NVR (multi-channel)', {
          tags: { host: hostLabel },
          meta: {
            libType: detection.type,
            libChannelNum: detection.channelNum ?? null,
            cgiChannels: summary.channels,
            cgiDeviceCount: summary.devices.length,
          },
        })
        ;(detection as { type: string; channelNum?: number }).type = 'nvr'
        ;(detection as { type: string; channelNum?: number }).channelNum = summary.channels.length
      }
    } catch (err) {
      this.ctx.logger.debug('autodetect CGI sanity-check failed (keeping lib type)', {
        tags: { host: hostLabel },
        meta: { libType: detection.type, error: err instanceof Error ? err.message : String(err) },
      })
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

    const form = input.formValues ?? { host: typeof input.value === 'string' ? input.value : '' }
    const inputs = buildAutodetectInputs(form)

    if (!inputs.password) {
      return { status: 'error', error: 'Enter a password before running the test' }
    }
    if (!inputs.host && !inputs.uid) {
      return { status: 'error', error: 'Provide a host or a UID before running the test' }
    }

    // The Add-Device modal generates a `_probeRequestId` per dialog
    // open and tucks it into formValues for every test call. We pass
    // it through to a child logger so the lib's diagnostic lines
    // (Baichuan socket connect, login, profile probe) flow into the
    // log stream the modal is subscribed to. Operators see live socket
    // logs as the test runs instead of staring at a spinner.
    const probeRequestId =
      typeof form['_probeRequestId'] === 'string' ? (form['_probeRequestId'] as string) : undefined

    const probeLogger = probeRequestId
      ? this.ctx.logger.child('autodetect').withTags({ requestId: probeRequestId })
      : this.ctx.logger.child('autodetect')

    try {
      const result = await autoDetectDeviceType({
        host: inputs.host,
        username: inputs.username,
        password: inputs.password,
        ...(inputs.uid ? { uid: inputs.uid } : {}),
        mode: inputs.transport,
        logger: buildAutodetectLibLogger(probeLogger),
      })
      // Mirror onCreateDevice's CGI sanity check so the operator
      // sees the same classification in the modal preview as they'd
      // get on Save. Without this, `getSupportInfo` flakiness
      // (ECONNRESET mid-probe on some hub firmwares) shows the
      // device as a regular camera even when CGI clearly reports
      // multi-channel.
      await this.applyNvrCgiSanityCheck(result, inputs.host || '(uid-only)')
      const cacheKey = AutodetectCache.keyFor(inputs)
      this.autodetectCache.set(cacheKey, result)
      // Suggest a human-readable name from the probe (model > device-type
      // label > host). The dialog merges this only when the operator hasn't
      // typed a name themselves — never overwrites.
      const suggestedName = buildAutodetectSuggestedName(result, inputs.host)
      return {
        status: 'ok',
        labels: buildAutodetectLabels(result),
        ...(suggestedName ? { suggestedValues: { name: suggestedName } } : {}),
      }
    } catch (err) {
      return {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  // ── Restore ──────────────────────────────────────────────────────────
  //
  // Default `BaseDeviceProvider.onRestoreDevices` impl:
  //   1. Iterates `savedDevices`, skips children (parentDeviceId !==
  //      null) — those are spawned by their parent's
  //      `getAccessoryChildren()` after the parent's `register`.
  //   2. For each parent, looks up the class in `deviceClasses`
  //      (`{Camera: ReolinkCamera}`) and calls `kernel.devices.create`.
  //   3. Inside `create` → `register` → `device.onCreated()` →
  //      `device.getAccessoryChildren()` → kernel auto-spawns each
  //      accessory child.
  //
  // The accessory factory closure (`new SirenAccessory(ctx, this)`)
  // lives in `ReolinkCamera.getAccessoryChildren()`, which captures
  // the parent reference for the child's `(ctx, parent)` constructor.
  // Provider has zero accessory boilerplate.
}

/**
 * The action catalog under the name the HUB HARVESTS.
 *
 * `loadForkedCustomActionCatalog` imports the module named by the manifest
 * `entry` — this file — and reads the `customActions` NAMED export. Returning
 * the catalog from `initialize` is NOT enough, and neither is exporting it from
 * `index.ts`: the hub never imports that module. Without this line
 * `addons.custom` answers *"no addon 'provider-reolink' registers custom
 * actions"*, which is exactly what it did from D346 until 2026-09-05 — the
 * debug raw-read surface shipped and was unreachable for its whole life.
 */
export { reolinkDebugActions as customActions } from './debug-actions.js'
