/**
 * prune-policy — which alerts get deleted, as a pure decision.
 *
 * ## The bug this exists to prevent
 *
 * Both prune paths filtered `where: { read: true }`. On a live hub every one of
 * 2,288 rows was UNREAD, so neither path had ever deleted anything — at roughly
 * 128 new alerts a day, with `maxAlerts` and `retentionDays` both configured and
 * both inert. A cap that only bounds rows a human has clicked is not a cap, and
 * "retention (days)" that ignores age is not retention.
 *
 * The decision is extracted here because both callers were private methods
 * inside the addon, reachable only through a running store — so the rule nobody
 * could test is exactly the rule that was wrong.
 *
 * ## The two rules, and why they differ
 *
 *  - **Age** ignores read state entirely. An alert past the retention window is
 *    expired whether or not anyone looked at it; that is what the operator set
 *    the number for.
 *  - **The cap** still PREFERS read alerts — an unread alert is more likely to
 *    matter, so it should be the last to go — but it must not stop there. Once
 *    the read ones are exhausted it keeps taking the oldest, or the cap silently
 *    is not one.
 */

/** The fields the policy needs. Anything else on the record is irrelevant. */
export interface PrunableAlert {
  readonly id: string
  readonly createdAt: number
  readonly read: boolean
}

/**
 * Ids older than `cutoffMs`, oldest first.
 *
 * Read state is deliberately NOT consulted — that filter is the defect.
 */
export function selectExpired(
  alerts: readonly PrunableAlert[],
  cutoffMs: number,
): readonly string[] {
  return alerts
    .filter((a) => a.createdAt < cutoffMs)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((a) => a.id)
}

/**
 * Ids to drop so at most `maxAlerts` remain: read ones first (oldest first),
 * then unread ones (oldest first) if that was not enough.
 *
 * Returns empty when already within the cap, and never more than the excess.
 */
export function selectOverflow(
  alerts: readonly PrunableAlert[],
  maxAlerts: number,
): readonly string[] {
  if (maxAlerts < 0) return []
  const excess = alerts.length - maxAlerts
  if (excess <= 0) return []
  const byAge = [...alerts].sort((a, b) => a.createdAt - b.createdAt)
  // Read first, unread only to make up the shortfall.
  const ordered = [...byAge.filter((a) => a.read), ...byAge.filter((a) => !a.read)]
  return ordered.slice(0, excess).map((a) => a.id)
}
