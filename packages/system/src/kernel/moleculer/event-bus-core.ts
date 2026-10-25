/**
 * Shared event-bus core — pure in-process fan-out logic with NO dependency on
 * Moleculer or any transport layer.
 *
 * Consumed by:
 *  - `event-bus.ts`      (Moleculer broker-backed cluster bus)
 *  - `uds-event-bus.ts`  (UDS-backed child-process bus, C1)
 *
 * Keeping this module transport-free means the UDS bus can reuse every piece
 * of logic (deny-list, subscriber map, filter semantics) without pulling in
 * Moleculer types.
 */
import type { EventFilter, SystemEvent } from '@camstack/types'
import type { DeviceEventRings } from './device-event-ring.js'
import { createDeviceEventRings, recordDeviceEvent } from './device-event-ring.js'

// ---------------------------------------------------------------------------
// Subscriber entry
// ---------------------------------------------------------------------------

export interface SubscriberEntry {
  /** Original filter — kept whole so non-category dimensions are honoured per-event. */
  readonly filter: EventFilter | string | undefined
  /**
   * Pre-computed category pattern for the cheap pre-filter — the FIRST of
   * {@link extractCategoryPatterns} when the filter names several. Diagnostic
   * only: the authority on which keys an entry occupies is the handler map
   * itself, written by {@link registerSubscriber}.
   */
  readonly categoryPattern: string
  readonly handler: (event: SystemEvent) => void
}

// ---------------------------------------------------------------------------
// Shared per-process bus state
// ---------------------------------------------------------------------------

export interface SharedBusState {
  /**
   * Subscribers indexed by category pattern. Each entry also carries its full
   * filter so the subsequent `matchesEventFilter` call can reject events that
   * match the category but not the scope (deviceId, addonId, …).
   */
  readonly handlers: Map<string, Set<SubscriberEntry>>
  /**
   * In-memory recent-events buffer. The deny-list below filters out
   * high-frequency categories so the buffer only accumulates audit-grade
   * lifecycle events.
   *
   * ONLY populated when `retainRecent` is true (the hub main process). On every
   * other bus this array stays empty for the process's whole lifetime.
   *
   * Cleared on server restart (intentional — events are volatile by design).
   */
  readonly recent: SystemEvent[]
  /**
   * Per-device rings BESIDE `recent[]` — not a replacement for it.
   *
   * `recent[]` is one global, count-bounded ring: a busy fleet evicts a quiet
   * camera's events out of it long before an operator opens that camera's
   * panel, and filtering a global ring by device cannot bring them back. A
   * per-device ask is therefore answered from here instead
   * (`getBrokerEventBus().getRecent({ deviceId })`), while an ask that names no
   * device is still answered from `recent[]`.
   *
   * Populated under exactly the same conditions as `recent[]` (retaining bus,
   * category not on the high-frequency deny-list), with mirror categories
   * coalesced and payloads capped — see `device-event-ring.ts`. An event that
   * names no device is retained in `recent[]` ONLY; no device is invented for
   * it.
   */
  readonly deviceRings: DeviceEventRings
  /**
   * Whether this bus retains events in `recent[]` to back the
   * `getRecent`/audit capability.
   *
   * Events are one-shot (fire-and-forget): ONLY the hub main process — the
   * single process that serves `getRecent` — needs the registry, so ONLY its
   * broker bus sets this true. Child addon runners and remote agents leave it
   * false: they fan every event out to their local subscribers but retain
   * nothing, so their heap can never accumulate an unbounded recent[] backlog.
   *
   * Mutable so the authoritative opt-in (the hub-main `getBrokerEventBus`
   * caller) can upgrade a bus that a non-retaining caller happened to create
   * first — see `getSharedBusState`. Never downgraded from true → false.
   */
  retainRecent: boolean
}

/**
 * @param retainRecent - `true` ONLY for the hub main broker bus (it serves
 *   `getRecent`). Defaults to `false` — the safe one-shot default for child
 *   runners + agents, which retain nothing.
 */
export function createSharedBusState(retainRecent = false): SharedBusState {
  return {
    handlers: new Map(),
    recent: [],
    deviceRings: createDeviceEventRings(),
    retainRecent,
  }
}

// ---------------------------------------------------------------------------
// Pattern matching helpers
// ---------------------------------------------------------------------------

export function matchesPattern(pattern: string, category: string): boolean {
  if (pattern === '*' || pattern === '**') return true
  if (pattern.endsWith('.**')) {
    return category.startsWith(pattern.slice(0, -3))
  }
  if (pattern.endsWith('.*')) {
    return category.startsWith(pattern.slice(0, -2))
  }
  return pattern === category
}

/**
 * The FIRST category pattern of a filter.
 *
 * Kept for the diagnostic `SubscriberEntry.categoryPattern` field and for
 * callers that genuinely want one string. It is NOT the registration path:
 * a filter naming several categories must occupy several map keys, which is
 * what {@link extractCategoryPatterns} + {@link registerSubscriber} do. Using
 * this function to key a subscriber is the bug described on
 * `extractCategoryPatterns`.
 */
export function extractCategoryPattern(filter: EventFilter | string): string {
  return extractCategoryPatterns(filter)[0] ?? '*'
}

/**
 * EVERY category pattern a filter asks for — the registration key set.
 *
 * `EventFilter.category` has always accepted an array, and until 2026-08-12
 * the delivery path kept only `cat[0]`. Inside a forked runner that was not
 * merely a local filter: `createUdsEventBus` reports its handler-map keys to
 * the parent as this child's forwarding interest, so the categories that never
 * became keys were never forwarded across the process boundary at all. A
 * ten-category subscribe received one category, silently.
 *
 * Duplicates are collapsed so a filter that names the same category twice does
 * not put the entry in one key twice.
 */
export function extractCategoryPatterns(filter: EventFilter | string): readonly string[] {
  if (typeof filter === 'string') return [filter]
  if (filter && typeof filter === 'object' && 'category' in filter) {
    const cat = filter.category
    if (typeof cat === 'string') return [cat]
    if (Array.isArray(cat) && cat.length > 0) return [...new Set(cat.map((c) => String(c)))]
  }
  return ['*']
}

/**
 * Register one handler under every category pattern its filter names, and
 * return the unsubscribe that removes it from all of them.
 *
 * The ONE place a subscriber enters `state.handlers` — both bus
 * implementations (broker and UDS) call it, so "which keys does this
 * subscriber occupy" has a single answer. An emptied key is DELETED rather
 * than left as an empty `Set`: on a child bus the key set is what the parent
 * is told to forward, and an empty set left behind pins the parent to forward
 * a category nobody wants.
 *
 * @param onKeysChanged - Called after the key set may have changed (both on
 *   registration and on unsubscribe), for buses that mirror their key set
 *   somewhere — the UDS child's parent report, the broker's local-interest
 *   surface. Receives the patterns this call touched.
 */
export function registerSubscriber(
  state: SharedBusState,
  filter: EventFilter | string,
  handler: (event: SystemEvent) => void,
  onKeysChanged?: (patterns: readonly string[], added: boolean) => void,
): () => void {
  const patterns = extractCategoryPatterns(filter)
  const entry: SubscriberEntry = {
    filter,
    categoryPattern: patterns[0] ?? '*',
    handler,
  }
  for (const pattern of patterns) {
    const set = state.handlers.get(pattern) ?? new Set<SubscriberEntry>()
    set.add(entry)
    state.handlers.set(pattern, set)
  }
  onKeysChanged?.(patterns, true)
  // Idempotent: a second call must not drop a key a LATER subscriber took, and
  // must not decrement a refcounted interest surface twice. Callers do double-
  // unsubscribe (a shutdown list iterated after an early individual release).
  let released = false
  return () => {
    if (released) return
    released = true
    for (const pattern of patterns) {
      const current = state.handlers.get(pattern)
      if (current === undefined) continue
      current.delete(entry)
      if (current.size === 0) state.handlers.delete(pattern)
    }
    onKeysChanged?.(patterns, false)
  }
}

/**
 * Match an event against the full `EventFilter`. The Map-keyed subscribe path
 * only handles the category pattern (deciding which handler set to fan out to);
 * this function applies the remaining scope dimensions (`agentId`, `addonId`,
 * `deviceId`, `source`, `since`) so per-device / per-addon subscribers don't
 * receive sibling events.
 */
export function matchesEventFilter(
  event: SystemEvent,
  filter: EventFilter | string | undefined,
): boolean {
  if (!filter || typeof filter === 'string') return true
  if (filter.source) {
    if (event.source.type !== filter.source.type || event.source.id !== filter.source.id) {
      return false
    }
  }
  if (filter.agentId) {
    const eventNodeId = event.source.nodeId
    if (
      !eventNodeId ||
      (eventNodeId !== filter.agentId && !eventNodeId.startsWith(`${filter.agentId}/`))
    ) {
      return false
    }
  }
  if (filter.addonId) {
    const eventAddonId =
      event.source.addonId ?? (event.source.type === 'addon' ? String(event.source.id) : undefined)
    if (eventAddonId !== filter.addonId) return false
  }
  if (filter.deviceId !== undefined) {
    const eventDeviceId =
      event.source.deviceId ??
      (event.source.type === 'device' ? Number(event.source.id) : undefined)
    if (eventDeviceId !== filter.deviceId) return false
  }
  if (filter.since && event.timestamp < filter.since) {
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// High-frequency deny-list — categories excluded from the recent[] ring buffer
// ---------------------------------------------------------------------------

/**
 * Categories filtered out of the `recent[]` ring buffer.
 *
 * High-frequency, low-value-for-the-operator categories — periodic metrics
 * snapshots, per-frame inference traces, raw motion-mask dumps, model-download
 * progress, etc. They still fan out to live subscribers (UI charts that
 * explicitly listen for them), but do NOT enter the recent-events ring so
 * meaningful events (motion / phase transitions / device lifecycle / addon
 * lifecycle / recording / detection.event) survive in the last-N window without
 * being displaced by per-frame noise.
 */
export const RING_BUFFER_DENY_PATTERNS: readonly string[] = [
  'pipeline.camera-metrics-snapshot',
  'pipeline.runner-load-snapshot',
  'pipeline.engine-metrics-snapshot',
  'pipeline.inference-result',
  'pipeline.trace',
  'pipeline.progress',
  'stream-broker.metrics-snapshot',
  'metrics.node-resources-snapshot',
  'metrics.node-processes-snapshot',
  'cluster.topology-snapshot',
  'detection.motion-analysis',
  'detection.motion-zones-raw',
  'detection.result',
  'pipeline.audio-inference-result',
  'platform-probe.phase',
  'benchmark.progress',
  'model.download.progress',
  // High-frequency per-frame / per-track analytics + raw motion toggles —
  // these were the dominant contributors to the unbounded recent[] leak.
  'pipeline-analytics.frame-tracked',
  'pipeline-analytics.detection-event',
  'pipeline-analytics.track-started',
  'pipeline-analytics.track-ended',
  'motion.on-motion-changed',
  // A camera's RAW onboard motion push (D673), re-emitted at ~1 Hz by some
  // providers: the same noise `motion.on-motion-changed` was before the split.
  'provider.motion',
  // `device.state-changed` is intentionally NOT denied (audit-grade) — the
  // MAX_RECENT_EVENTS length cap in `deliverShared` bounds it instead.
  'capability.binding-changed',
]

/**
 * Hard cap on the `recent[]` buffer size. Even audit-grade categories that
 * are NOT on the deny-list (e.g. `device.state-changed`) must not accumulate
 * without bound — this is the last-N window, not a durable log. Without this
 * cap the buffer grew forever (~26 MB/h/process across every broker, agent,
 * and UDS-child bus), filling the hub to 16 GB.
 */
export const MAX_RECENT_EVENTS = 1000

export function isHighFrequencyCategory(category: string): boolean {
  for (const pattern of RING_BUFFER_DENY_PATTERNS) {
    if (matchesPattern(pattern, category)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Cross-node (Moleculer) subscription-aware inbound filter (D2)
// ---------------------------------------------------------------------------

/**
 * Cross-node (Moleculer) inbound gate: an inbound cross-node event whose
 * category no local subscriber on THIS node wants (the union of its children's
 * declared patterns) is dropped and counted (`suppressed`). It always filters —
 * the `CAMSTACK_MOLECULER_EVENT_FANOUT` shadow/broadcast modes were removed on
 * 2026-10-06; the intra-host analogue is `LocalChildRegistry.childWantsEvent`.
 */

/**
 * A node's inbound-interest snapshot used by {@link crossNodeAcceptsCategory}.
 *  - `retainRecent` — the receiving bus retains events for `getRecent`/audit
 *    (the hub main process). Such a bus genuinely wants EVERY category (its
 *    interest set is the admin-ui live stream + recent[] ring), so it always
 *    fails OPEN — it never filters inbound cross-node events.
 *  - `interest` — the union of this node's local subscribers' declared category
 *    patterns (aggregated from its UDS children). `null` = undeclared / unknown
 *    (a legacy child, or no oracle installed) → fail OPEN (accept everything).
 *    An EMPTY array is a *declared* "wants nothing" and drops every category.
 */
export interface CrossNodeInterestSnapshot {
  readonly retainRecent: boolean
  readonly interest: readonly string[] | null
}

/**
 * Does this node want to accept an inbound cross-node event in `category`?
 * The receiving-side mirror of `LocalChildRegistry.childWantsEvent`:
 *   - a retaining bus (hub main) → always (it serves `getRecent` + admin-ui;
 *     its interest is genuinely everything).
 *   - undeclared interest (`null`) → always (fail-open).
 *   - else the declared union must match via `matchesPattern` — the SAME
 *     function the local subscriber map-key gate uses, giving delivery parity.
 */
export function crossNodeAcceptsCategory(
  snapshot: CrossNodeInterestSnapshot,
  category: string,
): boolean {
  if (snapshot.retainRecent) return true
  if (snapshot.interest === null) return true
  return snapshot.interest.some((p) => matchesPattern(p, category))
}

// ---------------------------------------------------------------------------
// Core fan-out
// ---------------------------------------------------------------------------

/**
 * Deliver `event` to all matching local subscribers and — ONLY on a bus that
 * opted into retention (`state.retainRecent`, i.e. the hub main process) and
 * unless the event is high-frequency — append it to the bounded `recent[]`
 * ring.
 *
 * On a non-retaining bus (child runners, agents) the retention block is skipped
 * entirely: events are one-shot / fire-and-forget, still fanned out to local
 * subscribers but never accumulated. `getRecent` on such a bus returns `[]`.
 */
export function deliverShared(state: SharedBusState, event: SystemEvent): void {
  if (state.retainRecent && !isHighFrequencyCategory(event.category)) {
    state.recent.push(event)
    if (state.recent.length > MAX_RECENT_EVENTS) {
      state.recent.splice(0, state.recent.length - MAX_RECENT_EVENTS)
    }
    // Same retention gate, second destination: the device's own ring, so a
    // quiet camera's history survives the fleet's traffic. An event naming no
    // device is retained above and nowhere else.
    recordDeviceEvent(state.deviceRings, event)
  }
  // Dedup by ENTRY, not by key. One subscriber occupies one map key per
  // category it named, and those patterns can overlap — `{ category:
  // ['device.*', 'device.online'] }` matches a `device.online` event under
  // both. Without this set the handler would run twice for one event, which
  // for a notification path means two notifications.
  const delivered = new Set<SubscriberEntry>()
  for (const [pattern, set] of state.handlers) {
    if (!matchesPattern(pattern, event.category)) continue
    for (const entry of set) {
      if (delivered.has(entry)) continue
      if (!matchesEventFilter(event, entry.filter)) continue
      delivered.add(entry)
      try {
        entry.handler(event)
      } catch (err) {
        // Swallow handler errors so one broken subscriber can't kill the rest.
        void err
      }
    }
  }
}
