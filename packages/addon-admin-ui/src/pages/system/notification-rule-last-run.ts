/**
 * The "Last run" cell of the rules table — what it may CLAIM, decided once.
 *
 * D315: a rule is called absent ("not in the last 7 days") only by a query that
 * ANSWERED. While it is pending the cell claims nothing; when it failed the cell
 * says it could not look. And the window it names is the one the hub answered
 * with (`horizonMs` — the outbox prune window, narrowed when the hub's read hit
 * its bound), never a constant here: the operator can change the window, and a
 * UI that said "7 days" over a 3-day window would be lying about 4 of them.
 */

import type { NcHistoryStatus, NcRuleLastRuns } from '@camstack/types'
import i18n from '../../i18n/index'

/** The slice of a react-query result the decision reads. */
export interface RuleLastRunsView {
  readonly status: 'pending' | 'error' | 'success'
  readonly data: NcRuleLastRuns | undefined
  readonly error: unknown
}

export type RuleLastRunCell =
  | { readonly kind: 'pending' }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'absent'; readonly phrase: string }
  | {
      readonly kind: 'ran'
      readonly lastAt: number
      readonly status: NcHistoryStatus
      readonly deviceId: number
    }

export function ruleLastRunCell(view: RuleLastRunsView, ruleId: string): RuleLastRunCell {
  if (view.status === 'error') {
    return {
      kind: 'failed',
      reason:
        view.error instanceof Error
          ? view.error.message
          : i18n.t('helpers.notificationRuleLastRun.unknownError'),
    }
  }
  if (view.status !== 'success' || view.data === undefined) return { kind: 'pending' }
  const run = view.data.runs.find((r) => r.ruleId === ruleId)
  if (run === undefined) {
    return { kind: 'absent', phrase: lastRunHorizonPhrase(view.data.horizonMs) }
  }
  return { kind: 'ran', lastAt: run.lastAt, status: run.status, deviceId: run.deviceId }
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** One unit, floored: a narrowed 5.9-day window is "5 days", never "6". */
/**
 * "Not in the last N days" for the window the hub answered over. `null` is the
 * operator's keep-forever outbox read to its end: absent means never recorded.
 */
export function lastRunHorizonPhrase(horizonMs: number | null): string {
  if (horizonMs === null) return i18n.t('helpers.notificationRuleLastRun.noDelivery')
  if (horizonMs >= DAY_MS)
    return i18n.t('helpers.notificationRuleLastRun.notInDay', {
      count: Math.floor(horizonMs / DAY_MS),
    })
  if (horizonMs >= HOUR_MS)
    return i18n.t('helpers.notificationRuleLastRun.notInHour', {
      count: Math.floor(horizonMs / HOUR_MS),
    })
  if (horizonMs >= MINUTE_MS)
    return i18n.t('helpers.notificationRuleLastRun.notInMinute', {
      count: Math.floor(horizonMs / MINUTE_MS),
    })
  return i18n.t('helpers.notificationRuleLastRun.notInWindow')
}
