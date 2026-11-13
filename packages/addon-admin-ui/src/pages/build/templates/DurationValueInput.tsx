/**
 * A duration input of a template (#527): stored in seconds, typed in the unit
 * the operator picks (s, min, h) through the library's quantity input (D972).
 * The picked unit is a view choice only; the value handed on is always seconds.
 */
import { QuantityValueInput, typedToStored } from '@camstack/ui-library'
import { useState, type ReactNode } from 'react'

const STORED_UNIT = 's'
const SECONDS_PER_MINUTE = 60

export interface DurationValueInputProps {
  readonly value: number | undefined
  readonly min?: number
  readonly max?: number
  readonly disabled?: boolean
  readonly 'aria-label'?: string
  readonly onChange: (seconds: number | undefined) => void
}

/** Whole minutes read better in minutes; anything else stays in seconds. */
function initialUnit(seconds: number | undefined): string {
  return seconds !== undefined &&
    seconds >= SECONDS_PER_MINUTE &&
    seconds % SECONDS_PER_MINUTE === 0
    ? 'min'
    : STORED_UNIT
}

export function DurationValueInput({
  value,
  min,
  max,
  disabled = false,
  'aria-label': ariaLabel,
  onChange,
}: DurationValueInputProps): ReactNode {
  const [unit, setUnit] = useState(() => initialUnit(value))
  return (
    <QuantityValueInput
      quantity="duration"
      storedUnit={STORED_UNIT}
      unit={unit}
      value={value}
      disabled={disabled}
      {...(min === undefined ? {} : { min })}
      {...(max === undefined ? {} : { max })}
      {...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel })}
      onChange={(typed) => {
        setUnit(typed.unit)
        try {
          onChange(Math.round(typedToStored(typed, STORED_UNIT).value))
        } catch {
          onChange(undefined)
        }
      }}
    />
  )
}
