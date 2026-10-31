/**
 * The `schedule` catalog widget — weekly activation windows OR punctual send
 * times, both stored as the ordinary `NcSchedule`.
 *
 * Two authoring modes, one wire shape:
 *
 *   - `windows` (default) — start→end bands. Used when the consumer means
 *     "active WHILE inside" (notification rule conditions, recording bands).
 *   - `times` — one HH:MM per row. Used when the consumer means "fire AT"
 *     (TV schedule, state-summary delivery). Stored as one-minute windows via
 *     `scheduleForSendTimes` so the same schedule evaluator answers both.
 *
 * A stored schedule that is not a list of one-minute windows (longer or
 * inverted) cannot be shown as times: the editor falls back to the windows
 * view and says so.
 */

import {
  scheduleForSendTimes,
  sendTimesForEditor,
  type NcSchedule,
  type NcScheduleWindow,
  type NcSummarySendTime,
} from '@camstack/types'
import { Plus, Trash2 } from 'lucide-react'

import { HINT_CLASS } from './notification-condition-widgets'
import {
  DEFAULT_SEND_TIME,
  hhmmOf,
  minuteOfHhmm,
  WEEKDAY_CHOICES,
} from './notification-system-event-delivery'
import { useTranslation } from 'react-i18next'
import { Button, Checkbox, Input } from '@camstack/ui-library'

export type ScheduleFieldMode = 'windows' | 'times'

interface ScheduleFieldProps {
  readonly value: NcSchedule | undefined
  readonly onChange: (next: NcSchedule | undefined) => void
  /**
   * `windows` — start→end bands (default).
   * `times` — punctual HH:MM rows stored as one-minute NcSchedule windows.
   */
  readonly mode?: ScheduleFieldMode
  /** Seed minute for a newly added punctual row. Default 08:00. */
  readonly defaultMinute?: number
  /** Shown when there are no windows (default: rule-firing copy). */
  readonly emptyHint?: string
}

function minutesToHhmm(minute: number): string {
  return hhmmOf(minute)
}

function hhmmToMinutes(value: string): number {
  return minuteOfHhmm(value)
}

function newWindow(): NcScheduleWindow {
  return { days: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1080 }
}

function newSendTime(defaultMinute: number): NcSummarySendTime {
  return { days: [...DEFAULT_SEND_TIME.days], minute: defaultMinute }
}

const DEFAULT_WINDOWS_EMPTY_HINT = 'Always active — add a window to restrict when the rule fires.'

export function ScheduleField({
  value,
  onChange,
  mode = 'windows',
  defaultMinute = DEFAULT_SEND_TIME.minute,
  emptyHint,
}: ScheduleFieldProps) {
  if (mode === 'times') {
    return <TimesScheduleField value={value} onChange={onChange} defaultMinute={defaultMinute} />
  }
  return (
    <WindowsScheduleField
      value={value}
      onChange={onChange}
      emptyHint={emptyHint ?? DEFAULT_WINDOWS_EMPTY_HINT}
    />
  )
}

function WindowsScheduleField({
  value,
  onChange,
  emptyHint,
}: {
  readonly value: NcSchedule | undefined
  readonly onChange: (next: NcSchedule | undefined) => void
  readonly emptyHint: string
}) {
  const { t } = useTranslation()
  const windows = value?.windows ?? []
  const invert = value?.invert ?? false

  const commit = (nextWindows: NcScheduleWindow[], nextInvert: boolean): void => {
    if (nextWindows.length === 0) {
      onChange(undefined)
      return
    }
    onChange({
      windows: nextWindows,
      ...(nextInvert ? { invert: true } : {}),
      ...(value?.timezone ? { timezone: value.timezone } : {}),
    })
  }

  const addWindow = (): void => commit([...windows, newWindow()], invert)
  const removeAt = (i: number): void =>
    commit(
      windows.filter((_, idx) => idx !== i),
      invert,
    )
  const replaceAt = (i: number, win: NcScheduleWindow): void =>
    commit(
      windows.map((w, idx) => (idx === i ? win : w)),
      invert,
    )

  return (
    <div className="mt-1 space-y-2" data-testid="schedule-field-windows">
      {windows.length === 0 ? (
        <p className={HINT_CLASS}>{emptyHint}</p>
      ) : (
        windows.map((win, i) => (
          <ScheduleWindowRow
            key={i}
            window={win}
            onChange={(w) => replaceAt(i, w)}
            onRemove={() => removeAt(i)}
          />
        ))
      )}
      <div className="flex items-center gap-3">
        <Button
          variant="unstyled"
          type="button"
          onClick={addWindow}
          className="flex items-center gap-1 rounded-md bg-surface-hover px-2 py-1 text-[11px] text-foreground-subtle hover:text-foreground"
        >
          <Plus className="h-3 w-3" /> {t('system.notificationScheduleField.addWindow')}
        </Button>
        {windows.length > 0 && (
          <label className="flex items-center gap-1.5 text-[11px] text-foreground-subtle">
            <Checkbox
              checked={invert}
              onChange={(e) => commit([...windows], e.target.checked)}
              className="accent-primary"
            />
            {t(
              'system.notificationScheduleField.activeOutsideTheWindows',
              'Active outside the windows',
            )}
          </label>
        )}
      </div>
    </div>
  )
}

function TimesScheduleField({
  value,
  onChange,
  defaultMinute,
}: {
  readonly value: NcSchedule | undefined
  readonly onChange: (next: NcSchedule | undefined) => void
  readonly defaultMinute: number
}) {
  const { t } = useTranslation()
  const timezone = value?.timezone
  const parsed =
    value === undefined ? { times: [], approximated: false } : sendTimesForEditor(value)

  // Inverted schedules cannot map to punctual rows — only then show bands.
  if (parsed === null) {
    return (
      <div className="mt-1 space-y-2" data-testid="schedule-field-times-fallback">
        <p className={HINT_CLASS}>
          {t(
            'system.notificationScheduleField.invertedScheduleShownAsBands',
            'Inverted schedule — shown as bands. Clear the invert flag (or the windows) to author punctual times.',
          )}
        </p>
        <WindowsScheduleField
          value={value}
          onChange={onChange}
          emptyHint={DEFAULT_WINDOWS_EMPTY_HINT}
        />
      </div>
    )
  }

  const rows = parsed.times
  const commit = (next: readonly NcSummarySendTime[]): void => {
    if (next.length === 0) {
      onChange(undefined)
      return
    }
    onChange(scheduleForSendTimes(next, timezone))
  }

  return (
    <div className="mt-1 space-y-2" data-testid="schedule-field-times">
      {parsed.approximated && (
        <p className={HINT_CLASS} data-testid="schedule-field-times-approximated">
          {t(
            'system.notificationScheduleField.shownAsSendAtTimes',
            "Shown as send-at times from each window's end (when the summary fires). Edit or save to store them as punctual one-minute windows.",
          )}
        </p>
      )}
      {rows.length === 0 ? (
        <p className={HINT_CLASS}>
          {t(
            'system.notificationScheduleField.noTimesYetAddOne',
            'No times yet — add one to send on those days at that clock time.',
          )}
        </p>
      ) : (
        rows.map((time, i) => (
          <SendTimeRow
            key={i}
            time={time}
            index={i}
            onChange={(next) => commit(rows.map((t, idx) => (idx === i ? next : t)))}
            onRemove={
              rows.length > 1 ? () => commit(rows.filter((_, idx) => idx !== i)) : undefined
            }
          />
        ))
      )}
      <Button
        variant="unstyled"
        type="button"
        onClick={() => commit([...rows, newSendTime(defaultMinute)])}
        className="flex items-center gap-1 rounded-md bg-surface-hover px-2 py-1 text-[11px] text-foreground-subtle hover:text-foreground"
        data-testid="schedule-field-add-time"
      >
        <Plus className="h-3 w-3" /> {t('system.notificationScheduleField.addTime')}
      </Button>
    </div>
  )
}

interface ScheduleWindowRowProps {
  readonly window: NcScheduleWindow
  readonly onChange: (win: NcScheduleWindow) => void
  readonly onRemove: () => void
}

function ScheduleWindowRow({ window: win, onChange, onRemove }: ScheduleWindowRowProps) {
  const { t } = useTranslation()
  const toggleDay = (day: number): void => {
    const next = win.days.includes(day) ? win.days.filter((d) => d !== day) : [...win.days, day]
    if (next.length === 0) return // schema requires ≥1 day
    onChange({ ...win, days: next })
  }
  return (
    <div className="space-y-1.5 rounded-md border border-border p-2">
      <div className="flex items-center gap-2 text-xs">
        <Input
          type="time"
          value={minutesToHhmm(win.startMinute)}
          onChange={(e) => onChange({ ...win, startMinute: hhmmToMinutes(e.target.value) })}
          className="rounded-md border border-border bg-background px-1 py-0.5"
        />
        <span className="text-foreground-subtle">→</span>
        <Input
          type="time"
          value={minutesToHhmm(win.endMinute)}
          onChange={(e) => onChange({ ...win, endMinute: hhmmToMinutes(e.target.value) })}
          className="rounded-md border border-border bg-background px-1 py-0.5"
        />
        <span className="flex-1" />
        <Button
          variant="unstyled"
          type="button"
          onClick={onRemove}
          aria-label={t('system.notificationScheduleField.removeWindow', 'Remove window')}
          className="text-foreground-subtle hover:text-danger"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <WeekdayToggles days={win.days} onToggle={toggleDay} />
    </div>
  )
}

interface SendTimeRowProps {
  readonly time: NcSummarySendTime
  readonly index: number
  readonly onChange: (next: NcSummarySendTime) => void
  readonly onRemove: (() => void) | undefined
}

function SendTimeRow({ time, index, onChange, onRemove }: SendTimeRowProps) {
  const { t } = useTranslation()
  const toggleDay = (day: number): void => {
    const days = time.days.includes(day) ? time.days.filter((d) => d !== day) : [...time.days, day]
    if (days.length === 0) return // a send time needs at least one day
    onChange({ ...time, days })
  }
  return (
    <div className="space-y-1.5 rounded-md border border-border p-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-foreground-subtle">
          {t('system.notificationScheduleField.at', 'At')}
        </span>
        <Input
          type="time"
          value={hhmmOf(time.minute)}
          onChange={(e) => onChange({ ...time, minute: minuteOfHhmm(e.target.value) })}
          className="rounded-md border border-border bg-background px-1 py-0.5"
          data-testid={`schedule-field-time-${String(index)}`}
        />
        <span className="flex-1" />
        {onRemove !== undefined && (
          <Button
            variant="unstyled"
            type="button"
            onClick={onRemove}
            aria-label={t('system.notificationScheduleField.removeTime', 'Remove time')}
            className="text-foreground-subtle hover:text-danger"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <WeekdayToggles days={time.days} onToggle={toggleDay} />
    </div>
  )
}

function WeekdayToggles({
  days,
  onToggle,
}: {
  readonly days: readonly number[]
  readonly onToggle: (day: number) => void
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {WEEKDAY_CHOICES.map((d) => {
        const on = days.includes(d.value)
        return (
          <Button
            variant="unstyled"
            key={d.value}
            type="button"
            onClick={() => onToggle(d.value)}
            className={`rounded px-1.5 py-0.5 text-[10px] ${on ? 'bg-primary text-primary-foreground' : 'bg-surface-hover text-foreground-subtle'}`}
          >
            {d.label}
          </Button>
        )
      })}
    </div>
  )
}
