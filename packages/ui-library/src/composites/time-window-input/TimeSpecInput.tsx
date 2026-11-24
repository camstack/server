/**
 * One moment of the day, as data: a clock time, a sun event plus or minus an
 * offset, or (only when the caller allows it) one local date and time. The
 * value is a `TimeSpec` from `@camstack/types`; nothing is converted.
 *
 * A sun time cannot be judged on a site without a location: the caller flags
 * that with `siteHasNoLocation` and the sun choice is disabled with its reason.
 */
import { SunEventSchema, type TimeSpec } from '@camstack/types'
import { type ReactNode, useState } from 'react'
import { useUiText } from '../../contexts/ui-text.js'
import { Input } from '../../primitives/input.js'
import { Select } from '../../primitives/select.js'
import { clockInputText, parseClockInputText, SUN_EVENTS } from './time-window-model.js'

export type TimeSpecKind = TimeSpec['kind']

const SEED: Readonly<Record<TimeSpecKind, TimeSpec>> = {
  clock: { kind: 'clock', hh: 12, mm: 0 },
  sun: { kind: 'sun', event: 'sunset', offsetMin: 0 },
  date: { kind: 'date', local: '2026-01-01T12:00' },
}

export interface TimeSpecInputProps {
  readonly value: TimeSpec
  readonly onChange: (next: TimeSpec) => void
  /** Offer "On a date" (one local date and time). Default false: a daily window cannot use it. */
  readonly allowDate?: boolean
  /** Offer "At a sun event". Default true; false for a stored shape that holds only clock times. */
  readonly allowSun?: boolean
  /** The site has no location: sun choices are disabled and say why. */
  readonly siteHasNoLocation?: boolean
  /** Names the group, and prefixes each control's accessible name ("From: Time"). */
  readonly label: string
  readonly disabled?: boolean
  readonly testId?: string
  readonly className?: string
}

const WHOLE_NUMBER = /^-?\d+$/

/** The integer a typed offset commits as; `-0` is `0`. */
function wholeMinutes(number: number): number {
  const rounded = Math.round(number)
  return rounded === 0 ? 0 : rounded
}

export function TimeSpecInput({
  value,
  onChange,
  allowDate = false,
  allowSun = true,
  siteHasNoLocation = false,
  label,
  disabled = false,
  testId,
  className,
}: TimeSpecInputProps): ReactNode {
  const t = useUiText()
  const [offsetDraft, setOffsetDraft] = useState<string | null>(null)
  const named = (what: string): string => `${label}: ${what}`
  const noLocation = t(
    'uiLibrary.timeWindow.noLocation',
    'This site has no location, so a sun time cannot be judged. Set the site location to use it.',
  )
  const kindOptions = [
    {
      value: 'clock',
      label: t('uiLibrary.timeWindow.kind.clock', 'At a time'),
    },
    ...(allowSun
      ? [
          {
            value: 'sun',
            label: t('uiLibrary.timeWindow.kind.sun', 'At a sun event'),
            disabled: siteHasNoLocation,
          },
        ]
      : []),
    ...(allowDate
      ? [
          {
            value: 'date',
            label: t('uiLibrary.timeWindow.kind.date', 'On a date'),
          },
        ]
      : []),
  ]
  return (
    <div
      role="group"
      aria-label={label}
      data-testid={testId}
      className={className ?? 'flex flex-wrap items-center gap-2'}
    >
      {kindOptions.length > 1 && (
        <Select
          wrapperClassName="relative w-40"
          aria-label={label}
          disabled={disabled}
          value={value.kind}
          options={kindOptions}
          onChange={(e) => {
            const kind = e.target.value
            if ((kind === 'clock' || kind === 'sun' || kind === 'date') && kind !== value.kind) {
              setOffsetDraft(null)
              onChange(SEED[kind])
            }
          }}
        />
      )}
      {value.kind === 'clock' && (
        <Input
          type="time"
          className="w-28"
          disabled={disabled}
          aria-label={named(t('uiLibrary.timeWindow.time', 'Time'))}
          value={clockInputText(value.hh, value.mm)}
          onChange={(e) => {
            const parsed = parseClockInputText(e.target.value)
            if (parsed !== null) onChange({ kind: 'clock', ...parsed })
          }}
        />
      )}
      {value.kind === 'date' && (
        <Input
          type="datetime-local"
          className="w-52"
          disabled={disabled}
          aria-label={named(t('uiLibrary.timeWindow.date', 'Date and time'))}
          value={value.local}
          onChange={(e) => {
            if (e.target.value !== '') onChange({ kind: 'date', local: e.target.value })
          }}
        />
      )}
      {value.kind === 'sun' && (
        <>
          <Select
            wrapperClassName="relative w-40"
            disabled={disabled}
            aria-label={named(t('uiLibrary.timeWindow.sunEvent', 'Sun event'))}
            value={value.event}
            options={SUN_EVENTS.map((event) => ({
              value: event,
              label: t(`uiLibrary.timeWindow.sun.${event}`, event),
            }))}
            onChange={(e) => {
              const parsed = SunEventSchema.safeParse(e.target.value)
              if (parsed.success) onChange({ ...value, event: parsed.data })
            }}
          />
          <Input
            type="text"
            inputMode="numeric"
            className="w-20"
            disabled={disabled}
            aria-label={named(
              t('uiLibrary.timeWindow.offset', 'Offset (minutes, negative = before)'),
            )}
            title={t('uiLibrary.timeWindow.offset', 'Offset (minutes, negative = before)')}
            value={offsetDraft ?? String(value.offsetMin)}
            onChange={(e) => {
              const text = e.target.value
              setOffsetDraft(text)
              // Only a whole number is stored while typing; "1.5" waits for the blur.
              if (WHOLE_NUMBER.test(text.trim())) {
                onChange({ ...value, offsetMin: wholeMinutes(Number(text)) })
              }
            }}
            onBlur={() => {
              const number = Number(offsetDraft)
              if (offsetDraft !== null && offsetDraft.trim() !== '' && Number.isFinite(number)) {
                const minutes = wholeMinutes(number)
                if (minutes !== value.offsetMin) onChange({ ...value, offsetMin: minutes })
              }
              setOffsetDraft(null)
            }}
          />
        </>
      )}
      {siteHasNoLocation && value.kind === 'sun' && (
        <p className="w-full text-xs text-warning" data-testid={testId && `${testId}-no-location`}>
          {noLocation}
        </p>
      )}
    </div>
  )
}
