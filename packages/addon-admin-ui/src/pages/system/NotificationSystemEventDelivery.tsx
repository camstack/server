/**
 * The DELIVERY of a device-events / system rule (D1019): a rule speaks at any
 * combination of three moments — when the condition STARTS, when it CLEARS,
 * and on a SCHEDULE (a state summary of what is still true).
 *
 * The schedule is authored as "send at HH:MM on days …" and stored as the
 * ordinary `NcSchedule`: each send time is a one-minute window that ENDS at
 * that minute (`scheduleForSendTimes`), because a summary is sent when a window
 * ends. A stored schedule that is not a list of send times is shown as its
 * window ends. Every write is the `modes` shape; a legacy stored value is read
 * through `deliveryModesOf`.
 *
 * The alarm has no summary (it stays instant) and a `mixed` rule is read-only:
 * for either this control renders nothing.
 */
import {
  type NcRuleInput,
  type NcStateSummaryPreview,
  type NcStateSummarySplit,
  type NcSystemEventDelivery,
  type NcSystemEventFamily,
  type NcSystemEventKind,
  systemEventDeliveryProblems,
  describeSystemEventDeliveryProblem,
} from '@camstack/types'
import {
  Button,
  CHIP_ACTIVE,
  CHIP_BASE,
  CHIP_INACTIVE,
  Checkbox,
  Switch,
  cn,
  useSystem,
} from '@camstack/ui-library'
import { useMutation } from '@tanstack/react-query'

import { HINT_CLASS } from './notification-condition-widgets'
import { ScheduleField } from './notification-schedule-field'
import {
  type DeliveryToggle,
  type SystemEventModesDelivery,
  clearingHintOf,
  deliveryFamilyApplies,
  deliveryModesOf,
  previewVerdictOf,
  withModeToggle,
  withSummaryGrouping,
  withSummarySchedule,
} from './notification-system-event-delivery'
import { useTranslation } from 'react-i18next'

interface Props {
  readonly value: NcSystemEventDelivery | undefined
  readonly family: NcSystemEventFamily | undefined
  /** The kinds the rule selected — what "when it clears" is judged on. */
  readonly kinds: readonly NcSystemEventKind[]
  readonly onChange: (next: NcSystemEventDelivery) => void
  /** The rule as it would be saved now — what the preview asks about. */
  readonly draft: () => NcRuleInput
}

export function SystemEventDeliveryField({ value, family, kinds, onChange, draft }: Props) {
  const { t } = useTranslation()
  if (!deliveryFamilyApplies(family)) return null
  const modes = deliveryModesOf(value, kinds)
  const toggles: readonly {
    readonly id: DeliveryToggle
    readonly on: boolean
    readonly label: string
  }[] = [
    {
      id: 'activation',
      on: modes.onActivation,
      label: t('system.notificationSystemEventDelivery.whenItStarts', 'When it starts'),
    },
    {
      id: 'deactivation',
      on: modes.onDeactivation,
      label: t('system.notificationSystemEventDelivery.whenItClears', 'When it clears'),
    },
    {
      id: 'schedule',
      on: modes.onSchedule !== undefined,
      label: t('system.notificationSystemEventDelivery.onASchedule', 'On a schedule'),
    },
  ]
  const problems = systemEventDeliveryProblems({
    delivery: 'system-event',
    conditions: kinds.length > 0 ? { systemEvent: { kinds: [...kinds] } } : {},
    systemEventDelivery: modes,
  })
    .filter((problem) => problem.code === 'no-mode' || problem.code === 'no-instant-kind')
    .map(describeSystemEventDeliveryProblem)
  return (
    <div className="rounded-md border border-border px-3 py-3" data-testid="rule-delivery">
      <div className="mb-2 text-[11px] font-semibold text-foreground">
        {t('system.notificationSystemEventDelivery.delivery', 'Delivery')}
      </div>
      <div className="flex flex-wrap gap-1.5" role="group">
        {toggles.map((toggle) => (
          <label
            key={toggle.id}
            className={cn(CHIP_BASE, 'cursor-pointer', toggle.on ? CHIP_ACTIVE : CHIP_INACTIVE)}
          >
            <Checkbox
              checked={toggle.on}
              onChange={(event) => onChange(withModeToggle(modes, toggle.id, event.target.checked))}
              data-testid={`rule-delivery-${toggle.id}`}
            />
            {toggle.label}
          </label>
        ))}
      </div>
      <DeliveryHints modes={modes} kinds={kinds} />
      {problems.map((problem) => (
        <p
          key={problem}
          className="mt-2 text-[11px] text-danger"
          data-testid="rule-delivery-problem"
        >
          {problem}
        </p>
      ))}
      {modes.onSchedule !== undefined && (
        <SummarySchedule value={modes} onChange={onChange} draft={draft} />
      )}
    </div>
  )
}

interface HintsProps {
  readonly modes: SystemEventModesDelivery
  readonly kinds: readonly NcSystemEventKind[]
}

function DeliveryHints({ modes, kinds }: HintsProps) {
  const { t } = useTranslation()
  const clearing = clearingHintOf(kinds)
  const scheduleOnly = !modes.onActivation && !modes.onDeactivation
  return (
    <div className="mt-2 space-y-1" data-testid="rule-delivery-hints">
      {modes.onDeactivation && clearing.adds.length > 0 && (
        <p className={HINT_CLASS} data-testid="rule-delivery-clears-hint">
          {t(
            'system.notificationSystemEventDelivery.clearsAdds',
            'When it clears also reports the recovery of: {{what}}.',
            { what: clearing.adds.join(' · ') },
          )}
        </p>
      )}
      {modes.onDeactivation && clearing.without > 0 && (
        <p className={HINT_CLASS} data-testid="rule-delivery-no-clearing-hint">
          {t('system.notificationSystemEventDelivery.noClearingEvent', { count: clearing.without })}
        </p>
      )}
      {modes.onSchedule !== undefined && (
        <p className={HINT_CLASS} data-testid="rule-delivery-schedule-hint">
          {scheduleOnly
            ? t(
                'system.notificationSystemEventDelivery.scheduleOnlyHint',
                'Only on a schedule: nothing is sent per event, and the active hours and actions of this rule do not apply.',
              )
            : t(
                'system.notificationSystemEventDelivery.scheduleBesideHint',
                'The summary is sent at the times below whatever the active hours of this rule say, and runs no actions.',
              )}
        </p>
      )}
    </div>
  )
}

interface SummaryScheduleProps {
  readonly value: SystemEventModesDelivery
  readonly onChange: (next: NcSystemEventDelivery) => void
  readonly draft: () => NcRuleInput
}

function SummarySchedule({ value, onChange, draft }: SummaryScheduleProps) {
  const { t } = useTranslation()
  const scheduled = value.onSchedule
  if (scheduled === undefined) return null
  const timezone =
    scheduled.schedule.timezone ?? t('system.notificationSystemEventDelivery.theHubS', 'the hub’s')
  return (
    <div className="mt-2 space-y-2">
      <p className={HINT_CLASS}>
        {t(
          'system.notificationSystemEventDelivery.summaryExplain',
          'At each time below, one notification lists what is still true for the kinds and filters of this rule — low batteries, consumables, devices or streams offline, updates available. Nothing to report sends nothing. Time zone: {{timezone}}.',
          { timezone },
        )}
      </p>
      {/* Same punctual ScheduleField as ConfigUI `type: 'schedule', mode: 'times'`
          — one HH:MM per row, stored as one-minute windows. */}
      <ScheduleField
        mode="times"
        value={scheduled.schedule}
        onChange={(next) => {
          // A summary needs at least one send time — refuse clearing the last row.
          if (next === undefined) return
          onChange(withSummarySchedule(value, next))
        }}
      />
      <Switch
        checked={scheduled.grouping === 'section'}
        onCheckedChange={(on) => onChange(withSummaryGrouping(value, on ? 'section' : 'rule'))}
        label={t(
          'system.notificationSystemEventDelivery.onePerCategory',
          'One notification per category',
        )}
        data-testid="rule-delivery-grouping"
      />
      <SummaryPreview draft={draft} split={scheduled.grouping} />
    </div>
  )
}

interface SummaryPreviewProps {
  readonly draft: () => NcRuleInput
  readonly split: NcStateSummarySplit
}

function SummaryPreview({ draft, split }: SummaryPreviewProps) {
  const { t } = useTranslation()
  const system = useSystem()
  const preview = useMutation<NcStateSummaryPreview, unknown, NcRuleInput>({
    mutationFn: (rule) => system.trpcClient.notificationRules.previewStateSummary.mutate({ rule }),
  })
  const verdict = previewVerdictOf(preview.status, preview.data, preview.error, split)
  return (
    <div className="space-y-1.5">
      <Button
        size="sm"
        variant="secondary"
        onClick={() => preview.mutate(draft())}
        disabled={preview.isPending}
        data-testid="rule-delivery-preview"
      >
        {preview.isPending
          ? t('system.notificationSystemEventDelivery.readingTheState', 'Reading the state…')
          : t(
              'system.notificationSystemEventDelivery.previewTheSummaryNow',
              'Preview the summary now',
            )}
      </Button>
      {verdict !== null && (
        <div className={HINT_CLASS} data-testid="rule-delivery-preview-result">
          {verdict.lines.map((line, i) => (
            <p key={i} className="whitespace-pre-wrap">
              {line}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
