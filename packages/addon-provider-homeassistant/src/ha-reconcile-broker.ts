import type { HaDiscoveredDevice } from './ha-discovery-types.js'

/**
 * Per-broker reconcile orchestration: fetch the live HA inventory ONCE and feed
 * the SAME snapshot to both the Container reconciler and the standalone-entity
 * reconciler. Without this both reconcilers would each fetch independently — 6 WS
 * round-trips per broker per tick instead of 3.
 *
 * Pure-ish: all I/O is injected. Best-effort isolation —
 *   - a discovery fetch failure for this broker is swallowed (the caller logs
 *     within `fetch`/`onFetchError`) and NEITHER reconciler runs, but the sweep
 *     over OTHER brokers continues;
 *   - a failure inside EITHER reconciler never prevents the OTHER from running,
 *     and never propagates out (so one broker never aborts a multi-broker sweep).
 */
export interface ReconcileBrokerDeps {
  /** Fetch the live HA inventory for the broker. Throws on transport failure. */
  fetch: (brokerId: string) => Promise<readonly HaDiscoveredDevice[]>
  /** Reconcile adopted Containers against the shared inventory snapshot. */
  reconcileContainers: (
    brokerId: string,
    discovered: readonly HaDiscoveredDevice[],
  ) => Promise<void>
  /** Reconcile standalone entity devices against the shared inventory snapshot. */
  reconcileStandalone: (
    brokerId: string,
    discovered: readonly HaDiscoveredDevice[],
  ) => Promise<void>
  /** Called when the single per-tick fetch fails (best-effort logging hook). */
  onFetchError?: (brokerId: string, error: unknown) => void
}

/**
 * Run BOTH reconcilers for one broker off a SINGLE shared inventory fetch.
 * Never throws — every failure is isolated so a multi-broker sweep (and the
 * on-connect callback) stays best-effort.
 */
export async function reconcileBroker(brokerId: string, deps: ReconcileBrokerDeps): Promise<void> {
  let discovered: readonly HaDiscoveredDevice[]
  try {
    discovered = await deps.fetch(brokerId)
  } catch (err) {
    deps.onFetchError?.(brokerId, err)
    return
  }
  // Both reconcilers share the one fetch. Each is isolated: a failure in one
  // does not prevent the other from running, and neither propagates out.
  await deps.reconcileContainers(brokerId, discovered).catch(() => {
    /* logged within */
  })
  await deps.reconcileStandalone(brokerId, discovered).catch(() => {
    /* logged within */
  })
}
