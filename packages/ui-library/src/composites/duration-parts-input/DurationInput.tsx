/**
 * A duration as one number field per unit — hours, minutes, seconds,
 * milliseconds — in any subset the caller shows. The caller also names the
 * unit the value is STORED in (`ms` or `s`), so the form never converts.
 * Typing in one field keeps the others and emits the new total; a field shows
 * what was typed until it is left, then the total is written the tidy way
 * (90 minutes reads 1 h 30 min).
 *
 * Nothing is clamped: a duration outside `min` / `max` (storage unit) is
 * emitted and every field is marked, so the caller's own check says why.
 */
import { type ReactNode, useState } from 'react'
import { Input } from '../../primitives/input.js'
import {
  type DurationStorageUnit,
  type DurationUnit,
  type DurationUnitValues,
  joinDuration,
  orderDurationUnits,
  splitDuration,
} from './duration-parts.js'

export type DurationUnitLabels = Readonly<Record<DurationUnit, string>>

/** The accessible name of each field; pass translated ones. */
export const DEFAULT_DURATION_UNIT_LABELS: DurationUnitLabels = {
  hours: 'Hours',
  minutes: 'Minutes',
  seconds: 'Seconds',
  millis: 'Milliseconds',
}

/** Unit symbols: the same in every language the UI ships. */
const SUFFIX: DurationUnitLabels = { hours: 'h', minutes: 'min', seconds: 's', millis: 'ms' }

const DEFAULT_UNITS: readonly DurationUnit[] = ['hours', 'minutes', 'seconds']

interface UnitDraft {
  readonly unit: DurationUnit
  readonly text: string
}

export interface DurationInputProps {
  /** The duration, in `storageUnit`. */
  readonly value: number
  readonly onChange: (value: number) => void
  /** The unit `value`, `min` and `max` are in. */
  readonly storageUnit?: DurationStorageUnit
  /** The fields shown; default hours, minutes, seconds. */
  readonly units?: readonly DurationUnit[]
  /** Bounds in `storageUnit`; outside them the fields are marked, the number is still emitted. */
  readonly min?: number
  readonly max?: number
  /** The smallest shown unit takes a fraction (a half-second wait). */
  readonly fractional?: boolean
  readonly labels?: Partial<DurationUnitLabels>
  readonly disabled?: boolean
  /** Names the fields as one group. */
  readonly 'aria-label'?: string
  /** `<prefix>-hours`, `<prefix>-minutes`, `<prefix>-seconds`, `<prefix>-millis`. */
  readonly testIdPrefix?: string
  readonly className?: string
}

export function DurationInput({
  value,
  onChange,
  storageUnit = 's',
  units = DEFAULT_UNITS,
  min,
  max,
  fractional = false,
  labels,
  disabled = false,
  'aria-label': ariaLabel,
  testIdPrefix,
  className,
}: DurationInputProps): ReactNode {
  const [draft, setDraft] = useState<UnitDraft | null>(null)
  const visible = orderDurationUnits(units)
  const smallest = visible[visible.length - 1]
  const parts = splitDuration(value, storageUnit, visible)
  const invalid = (min !== undefined && value < min) || (max !== undefined && value > max)

  const type = (unit: DurationUnit, text: string): void => {
    const typed = text.trim() === '' ? 0 : Number(text)
    const whole = unit !== smallest || !fractional
    setDraft({ unit, text })
    if (!Number.isFinite(typed) || typed < 0 || (whole && !Number.isInteger(typed))) return
    const next: DurationUnitValues = { ...parts, [unit]: typed }
    onChange(joinDuration(next, storageUnit))
  }

  return (
    <fieldset
      aria-label={ariaLabel}
      disabled={disabled}
      className={`inline-flex min-w-0 items-center gap-1.5 ${className ?? ''}`}
    >
      {visible.map((unit) => {
        const takesFraction = unit === smallest && fractional
        return (
          <span key={unit} className="inline-flex items-center gap-1">
            <Input
              type="number"
              inputMode={takesFraction ? 'decimal' : 'numeric'}
              min={0}
              step={takesFraction ? 'any' : 1}
              className={unit === 'millis' ? 'w-20' : 'w-14'}
              aria-label={labels?.[unit] ?? DEFAULT_DURATION_UNIT_LABELS[unit]}
              aria-invalid={invalid}
              state={invalid ? 'error' : 'default'}
              disabled={disabled}
              data-testid={testIdPrefix === undefined ? undefined : `${testIdPrefix}-${unit}`}
              value={draft?.unit === unit ? draft.text : String(parts[unit] ?? 0)}
              onChange={(event) => type(unit, event.target.value)}
              onBlur={() => setDraft(null)}
            />
            <span className="text-xs text-foreground-subtle">{SUFFIX[unit]}</span>
          </span>
        )
      })}
    </fieldset>
  )
}
