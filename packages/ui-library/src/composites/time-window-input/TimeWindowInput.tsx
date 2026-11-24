/**
 * A daily window as the operator edits it: the whole day, two times (a clock
 * time or a sun event with an offset each; the range may cross midnight, and
 * the input says so), or the Day / Night preset, plus the weekdays. The value
 * is a `TimeWindow` from `@camstack/types` and every change emits one the
 * evaluator can read; what `TimeWindowSchema` refuses (an empty day list, an
 * offset past twelve hours) is emitted anyway and shown inline, so the caller
 * decides what to do with a draft that is not yet valid.
 *
 * Sun times cannot be judged on a site without a location: `siteHasNoLocation`
 * disables the sun choices (and the Day / Night presets) with the reason.
 */
import { TimeWindowSchema, type TimeWindow, type WeekdayKey } from '@camstack/types'
import { type ReactNode } from 'react'
import { useUiText } from '../../contexts/ui-text.js'
import { Button } from '../../primitives/button.js'
import { Select } from '../../primitives/select.js'
import { TimeSpecInput } from './TimeSpecInput.js'
import {
  ALL_WEEKDAYS,
  editableWindowEnd,
  modeOfWindow,
  selectedDays,
  type TimeWindowMode,
  toggleWindowDay,
  windowWrapsMidnight,
  withWindowEnd,
  withWindowMode,
} from './time-window-model.js'

export interface TimeWindowInputProps {
  readonly value: TimeWindow
  readonly onChange: (next: TimeWindow) => void
  /** Offer the Day / Night presets. Default true. */
  readonly presets?: boolean
  /** Offer the weekday chips and the whole-day choice. Default true. */
  readonly weekdays?: boolean
  /**
   * Only what a stored clock range can hold: two clock times and the weekdays. No whole-day choice,
   * no Day / Night presets, no sun times, and no mode select (it would have one option).
   */
  readonly clockOnly?: boolean
  /** The site has no location: sun choices are disabled with a reason. */
  readonly siteHasNoLocation?: boolean
  readonly disabled?: boolean
  /** Prefix of the test ids: `<p>-fields`, `<p>-from`, `<p>-to`, `<p>-wraps`, `<p>-no-days`, `<p>-errors`. */
  readonly testIdPrefix?: string
}

const MODE_LABEL: Readonly<Record<TimeWindowMode, readonly [string, string]>> = {
  'whole-day': ['uiLibrary.timeWindow.mode.wholeDay', 'The whole day'],
  between: ['uiLibrary.timeWindow.mode.between', 'Between two times'],
  day: ['uiLibrary.timeWindow.mode.day', 'Daytime (sunrise to sunset)'],
  night: ['uiLibrary.timeWindow.mode.night', 'Nighttime (sunset to sunrise)'],
}

const DAY_LABEL: Readonly<Record<WeekdayKey, string>> = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
  sat: 'Sat',
  sun: 'Sun',
}

export function TimeWindowInput({
  value,
  onChange,
  presets = true,
  weekdays = true,
  clockOnly = false,
  siteHasNoLocation = false,
  disabled = false,
  testIdPrefix = 'time-window',
}: TimeWindowInputProps): ReactNode {
  const t = useUiText()
  const mode = modeOfWindow(value)
  const between = value.between
  const days = selectedDays(value)
  const offered: readonly TimeWindowMode[] = clockOnly
    ? ['between']
    : [
        ...(weekdays ? (['whole-day'] as const) : []),
        'between',
        ...(presets ? (['day', 'night'] as const) : []),
      ]
  // A stored value this field does not OFFER (a whole-day window under `weekdays={false}`, a
  // preset under `presets={false}`) keeps its option, so the select names what is stored.
  const modes: readonly TimeWindowMode[] = offered.includes(mode) ? offered : [mode, ...offered]
  const issues = TimeWindowSchema.safeParse(value).error?.issues ?? []
  const daysEmpty = value.days?.length === 0
  const otherIssues = issues.filter((issue) => issue.path[0] !== 'days')
  const sunDisabledNote =
    siteHasNoLocation && value.preset !== undefined ? (
      <p className="text-xs text-warning" data-testid={`${testIdPrefix}-no-location`}>
        {t(
          'uiLibrary.timeWindow.noLocation',
          'This site has no location, so a sun time cannot be judged. Set the site location to use it.',
        )}
      </p>
    ) : null
  return (
    <div className="flex w-full flex-col gap-2" data-testid={`${testIdPrefix}-fields`}>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        {!clockOnly && (
          <label>
            <span className="mb-1 block text-xs font-medium text-foreground-muted">
              {t('uiLibrary.timeWindow.windowLabel', 'Time of day')}
            </span>
            <Select
              wrapperClassName="relative w-40"
              aria-label={t('uiLibrary.timeWindow.windowLabel', 'Time of day')}
              disabled={disabled}
              value={mode}
              options={modes.map((m) => ({
                value: m,
                label: t(MODE_LABEL[m][0], MODE_LABEL[m][1]),
                disabled: siteHasNoLocation && (m === 'day' || m === 'night') && mode !== m,
              }))}
              onChange={(e) => {
                const next = modes.find((m) => m === e.target.value)
                if (next !== undefined && next !== mode) onChange(withWindowMode(value, next))
              }}
            />
          </label>
        )}
        {between !== undefined && (
          <>
            <div>
              <span className="mb-1 block text-xs font-medium text-foreground-muted">
                {t('uiLibrary.timeWindow.from', 'From')}
              </span>
              <TimeSpecInput
                label={t('uiLibrary.timeWindow.from', 'From')}
                testId={`${testIdPrefix}-from`}
                disabled={disabled}
                siteHasNoLocation={siteHasNoLocation}
                allowSun={!clockOnly}
                value={editableWindowEnd(between.from)}
                onChange={(end) => {
                  if (end.kind !== 'date') onChange(withWindowEnd(value, 'from', end))
                }}
              />
            </div>
            <div>
              <span className="mb-1 block text-xs font-medium text-foreground-muted">
                {t('uiLibrary.timeWindow.to', 'To')}
              </span>
              <TimeSpecInput
                label={t('uiLibrary.timeWindow.to', 'To')}
                testId={`${testIdPrefix}-to`}
                disabled={disabled}
                siteHasNoLocation={siteHasNoLocation}
                allowSun={!clockOnly}
                value={editableWindowEnd(between.to)}
                onChange={(end) => {
                  if (end.kind !== 'date') onChange(withWindowEnd(value, 'to', end))
                }}
              />
            </div>
          </>
        )}
      </div>
      {sunDisabledNote}
      {weekdays && (
        <div>
          <span className="mb-1 block text-xs font-medium text-foreground-muted">
            {t('uiLibrary.timeWindow.days', 'Days')}
          </span>
          <div
            className="flex flex-wrap gap-1"
            role="group"
            aria-label={t('uiLibrary.timeWindow.days', 'Days')}
          >
            {ALL_WEEKDAYS.map((day) => {
              const on = days.includes(day)
              return (
                <Button
                  key={day}
                  size="sm"
                  variant={on ? 'primary' : 'outline'}
                  aria-pressed={on}
                  disabled={disabled}
                  onClick={() => onChange(toggleWindowDay(value, day))}
                >
                  {t(`uiLibrary.timeWindow.day.${day}`, DAY_LABEL[day])}
                </Button>
              )
            })}
          </div>
          {daysEmpty && (
            <p className="mt-1 text-xs text-danger" data-testid={`${testIdPrefix}-no-days`}>
              {t('uiLibrary.timeWindow.noDays', 'Pick at least one day.')}
            </p>
          )}
        </div>
      )}
      {windowWrapsMidnight(value) && (
        <p className="text-xs text-foreground-subtle" data-testid={`${testIdPrefix}-wraps`}>
          {t(
            'uiLibrary.timeWindow.wraps',
            'This window ends the next day. The days are the days it starts on.',
          )}
        </p>
      )}
      {otherIssues.length > 0 && (
        <ul className="text-xs text-danger" role="alert" data-testid={`${testIdPrefix}-errors`}>
          {otherIssues.map((issue) => (
            <li key={`${issue.path.join('.')}:${issue.message}`}>{issue.message}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
