/**
 * The rules table's "Last run" column and "History" action.
 *
 * ONE query for the whole table (`notificationRules.getRuleLastRuns`, a single
 * bounded read of the outbox on the hub) — never a history read per row. What a
 * cell may claim is decided in `notification-rule-last-run.ts` (D315); this
 * file only draws it.
 */

import type { NcHistoryStatus, NcRule, NcRuleLastRuns } from '@camstack/types'
import { Button, useSystem } from '@camstack/ui-library'
import { useQuery } from '@tanstack/react-query'
import { History } from 'lucide-react'
import { formatRelativeTime } from '../../components/device/hero/format'
import {
  type RuleLastRunCell,
  type RuleLastRunsView,
  ruleLastRunCell,
} from './notification-rule-last-run'
import { useTranslation } from 'react-i18next'

export const RULE_LAST_RUNS_QUERY_KEY = ['notificationRules', 'getRuleLastRuns'] as const

/** A delivery is minutes-grained news; a refetch per render of the table is not. */
const LAST_RUNS_STALE_MS = 30_000

/** The table's one read, as the decision reads it. */
export function useRuleLastRuns(): RuleLastRunsView {
  const system = useSystem()
  const query = useQuery({
    queryKey: RULE_LAST_RUNS_QUERY_KEY,
    queryFn: (): Promise<NcRuleLastRuns> =>
      system.trpcClient.notificationRules.getRuleLastRuns.query({}),
    // A hub without the method answers NOT_FOUND: show "—" at once rather than
    // a skeleton that spins through retries.
    retry: false,
    staleTime: LAST_RUNS_STALE_MS,
  })
  return { status: query.status, data: query.data, error: query.error }
}

const STATUS_DOT: Readonly<Record<NcHistoryStatus, string>> = {
  sent: 'bg-success',
  pending: 'bg-info',
  dead: 'bg-danger',
}

export function RuleLastRunCellView({ cell }: { readonly cell: RuleLastRunCell }) {
  const { t } = useTranslation()
  switch (cell.kind) {
    case 'pending':
      return (
        <span
          data-testid="rule-last-run-pending"
          aria-label={t('system.notificationRuleLastRun.lastRunLoading', 'Last run loading')}
          className="inline-block h-3 w-14 animate-pulse rounded bg-surface-hover"
        />
      )
    case 'failed':
      return (
        <span
          data-testid="rule-last-run-failed"
          title={t(
            'system.notificationRuleLastRun.lastRunCouldNotBe',
            'Last run could not be read: {{reason}}',
            { reason: cell.reason },
          )}
          className="text-[11px] text-foreground-subtle"
        >
          —
        </span>
      )
    case 'absent':
      return <span className="text-[11px] text-foreground-subtle">{cell.phrase}</span>
    case 'ran':
      return (
        <span className="flex items-center gap-1.5" title={new Date(cell.lastAt).toLocaleString()}>
          <span
            data-testid="rule-last-run-dot"
            title={cell.status}
            className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[cell.status]}`}
          />
          <span className="text-[11px] text-foreground-subtle">
            {formatRelativeTime(cell.lastAt)}
          </span>
        </span>
      )
  }
}

export interface RuleHistoryButtonProps {
  readonly rule: NcRule
  readonly onOpenHistory: (rule: NcRule) => void
}

/** Opens the History tab filtered on this rule (the host owns the URL). */
export function RuleHistoryButton({ rule, onOpenHistory }: RuleHistoryButtonProps) {
  const { t } = useTranslation()
  return (
    <Button
      size="sm"
      variant="ghost"
      type="button"
      onClick={() => onOpenHistory(rule)}
      title={t(
        'system.notificationRuleLastRun.historyThisRuleSDeliveries',
        "History — this rule's deliveries",
      )}
      aria-label={t('system.notificationRuleLastRun.historyOf', 'history of {{name}}', {
        name: rule.name,
      })}
    >
      <History className="h-3.5 w-3.5" />
    </Button>
  )
}
