/**
 * Pure reduction of `notificationRules.getHistory` rows into "the most
 * recent trigger overall" and "the most recent trigger PER RULE" — from the
 * SAME single read.
 *
 * Two things this repo already tried, both rejected in
 * `docs/design/plans/2026-08-26-home-assistant-export.md` §5.1, for reasons
 * that no longer hold when the axis is the RULE rather than the (rule,
 * camera) pair:
 *
 *  - *"960 entities"* — that count was 8 rules × 4 entities × 30 cameras: a
 *    per-camera fan-out. Per-RULE, measured live, is 15 rules; this module
 *    adds no camera dimension at all (there is no `deviceId` in its inputs
 *    or outputs beyond the one already embedded in each history row), so the
 *    count it produces cannot scale with the fleet — see
 *    `__tests__/rule-triggers.spec.ts`'s "many cameras, few rules" case.
 * - *"`getHistory` throws away `artifacts`"* — false since :
 *    `NcHistoryEntry.artifactIds` exists, and `resolveArtifactUrl` (already
 *    called by `ha-export.addon.ts` for the GLOBAL last trigger) resolves
 *    them on request.
 *
 * `getHistory` is newest-first (`notification-rules.cap.ts`'s own contract),
 * so one linear pass that keeps only the FIRST row seen per rule id — and
 * the very first row overall — reproduces "the last trigger of every rule"
 * without a second query, a sort, or a query per rule.
 *
 * Artefact URL resolution is deliberately NOT here: minting a signed link is
 * I/O (`notificationRules.resolveArtifactUrl`), and this module stays pure
 * so it is testable without a fake `ctx.api` — the same split
 * `camera-functions.ts` / `camera-function-writes.ts` already uses.
 */

/** The fields this reduction reads off one `NcHistoryEntry` (§3.2). */
export interface HistoryRow {
  readonly ruleId: string
  readonly ruleName: string
  readonly deviceId: number
  /** Fire time — the outbox row's `createdAt`, epoch ms. */
  readonly createdAt: number
  readonly status: 'pending' | 'sent' | 'dead'
  readonly subject: { readonly className: string; readonly label?: string }
  /** `NcHistoryEntry.artifactIds` — absent on a row with no indexed artefact. */
  readonly artifactIds?: readonly string[]
}

/** One row, reduced to what an entity needs — before URL resolution. */
export interface ReducedTrigger {
  readonly ruleId: string
  readonly ruleName: string
  readonly deviceId: number
  readonly at: number
  /**
   * The identified label when the pipeline resolved one, else the detected
   * class — ALWAYS non-empty: className is populated on every recordKind,
   * including system events.
   */
  readonly label: string
  readonly status: 'pending' | 'sent' | 'dead'
  /** `null` = no artefact was indexed for this delivery. */
  readonly artifactId: string | null
}

export interface ReducedTriggers {
  /** The single most recent row across every rule — `rows[0]`, reduced. */
  readonly overall: ReducedTrigger | null
  /** The most recent row PER rule id seen in `rows`. Never more than one
   *  entry per id, and never an id that was not IN `rows`. */
  readonly byRule: ReadonlyMap<string, ReducedTrigger>
}

function reduceOne(row: HistoryRow): ReducedTrigger {
  return {
    ruleId: row.ruleId,
    ruleName: row.ruleName,
    deviceId: row.deviceId,
    at: row.createdAt,
    label: row.subject.label ?? row.subject.className,
    status: row.status,
    artifactId: row.artifactIds?.[0] ?? null,
  }
}

/**
 * Reduce a newest-first page of history rows.
 *
 * A rule missing from `rows` (never fired, or its last fire fell outside the
 * page this pass could afford) is simply absent from `byRule` — the caller
 * renders that as `unknown`, never as an invented value.
 */
export function reduceLastTriggers(rows: readonly HistoryRow[]): ReducedTriggers {
  const byRule = new Map<string, ReducedTrigger>()
  let overall: ReducedTrigger | null = null
  for (const row of rows) {
    if (overall === null) overall = reduceOne(row)
    if (!byRule.has(row.ruleId)) byRule.set(row.ruleId, reduceOne(row))
  }
  return { overall, byRule }
}
