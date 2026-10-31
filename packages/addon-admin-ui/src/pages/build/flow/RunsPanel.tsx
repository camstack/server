/**
 * The Runs panel and the traced When / If / Then block, shared by the
 * automation and the action editors. A run is a ledger trace; selecting one
 * colours the blocks of the editor beside it (see `trace-view.ts`).
 */

import type { AutomationRunOutcome, AutomationRunTrace, SchedulerOutcome } from '@camstack/types'
import {
  Badge,
  type BadgeVariant,
  Button,
  DisclosureChevron,
  EmptyState,
  SectionCard,
  Skeleton,
  useIsMidWidth,
  useIsMobile,
} from '@camstack/ui-library'
import { History } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatRelativeTime } from '../../../components/device/hero/format'
import { type BlockView, runSummary } from './trace-view'

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

const SCHEDULER_VARIANT: Readonly<Record<SchedulerOutcome, BadgeVariant>> = {
  done: 'success',
  missed: 'warning',
  inactive: 'neutral',
  'condition-false': 'neutral',
  failed: 'danger',
  held: 'success',
  'gave-up': 'danger',
  overridden: 'info',
  'suspended-manual': 'warning',
}

/** A scheduler point's own outcome, in the operator's words. */
export function useSchedulerOutcomeLabel(): (outcome: SchedulerOutcome) => string {
  const { t } = useTranslation()
  return (outcome) => {
    switch (outcome) {
      case 'done':
        return t('flow.runs.schedulerDone', 'Done')
      case 'missed':
        return t('flow.runs.schedulerMissed', 'Missed')
      case 'inactive':
        return t('flow.runs.schedulerInactive', 'Not active')
      case 'condition-false':
        return t('flow.runs.schedulerConditionFalse', 'Condition not met')
      case 'failed':
        return t('flow.runs.schedulerFailed', 'Failed')
      case 'held':
        return t('flow.runs.schedulerHeld', 'Held')
      case 'gave-up':
        return t('flow.runs.schedulerGaveUp', 'Gave up')
      case 'overridden':
        return t('flow.runs.schedulerOverridden', 'Changed by hand')
      default:
        return t('flow.runs.schedulerSuspendedManual', 'Paused by hand')
    }
  }
}

export interface RunsPanelProps {
  /** Oldest first, as the ledger keeps them; shown newest first. */
  readonly traces: readonly AutomationRunTrace[] | undefined
  readonly selectedId: string | null
  readonly onSelect: (id: string | null) => void
}

/** The list scrolls inside itself; the editor beside it never grows with it. */
const LIST_MAX_H = 'max-h-64'

/**
 * Below the two-column layout (`lg`) the panel stacks above the editor, so it
 * starts folded: a long run history must not push the editor down the page.
 */
function useStartsCollapsed(): boolean {
  const mobile = useIsMobile()
  const mid = useIsMidWidth()
  return mobile || mid
}

function RunsToggle({
  expanded,
  onToggle,
}: {
  readonly expanded: boolean
  readonly onToggle: () => void
}) {
  const { t } = useTranslation()
  return (
    <Button
      variant="unstyled"
      type="button"
      aria-expanded={expanded}
      data-testid="runs-toggle"
      onClick={onToggle}
      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground-muted hover:bg-surface-hover"
    >
      <DisclosureChevron expanded={expanded} />
      <span>{expanded ? t('flow.runs.hide', 'Hide runs') : t('flow.runs.show', 'Show runs')}</span>
    </Button>
  )
}

/** One line for the selected run: what it decided and how far the steps got. */
function SelectedSummary({ run }: { readonly run: AutomationRunTrace }) {
  const { t } = useTranslation()
  const outcomeLabel = useOutcomeLabel()
  const summary = runSummary(run)
  return (
    <p
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border-subtle bg-primary/5 px-3 py-2 text-xs"
      data-testid="run-summary"
    >
      <Badge variant={OUTCOME_VARIANT[run.outcome]}>{outcomeLabel(run.outcome)}</Badge>
      {summary.reason !== null && (
        <span className="min-w-0 break-words text-foreground">{summary.reason}</span>
      )}
      {summary.stepsTotal > 0 && (
        <span className="text-foreground-subtle">
          {t('flow.runs.stepsRan', '{{run}} of {{total}} steps ran', {
            run: summary.stepsRun,
            total: summary.stepsTotal,
          })}
        </span>
      )}
    </p>
  )
}

export function RunsPanel({ traces, selectedId, onSelect }: RunsPanelProps) {
  const { t } = useTranslation()
  const outcomeLabel = useOutcomeLabel()
  const schedulerLabel = useSchedulerOutcomeLabel()
  const startsCollapsed = useStartsCollapsed()
  // null: the person has not chosen, so the viewport decides.
  const [chosen, setChosen] = useState<boolean | null>(null)
  const expanded = chosen ?? !startsCollapsed
  const newestFirst = traces === undefined ? [] : traces.toReversed()
  const selectedRun = newestFirst.find((run) => run.runId === selectedId) ?? null
  return (
    <SectionCard headingId="runs-heading" title={t('flow.runs.title', 'Runs')} icon={History}>
      <RunsToggle expanded={expanded} onToggle={() => setChosen(!expanded)} />
      {!expanded ? (
        selectedRun !== null && <SelectedSummary run={selectedRun} />
      ) : traces === undefined ? (
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
          <ul
            className={`${LIST_MAX_H} divide-y divide-border-subtle overflow-y-auto`}
            data-testid="runs-panel"
          >
            {newestFirst.map((run) => {
              const selected = run.runId === selectedId
              return (
                <li key={run.runId}>
                  <Button
                    variant="unstyled"
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onSelect(selected ? null : run.runId)}
                    className={`flex w-full flex-col gap-1 px-3 py-2 text-left hover:bg-surface-hover ${
                      selected ? 'bg-primary/10' : ''
                    }`}
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      {run.scheduler === undefined ? (
                        <Badge variant={OUTCOME_VARIANT[run.outcome]}>
                          {outcomeLabel(run.outcome)}
                        </Badge>
                      ) : (
                        <Badge variant={SCHEDULER_VARIANT[run.scheduler]}>
                          {schedulerLabel(run.scheduler)}
                        </Badge>
                      )}
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
                  </Button>
                </li>
              )
            })}
          </ul>
          {selectedRun !== null && <SelectedSummary run={selectedRun} />}
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

const EDGE_CLASS = {
  pass: 'border-success/50',
  fail: 'border-danger/50',
  idle: 'border-border',
} as const

/** Border only, for a container that holds toned rows: a fill would stack. */
export function toneEdgeClass(tone: keyof typeof EDGE_CLASS): string {
  return EDGE_CLASS[tone]
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
