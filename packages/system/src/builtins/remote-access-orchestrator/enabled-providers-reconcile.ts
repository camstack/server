/**
 * Pure reconciliation core for the remote-access orchestrator's durable
 * `enabledProviders` set (D8 delivery-rule fix).
 *
 * Why this module exists
 * ----------------------
 * `enabledProviders: string[]` is the operator's "auto-start on boot"
 * intent — a DURABLE setting. Historically it was written ONLY from two
 * fire-and-forget bus events (`NetworkTunnelStarted` / `Stopped`). A
 * dropped event (hub restart, addon crash-respawn, hub↔orchestrator
 * partition) silently diverges the persisted set from reality:
 *   - dropped `Started` → tunnel running, not recorded → no auto-start
 *   - dropped `Stopped` → tunnel stopped, still recorded → boot restarts
 *     an operator-stopped tunnel.
 *
 * A durable setting must not be written by a lossy event. The fix is an
 * idempotent reconcile pass that pulls authoritative state via an
 * ACKNOWLEDGED RPC (`network-access` cap `getStatus`) on every provider
 * (re)connect — mirroring the kernel readiness-registry hydration via
 * `$readiness.getSnapshot`. The lifecycle events stay (still fine for
 * live UI dashboards); only the PERSISTENCE WRITE moves to the RPC pull.
 *
 * Reconcile semantics — ADD-ONLY (deliberately conservative)
 * ----------------------------------------------------------
 * `connected: true` from an acked RPC is UNAMBIGUOUS: the tunnel is up,
 * so the operator must have started it → safe to ADD to `enabledProviders`
 * (recovers a dropped `NetworkTunnelStarted` event).
 *
 * `connected: false` is AMBIGUOUS:
 *   - Provider registered but not yet started (normal cold-boot state,
 *     BEFORE `autoStartEnabledProviders` has called `start()`).
 *   - Provider transiently down (network blip, restart in progress).
 *   - Provider intentionally stopped by the operator.
 * `getStatus()` reports connectivity, NOT operator intent. Acting on
 * `connected: false` would wipe `enabledProviders` on every hub restart
 * (providers re-register ~15-20 s before `start()` is called), defeating
 * the purpose of the durable enabled-set. Therefore the reconcile pass
 * NEVER removes on `connected: false`.
 *
 * Removal of operator intent stays event-driven (`NetworkTunnelStopped`
 * → `markEnabled(id, false)`). That event is emitted synchronously by
 * the provider's own `stop()` call — it is the reliable signal that the
 * operator actually stopped the tunnel. A failed/absent RPC probe also
 * leaves the provider untouched.
 *
 * // Follow-up: covering the dropped-`Stopped` direction (a `Stopped`
 * // event lost → tunnel stopped but still in enabledProviders → boot
 * // wrongly restarts it) would require a provider-side persisted
 * // operator-intent flag that `getStatus()` surfaces. That is a larger
 * // multi-addon change (the audit's "approach 2") and is OUT OF SCOPE
 * // for this backstop. The current fix covers the higher-impact direction
 * // (dropped `Started` → operator's running tunnel not auto-restarted).
 *
 * The function is pure: the addon owns the RPC fan-out + the persist
 * call, so this core is unit-testable without a CapabilityRegistry.
 */

/**
 * Outcome of one provider's `getStatus()` RPC probe.
 *
 * `ok: true`  → the RPC was acknowledged; `connected` is authoritative.
 * `ok: false` → the RPC threw / timed out; state is unknown and the
 *               provider's membership must be left as-is.
 */
export type ProviderProbeResult =
  | { readonly addonId: string; readonly ok: true; readonly connected: boolean }
  | { readonly addonId: string; readonly ok: false }

export interface ReconcileResult {
  /** The corrected enabled-set, sorted for stable persistence. */
  readonly nextEnabled: readonly string[]
  /** `true` when `nextEnabled` differs from the input — caller persists only then. */
  readonly changed: boolean
  /** addonIds added because an acked RPC reported them connected. */
  readonly added: readonly string[]
  /**
   * Always empty — reconcile is add-only. Removal of operator intent is
   * event-driven (`NetworkTunnelStopped`). Kept in the type so callers
   * that log `result.removed` continue to compile without changes.
   */
  readonly removed: readonly string[]
}

/**
 * Reconcile the durable `enabledProviders` set against authoritative
 * RPC probe results. Pure — no I/O. ADD-ONLY: only adds providers whose
 * acked `getStatus()` reports `connected: true`. Never removes on
 * `connected: false` — see module doc for the full rationale.
 *
 * @param currentEnabled - the persisted enabled-set before reconcile.
 * @param probes - one entry per provider whose `getStatus()` RPC was
 *   attempted this pass. Providers absent from this list are untouched.
 */
export function reconcileEnabledProviders(
  currentEnabled: readonly string[],
  probes: readonly ProviderProbeResult[],
): ReconcileResult {
  const next = new Set<string>(currentEnabled)
  const added: string[] = []

  for (const probe of probes) {
    if (!probe.ok) continue // RPC failed → state unknown → leave membership as-is
    if (probe.connected) {
      // Acked connected:true is unambiguous → operator must have started
      // this tunnel → ensure it is in the enabled-set (recovers a dropped
      // NetworkTunnelStarted event).
      if (!next.has(probe.addonId)) {
        next.add(probe.addonId)
        added.push(probe.addonId)
      }
    }
    // connected:false → ambiguous (not-yet-started / transient blip /
    // operator-stopped). Do NOT remove. Removal is event-driven only.
  }

  const nextEnabled = [...next].toSorted()
  return {
    nextEnabled,
    changed: added.length > 0,
    added,
    removed: [], // always empty — reconcile is add-only
  }
}
