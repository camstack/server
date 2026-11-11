/**
 * What the selected run held, shown INSIDE the block it belongs to: a When row
 * or block shows its own outcome and observed-against-expected values, the
 * event row shows the trigger's variables, a Then step shows its outcome,
 * message, arguments and per-device results. The Runs panel keeps only the
 * list; nothing is shown twice.
 */

import { AutomationConditionOperatorSchema, type TraceNodeOutcome } from '@camstack/types'
import { Badge, type BadgeVariant } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import { operatorLabel } from '../automation/recipe-parts'
import {
  type BlockTone,
  type ConditionNodeView,
  type StepDetailView,
  type TriggerVarView,
  type ValueView,
} from './trace-view'

const NODE_VARIANT: Readonly<Record<TraceNodeOutcome, BadgeVariant>> = {
  pass: 'success',
  fail: 'danger',
  'not-evaluated': 'neutral',
}

const TONE_VARIANT: Readonly<Record<BlockTone, BadgeVariant>> = {
  pass: 'success',
  fail: 'danger',
  idle: 'neutral',
}

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

function NamedValues({
  items,
  testId,
}: {
  readonly items: readonly { readonly name: string; readonly value: ValueView }[]
  readonly testId: string
}) {
  if (items.length === 0) return null
  return (
    <dl
      className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[11px]"
      data-testid={testId}
    >
      {items.map((item) => (
        <div key={item.name} className="contents">
          <dt className="text-foreground-subtle">{item.name}</dt>
          <dd className="break-words">
            <TraceValueText value={item.value} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

export interface ConditionResultProps {
  readonly node: ConditionNodeView
  /** Shown when this is the row the event fired on. */
  readonly vars?: readonly TriggerVarView[]
  /** Already in the unit the row picked (`valueInUnit`). */
  readonly expected: ValueView | null
  readonly observed: ValueView | null
}

/** The outcome strip of one When row or block: badge, reason, values. */
export function ConditionResult({ node, vars = [], expected, observed }: ConditionResultProps) {
  const { t } = useTranslation()
  const outcomeLabel = useNodeOutcomeLabel()
  const subject =
    node.subject === null
      ? null
      : `${node.subject}${node.operator === null ? '' : ` ${operatorText(node.operator)}`}`
  return (
    <div
      className="space-y-1 border-t border-border-subtle pt-2 text-xs"
      data-testid="trace-result"
      data-outcome={node.outcome}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={NODE_VARIANT[node.outcome]}>{outcomeLabel(node.outcome)}</Badge>
        {node.reason !== null && (
          <span className="min-w-0 break-words text-foreground">{node.reason}</span>
        )}
      </div>
      {subject !== null && <div className="text-[11px] text-foreground-subtle">{subject}</div>}
      {(expected !== null || observed !== null) && (
        <div className="flex flex-wrap gap-x-3 text-[11px] text-foreground-subtle">
          {expected !== null && (
            <span data-testid="trace-expected">
              {t('flow.runs.expected', 'Expected')} <TraceValueText value={expected} />
            </span>
          )}
          {observed !== null && (
            <span data-testid="trace-observed">
              {t('flow.runs.observed', 'Observed')} <TraceValueText value={observed} />
            </span>
          )}
        </div>
      )}
      <NamedValues testId="trace-vars" items={vars} />
    </div>
  )
}

export interface StepResultProps {
  readonly step: StepDetailView
  /** Names a device id; an unknown id reads `#id`. */
  readonly deviceName: (deviceId: number) => string
}

/** The result strip of one Then step: outcome, message, what it sent, per device. */
export function StepResult({ step, deviceName }: StepResultProps) {
  const { t } = useTranslation()
  const label =
    step.tone === 'pass'
      ? t('flow.runs.stepOk', 'OK')
      : step.tone === 'fail'
        ? t('flow.runs.stepError', 'Error')
        : t('flow.runs.stepNotRun', 'Not run')
  return (
    <div
      className="space-y-1 border-t border-border-subtle pt-2 text-xs"
      data-testid="step-result"
      data-tone={step.tone}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={TONE_VARIANT[step.tone]}>{label}</Badge>
        {step.message !== null && (
          <span className="min-w-0 break-words text-foreground">{step.message}</span>
        )}
      </div>
      {step.chose !== null && (
        <div className="text-foreground-subtle" data-testid="step-chose">
          {step.chose.kind === 'else'
            ? t('flow.runs.choseElse', 'Ran the "otherwise" list')
            : t('flow.runs.choseBranch', 'Ran branch {{n}}', { n: step.chose.index + 1 })}
        </div>
      )}
      {step.rounds !== null && step.nested.length > 0 && (
        <div className="text-foreground-subtle" data-testid="step-last-round">
          {t('flow.runs.lastRound', 'The last of {{n}} rounds:', { n: step.rounds })}
        </div>
      )}
      {step.nested.length > 0 && (
        <ol className="space-y-0.5 text-[11px]" data-testid="step-nested">
          {step.nested.map((inner, at) => (
            <li key={String(at)} className="space-y-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={TONE_VARIANT[inner.tone]}>
                  {String(at + 1)} · {inner.kind}
                </Badge>
                {inner.message !== null && (
                  <span className="min-w-0 break-words text-foreground-subtle">
                    {inner.message}
                  </span>
                )}
                {inner.chose !== null && (
                  <span
                    className="text-foreground-subtle"
                    data-testid={`nested-chose-${String(at)}`}
                  >
                    {inner.chose.kind === 'else'
                      ? t('flow.runs.choseElse', 'Ran the "otherwise" list')
                      : t('flow.runs.choseBranch', 'Ran branch {{n}}', {
                          n: inner.chose.index + 1,
                        })}
                  </span>
                )}
                {inner.rounds !== null && inner.inner.length > 0 && (
                  <span
                    className="text-foreground-subtle"
                    data-testid={`nested-rounds-${String(at)}`}
                  >
                    {t('flow.runs.lastRound', 'The last of {{n}} rounds:', { n: inner.rounds })}
                  </span>
                )}
              </div>
              {inner.inner.length > 0 && (
                <ol
                  className="space-y-0.5 border-l border-border-subtle pl-2"
                  data-testid={`nested-inner-${String(at)}`}
                >
                  {inner.inner.map((leaf, i) => (
                    <li key={String(i)} className="flex flex-wrap items-center gap-2">
                      <Badge variant={TONE_VARIANT[leaf.tone]}>
                        {String(i + 1)} · {leaf.kind}
                      </Badge>
                      {leaf.message !== null && (
                        <span className="min-w-0 break-words text-foreground-subtle">
                          {leaf.message}
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </li>
          ))}
        </ol>
      )}
      <NamedValues testId="step-args" items={step.args} />
      {step.devices.length > 0 && (
        <ul className="space-y-0.5 text-[11px]" data-testid="step-devices">
          {step.devices.map((d) => (
            <li key={d.deviceId} className="flex flex-wrap items-center gap-2">
              <Badge variant={TONE_VARIANT[d.tone]}>{deviceName(d.deviceId)}</Badge>
              {d.message !== null && (
                <span className="min-w-0 break-words text-foreground-subtle">{d.message}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
