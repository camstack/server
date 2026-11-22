/**
 * A duration as one number field per unit: hours, minutes, seconds, side by
 * side. `seconds` is the stored duration; typing in one field keeps the other
 * two and emits the new total. A field shows what was typed until it is left,
 * then the total is written the tidy way (90 minutes reads 1 h 30 min).
 *
 * Nothing is clamped: a duration outside `min` / `max` is emitted and every
 * field is marked, so the caller's own check says why.
 */
import { type ReactNode, useState } from 'react'
import { Input } from '../../primitives/input.js'
import {
  DURATION_PARTS,
  type DurationPart,
  joinDurationParts,
  splitDurationParts,
} from './duration-parts.js'

export type DurationPartLabels = Readonly<Record<DurationPart, string>>

/** The accessible name of each field; pass translated ones. */
export const DEFAULT_DURATION_PART_LABELS: DurationPartLabels = {
  hours: 'Hours',
  minutes: 'Minutes',
  seconds: 'Seconds',
}

/** Unit symbols: the same in every language the UI ships. */
const SUFFIX: DurationPartLabels = { hours: 'h', minutes: 'min', seconds: 's' }

interface PartDraft {
  readonly part: DurationPart
  readonly text: string
}

export interface DurationPartsInputProps {
  /** The duration, in seconds. */
  readonly seconds: number
  readonly onChange: (seconds: number) => void
  /** Bounds in seconds; outside them the fields are marked, the number is still emitted. */
  readonly min?: number
  readonly max?: number
  /** The seconds field takes a fraction (a half-second wait). */
  readonly fractionalSeconds?: boolean
  readonly labels?: DurationPartLabels
  readonly disabled?: boolean
  /** Names the three fields as one group. */
  readonly 'aria-label'?: string
  /** `<prefix>-hours`, `<prefix>-minutes`, `<prefix>-seconds`. */
  readonly testIdPrefix?: string
  readonly className?: string
}

export function DurationPartsInput({
  seconds,
  onChange,
  min,
  max,
  fractionalSeconds = false,
  labels = DEFAULT_DURATION_PART_LABELS,
  disabled = false,
  'aria-label': ariaLabel,
  testIdPrefix,
  className,
}: DurationPartsInputProps): ReactNode {
  const [draft, setDraft] = useState<PartDraft | null>(null)
  const parts = splitDurationParts(seconds)
  const invalid = (min !== undefined && seconds < min) || (max !== undefined && seconds > max)

  const type = (part: DurationPart, text: string): void => {
    const typed = text.trim() === '' ? 0 : Number(text)
    const whole = part !== 'seconds' || !fractionalSeconds
    setDraft({ part, text })
    if (!Number.isFinite(typed) || typed < 0 || (whole && !Number.isInteger(typed))) return
    onChange(joinDurationParts({ ...parts, [part]: typed }))
  }

  return (
    <fieldset
      aria-label={ariaLabel}
      disabled={disabled}
      className={`inline-flex min-w-0 items-center gap-1.5 ${className ?? ''}`}
    >
      {DURATION_PARTS.map((part) => (
        <span key={part} className="inline-flex items-center gap-1">
          <Input
            type="number"
            inputMode={part === 'seconds' && fractionalSeconds ? 'decimal' : 'numeric'}
            min={0}
            step={part === 'seconds' && fractionalSeconds ? 'any' : 1}
            className="w-14"
            aria-label={labels[part]}
            aria-invalid={invalid}
            state={invalid ? 'error' : 'default'}
            disabled={disabled}
            data-testid={testIdPrefix === undefined ? undefined : `${testIdPrefix}-${part}`}
            value={draft?.part === part ? draft.text : String(parts[part])}
            onChange={(event) => type(part, event.target.value)}
            onBlur={() => setDraft(null)}
          />
          <span className="text-xs text-foreground-subtle">{SUFFIX[part]}</span>
        </span>
      ))}
    </fieldset>
  )
}
