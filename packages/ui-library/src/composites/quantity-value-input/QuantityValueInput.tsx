/**
 * A number tied to a physical quantity: a number field and a unit picker
 * (D972). The person picks the unit; the component emits `{ value, unit }`:
 * "this number is in this unit". The caller stores it (`typedToStored`).
 *
 * `value` is the STORED number, in `storedUnit` (the quantity base for a
 * reading, the declared unit for a method param). It is shown in the unit the
 * person picked (`unit`, e.g. `leaf.unit` / `argUnits[arg]`); a number saved
 * in grams and picked in ounces reads as ounces. Changing the unit keeps the
 * physical amount and only changes how it is written.
 *
 * With one selectable unit there is no picker: the unit is a suffix.
 */
import { type QuantityValue, type ReadingQuantity, unitDimension } from '@camstack/types'
import { type ReactNode, useState } from 'react'
import { Input } from '../../primitives/input.js'
import { UnitPicker } from '../unit-picker/UnitPicker.js'
import {
  type QuantityBounds,
  isPickableUnit,
  outsideBounds,
  quantityStoredUnit,
  quantityUnitChoices,
  storedToPicked,
} from './quantity-value.js'

const PICKER_CLASS =
  'h-7 w-20 px-1.5 text-xs bg-surface border border-border rounded-md text-foreground focus:outline-none focus:ring-1 focus:ring-inset focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed'

export interface QuantityValueInputProps {
  readonly quantity: ReadingQuantity
  /** The stored number, in `storedUnit`. */
  readonly value: number | undefined
  /** The unit `value` is stored in. Default: the quantity's base unit. */
  readonly storedUnit?: string
  /** The unit the person picked for it. Default: `storedUnit`. */
  readonly unit?: string
  /** Bounds in `storedUnit`. */
  readonly min?: number
  readonly max?: number
  readonly onChange: (next: QuantityValue) => void
  /** Called when the typed text contains "{" (a variable menu opens). */
  readonly onBrace?: () => void
  readonly disabled?: boolean
  readonly placeholder?: string
  readonly 'aria-label'?: string
  readonly className?: string
}

function shown(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? '' : String(value)
}

export function QuantityValueInput({
  quantity,
  value,
  storedUnit,
  unit,
  min,
  max,
  onChange,
  onBrace,
  disabled = false,
  placeholder,
  'aria-label': ariaLabel,
  className,
}: QuantityValueInputProps): ReactNode {
  const stored = storedUnit ?? quantityStoredUnit(quantity)
  const choices = quantityUnitChoices(quantity)
  const [draft, setDraft] = useState<string | null>(null)
  const [pendingUnit, setPendingUnit] = useState<string | undefined>(undefined)
  if (stored === undefined) return null

  const requested = pendingUnit ?? unit
  const picked = isPickableUnit(quantity, requested) ? (requested ?? stored) : stored
  const display = value === undefined ? undefined : storedToPicked(value, stored, picked)
  const bounds: QuantityBounds = { min, max }
  const invalid = outsideBounds(value, bounds)

  const pickUnit = (next: string): void => {
    if (value === undefined) {
      setPendingUnit(next)
      return
    }
    setPendingUnit(undefined)
    onChange({ value: storedToPicked(value, stored, next), unit: next })
  }

  return (
    <span className={`inline-flex items-center gap-1 ${className ?? ''}`}>
      <Input
        type="text"
        inputMode="decimal"
        className="w-20"
        aria-label={ariaLabel}
        placeholder={placeholder}
        disabled={disabled}
        state={invalid ? 'error' : 'default'}
        value={draft ?? shown(display)}
        onChange={(event) => {
          const text = event.target.value
          if (text.includes('{')) {
            onBrace?.()
            return
          }
          setDraft(text)
          const parsed = text.trim() === '' ? Number.NaN : Number(text)
          if (Number.isFinite(parsed)) onChange({ value: parsed, unit: picked })
        }}
        onBlur={() => setDraft(null)}
      />
      {choices.length > 1 ? (
        <UnitPicker
          dimension={unitDimension(stored)}
          value={picked}
          onChange={pickUnit}
          disabled={disabled}
          className={PICKER_CLASS}
          aria-label={ariaLabel === undefined ? undefined : `${ariaLabel} unit`}
        />
      ) : (
        <span className="text-xs text-foreground-subtle">{picked}</span>
      )}
    </span>
  )
}
