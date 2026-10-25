/**
 * Returns the deviceIds that are KNOWN (present in `known`) but currently
 * UNASSIGNED (absent from `assigned`). These are the "stranded" cameras — the
 * orchestrator has a runner config for them but no live pipeline assignment
 * (pending / over-cap / no-frame-source / load-shed).
 *
 * Mirror of `computeDispatchGap` in `dispatch-reconcile.ts`: a plain set
 * difference (`known \ assigned`). Pure — no side effects, deterministic
 * ordering (iteration order of `known`).
 */
export function computeStrandedDevices(
  known: ReadonlySet<number>,
  assigned: ReadonlySet<number>,
): number[] {
  return [...known].filter((id) => !assigned.has(id))
}
