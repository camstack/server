/**
 * The DELIVERY of a device-events / system rule (D647): a notification per
 * event, or a STATE SUMMARY at set times.
 *
 * "Send at 08:00 on Mon–Fri" is authored here and stored as the ordinary
 * `NcSchedule`: each send time is a one-minute window that ENDS at that minute
 * (`scheduleForSendTimes`), because a summary is sent when a window ends — the
 * same machinery as the fixed-time digest. A stored schedule that is not a
 * list of send times (longer or inverted windows, authored elsewhere) is shown
 * as its raw windows, with the rule it follows said out loud.
 *
 * The alarm has no summary (it stays instant) and a `mixed` rule is read-only:
 * for either this control renders nothing.
 */
import {
  NC_SYSTEM_EVENT_SUMMARY_FAMILIES,
  type NcRuleInput,
  type NcStateSummaryPreview,
  type NcStateSummarySplit,
  type NcSystemEventDelivery,
  type NcSystemEventFamily,
  scheduleForSendTimes,
  systemEventSummarySplitOf,
} from '@camstack/types'
import { Button, useSystem, Radio } from '@camstack/ui-library'
import { useMutation } from '@tanstack/react-query'

import { HINT_CLASS } from './notification-condition-widgets'
import { ScheduleField } from './notification-schedule-field'
import {
  DEFAULT_SEND_TIME,
  previewVerdictOf,
  withSummarySchedule,
  withSummarySplit,
} from './notification-system-event-delivery'
import { useTranslation } from 'react-i18next'

interface Props {
  readonly value: NcSystemEventDelivery | undefined
  readonly family: NcSystemEventFamily | undefined
  readonly onChange: (next: NcSystemEventDelivery) => void
  /** The rule as it would be saved now — what the preview asks about. */
  readonly draft: () => NcRuleInput
}

export function SystemEventDeliveryField({ value, family, onChange, draft }: Props) {
  const { t } = useTranslation()
  if (family === undefined || !NC_SYSTEM_EVENT_SUMMARY_FAMILIES.includes(family)) return null
  const summary = value?.mode === 'summary' ? value : null
  return (
    <div className="rounded-md border border-border px-3 py-3" data-testid="rule-delivery">
      <div className="mb-2 text-[11px] font-semibold text-foreground">
        {t('system.notificationSystemEventDelivery.delivery', 'Delivery')}
      </div>
      <div className="flex flex-wrap gap-3 text-xs">
        <label className="flex items-center gap-1.5">
          <Radio
            name="system-event-delivery"
            checked={summary === null}
            onChange={() => onChange({ mode: 'instant' })}
            data-testid="rule-delivery-instant"
          />
          {t(
            'system.notificationSystemEventDelivery.instantANotificationPerEvent',
            'Instant — a notification per event',
          )}
        </label>
        <label className="flex items-center gap-1.5">
          <Radio
            name="system-event-delivery"
            checked={summary !== null}
            onChange={() =>
              onChange({ mode: 'summary', schedule: scheduleForSendTimes([DEFAULT_SEND_TIME]) })
            }
            data-testid="rule-delivery-summary"
          />
          {t(
            'system.notificationSystemEventDelivery.summaryOnScheduleTheCurrent',
            'Summary on schedule — the current state, at set times',
          )}
        </label>
      </div>
      {summary !== null && <SummarySchedule value={summary} onChange={onChange} draft={draft} />}
    </div>
  )
}

interface SummaryScheduleProps {
  readonly value: Extract<NcSystemEventDelivery, { readonly mode: 'summary' }>
  readonly onChange: (next: NcSystemEventDelivery) => void
  readonly draft: () => NcRuleInput
}

function SummarySchedule({ value, onChange, draft }: SummaryScheduleProps) {
  const { t } = useTranslation()
  const timezone = value.schedule.timezone
  const split = systemEventSummarySplitOf({ systemEventDelivery: value })
  return (
    <div className="mt-2 space-y-2">
      <p className={HINT_CLASS}>
        {t(
          'system.notificationSystemEventDelivery.nothingIsSentPerEvent',
          'Nothing is sent per event. At each time below, one notification lists what is still true for the kinds and filters of this rule — low batteries, consumables, devices or streams offline, updates available — or one notification per category, if you choose so below. Nothing to report sends nothing. Time zone:',
        )}{' '}
        {timezone ?? t('system.notificationSystemEventDelivery.theHubS', 'the hub’s')}.
      </p>
      {/* Same punctual ScheduleField as ConfigUI `type: 'schedule', mode: 'times'`
          (TV schedule, etc.) — one HH:MM per row, stored as one-minute windows. */}
      <ScheduleField
        mode="times"
        value={value.schedule}
        onChange={(next) => {
          // A summary needs at least one send time — refuse clearing the last row.
          if (next === undefined) return
          onChange(withSummarySchedule(value, next))
        }}
      />
      <fieldset className="flex flex-wrap gap-3 text-xs" data-testid="rule-delivery-split">
        <legend className="sr-only">
          {t(
            'system.notificationSystemEventDelivery.howTheSummaryIsSent',
            'How the summary is sent',
          )}
        </legend>
        <label className="flex items-center gap-1.5">
          <Radio
            name="system-event-summary-split"
            checked={split === 'rule'}
            onChange={() => onChange(withSummarySplit(value, 'rule'))}
            data-testid="rule-delivery-split-rule"
          />
          {t(
            'system.notificationSystemEventDelivery.oneMessageWithEveryCategory',
            'One message with every category',
          )}
        </label>
        <label className="flex items-center gap-1.5">
          <Radio
            name="system-event-summary-split"
            checked={split === 'section'}
            onChange={() => onChange(withSummarySplit(value, 'section'))}
            data-testid="rule-delivery-split-section"
          />
          {t(
            'system.notificationSystemEventDelivery.oneNotificationPerCategoryBatteries',
            'One notification per category (batteries, consumables, devices…)',
          )}
        </label>
      </fieldset>
      <SummaryPreview draft={draft} split={split} />
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
