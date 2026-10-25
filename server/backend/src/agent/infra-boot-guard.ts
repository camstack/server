/**
 * infra-boot-guard.ts — the agent's "did my infrastructure actually load?" gate.
 *
 * `bootCoreAddons` resolves each {@link INFRA_CAPABILITIES} entry to an addon
 * package found under `<dataDir>/addons`. Two things can go wrong, and until
 * 2026-08-08 only ONE of them was fatal:
 *
 *   - the addon was found but its `initialize()` threw  → boot aborted (correct);
 *   - the addon was NOT FOUND at all                    → `console.error`, continue.
 *
 * The second branch is strictly worse than the first and it was the quiet one.
 * On `agent-a` the whole `@camstack/system` package was renamed out of
 * `/data/addons/@camstack/` at 16:40 on 2026-08-07 (a builtin-shadow cleanup).
 * On an AGENT that directory is the SOLE source of the builtins — there is no
 * seed fallback — so the next boot came up with ZERO infra addons: no storage,
 * no settings-store, no metrics, no `platform-probe`, and no `hub-forwarder`.
 *
 * The node then reported `healthy`, registered its 14 forked addons with the
 * hub, and kept running. Nothing said otherwise, because the ONE addon that
 * ships an agent's logs to the hub (`hub-forwarder`, a `log-destination`) is in
 * the same missing package: the failure was unobservable BY CONSTRUCTION. It
 * surfaced five hours later, and only indirectly, as
 * `getNodeInferenceDevices → reachable:false` on the hub — because the node's
 * `registerNode` manifest legitimately no longer contained `platform-probe`,
 * so `CapRouteResolver.nodeKnowsCap` correctly answered "no provider".
 *
 * `InfraCapability.required` is documented as "boot aborts when this
 * capability's addon fails to initialize". A capability whose addon is not
 * even present has failed harder. This guard makes both branches agree.
 *
 * It reports EVERY missing required capability in one throw, not just the
 * first — an operator staring at a crash-loop needs the whole list, and the
 * four that vanished together on agent-a vanished for one single reason.
 */

/** One infra capability and the addon id that was resolved for it (or `null`). */
export interface InfraResolution {
  /** The capability name, e.g. `'storage-provider'`. */
  readonly name: string
  /** `true` when boot must abort rather than continue without it. */
  readonly required: boolean
  /** The addon id that will provide it, or `null` when no candidate was found. */
  readonly addonId: string | null
}

/**
 * Throw when any `required` infra capability resolved to no addon at all.
 *
 * Called AFTER the resolution pass so the message names every missing
 * capability at once. Non-required misses (`platform-probe`,
 * `metrics-provider`, `log-destination`) are the caller's business — they are
 * already logged individually and are legitimately absent on some nodes.
 */
export function assertRequiredInfraResolved(
  resolutions: readonly InfraResolution[],
  addonsDir: string,
): void {
  const missing = resolutions.filter((r) => r.required && r.addonId === null).map((r) => r.name)
  if (missing.length === 0) return
  throw new Error(
    `Required infrastructure capabilities have no addon under "${addonsDir}": ` +
      `${missing.join(', ')}. The agent's builtins package (@camstack/system) is ` +
      `missing or unreadable — this node cannot store, configure or probe itself, ` +
      `and every hub routing decision that consults its manifest would be wrong. ` +
      `Refusing to boot degraded.`,
  )
}
