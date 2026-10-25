import type { Connection, MessageBase } from 'home-assistant-js-websocket'
import {
  ERR_HASS_HOST_REQUIRED,
  ERR_INVALID_AUTH,
  ERR_CANNOT_CONNECT,
} from 'home-assistant-js-websocket'
import { createEvent, errMsg, type IEventBus, type IScopedLogger } from '@camstack/types'
import { randomUUID } from 'node:crypto'
import { HaWsClient } from './ha-ws-client.js'
import type { HaAuthConfig, HaEntityState, HaCompactUpdate } from './ha-types.js'
import { processEvent } from './ha-events.js'

/**
 * One `HaIntegrationManager` per registered HA broker. Owns the WS
 * connection, the entity-state cache, and the subscription
 * multiplexer that routes downstream consumers via the typed event-bus.
 *
 * Subscription multiplexing:
 *   - Many CamStack consumers may call `broker.subscribe({filter})` on
 *     the same HA broker for overlapping entity sets. We keep ONE
 *     upstream `subscribe_entities` to HA with the UNION of every
 *     active subscription's entity ids, and fan inbound state changes
 *     out via `EventCategory.BrokerMessage` once per matching
 *     subscription.
 *   - When the active union changes (subscribe / unsubscribe call),
 *     we re-issue the upstream subscribe with the new set. HA accepts
 *     this efficiently (server-side filter).
 *
 * State cache:
 *   - Folded by `processEvent` from every `subscribe_entities` push.
 *   - `getState({key})` reads directly from the cache — no round-trip.
 *   - Cleared on disconnect; rehydrated on reconnect via the upstream
 *     subscribe's initial `a` (add) frames.
 */

const HA_KIND = 'home-assistant'

/**
 * Curated device-event allowlist for the per-broker bus-event aggregator
 * (Case 2). Home Assistant fires arbitrary events on its bus; subscribing
 * with NO `event_type` would flood us with EVERY internal HA event
 * (state_changed, service_registered, …). Instead we subscribe per type to
 * a CURATED list of device-action events that carry no entity + no declared
 * vocabulary (ZHA / deCONZ remotes, Xiaomi Aqara clicks). Extensible — add
 * the bus event types the deployment needs here.
 */
const BUS_EVENT_TYPES = ['zha_event', 'deconz_event', 'xiaomi_aqara.click'] as const

/** Narrow shape of a HA `subscribe_events` callback result — the bus event
 *  envelope. `data` is the complex per-event payload (verbatim). */
interface HaBusEventResult {
  readonly event_type: string
  readonly data?: Record<string, unknown>
}

/** A curated HA bus event routed up to the addon — eventType + verbatim data. */
export interface HaBusEventEnvelope {
  readonly eventType: string
  readonly data: Record<string, unknown> | null
}

export type HaBrokerStatus =
  | 'connected'
  | 'disconnected'
  | 'connecting'
  | 'auth-failed'
  | 'unreachable'
  | 'error'

export interface HaBrokerInfo {
  readonly id: string
  readonly name: string
  readonly kind: typeof HA_KIND
  readonly status: HaBrokerStatus
  readonly info: Record<string, unknown>
  readonly lastCheckedAt: number | null
  readonly error: string | null
}

export interface PublishTargetHa {
  readonly domain: string
  readonly service: string
  /**
   * Entity target(s). HA accepts a string or a string array on
   * `target.entity_id` — calendars use the array form for one
   * `calendar.get_events` spanning several entities.
   */
  readonly entityId?: string | readonly string[]
  readonly areaId?: string
  readonly deviceId?: string
  /**
   * Ask HA for the service response body (`return_response: true`).
   * Required for `calendar.get_events`, `script.run`, and similar
   * response-bearing services — without it the call succeeds but the
   * payload is empty.
   */
  readonly returnResponse?: boolean
}

export interface SubscribeFilterHa {
  /** Explicit list of entity ids. Subscriptions to a non-existent
   *  entity stay valid — push notifications start when HA creates it. */
  readonly entityIds?: readonly string[]
  /** Domain-scoped subscription. Equivalent to listing every
   *  `<domain>.*` entity. */
  readonly domain?: string
}

/** Internal subscription record. */
interface SubscriptionEntry {
  readonly id: string
  readonly entityIds: ReadonlySet<string>
  readonly domain: string | null
}

export interface HaIntegrationManagerOptions {
  readonly id: string
  readonly name: string
  readonly auth: HaAuthConfig
  readonly logger: IScopedLogger
  readonly eventBus: IEventBus
  /**
   * Fired once the broker's WS reaches `connected` (baseline subscription
   * established). Wired broker → integration in-process — NOT via the system
   * event bus — so the owning integration can warm its discovery cache the
   * moment the connection is live.
   */
  readonly onConnected?: (brokerId: string) => void
  /**
   * Fired when the broker's WS drops (`onDisconnected` from the WS client).
   * Wired broker → integration in-process — NOT via the system event bus —
   * so the owning integration can fan the loss of reachability down to every
   * child device of this broker (mark them `online=false`). Reconnect needs
   * no counterpart: the re-subscribe replays each entity's current state and
   * the per-child availability chokepoint (A1) restores `online=true`.
   */
  readonly onDisconnected?: (brokerId: string) => void
  /**
   * Fired for every curated HA BUS event ({@link BUS_EVENT_TYPES}) — e.g. a
   * ZHA remote's `zha_event`. Wired broker → integration in-process — NOT via
   * the system event bus — so the owning addon can route the event onto the
   * per-broker generic `EventEmitter` aggregator. The `data` payload is carried
   * VERBATIM (NO normalization).
   */
  readonly onBusEvent?: (brokerId: string, ev: HaBusEventEnvelope) => void
}

/**
 * Result of `publish` on this manager — returns the HA service-call
 * response when the service has one (script.execute returns
 * `script_run_id`), otherwise `null`.
 */
export type HaPublishResult = Record<string, unknown> | null

export class HaIntegrationManager {
  private wsClient: HaWsClient | null = null
  private connection: Connection | null = null
  private upstreamSubscriptionUnsub: (() => Promise<void> | void) | null = null
  /** Unsubs for the curated bus-event subscriptions (Case 2). Cleaned on
   *  re-subscribe (reconnect) and on stop, mirroring the entity unsub. */
  private busEventUnsubs: (() => Promise<void> | void)[] = []

  private readonly subscriptions = new Map<string, SubscriptionEntry>()
  private readonly stateCache: Record<string, HaEntityState> = {}

  private status: HaBrokerStatus = 'disconnected'
  private lastCheckedAt: number | null = null
  private lastError: string | null = null
  private haInfo: Record<string, unknown> = {}
  /** Deadline timer for the INITIAL connect. `start()` no longer blocks on
   *  the socket (see the comment there), so a broker whose host silently
   *  drops packets would otherwise sit at `connecting` for the full OS TCP
   *  timeout (tens of seconds) with no UI signal. This timer flips it to
   *  `unreachable` promptly; a late successful connect still overrides it. */
  private connectDeadlineTimer: ReturnType<typeof setTimeout> | null = null

  /** Ceiling on the `connecting` state before the UI is shown `unreachable`.
   *  Slightly above the throwaway `testSettings` probe timeout (8s). */
  private static readonly CONNECT_DEADLINE_MS = 10_000

  constructor(private readonly opts: HaIntegrationManagerOptions) {}

  // ── Lifecycle ────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.setStatus('connecting')
    this.wsClient = new HaWsClient({
      auth: this.opts.auth,
      callbacks: {
        onConnected: async (connection) => {
          this.connection = connection
          // Probe HA version + serial via the `get_config` ws message —
          // populates `info` for the broker registry view.
          await this.refreshHaConfigInfo(connection)
          // Baseline subscription — subscribe to EVERY entity (empty
          // entity_ids list = wildcard). Keeps the state cache fresh so
          // discovery + downstream consumers see live state without an
          // extra round-trip. Downstream `subscribe()` calls do NOT add
          // upstream subscriptions; they only register fan-out handlers.
          await this.ensureBaselineSubscription()
          // Case 2: subscribe to the curated HA bus events so device-action
          // events (zha_event, …) reach the per-broker aggregator. Best-effort
          // — a failing bus subscription must not break the connect path.
          await this.ensureBusEventSubscriptions()
          // A live connection clears any prior failure + the connect deadline.
          this.clearConnectDeadline()
          this.lastError = null
          this.setStatus('connected')
          // Broker → integration: nudge the owning integration to warm its
          // discovery cache now that the WS is live. Direct in-process call,
          // not a system-bus event. Best-effort — a throwing listener must
          // not break the connect path.
          try {
            this.opts.onConnected?.(this.opts.id)
          } catch (err) {
            this.opts.logger.warn('ha-broker onConnected handler threw', {
              meta: { brokerId: this.opts.id, error: errMsg(err) },
            })
          }
        },
        onDisconnected: () => {
          this.connection = null
          this.upstreamSubscriptionUnsub = null
          // The bus-event subscriptions died with the connection — drop the
          // dead unsub handles; `ensureBusEventSubscriptions` re-subscribes
          // on the next connect.
          this.busEventUnsubs = []
          this.setStatus('disconnected')
          // Purge cache — entities may have changed while disconnected.
          for (const key of Object.keys(this.stateCache)) {
            delete this.stateCache[key]
          }
          // Broker → integration: fan the loss of reachability down to this
          // broker's child devices (A2). Direct in-process call, not a system-
          // bus event. Best-effort — a throwing listener must not break the
          // disconnect path.
          try {
            this.opts.onDisconnected?.(this.opts.id)
          } catch (err) {
            this.opts.logger.warn('ha-broker onDisconnected handler threw', {
              meta: { brokerId: this.opts.id, error: errMsg(err) },
            })
          }
        },
        onReconnectError: (err, nextDelayMs) => {
          this.lastError = errMsg(err)
          this.opts.logger.warn('ha-broker reconnect attempt failed', {
            meta: { brokerId: this.opts.id, error: this.lastError, nextDelayMs },
          })
        },
      },
    })
    // Kick off the initial connect WITHOUT blocking. An unreachable / dead
    // host makes the underlying WS connect hang on the OS TCP timeout (tens
    // of seconds); awaiting it here would (a) hang `broker.add` so the wizard
    // spinner traps the operator with no error and no way out, and (b) block
    // `HaBrokerRegistry.restore()` on addon boot — the whole addon then can't
    // return its cap providers, so list / delete calls to it time out (a dead
    // broker made deleting ANY broker impossible). Instead we start in the
    // background and let the status callbacks + connect deadline drive state.
    // A failed connect resolves to an `unreachable` / `auth-failed` broker the
    // UI surfaces, and the operator can edit or delete it. Auth / connect
    // errors no longer throw out of `start()` — they become observable status.
    this.startConnectDeadline()
    void this.wsClient.start().catch((err: unknown) => {
      this.classifyAuthError(err)
    })
  }

  /** Arm the initial-connect deadline. Idempotent — clears any prior timer. */
  private startConnectDeadline(): void {
    this.clearConnectDeadline()
    const timer = setTimeout(() => {
      this.connectDeadlineTimer = null
      // Only fire if the connect is still in flight — a resolved (connected)
      // or already-classified (unreachable/auth-failed/error) broker owns its
      // own status.
      if (this.status === 'connecting') {
        if (this.lastError === null) this.lastError = 'Connection timed out'
        this.setStatus('unreachable')
      }
    }, HaIntegrationManager.CONNECT_DEADLINE_MS)
    // Never let this timer hold the event loop open on its own.
    if (typeof timer.unref === 'function') timer.unref()
    this.connectDeadlineTimer = timer
  }

  private clearConnectDeadline(): void {
    if (this.connectDeadlineTimer) {
      clearTimeout(this.connectDeadlineTimer)
      this.connectDeadlineTimer = null
    }
  }

  async stop(): Promise<void> {
    this.clearConnectDeadline()
    if (this.upstreamSubscriptionUnsub) {
      try {
        await this.upstreamSubscriptionUnsub()
      } catch {
        // best-effort
      }
      this.upstreamSubscriptionUnsub = null
    }
    await this.teardownBusEventSubscriptions()
    if (this.wsClient) {
      this.wsClient.stop()
      this.wsClient = null
    }
    this.connection = null
    this.setStatus('disconnected')
  }

  getInfo(): HaBrokerInfo {
    return {
      id: this.opts.id,
      name: this.opts.name,
      kind: HA_KIND,
      status: this.status,
      info: { ...this.haInfo },
      lastCheckedAt: this.lastCheckedAt,
      error: this.lastError,
    }
  }

  // ── Read API ─────────────────────────────────────────────────────────

  getState(key: string): HaEntityState | null {
    return this.stateCache[key] ?? null
  }

  getStates(keys: readonly string[]): Record<string, HaEntityState> {
    const out: Record<string, HaEntityState> = {}
    for (const k of keys) {
      const v = this.stateCache[k]
      if (v !== undefined) out[k] = v
    }
    return out
  }

  /** Full snapshot of every cached entity. Used by the discovery
   *  surface (Phase E3) which lists adopted+un-adopted entities. */
  snapshotAllStates(): Record<string, HaEntityState> {
    return { ...this.stateCache }
  }

  // ── Raw WS messaging (for discovery service registry queries) ───────

  /**
   * Send an arbitrary WS message and await the response. Used by the
   * discovery service to issue `config/device_registry/list` and
   * friends. Throws when the connection isn't ready.
   */
  async sendMessage<T = unknown>(message: MessageBase): Promise<T> {
    return this.requireConnection().sendMessagePromise<T>(message)
  }

  // ── Write API ────────────────────────────────────────────────────────

  /**
   * Dispatch a service call over the WS. The HA `call_service` message
   * follows the shape:
   *   { type:'call_service', domain, service, target?:{...}, service_data?:{...} }
   *
   * Returns the service response when HA exposes one (`return_response`
   * actions: script.run, calendar.list_events, …), otherwise null.
   */
  async publish(target: PublishTargetHa, payload: unknown): Promise<HaPublishResult> {
    const conn = this.requireConnection()
    const message: MessageBase = {
      type: 'call_service',
      domain: target.domain,
      service: target.service,
    }
    const targetEnvelope: Record<string, string | string[]> = {}
    if (target.entityId !== undefined) {
      // `typeof`, not `Array.isArray`: the latter does not narrow a
      // `readonly string[]` and leaves the branch typed `any[]`.
      targetEnvelope['entity_id'] =
        typeof target.entityId === 'string' ? target.entityId : [...target.entityId]
    }
    if (target.areaId) targetEnvelope['area_id'] = target.areaId
    if (target.deviceId) targetEnvelope['device_id'] = target.deviceId
    if (Object.keys(targetEnvelope).length > 0) {
      ;(message as Record<string, unknown>)['target'] = targetEnvelope
    }
    if (payload !== undefined && payload !== null) {
      ;(message as Record<string, unknown>)['service_data'] = payload
    }
    if (target.returnResponse === true) {
      ;(message as Record<string, unknown>)['return_response'] = true
    }
    const result = await conn.sendMessagePromise<unknown>(message)
    if (result && typeof result === 'object') {
      return result as Record<string, unknown>
    }
    return null
  }

  // ── Subscription multiplexer ─────────────────────────────────────────

  async subscribe(filter: SubscribeFilterHa): Promise<{ subscriptionId: string }> {
    const subscriptionId = randomUUID()
    const entityIds = new Set<string>(filter.entityIds ?? [])
    const domain = filter.domain ?? null
    this.subscriptions.set(subscriptionId, {
      id: subscriptionId,
      entityIds,
      domain,
    })
    // Baseline subscription is to ALL entities — no upstream resubscribe
    // is needed when a downstream consumer joins. We just replay the
    // current cache for matching entities so the consumer sees state
    // immediately (no race between subscribe and first push).
    for (const entityId of Object.keys(this.stateCache)) {
      if (this.subscriptionMatches(this.subscriptions.get(subscriptionId)!, entityId)) {
        this.emitBrokerMessage(subscriptionId, entityId, this.stateCache[entityId]!)
      }
    }
    return { subscriptionId }
  }

  async unsubscribe(subscriptionId: string): Promise<void> {
    if (!this.subscriptions.has(subscriptionId)) return
    this.subscriptions.delete(subscriptionId)
    // No upstream resubscribe needed — baseline is wildcard.
  }

  // ── Settings ─────────────────────────────────────────────────────────

  /**
   * Apply new auth credentials. Tears down the existing connection and
   * re-opens with the new config. Subscriptions and cache are preserved
   * across the reconnect.
   */
  async applyAuth(auth: HaAuthConfig): Promise<void> {
    ;(this.opts as { auth: HaAuthConfig }).auth = auth
    if (this.wsClient) {
      this.wsClient.stop()
      this.wsClient = null
    }
    await this.start()
  }

  // ── Private ──────────────────────────────────────────────────────────

  private async ensureBaselineSubscription(): Promise<void> {
    const conn = this.connection
    if (!conn) return
    if (this.upstreamSubscriptionUnsub) {
      // Already subscribed (rare reconnect race — be defensive).
      try {
        await this.upstreamSubscriptionUnsub()
      } catch {
        // best-effort
      }
      this.upstreamSubscriptionUnsub = null
    }
    // Wildcard subscription — every entity stream lands here, fed into
    // the state cache via `processEvent`. The downstream consumer
    // subscriptions fan out from the cache; HA only ever sees ONE
    // upstream subscription per broker regardless of consumer count.
    const wildcardSubscribeMsg: MessageBase = { type: 'subscribe_entities' }
    const unsub = await conn.subscribeMessage<HaCompactUpdate>(
      (update) => this.handleUpstreamUpdate(update),
      wildcardSubscribeMsg,
    )
    this.upstreamSubscriptionUnsub = unsub
  }

  /**
   * Subscribe to each curated HA bus event type ({@link BUS_EVENT_TYPES}) and
   * fan each fire up to the owning addon via `onBusEvent`. Re-subscribes
   * cleanly on reconnect (tears down stale handles first). When no `onBusEvent`
   * hook is registered we skip the work entirely — no consumer, no subscription.
   */
  private async ensureBusEventSubscriptions(): Promise<void> {
    if (!this.opts.onBusEvent) return
    const conn = this.connection
    if (!conn) return
    await this.teardownBusEventSubscriptions()
    for (const eventType of BUS_EVENT_TYPES) {
      try {
        const unsub = await conn.subscribeMessage<HaBusEventResult>(
          (result) => {
            this.opts.onBusEvent?.(this.opts.id, {
              eventType: result.event_type,
              data: result.data ?? null,
            })
          },
          { type: 'subscribe_events', event_type: eventType },
        )
        this.busEventUnsubs.push(unsub)
      } catch (err) {
        this.opts.logger.warn('ha-broker bus-event subscribe failed', {
          meta: { brokerId: this.opts.id, eventType, error: errMsg(err) },
        })
      }
    }
  }

  private async teardownBusEventSubscriptions(): Promise<void> {
    const unsubs = this.busEventUnsubs
    this.busEventUnsubs = []
    for (const unsub of unsubs) {
      try {
        await unsub()
      } catch {
        // best-effort
      }
    }
  }

  private handleUpstreamUpdate(update: HaCompactUpdate): void {
    const previous = { ...this.stateCache }
    const next = processEvent(previous, update)
    // Fold deltas back into the cache (mutate in place since we own it).
    for (const key of Object.keys(this.stateCache)) {
      if (!(key in next)) delete this.stateCache[key]
    }
    for (const [key, value] of Object.entries(next)) {
      this.stateCache[key] = value
    }
    // Determine which entities changed and fan out broker.message events
    // to matching subscriptions.
    const changed = new Set<string>([
      ...Object.keys(update.a ?? {}),
      ...Object.keys(update.c ?? {}),
      ...(update.r ?? []),
    ])
    for (const entityId of changed) {
      const state = next[entityId] ?? null
      if (state === null) continue // removal — consumers infer from getState returning null
      for (const sub of this.subscriptions.values()) {
        if (this.subscriptionMatches(sub, entityId)) {
          this.emitBrokerMessage(sub.id, entityId, state)
        }
      }
    }
  }

  private subscriptionMatches(sub: SubscriptionEntry, entityId: string): boolean {
    if (sub.entityIds.size > 0 && sub.entityIds.has(entityId)) return true
    if (sub.domain && entityId.startsWith(`${sub.domain}.`)) return true
    if (sub.entityIds.size === 0 && !sub.domain) return true // wildcard
    return false
  }

  private emitBrokerMessage(subscriptionId: string, entityId: string, state: HaEntityState): void {
    this.opts.eventBus.emit(
      createEvent(
        'broker.message',
        { type: 'addon', id: this.opts.id },
        {
          brokerId: this.opts.id,
          subscriptionId,
          key: entityId,
          payload: state,
        },
      ),
    )
  }

  private async refreshHaConfigInfo(connection: Connection): Promise<void> {
    try {
      const cfg = await connection.sendMessagePromise<Record<string, unknown>>({
        type: 'get_config',
      })
      this.haInfo = {
        version: cfg['version'] ?? null,
        locationName: cfg['location_name'] ?? null,
        timeZone: cfg['time_zone'] ?? null,
        unitSystem: cfg['unit_system'] ?? null,
      }
    } catch (err) {
      this.opts.logger.debug('ha get_config probe failed', {
        meta: { brokerId: this.opts.id, error: errMsg(err) },
      })
    }
  }

  private setStatus(next: HaBrokerStatus): void {
    if (this.status === next) return
    this.status = next
    this.lastCheckedAt = Date.now()
    this.opts.eventBus.emit(
      createEvent(
        'broker.status-changed',
        { type: 'addon', id: this.opts.id },
        {
          brokerId: this.opts.id,
          status: next,
          ...(this.lastError !== null ? { error: this.lastError } : {}),
        },
      ),
    )
  }

  private classifyAuthError(err: unknown): void {
    // The initial connect has now settled (rejected) — its deadline is moot.
    this.clearConnectDeadline()
    // Set `lastError` BEFORE `setStatus` so the emitted `broker.status-changed`
    // event carries the message on the first transition. Map the library's
    // NUMERIC error codes (ERR_CANNOT_CONNECT === 1, ERR_INVALID_AUTH === 2, …)
    // to human-readable text — `errMsg(1)` would otherwise surface a bare "1"
    // in the UI.
    if (err === ERR_INVALID_AUTH) {
      this.lastError = 'Authentication failed — check the access token'
      this.setStatus('auth-failed')
    } else if (err === ERR_CANNOT_CONNECT) {
      this.lastError = 'Cannot connect — host unreachable or Home Assistant not responding'
      this.setStatus('unreachable')
    } else if (err === ERR_HASS_HOST_REQUIRED) {
      this.lastError = 'Home Assistant host / URL is required'
      this.setStatus('unreachable')
    } else {
      this.lastError = errMsg(err)
      this.setStatus('error')
    }
  }

  private requireConnection(): Connection {
    if (!this.connection) {
      throw new Error(`ha-broker '${this.opts.id}': WS connection not ready`)
    }
    return this.connection
  }
}
