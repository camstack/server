/**
 * Parent-side UDS ↔ Moleculer event bridge (C2).
 *
 * Wires the `LocalChildRegistry`'s child-event stream into the parent's own
 * event bus + the cross-node Moleculer cluster, and forwards cluster / parent-
 * local events back to every UDS child — with NO echo and NO duplicate delivery.
 *
 * ## Echo / duplication prevention (id-dedupe set)
 *
 * When a child emits event E:
 *  1. The bridge fans E to siblings immediately via
 *     `registry.broadcastEventToChildren(E, parentNodeId, childId)`.
 *  2. The bridge records E.id in `recentlyFannedIds` and emits the CLEAN
 *     (unmarked) event to the parent bus so parent-local subscribers and the
 *     cluster receive it. The cluster broadcast carries the clean event — no
 *     extra fields travel to remote nodes.
 *  3. The bridge's own parent-bus subscriber fires synchronously inside
 *     `parentBus.emit` (deliverShared is synchronous). Because `recentlyFannedIds`
 *     was populated in step 2 BEFORE `parentBus.emit` returns, the id is in the
 *     set when the loopback check runs — no re-fan occurs.
 *  4. For any event whose id is NOT in `recentlyFannedIds` (remote cluster event,
 *     parent-process-local event) the subscriber fans it to all children.
 *
 * The set is bounded at MAX_RECENT entries (FIFO eviction of the oldest).
 * Normal event rates are well below this limit; the cap prevents unbounded growth
 * if the bridge is left live for a long time with no dispose.
 */
import type { IEventBus, SystemEvent } from '@camstack/types'

// ---------------------------------------------------------------------------
// Dependency interface
// ---------------------------------------------------------------------------

/**
 * Minimal surface the bridge requires from `LocalChildRegistry`.
 * Structurally typed so tests can provide a fake without any casts.
 *
 * CONTRACT: `broadcastEventToChildren` is SUBSCRIPTION-FILTERED. The registry
 * fans an event only to children whose declared category-pattern set matches
 * `event.category` (mirror of each child's local `SharedBusState.handlers`
 * keys). A child that never declared a set (legacy/undeclared) fails OPEN and
 * receives everything. There is no kill-switch any more (the
 * `CAMSTACK_UDS_EVENT_FANOUT` modes were removed on 2026-10-06). The bridge itself
 * needs no per-event logic change — both fan-out call sites here go through the
 * filtered `broadcastEventToChildren`. `sendEventToChild` (targeted push) is
 * NOT filtered — an explicit single-child send expresses intent.
 */
export interface ChildEventBroadcaster {
  /**
   * Register the (single) child-event handler, or pass `null` to clear it.
   * A new handler replaces the prior one; `null` removes it entirely.
   */
  onChildEvent(handler: ((childId: string, event: SystemEvent) => void) | null): void
  sendEventToChild(childId: string, event: SystemEvent, sourceNodeId: string): void
  broadcastEventToChildren(event: SystemEvent, sourceNodeId: string, exceptChildId?: string): void
}

/**
 * Dependencies for the UDS event bridge.
 */
export interface UdsEventBridgeDeps {
  /** The parent-side child registry. Only the event-related surface is required. */
  readonly registry: ChildEventBroadcaster
  /** The parent process's event bus (backed by `getBrokerEventBus(broker)`). */
  readonly parentBus: IEventBus
  /** This process's Moleculer node ID (e.g. `'hub'` or `'agent-a1b2c3'`). */
  readonly parentNodeId: string
  /**
   * D2: subscribe the bridge's cluster/parent-local → children RELAY handler to
   * the parent bus WITHOUT registering it in the node's local-interest surface
   * (`subscribePassthrough` from `@camstack/system`). The bridge is a conduit to
   * forked children, not a terminal local consumer — counting its wildcard `*`
   * subscription would make every cross-node category appear "wanted" and defeat
   * the inbound gate. When omitted (tests / legacy callers) the bridge falls
   * back to `parentBus.subscribe({}, …)`, which is functionally correct but
   * counts toward local interest — acceptable only where the D2 gate is not
   * under test.
   */
  readonly subscribePassthrough?: (handler: (event: SystemEvent) => void) => () => void
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of event ids retained in the loopback-dedup set.
 * FIFO eviction drops the oldest entry when the limit is reached.
 */
const MAX_RECENT = 512

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the parent-side UDS ↔ Moleculer event bridge.
 *
 * Call this once after the parent's `LocalChildRegistry` and `IEventBus` are
 * both ready. The bridge is inert-but-correct while no children are connected
 * (UDS child events never arrive, cluster events are fan-outed to zero children).
 *
 * @returns A disposer function that unsubscribes the bridge from the parent bus
 *          and clears the child-event handler. Call it on process shutdown.
 */
export function createUdsEventBridge(deps: UdsEventBridgeDeps): () => void {
  const { registry, parentBus, parentNodeId, subscribePassthrough } = deps

  /**
   * In-memory set of event ids for events that originated from one of this
   * bridge's UDS children and have already been fanned to siblings + the
   * parent bus. Used by the parent-bus subscriber to skip re-fanning the
   * synchronous loopback delivery that `parentBus.emit` causes.
   *
   * Bounded at MAX_RECENT via FIFO eviction of the oldest id.
   */
  const recentlyFannedIds = new Set<string>()

  // ── child → parent path ──────────────────────────────────────────────────
  // Fired when a UDS child calls `LocalChildClient.emitEvent(evt)`.
  // Strategy:
  //   1. Fan E to siblings immediately (before emit) so broadcastEventToChildren
  //      uses the clean event and the originating child is excluded.
  //   2. Record E.id in recentlyFannedIds BEFORE calling parentBus.emit so the
  //      synchronous loopback delivery in the bus subscriber below finds the id
  //      already in the set.
  //   3. Emit the CLEAN (unmarked) event to the parent bus — the cluster
  //      broadcast carries no extra fields; remote bridges see a clean event
  //      and correctly fan it to their own children.
  registry.onChildEvent((childId: string, event: SystemEvent): void => {
    // Step 1 — fan to siblings (excluding origin).
    registry.broadcastEventToChildren(event, parentNodeId, childId)

    // Step 2 — record id for loopback suppression (must come BEFORE emit).
    recentlyFannedIds.add(event.id)
    if (recentlyFannedIds.size > MAX_RECENT) {
      const oldest = recentlyFannedIds.values().next().value
      if (oldest !== undefined) recentlyFannedIds.delete(oldest)
    }

    // Step 3 — forward clean event to parent bus + cluster.
    parentBus.emit(event)
  })

  // ── parent bus → children path ───────────────────────────────────────────
  // Fired for ALL events that pass through the parent bus:
  //   - cluster-inbound events (from remote agents / hub via `$event-bus`)
  //   - parent-process-local emits (from hub addons or the hub itself)
  //   - the child-origin re-emits we just did above (must be skipped)
  //
  // Skip: events whose id is in recentlyFannedIds — we already fanned those
  // in the child-event handler above. The check fires synchronously inside
  // parentBus.emit (deliverShared is sync), so the id is guaranteed to be
  // present when this callback runs for the loopback delivery.
  // Empty EventFilter — no `category` key → extractCategoryPattern returns '*'
  // → matchesPattern('*', any) is true → matches ALL categories at runtime.
  // Type-valid against the IEventBus.subscribe(EventFilter, handler) overload
  // because every field on EventFilter is optional.
  const relayHandler = (event: SystemEvent): void => {
    if (recentlyFannedIds.has(event.id)) {
      // Already fanned to siblings in the child-event handler. Skip.
      return
    }
    // Cluster or parent-local event — fan to ALL children.
    registry.broadcastEventToChildren(event, parentNodeId, undefined)
  }
  // D2: prefer the pass-through subscription (does NOT count toward the node's
  // local interest); fall back to the counted bus subscribe for legacy callers.
  const unsubscribe =
    subscribePassthrough !== undefined
      ? subscribePassthrough(relayHandler)
      : parentBus.subscribe({}, relayHandler)

  // ── disposer ─────────────────────────────────────────────────────────────
  return (): void => {
    unsubscribe()
    // Clear the child-event handler so stale in-flight events from a child
    // don't reach a disposed bridge. Passing null is the single-slot contract.
    registry.onChildEvent(null)
  }
}
