import {
  type BatteryInfoResponse,
  ReolinkBaichuanApi,
  type ReolinkBaichuanDeviceSummary,
  type ReolinkEvent,
  type ReolinkSimpleEvent,
} from '@apocaliss92/nodelink-js'
import {
  type DiscoveredChildDevice,
  type DiscoveredChildStatus,
  DeviceType,
  errMsg,
  type IScopedLogger,
  userError,
} from '@camstack/types'
import { type ReolinkHubConnection, sameHubConnection } from './hub-connection.js'
import { mapHubBatteryPower, UnmappedCodeLedger } from './hub-battery-fields.js'
import { planChannelReconciliation } from './hub-channel-reconcile.js'
import { createMotionSensorTracker, type ReolinkMotionSensor } from './motion-sensor-source.js'
import { shouldTraceSimpleEventDispatch } from './simple-event-dispatch-trace.js'

const HUB_DISCOVERY_REFRESH_TIMEOUT_MS = 8000
/**
 * How often the session re-reads its own channels summary to reconcile the adopted children's
 * sleep slices. 60 s: a naturally-waking camera (PIR, schedule) is caught within a minute, and
 * the play path has its own faster confirm + post-dial watch, so this only ever carries
 * background drift. Never wakes a child — the summary is answered by the hub itself.
 */
export const HUB_CHILD_SLEEP_RECONCILE_MS = 60_000
export const HUB_RECONNECT_BASE_MS = 2000
export const HUB_RECONNECT_MAX_MS = 30_000
/**
 * Threshold for marking an adopted child offline when missing from consecutive refreshes.
 * 10 minutes covers ~3 default refresh cycles + transient firmware latency without
 * false-flagging battery cams that take a few cycles to wake into the list.
 */
export const HUB_MISSING_OFFLINE_MS = 10 * 60_000
const UNROUTED_LOG_THROTTLE_MS = 60_000

/** The slice of the Baichuan client a session subscribes to. */
interface HubClientPort {
  isSocketConnected(): boolean
  readonly loggedIn: boolean
  on(event: string, listener: (...args: never[]) => void): unknown
  off(event: string, listener: (...args: never[]) => void): unknown
  prependListener(event: string, listener: (...args: never[]) => void): unknown
}

/**
 * The slice of the Baichuan API a session drives. A real `ReolinkBaichuanApi` satisfies it
 * structurally; a spec supplies a fake without a cast.
 */
export interface HubApiPort {
  login: ReolinkBaichuanApi['login']
  close: ReolinkBaichuanApi['close']
  getNvrChannelsSummary(options?: {
    channels?: number[]
    timeoutMs?: number
    source?: 'cgi' | 'baichuan'
  }): Promise<{ readonly devices: readonly ReolinkBaichuanDeviceSummary[] }>
  getAllChannelsBatteryInfo(): Promise<{
    readonly batteryInfoData: Readonly<Record<number, BatteryInfoResponse>>
  }>
  onSimpleEvent: ReolinkBaichuanApi['onSimpleEvent']
  offSimpleEvent: ReolinkBaichuanApi['offSimpleEvent']
  readonly client: HubClientPort
}

/** Battery fields the hub reads for a child, already in the vocabulary of `mapBatteryInfo`. */
export interface HubBatteryInfo {
  readonly batteryPercent?: number
  readonly chargeStatus?: string
  readonly adapterStatus?: string
}

/**
 * One adopted camera, as a session sees it. The camera attaches itself to the session registry
 * on activation and detaches when removed, so the channel → device map is a FACT the camera
 * states, never a registry scan that can answer "empty" while the addon is still restoring
 * (D49, D173). The session never imports the camera class (no import cycle).
 */
export interface HubChildHandle {
  readonly id: number
  readonly stableId: string
  readonly name: string
  readonly type: DeviceType
  /** The persisted channel — `undefined` when the blob lost it (repaired from the hub). */
  readonly channel: number | undefined
  readonly online: boolean
  readonly debugGeneral: boolean
  readonly debugSocketFlags: readonly string[]
  markOnline(online: boolean): void
  repairChannel(channel: number): Promise<void>
  handleSimpleEvent(event: ReolinkSimpleEvent, motionSensor: ReolinkMotionSensor | null): void
  applyHubSleepState(sleeping: boolean): void
  applyHubBatteryInfo(info: HubBatteryInfo): void
}

/** What a child needs to dial the hub's RTSP relay without contacting the camera. */
export interface HubRelayEndpoint {
  readonly host: string
  readonly username: string
  readonly password: string
  readonly port: number
}

export interface ReolinkHubSessionDeps<TApi extends HubApiPort> {
  readonly integrationId: string
  readonly name: string
  readonly logger: IScopedLogger
  readonly connection: ReolinkHubConnection
  /** Dial + log in. The default builds a real `ReolinkBaichuanApi`. */
  readonly connect: (connection: ReolinkHubConnection) => Promise<TApi>
  /** The adopted children of THIS integration, live. */
  readonly children: () => readonly HubChildHandle[]
  /** The hub socket came up / went down. */
  readonly onConnectionChange?: (online: boolean) => void
  readonly now?: () => number
}

/**
 * What one session publishes for the adoption surface: the last channel list the hub reported,
 * and the error of the refresh that produced it.
 */
export interface HubChannelSnapshot {
  readonly channels: readonly HubChannel[]
  readonly lastRefreshAt: number | null
  readonly lastError: string | null
}

/** One channel the hub lists — the unit an operator adopts. */
export interface HubChannel {
  readonly childNativeId: string
  readonly channel: number
  readonly name: string
  readonly status: DiscoveredChildStatus
  readonly uid?: string
  readonly model?: string
  readonly serialNumber?: string
  readonly isBattery: boolean
  readonly isDoorbell: boolean
  readonly isMultifocal: boolean
}

/**
 * ONE Reolink NVR / Home Hub: a single Baichuan control + event socket fronting N channels,
 * owned per integration (D985). It was the `ReolinkHub` device; the device is gone, the
 * mechanism is unchanged:
 *
 *  - one persistent socket (no per-channel login), reconnected with a bounded backoff;
 *  - every `simpleEvent` from any channel is dispatched into the matching child;
 *  - every 60 s the hub's own channels summary reconciles the children's sleep, online and
 *    battery slices — read from the hub's mains-powered socket, never from a battery camera.
 */
export class ReolinkHubSession<TApi extends HubApiPort = ReolinkBaichuanApi> {
  readonly integrationId: string
  readonly #deps: ReolinkHubSessionDeps<TApi>
  readonly #logger: IScopedLogger
  readonly #now: () => number
  #connection: ReolinkHubConnection

  #api: TApi | null = null
  #connectInFlight: Promise<TApi> | null = null
  #reconnectAttempts = 0
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null
  #reconcileTimer: ReturnType<typeof setInterval> | null = null
  #shutdown = false
  #online = false

  #snapshot: HubChannelSnapshot = {
    channels: [],
    lastRefreshAt: null,
    lastError: null,
  }
  #refreshInFlight: Promise<void> | null = null
  /** Wall-clock ms of the last refresh that listed each child (by device id). */
  readonly #childLastSeenAt = new Map<number, number>()
  /** Channels the last good refresh listed but nobody adopted: their pushes are expected drops. */
  readonly #knownUnadoptedChannels = new Set<number>()
  readonly #unroutedLoggedAt = new Map<number, number>()
  #batteryShapeLogged = false
  readonly #unmappedBatteryCodes = new UnmappedCodeLedger()

  readonly #motionSensors = createMotionSensorTracker()
  readonly #simpleEventBound = (event: ReolinkSimpleEvent): void => {
    this.routeSimpleEvent(event)
  }
  readonly #rawEventBound = (event: ReolinkEvent): void => {
    this.#motionSensors.observe(event)
  }

  constructor(deps: ReolinkHubSessionDeps<TApi>) {
    this.integrationId = deps.integrationId
    this.#deps = deps
    this.#logger = deps.logger
    this.#connection = deps.connection
    this.#now = deps.now ?? Date.now
  }

  get connection(): ReolinkHubConnection {
    return this.#connection
  }

  get isOnline(): boolean {
    return this.#online
  }

  /** The last channel list, for the adoption surface. */
  channelSnapshot(): HubChannelSnapshot {
    return this.#snapshot
  }

  /**
   * What a child dials for the hub's RTSP relay. The port is the connection's, else 554 —
   * carried over verbatim from the hub device; it is one of the things to check live.
   */
  relayEndpoint(): HubRelayEndpoint {
    const c = this.#connection
    return {
      host: c.host,
      username: c.username,
      password: c.password,
      port: c.port > 0 ? c.port : 554,
    }
  }

  /** Arm the periodic reconcile and make the first dial. Idempotent. */
  start(): void {
    if (this.#reconcileTimer === null) {
      this.#reconcileTimer = setInterval(() => {
        void this.refresh().catch(() => {
          /* best-effort — the next tick retries */
        })
      }, HUB_CHILD_SLEEP_RECONCILE_MS)
      if (typeof this.#reconcileTimer.unref === 'function') this.#reconcileTimer.unref()
    }
    void this.getApi().catch((err: unknown) => {
      this.#logger.warn('Reolink hub initial connect failed — will retry', {
        tags: { integrationId: this.integrationId },
        meta: { error: errMsg(err) },
      })
    })
  }

  /**
   * Apply a new connection. A session already dialled the same way keeps its socket; any real
   * change tears the socket down and re-dials with the new credentials.
   */
  async reconfigure(connection: ReolinkHubConnection): Promise<void> {
    if (sameHubConnection(this.#connection, connection)) {
      this.#connection = connection
      return
    }
    this.#connection = connection
    await this.dropApi('settings-changed')
    this.#setOnline(false)
    void this.getApi().catch((err: unknown) => {
      this.#logger.warn('Reolink hub re-dial after settings change failed', {
        tags: { integrationId: this.integrationId },
        meta: { error: errMsg(err) },
      })
    })
  }

  async close(): Promise<void> {
    this.#shutdown = true
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
    if (this.#reconcileTimer !== null) {
      clearInterval(this.#reconcileTimer)
      this.#reconcileTimer = null
    }
    await this.dropApi('hub-shutdown')
  }

  /**
   * The logged-in api (single round-trip on first call). Mid-disconnect, callers wait for the
   * reconnect that is already in flight.
   */
  async getApi(): Promise<TApi> {
    const live = this.#api
    if (live !== null && live.client.isSocketConnected() && live.client.loggedIn) return live
    if (this.#connectInFlight !== null) return this.#connectInFlight
    this.#connectInFlight = this.#connect().finally(() => {
      this.#connectInFlight = null
    })
    return this.#connectInFlight
  }

  // ── connect / reconnect ──────────────────────────────────────────────

  private async dropApi(reason: string): Promise<void> {
    const api = this.#api
    this.#api = null
    if (api === null) return
    try {
      await api.close({ reason })
    } catch {
      /* best-effort */
    }
  }

  async #connect(): Promise<TApi> {
    await this.dropApi('hub-reconnect')
    const connection = this.#connection
    if (connection.host.length === 0) {
      throw userError('reolink.hub-host-missing', undefined, 'Reolink Hub: host not configured')
    }
    if (connection.password.length === 0) {
      throw userError(
        'reolink.hub-password-missing',
        undefined,
        'Reolink Hub: password not configured',
      )
    }
    this.#logger.info('Reolink hub connecting', {
      tags: { integrationId: this.integrationId },
      meta: {
        host: connection.host,
        port: connection.port,
        transport: connection.transport,
      },
    })
    const api = await this.#deps.connect(connection)

    // Subscribe BEFORE the first refresh so events that fire during enumeration
    // (online/sleeping bursts on login) hit the routing path.
    try {
      await api.offSimpleEvent(this.#simpleEventBound)
    } catch {
      /* first subscribe — handler not registered */
    }
    api.client.off('event', this.#rawEventBound)
    api.client.prependListener('event', this.#rawEventBound)
    await api.onSimpleEvent(this.#simpleEventBound)

    api.client.on('close', () => this.#scheduleReconnect('socket-close'))
    api.client.on('error', (err) => {
      this.#logger.warn('Reolink hub socket error — scheduling reconnect', {
        tags: { integrationId: this.integrationId },
        meta: { error: errMsg(err) },
      })
      this.#scheduleReconnect('socket-error')
    })

    this.#api = api
    this.#reconnectAttempts = 0
    this.#setOnline(true)

    // Initial refresh — non-blocking; the adoption surface shows "loading" until it lands.
    void this.refresh().catch(() => {
      /* best-effort */
    })
    return api
  }

  #setOnline(online: boolean): void {
    if (this.#online === online) return
    this.#online = online
    this.#deps.onConnectionChange?.(online)
  }

  #scheduleReconnect(reason: string): void {
    if (this.#shutdown) return
    this.#api = null
    this.#setOnline(false)
    if (this.#reconnectTimer !== null) return
    const backoff = Math.min(
      HUB_RECONNECT_BASE_MS * 2 ** this.#reconnectAttempts,
      HUB_RECONNECT_MAX_MS,
    )
    this.#reconnectAttempts += 1
    this.#logger.info('Reolink hub reconnect scheduled', {
      tags: { integrationId: this.integrationId },
      meta: { reason, attempt: this.#reconnectAttempts, backoffMs: backoff },
    })
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null
      void this.getApi().catch(() => {
        /* logged in #connect() */
      })
    }, backoff)
  }

  // ── refresh: channels summary + the three reconciles ─────────────────

  /**
   * Pull the channel list from the hub via `getNvrChannelsSummary({ source: 'cgi' })` — CGI,
   * because `GetChannelstatus` answers synchronously (no race against the cmd_id 145 push
   * cache that is empty right after login). Single-flight.
   */
  refresh(): Promise<void> {
    if (this.#refreshInFlight !== null) return this.#refreshInFlight
    const run = this.#refresh().finally(() => {
      this.#refreshInFlight = null
    })
    this.#refreshInFlight = run
    return run
  }

  async #refresh(): Promise<void> {
    const startedAt = this.#now()
    let lastError: string | null = null
    let channels: HubChannel[] = []
    try {
      const api = await this.getApi()
      const summary = await api.getNvrChannelsSummary({
        source: 'cgi',
        timeoutMs: HUB_DISCOVERY_REFRESH_TIMEOUT_MS,
      })
      channels = summary.devices.map(
        (d): HubChannel => ({
          childNativeId: computeChildNativeId(d.channel, d.uid),
          channel: d.channel,
          name: d.name ?? `Channel ${d.channel}`,
          status: discoveredStatusFor(d),
          ...(d.uid ? { uid: d.uid } : {}),
          ...(d.model ? { model: d.model } : {}),
          ...(d.serialNumber ? { serialNumber: d.serialNumber } : {}),
          isBattery: d.isBattery === true,
          isDoorbell: d.isDoorbell === true,
          isMultifocal: d.isMultifocal === true,
        }),
      )
    } catch (err) {
      lastError = errMsg(err)
      this.#logger.warn('Reolink hub channel refresh failed', {
        tags: { integrationId: this.integrationId },
        meta: { error: lastError },
      })
    }

    // A failed refresh keeps the last good list: "could not read" is not "no channels".
    this.#snapshot =
      lastError === null
        ? { channels, lastRefreshAt: this.#now(), lastError: null }
        : { ...this.#snapshot, lastError }
    if (lastError !== null) return

    // The hub is the authority on which slot a UID occupies. Repair any adopted child whose
    // persisted `channel` drifted — or vanished — BEFORE the known-unadopted set is rebuilt,
    // so a healed child is not also advertised as available for adoption.
    await this.reconcileChildChannels(channels)

    const adoptedChannels = new Set<number>()
    for (const child of this.#deps.children()) {
      if (child.channel !== undefined) adoptedChannels.add(child.channel)
    }
    this.#knownUnadoptedChannels.clear()
    for (const c of channels) {
      if (!adoptedChannels.has(c.channel)) this.#knownUnadoptedChannels.add(c.channel)
    }
    this.#logger.info('Reolink hub: channel refresh complete', {
      tags: { integrationId: this.integrationId },
      meta: {
        durationMs: this.#now() - startedAt,
        total: channels.length,
        adopted: channels.filter((c) => adoptedChannels.has(c.channel)).length,
        online: channels.filter((c) => c.status === 'online').length,
        sleeping: channels.filter((c) => c.status === 'sleeping').length,
      },
    })

    // Skipped when the refresh itself failed (returned above): an empty list would falsely
    // flag every child offline on a firmware blip.
    this.reconcileChildOnline(channels)
    this.reconcileChildSleepState(channels)
    await this.reconcileChildBattery()
  }

  /**
   * Re-derive each adopted child's `channel` from the hub's own list, matching by IDENTITY
   * (the stableId carries the camera UID) rather than by the channel itself — a child that lost
   * its channel is invisible to the routing, and a channel move produces the same damage under
   * a wrong number. A child that is not live is skipped: it is repaired on its next restore.
   */
  private async reconcileChildChannels(channels: readonly HubChannel[]): Promise<void> {
    const children = this.#deps.children()
    const repairs = planChannelReconciliation(
      channels.map((c) => ({
        childNativeId: c.childNativeId,
        rtspChannel: c.channel,
      })),
      children.map((child) => ({
        deviceId: child.id,
        stableId: child.stableId,
        ...(child.channel !== undefined ? { channel: child.channel } : {}),
      })),
    )
    for (const repair of repairs) {
      const child = children.find((c) => c.id === repair.deviceId)
      if (child === undefined) continue
      try {
        await child.repairChannel(repair.to)
        this.#logger.warn('Reolink hub: repaired a child channel from the hub channel list', {
          tags: { deviceId: repair.deviceId, stableId: repair.stableId },
          meta: { from: repair.from, to: repair.to },
        })
      } catch (err) {
        this.#logger.warn('Reolink hub: child channel repair failed', {
          tags: { deviceId: repair.deviceId, stableId: repair.stableId },
          meta: { from: repair.from, to: repair.to, error: errMsg(err) },
        })
      }
    }
  }

  /**
   * Mark every child still listed `online`, and any child missing for more than
   * `HUB_MISSING_OFFLINE_MS` `offline` — "if the hub firmware doesn't list it, the device isn't
   * reachable through the hub". Battery cams that briefly drop out of the summary during deep
   * sleep are not false-flagged: the threshold gives 3+ cycles of grace.
   */
  private reconcileChildOnline(channels: readonly HubChannel[]): void {
    const now = this.#now()
    const listed = new Set(channels.map((c) => c.channel))
    for (const child of this.#deps.children()) {
      const ch = child.channel
      if (ch === undefined) continue
      // Accessory grand-children carry their own linkage and are out of scope: only the
      // direct camera children are reconciled.
      if (child.type !== DeviceType.Camera) continue
      if (listed.has(ch)) {
        this.#childLastSeenAt.set(child.id, now)
        if (!child.online) {
          child.markOnline(true)
          this.#logger.info('Reolink hub: adopted child back online', {
            tags: { deviceId: child.id, deviceName: child.name },
            meta: { channel: ch },
          })
        }
        continue
      }
      const lastSeen = this.#childLastSeenAt.get(child.id) ?? 0
      const missingMs = lastSeen > 0 ? now - lastSeen : Number.POSITIVE_INFINITY
      if (missingMs >= HUB_MISSING_OFFLINE_MS && child.online) {
        child.markOnline(false)
        this.#logger.warn('Reolink hub: adopted child marked offline (missing from the hub list)', {
          tags: { deviceId: child.id, deviceName: child.name },
          meta: { channel: ch, missingMs },
        })
      }
    }
  }

  /**
   * Push the hub's per-channel sleep state into each adopted battery child's `battery.sleeping`
   * slice. The summary carries a `sleeping` flag straight from the firmware over the hub's own
   * mains-powered socket: it costs the battery channel nothing, and it is real firmware state
   * rather than socket-I/O inference. Only `online` / `sleeping` are acted on: `offline` and
   * `unknown` carry no sleep information, so the last known value stands.
   */
  private reconcileChildSleepState(channels: readonly HubChannel[]): void {
    const byChannel = new Map(channels.map((c) => [c.channel, c]))
    for (const child of this.#deps.children()) {
      if (child.channel === undefined) continue
      const entry = byChannel.get(child.channel)
      if (entry === undefined) continue
      if (entry.status !== 'sleeping' && entry.status !== 'online') continue
      child.applyHubSleepState(entry.status === 'sleeping')
    }
  }

  /**
   * Push the hub's per-channel battery read into each adopted battery child.
   * `getAllChannelsBatteryInfo` is one CGI on the hub's own socket — it never touches a battery
   * camera — and it is the ONLY way a sleeping child's percentage/charging ever moves.
   * Independent of the refresh's success path: a battery-read failure must not fail the refresh.
   */
  private async reconcileChildBattery(): Promise<void> {
    const children = this.#deps.children()
    if (children.length === 0) return
    try {
      const api = await this.getApi()
      const data = await api.getAllChannelsBatteryInfo()
      const entries = Object.entries(data.batteryInfoData)
      if (entries.length === 0) return
      if (!this.#batteryShapeLogged) {
        this.#batteryShapeLogged = true
        this.#logger.info('Reolink hub: per-channel battery payload (first read)', {
          tags: { integrationId: this.integrationId },
          meta: {
            raw: entries.map(([ch, v]) => ({ channel: Number(ch), ...v })),
          },
        })
      }
      for (const [chKey, info] of entries) {
        const child = children.find((c) => c.channel === Number(chKey))
        if (child === undefined) continue
        const power = mapHubBatteryPower(info.entries[0])
        for (const { field, value } of power.unmapped) {
          // A code the boundary cannot translate is a FINDING, not a silence.
          if (!this.#unmappedBatteryCodes.firstSeen(child.id, field, value)) continue
          this.#logger.warn('Reolink hub: unmapped battery power code — field dropped', {
            tags: { deviceId: child.id },
            meta: { channel: Number(chKey), field, value },
          })
        }
        child.applyHubBatteryInfo({
          batteryPercent: info.batteryLevel,
          ...power.fields,
        })
      }
    } catch (err) {
      this.#logger.debug('Reolink hub: per-channel battery refresh failed', {
        tags: { integrationId: this.integrationId },
        meta: { error: errMsg(err) },
      })
    }
  }

  // ── event routing ────────────────────────────────────────────────────

  /** Dispatch a hub-received simpleEvent to the matching child's `handleSimpleEvent`. */
  routeSimpleEvent(event: ReolinkSimpleEvent): void {
    const channel = event?.channel
    if (typeof channel !== 'number') return
    // Consumed now, synchronously with the raw emit it belongs to.
    const motionSensor = event.type === 'motion' ? this.#motionSensors.take(channel) : null
    const child = this.#deps.children().find((c) => c.channel === channel)
    if (child === undefined) {
      // An unmapped channel means every push for it dies here invisibly. Log it ONCE per
      // channel (throttled — a chatty channel must not flood). A channel the last refresh saw
      // but nobody adopted is an expected drop (debug), not a fault.
      const last = this.#unroutedLoggedAt.get(channel) ?? 0
      const now = this.#now()
      if (now - last > UNROUTED_LOG_THROTTLE_MS) {
        this.#unroutedLoggedAt.set(channel, now)
        const knownUnadopted = this.#knownUnadoptedChannels.has(channel)
        this.#logger[knownUnadopted ? 'debug' : 'warn'](
          'Reolink hub: simpleEvent for an unmapped channel dropped',
          {
            tags: { integrationId: this.integrationId },
            meta: { channel, type: event?.type ?? 'unknown', knownUnadopted },
          },
        )
      }
      return
    }
    try {
      // Hub-child events never hit the camera's own socket, so a debug flag on the child
      // produces no lib traces — log here, before dispatch, so an operator filtering to the
      // integration (or a debug camera) can see the push arrived and which child it hit.
      if (
        shouldTraceSimpleEventDispatch({
          hubDebugGeneral: this.#connection.debugGeneral,
          hubSocketFlags: this.#connection.debugSocketLogs,
          childDebugGeneral: child.debugGeneral,
          childSocketFlags: child.debugSocketFlags,
        })
      ) {
        this.#logger.info('Reolink hub: simpleEvent dispatch', {
          tags: { deviceId: child.id },
          meta: {
            type: event?.type ?? 'unknown',
            channel,
            timestamp: event?.timestamp,
            name: child.name,
          },
        })
      }
      child.handleSimpleEvent(event, motionSensor)
    } catch (err) {
      this.#logger.debug('Reolink hub simpleEvent dispatch failed', {
        tags: { deviceId: child.id },
        meta: { channel, error: errMsg(err) },
      })
    }
  }
}

// ── helpers ────────────────────────────────────────────────────────────

/**
 * A stable per-child identifier. UID is preferred when available (it identifies a paired camera
 * across re-pairings); otherwise `channel-N`, which is stable for a fixed channel assignment.
 */
export function computeChildNativeId(channel: number, uid?: string): string {
  if (uid && uid.length > 0) return `cam-${uid}`
  return `channel-${channel}`
}

/**
 * Map the lib's per-channel summary booleans to our `DiscoveredChildStatus`. Precedence:
 * `online === false` → offline; `sleeping === true` → sleeping; `online === true` → online;
 * any non-empty state → online; unknown otherwise (the cmd_id 145 push has not landed yet).
 */
export function discoveredStatusFor(d: {
  online?: boolean
  sleeping?: boolean
  state?: string
}): DiscoveredChildStatus {
  if (d.online === false) return 'offline'
  if (d.sleeping === true) return 'sleeping'
  if (d.online === true) return 'online'
  if (typeof d.state === 'string' && d.state.length > 0) return 'online'
  return 'unknown'
}

/** The wire-shaped channel the adoption surface lists. */
export function toDiscoveredChild(
  channel: HubChannel,
  adoptedDeviceId: number | null,
): DiscoveredChildDevice {
  return {
    childNativeId: channel.childNativeId,
    name: channel.name,
    // Doorbell vs camera lives in metadata; the adopted child is always a Camera.
    type: DeviceType.Camera,
    status: channel.status,
    metadata: {
      ...(channel.model ? { model: channel.model } : {}),
      ...(channel.serialNumber ? { serialNumber: channel.serialNumber } : {}),
      ...(channel.uid ? { uid: channel.uid } : {}),
      rtspChannel: channel.channel,
      isBattery: channel.isBattery,
      isDoorbell: channel.isDoorbell,
      isMultifocal: channel.isMultifocal,
    },
    alreadyAdopted: adoptedDeviceId !== null,
    adoptedDeviceId,
  }
}

// ── registry ───────────────────────────────────────────────────────────

/** Anything a child needs from its integration's session. */
export interface HubSessionHandle {
  getApi(): Promise<ReolinkBaichuanApi>
  relayEndpoint(): HubRelayEndpoint
}

/**
 * The per-integration registry the cameras reach their session through (the shape of
 * `veluxGateways` / `enpalConnections`). It also holds the children, so a child that activates
 * before its session exists (boot order) is already routable the moment the session starts.
 */
export class ReolinkHubSessions {
  readonly #sessions = new Map<string, HubSessionHandle>()
  readonly #children = new Map<string, Map<number, HubChildHandle>>()

  set(integrationId: string, session: HubSessionHandle | null): void {
    if (session === null) {
      this.#sessions.delete(integrationId)
      return
    }
    this.#sessions.set(integrationId, session)
  }

  get(integrationId: string): HubSessionHandle | null {
    return this.#sessions.get(integrationId) ?? null
  }

  attach(integrationId: string, child: HubChildHandle): void {
    let set = this.#children.get(integrationId)
    if (set === undefined) {
      set = new Map()
      this.#children.set(integrationId, set)
    }
    set.set(child.id, child)
  }

  /** Detach only if `child` is still the attached handle — a rebuilt device keeps its slot. */
  detach(integrationId: string, child: HubChildHandle): void {
    const set = this.#children.get(integrationId)
    if (set?.get(child.id) === child) set.delete(child.id)
  }

  childrenOf(integrationId: string): readonly HubChildHandle[] {
    return [...(this.#children.get(integrationId)?.values() ?? [])]
  }

  clear(): void {
    this.#sessions.clear()
    this.#children.clear()
  }
}

/** The module-level registry (one per addon process). */
export const reolinkHubSessions = new ReolinkHubSessions()

/** Dial a real hub. The default `connect` dependency of a session. */
export async function connectReolinkHub(
  connection: ReolinkHubConnection,
): Promise<ReolinkBaichuanApi> {
  const api = new ReolinkBaichuanApi({
    host: connection.host,
    port: connection.port,
    username: connection.username,
    password: connection.password,
    transport: connection.transport,
    ...(connection.uid ? { uid: connection.uid } : {}),
  })
  await api.login()
  return api
}
