/**
 * The Runs panel and the traced When / If / Then block, shared by the
 * automation and the action editors. A run is a ledger trace; selecting one
 * colours the blocks of the editor beside it (see `trace-view.ts`).
 */

import {
  AutomationConditionOperatorSchema,
  type AutomationRunOutcome,
  type AutomationRunTrace,
  type TraceNodeOutcome,
} from '@camstack/types'
import { Badge, type BadgeVariant, EmptyState, SectionCard, Skeleton } from '@camstack/ui-library'
import { History } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { formatRelativeTime } from '../../../components/device/hero/format'
import { operatorLabel } from '../automation/recipe-parts'
import {
  type BlockTone,
  type BlockView,
  type ConditionNodeView,
  traceDetails,
  type ValueView,
} from './trace-view'

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
                  {selected && <RunDetails trace={run} />}
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

const NODE_VARIANT: Readonly<Record<TraceNodeOutcome, BadgeVariant>> = {
  pass: 'success',
  fail: 'danger',
  'not-evaluated': 'neutral',
}

const STEP_VARIANT: Readonly<Record<BlockTone, BadgeVariant>> = {
  pass: 'success',
  fail: 'danger',
  idle: 'neutral',
}

/** Nesting under the root condition, as classes (no inline spacing). */
const DEPTH_INDENT = ['', 'pl-3', 'pl-6', 'pl-9'] as const

/** A value from a trace; a reading the mirror never held says so. */
export function TraceValueText({ value }: { readonly value: ValueView }) {
  const { t } = useTranslation()
  return value.kind === 'unknown' ? (
    <span className="italic text-foreground-subtle" data-testid="trace-value-unknown">
      {t('flow.runs.unknownValue', 'unknown')}
    </span>
  ) : (
    <span className="font-mono text-foreground">{value.text}</span>
  )
}

export interface TraceValueRowProps {
  readonly label: string
  readonly outcome: TraceNodeOutcome
  readonly outcomeLabel: string
  /** Where the node reads from (`cap.field`) and how it compares. */
  readonly detail?: ReactNode
  readonly expected: ValueView | null
  readonly observed: ValueView | null
  readonly depth?: number
}

/**
 * One evaluated condition: its outcome, then what it expected against what it
 * observed. A leaf row on its own, so the condition editor can reuse it.
 */
export function TraceValueRow({
  label,
  outcome,
  outcomeLabel,
  detail,
  expected,
  observed,
  depth = 0,
}: TraceValueRowProps) {
  const { t } = useTranslation()
  return (
    <li className={`space-y-0.5 py-1 ${DEPTH_INDENT[Math.min(depth, DEPTH_INDENT.length - 1)]}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={NODE_VARIANT[outcome]}>{outcomeLabel}</Badge>
        <span className="min-w-0 break-words text-xs text-foreground">{label}</span>
      </div>
      {detail !== undefined && <div className="text-[11px] text-foreground-subtle">{detail}</div>}
      {(expected !== null || observed !== null) && (
        <div className="flex flex-wrap gap-x-3 text-[11px] text-foreground-subtle">
          {expected !== null && (
            <span>
              {t('flow.runs.expected', 'Expected')} <TraceValueText value={expected} />
            </span>
          )}
          {observed !== null && (
            <span>
              {t('flow.runs.observed', 'Observed')} <TraceValueText value={observed} />
            </span>
          )}
        </div>
      )}
    </li>
  )
}

function useNodeOutcomeLabel(): (outcome: TraceNodeOutcome) => string {
  const { t } = useTranslation()
  return (outcome) =>
    outcome === 'pass'
      ? t('flow.runs.nodePass', 'Passed')
      : outcome === 'fail'
        ? t('flow.runs.nodeFail', 'Failed')
        : t('flow.runs.nodeNotEvaluated', 'Not evaluated')
}

function operatorText(operator: string): string {
  const parsed = AutomationConditionOperatorSchema.safeParse(operator)
  return parsed.success ? operatorLabel(parsed.data) : operator
}

function conditionLabel(node: ConditionNodeView, fallback: string): string {
  return node.reason ?? node.subject ?? fallback
}

/** What the selected run held: trigger values, each condition, each step. */
export function RunDetails({ trace }: { readonly trace: AutomationRunTrace }) {
  const { t } = useTranslation()
  const nodeLabel = useNodeOutcomeLabel()
  const details = traceDetails(trace)
  return (
    <div className="space-y-3 border-t border-border-subtle px-3 py-2" data-testid="run-details">
      {details.vars.length > 0 && (
        <section>
          <h5 className="text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
            {t('flow.runs.triggerValues', 'Trigger')}
          </h5>
          <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
            {details.vars.map((v) => (
              <div key={v.name} className="contents">
                <dt className="text-foreground-subtle">{v.name}</dt>
                <dd className="break-words">
                  <TraceValueText value={v.value} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {details.conditions.length > 0 && (
        <section>
          <h5 className="text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
            {t('flow.runs.whenValues', 'When')}
          </h5>
          <ul className="mt-1 divide-y divide-border-subtle">
            {details.conditions.map((node) => (
              <TraceValueRow
                key={node.path}
                depth={node.depth}
                label={conditionLabel(node, node.kind)}
                outcome={node.outcome}
                outcomeLabel={nodeLabel(node.outcome)}
                detail={
                  node.subject !== null && node.reason !== null
                    ? `${node.subject}${node.operator === null ? '' : ` ${operatorText(node.operator)}`}`
                    : undefined
                }
                expected={node.expected}
                observed={node.observed}
              />
            ))}
          </ul>
        </section>
      )}
      {details.steps.length > 0 && (
        <section>
          <h5 className="text-[11px] font-semibold uppercase tracking-wide text-foreground-muted">
            {t('flow.runs.stepValues', 'Steps')}
          </h5>
          <ul className="mt-1 divide-y divide-border-subtle">
            {details.steps.map((step) => (
              <li key={step.index} className="flex flex-wrap items-center gap-2 py-1 text-xs">
                <Badge variant={STEP_VARIANT[step.tone]}>
                  {step.tone === 'pass'
                    ? t('flow.runs.stepOk', 'OK')
                    : step.tone === 'fail'
                      ? t('flow.runs.stepError', 'Error')
                      : t('flow.runs.stepNotRun', 'Not run')}
                </Badge>
                <span className="text-foreground-subtle">{`${String(step.index + 1)}. ${step.kind}`}</span>
                {step.message !== null && (
                  <span className="min-w-0 break-words text-foreground">{step.message}</span>
                )}
                {step.args.length > 0 && (
                  <dl
                    className="grid w-full grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 pl-2 text-[11px]"
                    data-testid="step-args"
                  >
                    {step.args.map((arg) => (
                      <div key={arg.name} className="contents">
                        <dt className="text-foreground-subtle">{arg.name}</dt>
                        <dd className="break-words">
                          <TraceValueText value={arg.value} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
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
