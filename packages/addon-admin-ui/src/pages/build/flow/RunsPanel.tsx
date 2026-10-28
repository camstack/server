/**
 * The Runs panel and the traced When / If / Then block, shared by the
 * automation and the action editors. A run is a ledger trace; selecting one
 * colours the blocks of the editor beside it (see `trace-view.ts`).
 */

import type { AutomationRunOutcome, AutomationRunTrace } from '@camstack/types'
import { Badge, type BadgeVariant, EmptyState, SectionCard, Skeleton } from '@camstack/ui-library'
import { History } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { formatRelativeTime } from '../../../components/device/hero/format'
import type { BlockView } from './trace-view'

const OUTCOME_VARIANT: Readonly<Record<AutomationRunOutcome, BadgeVariant>> = {
  ran: 'success',
  failed: 'danger',
  aborted: 'danger',
  'skipped-trigger': 'neutral',
  'skipped-conditions': 'warning',
  'skipped-cooldown': 'neutral',
  'skipped-overlap': 'neutral',
}

const TONE_CLASS = {
  pass: 'border-success/50 bg-success/10',
  fail: 'border-danger/50 bg-danger/10',
  idle: 'border-border bg-surface text-foreground-subtle',
} as const

const TONE_REASON_CLASS = {
  pass: 'text-success',
  fail: 'text-danger',
  idle: 'text-foreground-subtle',
} as const

export function useOutcomeLabel(): (outcome: AutomationRunOutcome) => string {
  const { t } = useTranslation()
  return (outcome) => {
    switch (outcome) {
      case 'ran':
        return t('flow.runs.outcomeRan', 'Ran')
      case 'failed':
        return t('flow.runs.outcomeFailed', 'Failed')
      case 'aborted':
        return t('flow.runs.outcomeAborted', 'Stopped')
      case 'skipped-trigger':
        return t('flow.runs.outcomeSkippedTrigger', 'Trigger not met')
      case 'skipped-conditions':
        return t('flow.runs.outcomeSkippedConditions', 'Skipped by conditions')
      case 'skipped-cooldown':
        return t('flow.runs.outcomeSkippedCooldown', 'Skipped by cooldown')
      default:
        return t('flow.runs.outcomeSkippedOverlap', 'Skipped by run mode')
    }
  }
}

export interface RunsPanelProps {
  /** Oldest first, as the ledger keeps them; shown newest first. */
  readonly traces: readonly AutomationRunTrace[] | undefined
  readonly selectedId: string | null
  readonly onSelect: (id: string | null) => void
}

export function RunsPanel({ traces, selectedId, onSelect }: RunsPanelProps) {
  const { t } = useTranslation()
  const outcomeLabel = useOutcomeLabel()
  const newestFirst = traces === undefined ? [] : traces.toReversed()
  return (
    <SectionCard headingId="runs-heading" title={t('flow.runs.title', 'Runs')} icon={History}>
      {traces === undefined ? (
        <Skeleton className="m-3 h-16" />
      ) : newestFirst.length === 0 ? (
        <EmptyState
          title={t('flow.runs.emptyTitle', 'No runs yet')}
          description={t(
            'flow.runs.emptyDescription',
            'Each run appears here with what it decided.',
          )}
        />
      ) : (
        <>
          <ul className="divide-y divide-border-subtle" data-testid="runs-panel">
            {newestFirst.map((run) => {
              const selected = run.runId === selectedId
              return (
                <li key={run.runId}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onSelect(selected ? null : run.runId)}
                    className={`flex w-full flex-col gap-1 px-3 py-2 text-left hover:bg-surface-hover ${
                      selected ? 'bg-primary/10' : ''
                    }`}
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge variant={OUTCOME_VARIANT[run.outcome]}>
                        {outcomeLabel(run.outcome)}
                      </Badge>
                      {run.repeat > 1 && (
                        <Badge variant="neutral" style="outline">
                          {`x${String(run.repeat)}`}
                        </Badge>
                      )}
                      <span className="text-xs text-foreground-subtle">
                        {formatRelativeTime(run.lastAt)}
                      </span>
                    </span>
                    <span className="truncate text-sm text-foreground">{run.trigger.reason}</span>
                  </button>
                </li>
              )
            })}
          </ul>
          <p className="border-t border-border-subtle px-3 py-2 text-xs text-foreground-subtle">
            {t(
              'flow.runs.hint',
              'Select a run to colour the blocks: green passed, red failed, grey not evaluated.',
            )}
          </p>
        </>
      )}
    </SectionCard>
  )
}

/** Border and fill of an item the selected run did (or did not) reach. */
export function toneBorderClass(tone: keyof typeof TONE_CLASS): string {
  return TONE_CLASS[tone]
}

export interface TraceBlockProps {
  readonly step: string
  readonly title: string
  /** One line under the title: what this block is for. */
  readonly hint?: string
  readonly trace: BlockView | null
  readonly children: ReactNode
}

/** One When / If / Then block; tinted by the selected run, plain without one. */
export function TraceBlock({ step, title, hint, trace, children }: TraceBlockProps) {
  const tone = trace === null ? 'border-border bg-surface' : TONE_CLASS[trace.tone]
  return (
    <section className={`rounded-lg border p-3 ${tone}`} data-testid={`block-${step}`}>
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h4 className="text-sm font-semibold uppercase tracking-wide">{title}</h4>
        {hint !== undefined && <span className="text-xs text-foreground-subtle">{hint}</span>}
      </div>
      {trace !== null && trace.reason !== null && (
        <p className={`mb-2 text-xs font-medium ${TONE_REASON_CLASS[trace.tone]}`}>
          {trace.reason}
        </p>
      )}
      <div className="space-y-2">{children}</div>
    </section>
  )
}
