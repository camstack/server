/**
 * UDS-backed IEventBus for a forked child process (C1).
 *
 * Behaviour:
 *  - `emit(event)` — enriches with `sourceAddonId`, calls `deliverShared` for
 *    same-process local delivery, then forwards to the parent via
 *    `client.emitEvent`.
 *  - Inbound parent→child events (registered via `client.onEvent`) are fed
 *    into `deliverShared` so local subscribers receive them. They are NOT
 *    re-sent to the parent (no echo — the parent's C2 logic is responsible
 *    for not bouncing a child's own events back).
 *  - `subscribe` / `getRecent` delegate to the local `SharedBusState` using
 *    the same helpers as the Moleculer broker bus so filter semantics and
 *    the high-frequency deny-list behave identically.
 *
 * ## ONE shared state per channel — the group-runner contract
 *
 * `SharedBusState` is shared across every bus created on the SAME
 * `UdsEventChannel`, and `client.onEvent` is registered exactly ONCE per
 * channel (mirrors `getBrokerEventBus`'s "single in-process delivery map per
 * broker" — the property `createBrokerEventBus` already had). This matters for
 * GROUPED runners (`execution.group`), where several addons share one process
 * and therefore one `LocalChildClient`:
 *
 *   `LocalChildClient.onEvent` is SINGLE-SLOT (a new handler replaces the
 *   prior one). When each co-located addon's context built its own private
 *   state and registered its own `onEvent`, only the LAST-created addon's bus
 *   ever received parent→child events — every earlier addon's subscriptions
 *   were silently dead. In the `detection` group (pipeline-runner,
 *   detection-pipeline, motion-wasm — load order) this killed pipeline-runner's
 *   `MotionOnMotionChanged` subscriber: the dynamic onboard→analyzer gate never
 *   fired, the shared motion sink never registered, and no camera produced
 *   motion boxes, while the child's DECLARED pattern union (per-owner
 *   `updateEventPatterns`) still advertised the category, so the parent
 *   faithfully fanned events into a state with no subscriber.
 *
 * The per-addon return value is a thin facade over the shared state: `emit`
 * stamps the calling addon's `sourceAddonId`; `subscribe` reports the shared
 * key set under the calling addon's ownerId (a superset per owner — safe:
 * over-forwarding is filtered by the child-side delivery gate, and the
 * parent-forward ≡ child-deliver parity is exact because both read the same
 * shared key set). Sharing the state also restores broker-bus parity for
 * in-process sibling emits: an event emitted by one co-located addon reaches
 * another's subscriber synchronously, without a parent round-trip.
 *
 * The `UdsEventChannel` interface is the minimal surface this module needs
 * from `LocalChildClient` — typed structurally so tests can provide a fake
 * without any casts.
 */
import type { EventFilter, IEventBus, SystemEvent } from '@camstack/types'
import type { SharedBusState } from '../moleculer/event-bus-core.js'
import {
  createSharedBusState,
  deliverShared,
  isHighFrequencyCategory,
  matchesEventFilter,
  matchesPattern,
  registerSubscriber,
} from '../moleculer/event-bus-core.js'

// ---------------------------------------------------------------------------
// Public interface for the UDS channel surface this bus requires
// ---------------------------------------------------------------------------

/**
 * Minimal interface this bus requires from the child-side UDS transport.
 * `LocalChildClient` satisfies it structurally; tests can provide a fake.
 *
 * - `emitEvent` — fire-and-forget: send a system event to the parent.
 * - `onEvent`   — register the single handler for parent→child events.
 *   (Only one handler is registered; calling again replaces the previous one.
 *   Because the slot is single, this module registers it exactly ONCE per
 *   channel — the shared-state factory below — never once per addon bus.)
 * - `updateEventPatterns` — declare this owner's live category-pattern set to
 *   the parent so it can subscription-filter the event fan-out. Called after
 *   every subscribe/unsubscribe with the CURRENT key set (full-set replace).
 *   Keyed by `ownerId` (the addonId) so multiple buses sharing one client
 *   union correctly.
 */
export interface UdsEventChannel {
  emitEvent(event: SystemEvent): void
  onEvent(handler: (event: SystemEvent) => void): void
  updateEventPatterns(ownerId: string, patterns: readonly string[]): void
  /**
   * Optional: receive the categories someone else wants (`event-interest`).
   * Single slot, registered once per channel. A channel without it never learns
   * an interest set, so its bus sends everything (fail open).
   */
  onEventInterest?(handler: (patterns: readonly string[] | null) => void): void
}

/** The slice of a scoped logger the bus needs for its one-line-per-spell record. */
export interface UdsEventBusLogger {
  info(message: string, context?: Record<string, unknown>): void
}

export interface UdsEventBusOptions {
  readonly logger?: UdsEventBusLogger
}

/**
 * What the parent last said others want, per channel. `patterns === null` until
 * the first push (and after a `null` push): send everything.
 */
interface InterestState {
  patterns: readonly string[] | null
  /** Categories already logged in the CURRENT suppressed spell. */
  readonly logged: Set<string>
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * ONE `SharedBusState` per `UdsEventChannel` (see the module doc's
 * group-runner contract). Keyed weakly so a channel torn down with its
 * process does not pin its state.
 */
const sharedStateByChannel = new WeakMap<UdsEventChannel, SharedBusState>()
const interestByChannel = new WeakMap<UdsEventChannel, InterestState>()

/**
 * Should `category` cross the process boundary? A category the hub retains
 * (anything not high-frequency) always goes; a high-frequency one goes only if
 * the parent said someone else wants it. No set yet → everything goes.
 */
function crossesBoundary(interest: InterestState, category: string): boolean {
  if (interest.patterns === null) return true
  if (!isHighFrequencyCategory(category)) return true
  return interest.patterns.some((p) => matchesPattern(p, category))
}

/**
 * Resolve (or lazily create) the channel's shared bus state, registering the
 * single-slot `client.onEvent` handler exactly once — on first creation. The
 * handler delivers into the SHARED state, so every co-located addon's
 * subscribers see parent→child events regardless of bus construction order.
 * It does NOT call `client.emitEvent` (no echo back to the parent).
 */
function sharedStateFor(client: UdsEventChannel): SharedBusState {
  const existing = sharedStateByChannel.get(client)
  if (existing !== undefined) return existing
  // A child runner is one-shot: it fans events out to its own local subscribers
  // but retains NOTHING. `createSharedBusState()` defaults `retainRecent` to
  // false, so `deliverShared` never populates `recent[]` here and `getRecent`
  // always returns `[]` — only the hub main process serves the audit
  // registry. This is intentional: child heaps can't accumulate an unbounded
  // recent[] backlog.
  const created = createSharedBusState()
  sharedStateByChannel.set(client, created)
  const interest: InterestState = { patterns: null, logged: new Set() }
  interestByChannel.set(client, interest)
  client.onEventInterest?.((patterns) => {
    interest.patterns = patterns
    // A new set starts a new suppressed spell: a category that was announced
    // before may be announced again if it goes unwanted again.
    interest.logged.clear()
  })
  client.onEvent((event: SystemEvent) => {
    deliverShared(created, event)
  })
  return created
}

/**
 * Create a UDS-backed `IEventBus` for use inside a forked child process.
 * Returns a per-addon facade over the channel's ONE shared state (module doc).
 *
 * @param client  - The UDS channel toward the parent (hub or agent).
 * @param addonId - This child's stable addon id — stamped as `sourceAddonId`
 *                  on every outbound event so cluster consumers can attribute
 *                  events to their source addon.
 */
export function createUdsEventBus(
  client: UdsEventChannel,
  addonId: string,
  options?: UdsEventBusOptions,
): IEventBus {
  const state = sharedStateFor(client)
  const interest = interestByChannel.get(client)

  // Report the current category-pattern key set to the parent so it can
  // subscription-filter the fan-out. The reported set IS `[...handlers.keys()]`
  // — exactly the set the child's own `deliverShared` gate uses — giving
  // provable delivery parity between the parent forward-decision and the
  // child's local map-key filter.
  const reportPatterns = (): void => {
    client.updateEventPatterns(addonId, [...state.handlers.keys()])
  }

  return {
    emit(event: SystemEvent): void {
      const enriched: SystemEvent & { sourceAddonId: string } = {
        ...event,
        sourceAddonId: addonId,
      }
      // Synchronous local fan-out — same-process subscribers receive the
      // event immediately, matching the broker bus contract.
      deliverShared(state, enriched)
      // Cross-process forwarding — the parent delivers to the hub event bus
      // and fan-out to other nodes. Fire-and-forget (buffered pre-connect).
      //
      // Telemetry may be dropped (D8): a high-frequency category nobody else
      // wants is not serialised at all. The first one of each spell is logged
      // (D391) — the silence is otherwise indistinguishable from "never emitted".
      if (interest === undefined || crossesBoundary(interest, enriched.category)) {
        client.emitEvent(enriched)
        return
      }
      if (!interest.logged.has(enriched.category)) {
        interest.logged.add(enriched.category)
        options?.logger?.info('event category suppressed: no consumer', {
          category: enriched.category,
        })
      }
    },

    subscribe(filter: EventFilter | string, handler: (event: SystemEvent) => void): () => void {
      // EVERY category the filter names becomes a key — see
      // `registerSubscriber`. On this bus that is not a local nicety: the key
      // set IS what the parent is told to forward, so a category that never
      // became a key never crosses the process boundary. `registerSubscriber`
      // also deletes an emptied key, which is what lets a child that
      // unsubscribes everything genuinely drop to its framework baseline
      // instead of pinning the parent to a category nobody wants.
      return registerSubscriber(state, filter, handler, () => reportPatterns())
    },

    getRecent(filter?: EventFilter, limit?: number): readonly SystemEvent[] {
      const filtered = filter
        ? state.recent.filter((e) => {
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
        : state.recent
      return limit !== undefined ? filtered.slice(-limit) : filtered
    },
  }
}
