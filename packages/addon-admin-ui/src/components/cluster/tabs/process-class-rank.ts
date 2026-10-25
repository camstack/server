/**
 * Operational severity of a process classification — the order the `Class`
 * column sorts by.
 *
 * A status column has no alphabetical meaning: `managed / root / system` in
 * A-Z order tells an operator nothing. This rank is severity, worst first, so
 * ascending puts the processes that need attention at the top.
 *
 * `system` outranks `managed` because a camstack-shaped command the cluster
 * does not manage is the more interesting row of the two; `root` is last
 * because a supervisor is never the problem being hunted.
 */
export type ProcessClassification = 'root' | 'managed' | 'system'

export const PROCESS_CLASS_RANK: Readonly<Record<ProcessClassification, number>> = {
  system: 0,
  managed: 1,
  root: 2,
}
