/**
 * The fields of a `time-is` row: the whole day or a window between two
 * moments (each a clock time or a sun event with an offset), and the days.
 * The days name the day a window STARTS on, which the row says when the window
 * ends the next day.
 */
import type { TimeIsLeaf } from '@camstack/types'
import { Button, Input, Select } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import { DraftNumberInput } from '../flow/DraftNumberInput'
import { clockText, parseClockText } from '../schedulers/scheduler-model'
import { PickerLabel } from './FieldPicker'
import {
  ALL_WEEKDAYS,
  editableEnd,
  seedEnd,
  selectedDays,
  SUN_EVENTS,
  type TimeEnd,
  toggleDay,
  withEnd,
  withWindow,
  wrapsMidnight,
} from './time-is-model'

export interface TimeIsFieldsProps {
  readonly leaf: TimeIsLeaf
  readonly onChange: (next: TimeIsLeaf) => void
}

interface TimeEndFieldsProps {
  /** "From" / "To": the group's name, and the prefix of each control's accessible name. */
  readonly label: string
  readonly testId: string
  readonly end: TimeEnd
  readonly onChange: (next: TimeEnd) => void
}

function TimeEndFields({ label, testId, end, onChange }: TimeEndFieldsProps) {
  const { t } = useTranslation()
  const named = (what: string): string => `${label}: ${what}`
  return (
    <div role="group" aria-label={label} data-testid={testId}>
      <PickerLabel>{label}</PickerLabel>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          wrapperClassName="relative w-40"
          aria-label={label}
          value={end.kind}
          options={[
            { value: 'clock', label: t('schedulers.point.clock', 'At a time') },
            {
              value: 'sun',
              label: t('schedulers.point.sun', 'At a sun event'),
            },
          ]}
          onChange={(e) => {
            const kind = e.target.value
            if ((kind === 'clock' || kind === 'sun') && kind !== end.kind) onChange(seedEnd(kind))
          }}
        />
        {end.kind === 'clock' && (
          <Input
            type="time"
            className="w-28"
            aria-label={named(t('schedulers.point.time', 'Time'))}
            value={clockText(end.hh, end.mm)}
            onChange={(e) => {
              const parsed = parseClockText(e.target.value)
              if (parsed !== null && parsed.kind === 'clock') onChange(parsed)
            }}
          />
        )}
        {end.kind === 'sun' && (
          <>
            <Select
              wrapperClassName="relative w-40"
              aria-label={named(t('schedulers.point.sunEvent', 'Sun event'))}
              value={end.event}
              options={SUN_EVENTS.map((event) => ({
                value: event,
                label: t(`schedulers.sun.${event}`, event),
              }))}
              onChange={(e) => {
                const event = SUN_EVENTS.find((candidate) => candidate === e.target.value)
                if (event !== undefined) onChange({ ...end, event })
              }}
            />
            <DraftNumberInput
              aria-label={named(
                t('schedulers.point.offset', 'Offset (minutes, negative = before)'),
              )}
              title={t('schedulers.point.offset', 'Offset (minutes, negative = before)')}
              className="w-20"
              value={end.offsetMin}
              onValue={(value) => {
                if (value !== null) onChange({ ...end, offsetMin: Math.round(value) })
              }}
            />
          </>
        )}
      </div>
    </div>
  )
}

export function TimeIsFields({ leaf, onChange }: TimeIsFieldsProps) {
  const { t } = useTranslation()
  const between = leaf.between
  const days = selectedDays(leaf)
  return (
    <div className="flex w-full flex-col gap-2" data-testid="time-is-fields">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <label>
          <PickerLabel>{t('automation.timeIs.window', 'Time of day')}</PickerLabel>
          <Select
            wrapperClassName="relative w-40"
            aria-label={t('automation.timeIs.window', 'Time of day')}
            value={between === undefined ? 'whole-day' : 'between'}
            options={[
              {
                value: 'between',
                label: t('automation.timeIs.between', 'Between two times'),
              },
              {
                value: 'whole-day',
                label: t('automation.timeIs.wholeDay', 'The whole day'),
              },
            ]}
            onChange={(e) => onChange(withWindow(leaf, e.target.value === 'between'))}
          />
        </label>
        {between !== undefined && (
          <>
            <TimeEndFields
              label={t('automation.timeIs.from', 'From')}
              testId="time-is-from"
              end={editableEnd(between.from)}
              onChange={(end) => onChange(withEnd(leaf, 'from', end))}
            />
            <TimeEndFields
              label={t('automation.timeIs.to', 'To')}
              testId="time-is-to"
              end={editableEnd(between.to)}
              onChange={(end) => onChange(withEnd(leaf, 'to', end))}
            />
          </>
        )}
      </div>
      <div>
        <PickerLabel>{t('schedulers.profile.days', 'Days')}</PickerLabel>
        <div
          className="flex flex-wrap gap-1"
          role="group"
          aria-label={t('schedulers.profile.days', 'Days')}
        >
          {ALL_WEEKDAYS.map((day) => {
            const on = days.includes(day)
            return (
              <Button
                key={day}
                size="sm"
                variant={on ? 'primary' : 'outline'}
                aria-pressed={on}
                onClick={() => onChange(toggleDay(leaf, day))}
              >
                {t(`schedulers.day.${day}`, day)}
              </Button>
            )
          })}
        </div>
        {days.length === 0 && (
          <p className="mt-1 text-xs text-warning" data-testid="time-is-no-days">
            {t('automation.timeIs.noDays', 'Pick at least one day.')}
          </p>
        )}
        {wrapsMidnight(leaf) && (
          <p className="mt-1 text-xs text-foreground-subtle" data-testid="time-is-wraps">
            {t(
              'automation.timeIs.wraps',
              'This window ends the next day. The days are the days it starts on.',
            )}
          </p>
        )}
      </div>
    </div>
  )
}
