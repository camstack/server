import type { IEventBus, IScopedLogger } from '@camstack/types'
import { ReadinessRegistry } from '@camstack/types/addon'
import type { ServiceBroker } from 'moleculer'
import { asBrokerLike } from './event-bus.js'

/**
 * Minimal interface for the `LocalChildClient` surface used in UDS-mode
 * readiness hydration. Declared here (rather than importing the concrete
 * class) so this module stays free of a direct transport dependency and
 * remains independently testable with a plain fake object.
 */
interface UdsReadinessClient {
  /** True once `start()` has connected and registered with the parent. */
  readonly isConnected: boolean
  /** Request the current readiness snapshot from the parent over UDS. */
  requestReadinessSnapshot(): Promise<readonly import('@camstack/types').IReadinessRegistryRecord[]>
  /** Register a callback fired each time the client connects (including reconnects). */
  onConnected(cb: () => void): void
}

/**
 * Per-broker shared `ReadinessRegistry`. All addon contexts created on
 * the same broker share one instance so there's a single subscription
 * on the event bus and a consistent snapshot across consumers.
 *
 * Lazy-initialised on first `createAddonContext` call. Survives for the
 * broker's lifetime — closed only when the process exits (there's no
 * safe per-addon teardown since multiple addons share it).
 */
const brokerReadinessRegistries = new WeakMap<ServiceBroker, ReadinessRegistry>()

/**
 * Per-child-node shared `ReadinessRegistry` for UDS-mode children.
 * Keyed by the runner's stable node id (string) rather than a broker
 * instance — there is no broker in UDS-only mode.
 */
// Plain Map (not WeakMap): keyed by runner nodeId (string, not object); one entry per
// UDS child, process-lifetime matches the runner — no GC pressure, no dangling refs.
const clientReadinessRegistries = new Map<string, ReadinessRegistry>()

/**
 * Fixed-period authoritative snapshot re-pull (D8 reconcile). Readiness
 * deltas are telemetry — lossy across the UDS/Moleculer hops — and the
 * on-(re)connect hydrate alone cannot repair a delta lost while
 * CONNECTED (2026-07-17: the agent's platform-probe `ready` never
 * reached the detection runner child; the child held `starting` forever
 * and every waiter wedged). With `ReadinessRegistry.hydrate` able to
 * ADVANCE stale records, this periodic re-pull bounds the damage of any
 * lost delta to one reconcile round. Not a retry backoff — a
 * steady-state reconcile against the authority. `unref()`d so the timer
 * never keeps a process alive; registries are process-lifetime, so the
 * interval is never cleared.
 */
const READINESS_RECONCILE_INTERVAL_MS = 60_000

/**
 * Return the shared ReadinessRegistry for this broker — one per
 * process is enough. Every addon context on the same broker gets the
 * same instance via `ctx.kernel.readinessRegistry`.
 *
 * For non-hub brokers (forked workers + remote agents) the registry
 * is hydrated from the hub's `$readiness.getSnapshot` Moleculer action
 * on every `$node.connected` — this closes the boot-time race where
 * `broker.broadcast` consumers on the hub fire before the worker is
 * in the cluster, and makes hub reconnects refresh consumer state
 * without forcing every producer to re-emit. Live deltas continue
 * through the normal `system.ready-state` event bridge; hydrate skips
 * entries already observed locally.
 */
function getOrInitReadinessRegistry(
  broker: ServiceBroker,
  eventBus: IEventBus,
  logger: IScopedLogger,
): ReadinessRegistry {
  const bkr = asBrokerLike(broker)
  const existing = brokerReadinessRegistries.get(broker)
  if (existing) return existing
  const registry = new ReadinessRegistry({
    eventBus,
    sourceNodeId: bkr.nodeID,
    logger,
  })
  brokerReadinessRegistries.set(broker, registry)

  // Hub is the source of truth — don't hydrate from itself. Workers
  // and agents call the hub service on every hub reconnect.
  if (bkr.nodeID !== 'hub') {
    const hydrateFromHub = async (): Promise<void> => {
      try {
        const snapshot = await bkr.call<
          readonly import('@camstack/types').IReadinessRegistryRecord[]
        >('$readiness.getSnapshot', {})
        if (Array.isArray(snapshot) && snapshot.length > 0) {
          const applied = registry.hydrate(snapshot)
          // Silent when nothing changed: this runs every 60s in EVERY child
          // process and the unconditional line was ≈2 800 rows/hour of pure
          // "nothing happened" in the hub LogManager.
          if (applied > 0) {
            logger.debug?.(`readiness: hydrated ${applied}/${snapshot.length} record(s) from hub`)
          }
        }
      } catch (err) {
        // First attempts during TCP handshake / service propagation can
        // fail with "Service not found" — silent retry on the next
        // $node.connected is good enough (the gate is <1s typically).
        const msg = err instanceof Error ? err.message : String(err)
        if (!msg.includes('not found') && !msg.includes('NOT_FOUND')) {
          logger.warn?.(`readiness: hydrate from hub failed: ${msg}`)
        }
      }
    }
    // Eager hydrate — `getOrInitReadinessRegistry` is called lazily as
    // addons build their contexts. By that time the parent broker has
    // already started, the `$node.connected` event for hub has fired,
    // and the listener below is too late. Trigger an immediate hydrate
    // so consumers (e.g. `worker-device-restore.awaitReady`) see the
    // current snapshot without waiting for the next event.
    void hydrateFromHub()
    bkr.localBus.on('$node.connected', (data: unknown) => {
      const node = (data as { node?: { id?: string } }).node
      if (node?.id === 'hub') {
        void hydrateFromHub()
      }
    })
    // Reconcile readiness when the cluster's service topology changes.
    // A sibling capability (e.g. pipeline-executor) that becomes `ready`
    // AFTER our eager hydrate is otherwise missed when its live
    // `system.ready-state` delta never reaches this forked child — the
    // boot-time readiness race that wedges `acquireCapability(Infinity)`
    // forever (observed live: the orchestrator hangs in
    // `waitForAgentAndCatalog` because pipeline-executor's `ready`
    // transition arrived after the snapshot was pulled). `$services.changed`
    // is the broker's authoritative signal that the registry changed; we
    // re-pull the hub snapshot so pending `awaitReady()` callers unblock.
    // This is reconcile-on-topology-change, NOT a fixed-delay retry loop.
    // `registry.hydrate()` skips keys already observed locally, so this
    // only fills gaps — it never clobbers a live local delta. The 200ms
    // debounce coalesces the burst of `$services.changed` events that
    // fire as many addons register during boot.
    let rehydrateScheduled = false
    const scheduleRehydrate = (): void => {
      if (rehydrateScheduled) return
      rehydrateScheduled = true
      setTimeout(() => {
        rehydrateScheduled = false
        void hydrateFromHub()
      }, 200)
    }
    bkr.localBus.on('$services.changed', scheduleRehydrate)
    // Periodic reconcile against the hub's authoritative snapshot — see
    // READINESS_RECONCILE_INTERVAL_MS. Event/topology triggers above stay
    // the fast path; this is the loss-proof floor.
    const reconcileTimer = setInterval(() => {
      void hydrateFromHub()
    }, READINESS_RECONCILE_INTERVAL_MS)
    if (typeof reconcileTimer.unref === 'function') reconcileTimer.unref()
  }

  return registry
}

/**
 * Return (or create) the shared `ReadinessRegistry` for a UDS-only child
 * process — one per child node id. The registry is hydrated from the parent
 * over UDS instead of via `$readiness.getSnapshot` Moleculer action.
 *
 * **Hydration strategy:**
 *   - Initial snapshot: `client.requestReadinessSnapshot()` is called once
 *     `client.isConnected` becomes true (the `onConnected` callback).
 *   - Reconnect: each time `onConnected` fires again (the client re-connected
 *     after a parent-side restart), a fresh snapshot is pulled so pending
 *     `awaitReady` callers can unblock.
 *   - Live deltas: `system.ready-state` events arrive via the UDS event bus
 *     (Phase C) — the registry ingests them through its own event-bus
 *     subscription, exactly as in broker mode.
 *
 * **Periodic reconcile (D8):**
 *   The original design assumed the parent reliably forwards every
 *   `system.ready-state` delta over UDS, so no reconcile signal beyond
 *   the (re)connect hydrate was added. The 2026-07-17 incident disproved
 *   the assumption end-to-end: a delta can be lost across the full
 *   producer→parent→child path (restart churn, subscription races), and
 *   a child that saw `starting` then never got `ready` wedged forever.
 *   The registry therefore ALSO re-pulls the parent snapshot every
 *   `READINESS_RECONCILE_INTERVAL_MS` while connected — combined with
 *   `hydrate`'s advance semantics, a lost delta costs one reconcile
 *   round, never forever. No new parent-to-child protocol message is
 *   needed (the existing snapshot request is reused).
 *
 * **`awaitReady`/`acquireCapability`/`onReadyState` semantics unchanged.**
 *
 * Keep `$readiness.getSnapshot` (broker path) intact — Phase F removes it.
 */
function getOrInitReadinessRegistryForClient(
  client: UdsReadinessClient,
  eventBus: IEventBus,
  logger: IScopedLogger,
  nodeId: string,
): ReadinessRegistry {
  const existing = clientReadinessRegistries.get(nodeId)
  if (existing) return existing

  const registry = new ReadinessRegistry({
    eventBus,
    sourceNodeId: nodeId,
    logger,
  })
  clientReadinessRegistries.set(nodeId, registry)

  const hydrateFromParent = async (): Promise<void> => {
    try {
      const snapshot = await client.requestReadinessSnapshot()
      if (Array.isArray(snapshot) && snapshot.length > 0) {
        const applied = registry.hydrate(snapshot)
        // Same volume gate as the broker path above: the every-60s
        // reconcile stays silent unless it actually changed local state.
        if (applied > 0) {
          logger.debug?.(
            `readiness: hydrated ${applied}/${snapshot.length} record(s) from parent over UDS`,
          )
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn?.(`readiness: UDS snapshot request failed: ${msg}`)
    }
  }

  // Register the connect callback. It fires on every (re)connect so both the
  // initial hydrate AND post-disconnect reconnect re-pulls are covered.
  client.onConnected(() => {
    void hydrateFromParent()
  })

  // If the client is already connected when this function is called (late
  // initialization race), trigger an eager hydrate so callers don't miss
  // the current snapshot.
  if (client.isConnected) {
    void hydrateFromParent()
  }

  // Periodic reconcile against the parent's authoritative snapshot — see
  // READINESS_RECONCILE_INTERVAL_MS. Gated on `isConnected` so a
  // disconnected child doesn't spam failed snapshot requests (the
  // onConnected hydrate covers the reconnect edge).
  const reconcileTimer = setInterval(() => {
    if (client.isConnected) void hydrateFromParent()
  }, READINESS_RECONCILE_INTERVAL_MS)
  if (typeof reconcileTimer.unref === 'function') reconcileTimer.unref()

  return registry
}

export type { UdsReadinessClient }
export { getOrInitReadinessRegistry, getOrInitReadinessRegistryForClient }
