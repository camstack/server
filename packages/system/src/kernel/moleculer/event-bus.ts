import type { EventFilter, IEventBus, SystemEvent } from '@camstack/types'
import type { ServiceBroker } from 'moleculer'
import type { CrossNodeInterestSnapshot, SharedBusState } from './event-bus-core.js'
import { getDeviceRecent } from './device-event-ring.js'
import {
  createSharedBusState,
  crossNodeAcceptsCategory,
  deliverShared,
  matchesEventFilter,
  matchesPattern,
  registerSubscriber,
} from './event-bus-core.js'

/**
 * Narrow interface for the Moleculer ServiceBroker surface used in this file.
 * moleculer's index.d.ts chains through eventemitter2 whose package.json has
 * no `types` field; typescript-eslint's no-unsafe-* rules flag every
 * broker.X access when eslint no-unsafe rules apply elsewhere.
 */
export interface BrokerLike {
  readonly nodeID: string
  call<T = unknown>(action: string, params?: unknown, opts?: unknown): Promise<T>
  createService(schema: unknown): void
  waitForServices(service: unknown, timeout?: number): Promise<unknown>
  broadcast(event: string, data: unknown): void
  localBus: { on(event: string, handler: (data: unknown) => void): void }
  logger: { warn?: (msg: string) => void }
}

/** Documented boundary: CamStack brokers are always `createBroker` products. */
export function asBrokerLike(broker: ServiceBroker): BrokerLike {
  return broker as BrokerLike
}

/**
 * Topic prefix for clustered EventBus broadcasts. The `camstack.evt.`
 * namespace keeps our events disjoint from Moleculer internal events
 * (`$node.*`, `$services.*`) — the `$event-bus` service's
 * `camstack.evt.**` wildcard handler therefore never sees them.
 */
export const EVENT_TOPIC_PREFIX = 'camstack.evt.'

/** Moleculer event-name wildcard the `$event-bus` service subscribes to. */
const EVENT_TOPIC_WILDCARD = `${EVENT_TOPIC_PREFIX}**`

/** Build the Moleculer broadcast topic for an event category. */
export function clusterEventTopic(category: string): string {
  return EVENT_TOPIC_PREFIX + category
}

/**
 * Per-broker shared bus state. Holds the subscriber list + ring
 * buffer. Every `getBrokerEventBus` view and the `$event-bus`
 * service handler on the same broker share ONE instance — same
 * in-memory ring buffer, same subscriber list, single source of
 * truth. Cross-addon `subscribe` / `emit` within a process is just
 * function calls on a shared map, no broadcast roundtrip.
 *
 * Created lazily; keyed by broker so multiple brokers in the same
 * process (hub tests, agent tests) stay isolated. WeakMap lets
 * brokers GC naturally.
 */
const brokerBusState = new WeakMap<ServiceBroker, SharedBusState>()
/**
 * @param retainRecent - `true` from the hub-main opt-in call site
 *   (`event-bus.service.ts`). If the bus was already created by a non-retaining
 *   caller (e.g. `process-service`, the `$event-bus` handler, or the per-addon
 *   wrapper) we UPGRADE it in place so the opt-in wins regardless of call
 *   order. Only the hub main process ever passes `true`; agents + child runners
 *   never do, so their bus stays one-shot.
 */
function getSharedBusState(broker: ServiceBroker, retainRecent = false): SharedBusState {
  let state = brokerBusState.get(broker)
  if (!state) {
    state = createSharedBusState(retainRecent)
    brokerBusState.set(broker, state)
  } else if (retainRecent && !state.retainRecent) {
    state.retainRecent = true
  }
  return state
}

/** Brokers that already have the `$event-bus` service installed. */
const eventBusServiceInstalled = new WeakSet<ServiceBroker>()

const brokerBusWarnTimestamps = new WeakMap<ServiceBroker, Map<string, number>>()

// ---------------------------------------------------------------------------
// D2 — cross-node (Moleculer) subscription-aware inbound filter
// ---------------------------------------------------------------------------

/**
 * Per-broker node-interest oracle. Returns the FORKED-CHILD interest (the union
 * of this node's UDS children's declared category patterns), or `null` when it
 * is undeclared/unknown (a legacy child, or no forked child has connected yet)
 * → fail-open. Absent (no entry) is also fail-open: pre-D2 behaviour is
 * preserved until a node wires its interest via {@link setNodeEventInterest}.
 *
 * IMPORTANT: this oracle covers ONLY forked/UDS children. In-process
 * ('broker'-mode) subscribers on this same broker (e.g. each addon context's
 * `device.bindings-changed` cache-invalidation sub) are tracked SEPARATELY in
 * {@link brokerLocalInterest}. The gate unions BOTH so it can never starve a
 * live local subscriber of either kind.
 */
const brokerNodeInterest = new WeakMap<ServiceBroker, () => readonly string[] | null>()

/**
 * Per-broker IN-PROCESS subscriber interest: category pattern → live refcount.
 * Populated by `getBrokerEventBus(...).subscribe` (every in-process /
 * 'broker'-mode subscription) and decremented by its unsubscribe. Does NOT
 * include the UDS event bridge's pass-through relay subscription — that is a
 * conduit to forked children (whose real interest the oracle already reports),
 * not a genuine local consumer, so it registers via {@link subscribePassthrough}
 * which bypasses this surface. Keeping the bridge out is what lets the gate
 * actually filter (otherwise the bridge's `*` would make every category wanted).
 */
const brokerLocalInterest = new WeakMap<ServiceBroker, Map<string, number>>()

function bumpLocalInterest(broker: ServiceBroker, pattern: string): void {
  let m = brokerLocalInterest.get(broker)
  if (m === undefined) {
    m = new Map<string, number>()
    brokerLocalInterest.set(broker, m)
  }
  m.set(pattern, (m.get(pattern) ?? 0) + 1)
}

function dropLocalInterest(broker: ServiceBroker, pattern: string): void {
  const m = brokerLocalInterest.get(broker)
  if (m === undefined) return
  const next = (m.get(pattern) ?? 0) - 1
  if (next <= 0) m.delete(pattern)
  else m.set(pattern, next)
}

/** Snapshot of the in-process subscriber category patterns for `broker`. */
function localSubscriberPatterns(broker: ServiceBroker): readonly string[] {
  const m = brokerLocalInterest.get(broker)
  return m === undefined ? [] : [...m.keys()]
}

/**
 * Subscribe a PASS-THROUGH relay handler to the broker's shared bus WITHOUT
 * registering it in the local-interest surface. Used exclusively by the UDS
 * event bridge for its cluster/parent-local → children fan-out subscription:
 * the bridge must receive every event the gate lets through so it can relay to
 * forked children, but it is not itself a terminal consumer, so it must not
 * count toward this node's interest (a counted `*` would defeat the filter).
 * Returns an unsubscribe function.
 */
export function subscribePassthrough(
  broker: ServiceBroker,
  handler: (event: SystemEvent) => void,
): () => void {
  const state = getSharedBusState(broker)
  // Empty filter → `extractCategoryPatterns({})` is `['*']` and
  // `matchesEventFilter` returns true for every event: matches all categories,
  // same as the bridge's previous `parentBus.subscribe({}, …)`. Registered
  // WITHOUT the local-interest callback — a counted `*` would defeat the
  // cross-node filter, which is the whole point of this seam.
  return registerSubscriber(state, {}, handler)
}

/** Per-broker cross-node inbound counters (delivered / would-suppress). */
const brokerCrossNodeStats = new WeakMap<ServiceBroker, { delivered: number; suppressed: number }>()

/** Cross-node inbound fan-out counters for a broker, `{ delivered, suppressed }`. */
export interface MoleculerEventStats {
  readonly delivered: number
  readonly suppressed: number
}

/**
 * Install (or clear, with `null`) the per-node interest oracle consulted by the
 * `$event-bus` inbound handler to decide whether an inbound cross-node event is
 * wanted by any local subscriber on this node. The oracle is read PER-EVENT so a
 * child (un)subscribing takes effect immediately with no re-registration.
 *
 * Only non-retaining nodes (agents) meaningfully filter — a retaining bus (hub
 * main) always accepts every category (it serves `getRecent` + the admin-ui live
 * stream). Installing the oracle on the hub too is therefore harmless and keeps
 * the wiring uniform.
 */
export function setNodeEventInterest(
  broker: ServiceBroker,
  oracle: (() => readonly string[] | null) | null,
): void {
  if (oracle === null) brokerNodeInterest.delete(broker)
  else brokerNodeInterest.set(broker, oracle)
}

/**
 * Cross-node inbound counters for `broker`, or `null` if no cross-node event has
 * been processed yet. Exposed for the D2 shadow burn-in + operator debug —
 * mirror of `LocalChildRegistry.getChildEventStats`.
 */
export function getMoleculerEventStats(broker: ServiceBroker): MoleculerEventStats | null {
  const s = brokerCrossNodeStats.get(broker)
  return s === undefined ? null : { delivered: s.delivered, suppressed: s.suppressed }
}

function crossNodeStatsFor(broker: ServiceBroker): { delivered: number; suppressed: number } {
  let s = brokerCrossNodeStats.get(broker)
  if (s === undefined) {
    s = { delivered: 0, suppressed: 0 }
    brokerCrossNodeStats.set(broker, s)
  }
  return s
}

/**
 * Compute this node's COMBINED cross-node interest snapshot for the gate:
 *   - `retainRecent` — from the shared bus (hub main → accept everything).
 *   - `interest` — union of (a) forked-child interest (the oracle) and (b) live
 *     in-process subscriber patterns. `null` (fail-open) when the oracle reports
 *     `null` (undeclared / no forked child yet / oracle threw) — we cannot
 *     safely narrow while a forked child's real interest is unknown, and a boot
 *     window with no children yet must not drop everything.
 *
 * The oracle invocation is wrapped in try/catch and fails OPEN on throw — it
 * sits in front of the per-handler try/catch, in the subsystem that previously
 * caused an OOM, so a throwing oracle must never break inbound delivery.
 */
function nodeInterestSnapshot(broker: ServiceBroker): CrossNodeInterestSnapshot {
  const state = getSharedBusState(broker)
  let childInterest: readonly string[] | null
  try {
    const oracle = brokerNodeInterest.get(broker)
    childInterest = oracle ? oracle() : null
  } catch {
    childInterest = null // fail-open on oracle throw
  }
  if (childInterest === null) {
    return { retainRecent: state.retainRecent, interest: null }
  }
  const local = localSubscriberPatterns(broker)
  const interest = [...new Set<string>([...local, ...childInterest])]
  return { retainRecent: state.retainRecent, interest }
}

/**
 * Decide + account for an inbound cross-node event on `broker`. Returns whether
 * the event should be delivered to the local bus: unwanted categories are
 * dropped and counted as `suppressed`. The interest is the UNION of forked-child AND in-process subscribers — the
 * gate never starves a live local subscriber of either kind.
 */
function acceptInboundCrossNode(broker: ServiceBroker, category: string): boolean {
  const wants = crossNodeAcceptsCategory(nodeInterestSnapshot(broker), category)
  const stats = crossNodeStatsFor(broker)
  if (wants) stats.delivered++
  else stats.suppressed++
  return wants
}

/**
 * Register the `$event-bus` service on a broker. MUST be called BEFORE
 * `broker.start()` — Moleculer announces a service's event
 * subscriptions to remote nodes only during the discovery handshake;
 * a post-start `createService` propagates via the ~10s heartbeat and
 * makes cross-node delivery unreliable in the meantime.
 *
 * The service's single wildcard handler (`camstack.evt.**`) is the
 * inbound bridge: every `broker.broadcast('camstack.evt.<cat>', event)`
 * from any node lands here. Self-origin echoes are dropped (the
 * emitting node already delivered synchronously in `emit`).
 *
 * Idempotent. Internal service (`$`-prefixed) — hidden from the
 * capability graph.
 *
 * Callers:
 *  - hub backend (`MoleculerService.onModuleInit`), before `broker.start()`
 *  - agent bootstrap, before `broker.start()`
 *  - forkable process / group runner, before `broker.start()`
 */
export function registerEventBusService(broker: ServiceBroker): void {
  if (eventBusServiceInstalled.has(broker)) return
  eventBusServiceInstalled.add(broker)
  try {
    broker.createService({
      name: '$event-bus',
      events: {
        [EVENT_TOPIC_WILDCARD](ctx: unknown) {
          const params = (ctx as { params?: unknown }).params
          const event = params as (SystemEvent & { sourceNodeId?: string }) | undefined
          if (!event) return
          if (event.sourceNodeId === broker.nodeID) return // own broadcast echo
          // D2 subscription-aware gate: drop inbound cross-node categories no
          // local subscriber on this node wants (fail-open inside
          // `acceptInboundCrossNode`). A retaining bus (hub main) always accepts.
          if (!acceptInboundCrossNode(broker, event.category)) return
          deliverShared(getSharedBusState(broker), event)
        },
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    try {
      broker.logger?.warn?.(`[event-bus] failed to register $event-bus service: ${msg}`)
    } catch {
      /* swallow */
    }
  }
}

/**
 * @param options.retainRecent - Pass `true` ONLY from the hub main process
 *   (`EventBusService.attachBroker`), the single process that serves the
 *   `getRecent`/audit capability. Every other caller (agents, child runners,
 *   the per-addon wrapper, the `$event-bus` handler) omits it → the bus retains
 *   nothing and `getRecent` returns `[]`. Events are one-shot everywhere else.
 */
export function getBrokerEventBus(
  broker: ServiceBroker,
  options?: { retainRecent?: boolean },
): IEventBus {
  const state = getSharedBusState(broker, options?.retainRecent ?? false)

  // Idempotent fallback — if a caller forgot pre-start registration,
  // install the `$event-bus` service now so local delivery still
  // works. Cross-node delivery may arrive late (after the next
  // heartbeat) until the subscription propagates, but the in-process
  // bus is correct immediately. `registerEventBusService` is itself
  // idempotent against the pre-start call sites.
  registerEventBusService(broker)

  const warnTimestamps = (() => {
    let m = brokerBusWarnTimestamps.get(broker)
    if (!m) {
      m = new Map<string, number>()
      brokerBusWarnTimestamps.set(broker, m)
    }
    return m
  })()

  return {
    emit(event: SystemEvent) {
      const enriched: SystemEvent & { sourceNodeId: string } = {
        ...event,
        sourceNodeId: broker.nodeID,
      }
      // Synchronous local fan-out — all addons in this process share
      // `state`, so cross-addon subscribe → emit honours the
      // same-process contract without any broadcast roundtrip.
      deliverShared(state, enriched)
      // Cluster fan-out — one Moleculer event per category under the
      // `camstack.evt.` namespace. The echo back to the `$event-bus`
      // service on this broker is filtered out by its handler
      // (`sourceNodeId` matches), so we don't double-fire local
      // subscribers.
      const topic = clusterEventTopic(event.category)
      try {
        broker.broadcast(topic, enriched)
      } catch (err) {
        const cat = event.category
        const now = Date.now()
        const prev = warnTimestamps.get(`broadcast:${cat}`) ?? 0
        if (now - prev > 60_000) {
          warnTimestamps.set(`broadcast:${cat}`, now)
          try {
            broker.logger?.warn?.(
              `[event-bus] broker.broadcast('${topic}') failed for category="${cat}" nodeID="${broker.nodeID}": ${err instanceof Error ? err.message : String(err)}`,
            )
          } catch {
            /* swallow */
          }
        }
      }
    },
    subscribe(filter: EventFilter | string, handler: (event: SystemEvent) => void): () => void {
      // EVERY category the filter names becomes a key (`registerSubscriber`) —
      // an array filter used to register only its first element, so the other
      // categories were neither delivered locally nor declared to the
      // cross-node gate below.
      //
      // D2: record this IN-PROCESS subscriber's category patterns in the
      // per-broker local-interest surface so the cross-node inbound gate never
      // drops a category a live in-process ('broker'-mode) addon wants. Every
      // `createBrokerEventBus(...).subscribe` (e.g. each addon context's
      // `device.bindings-changed` cache-invalidation sub) flows through here.
      return registerSubscriber(state, filter, handler, (patterns, added) => {
        for (const pattern of patterns) {
          if (added) bumpLocalInterest(broker, pattern)
          else dropLocalInterest(broker, pattern)
        }
      })
    },
    getRecent(filter?: EventFilter, limit?: number) {
      // A per-device ask is answered from that DEVICE'S ring, never by
      // filtering the global one: the global ring is a fleet-wide count, so a
      // busy fleet had already evicted the quiet camera the operator is asking
      // about. `getDeviceRecent` returns [] for a device that has emitted
      // nothing — which is also what filtering the global ring returned, so the
      // shape of the answer is unchanged.
      const source =
        filter?.deviceId !== undefined
          ? getDeviceRecent(state.deviceRings, filter.deviceId)
          : state.recent
      // Apply the FULL filter (category + agentId + addonId + deviceId
      // + source + since), mirroring `subscribe`'s delivery semantics.
      const filtered = filter
        ? source.filter((e) => {
            const cat = filter.category
            if (cat) {
              const categories = typeof cat === 'string' ? [cat] : Array.isArray(cat) ? cat : []
              if (
                categories.length > 0 &&
                !categories.some((c) => matchesPattern(String(c), e.category))
              ) {
                return false
              }
            }
            return matchesEventFilter(e, filter)
          })
        : source
      return limit !== undefined ? filtered.slice(-limit) : filtered
    },
  }
}

export function createBrokerEventBus(broker: ServiceBroker, addonId: string): IEventBus {
  // Per-addon thin wrapper: subscribe / getRecent delegate straight to
  // the shared per-broker bus, but `emit` enriches the event with
  // `sourceAddonId` so cluster consumers can attribute every event back
  // to the addon that produced it (the broker bus already adds
  // `sourceNodeId`). Without this wrapper every emit is anonymous at
  // the addon level and downstream filters / dashboards lose the
  // ability to scope by addon.
  const shared = getBrokerEventBus(broker)
  return {
    emit(event: SystemEvent) {
      const enriched: SystemEvent & { sourceAddonId: string } = {
        ...event,
        sourceAddonId: addonId,
      }
      shared.emit(enriched)
    },
    subscribe: shared.subscribe.bind(shared),
    getRecent: shared.getRecent.bind(shared),
  }
}
