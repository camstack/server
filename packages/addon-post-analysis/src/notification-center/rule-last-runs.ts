/**
 * `notificationRules.getRuleLastRuns` — every rule's newest delivery, in ONE
 * bounded read of the outbox.
 *
 * The outbox is the single source of delivery truth: `getHistory` is a view
 * over it, and so is this. The read is `NcOutbox.queryLastRunRows` — one
 * statement, newest-first on the `createdAt` index, projected to the four
 * columns this reads (the heavy `payload` JSON is never selected), bounded by
 * the prune window AND by {@link NC_RULE_LAST_RUNS_SCAN_LIMIT} rows. The
 * reduction below is one pass over those rows into a map keyed by rule: the
 * first row seen for a rule is its newest.
 *
 * What it refuses to do, and why:
 *  - **No query per rule.** A rules table asking `getHistory({ ruleId, limit: 1 })`
 *    per row is N round trips to a synchronous SQLite thread (D447).
 *  - **No claim wider than the read.** A scan that hit its row bound did not
 *    read the whole window, so the answer's `horizonMs` narrows to the oldest
 *    row the store returned — judged on the RAW result, malformed rows
 *    included (`NcLastRunRead`). "Not in the last 7 days" must be true when a UI says it.
 *  - **No empty answer from a failed read.** The outbox read throws, and so
 *    does this: an empty `runs` would tell every rule it had not run (D393).
 */

import type { NcRuleLastRun, NcRuleLastRuns } from '@camstack/types'
import type { NcOutboxStatus } from './outbox.js'

/**
 * Row bound of the one read. Projected rows are four scalars (~100 B), so the
 * bound costs ~2 MB at worst. The live outbox volume was NOT measured when
 * this was chosen. It exists so a runaway rule cannot turn an admin page load
 * into a table walk — and when it bites, `horizonMs` says so.
 */
export const NC_RULE_LAST_RUNS_SCAN_LIMIT = 20_000

/** The slice of an outbox row this reads — exactly the projected columns. */
export interface NcLastRunRow {
  readonly ruleId: string
  readonly createdAt: number
  readonly status: NcOutboxStatus
  readonly deviceId: number
}

/**
 * One bounded read of the outbox, as the STORE returned it.
 *
 * `truncated` and `oldestReadAt` describe the raw result — malformed rows
 * included. Judged on `rows` instead, a read that hit its bound and dropped one
 * unreadable row would look complete and claim the whole window.
 */
export interface NcLastRunRead {
  /** The readable rows, newest-first. */
  readonly rows: readonly NcLastRunRow[]
  /** The store returned as many rows as the bound allowed: there may be more. */
  readonly truncated: boolean
  /** The oldest fire time among ALL rows returned; `null` when none carried one. */
  readonly oldestReadAt: number | null
}

/** The window the read was asked for, and the clock it was asked at. */
export interface NcLastRunScan {
  readonly now: number
  /** The prune window the read was bounded by; `null` = kept forever. */
  readonly windowMs: number | null
}

/** Least successful first: a fire that reached some targets and not others
 *  did not "deliver". */
const STATUS_SEVERITY: Readonly<Record<NcOutboxStatus, number>> = {
  sent: 0,
  pending: 1,
  dead: 2,
}

function worse(a: NcOutboxStatus, b: NcOutboxStatus): NcOutboxStatus {
  return STATUS_SEVERITY[b] > STATUS_SEVERITY[a] ? b : a
}

/**
 * Reduce newest-first rows to one run per rule, in one pass.
 *
 * Rows sharing the newest `createdAt` of a rule are one fire to several
 * targets; they merge into the least successful status. `read.rows` MUST be
 * ordered newest-first — that is what the outbox read asks the store for.
 */
export function summariseRuleLastRuns(read: NcLastRunRead, scan: NcLastRunScan): NcRuleLastRuns {
  const byRule = new Map<string, NcRuleLastRun>()
  for (const row of read.rows) {
    const seen = byRule.get(row.ruleId)
    if (seen === undefined) {
      byRule.set(row.ruleId, {
        ruleId: row.ruleId,
        lastAt: row.createdAt,
        status: row.status,
        deviceId: row.deviceId,
      })
    } else if (seen.lastAt === row.createdAt && worse(seen.status, row.status) !== seen.status) {
      byRule.set(row.ruleId, { ...seen, status: row.status, deviceId: row.deviceId })
    }
  }
  return { runs: [...byRule.values()], horizonMs: horizonOf(read, scan) }
}

/** How far back the answer really looked — see the module doc. */
function horizonOf(read: NcLastRunRead, scan: NcLastRunScan): number | null {
  if (read.truncated && read.oldestReadAt !== null) {
    return Math.max(0, scan.now - read.oldestReadAt)
  }
  return scan.windowMs
}
