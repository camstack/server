/**
 * Same-dimension unit picker. Lists only `unitsForDimension(dimension)`; an
 * empty dimension disables the control and shows `emptyReason` so the operator
 * never sees a refused conversion as a pickable option.
 */
import { normalizeUnit, type UnitDimension, unitsForDimension } from '@camstack/types'
import type { ChangeEvent, ReactNode } from 'react'

const FIELD_CLASS =
  'w-full min-w-0 px-1.5 py-0.5 text-[11px] bg-background border border-border rounded focus:outline-none focus:border-primary disabled:opacity-50 disabled:cursor-not-allowed'

export interface UnitPickerProps {
  readonly dimension: UnitDimension | undefined
  readonly value: string
  readonly onChange: (unit: string) => void
  readonly disabled?: boolean
  /** Shown when `dimension` is undefined; never offered as a pickable unit. */
  readonly emptyReason?: string
  /** Optional empty-value option label (inherit / source). */
  readonly inheritLabel?: string
  readonly className?: string
  readonly id?: string
  readonly 'aria-label'?: string
}

export function UnitPicker({
  dimension,
  value,
  onChange,
  disabled = false,
  emptyReason,
  inheritLabel,
  className,
  id,
  'aria-label': ariaLabel,
}: UnitPickerProps): ReactNode {
  const choices = dimension !== undefined ? unitsForDimension(dimension) : []
  const isEmpty = dimension === undefined
  const selectDisabled = disabled || isEmpty

  const handleChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    const raw = event.target.value
    if (raw === '') {
      onChange('')
      return
    }
    onChange(normalizeUnit(raw) ?? raw)
  }

  return (
    <div className="flex flex-col gap-0.5 min-w-0 w-full">
      <select
        id={id}
        className={className ?? FIELD_CLASS}
        aria-label={ariaLabel}
        value={value}
        onChange={handleChange}
        disabled={selectDisabled}
      >
        {inheritLabel !== undefined && <option value="">{inheritLabel}</option>}
        {choices.map((unit) => (
          <option key={unit} value={unit}>
            {unit}
          </option>
        ))}
      </select>
      {isEmpty && emptyReason !== undefined && emptyReason !== '' && (
        <span className="text-[10px] text-foreground-subtle">{emptyReason}</span>
      )}
    </div>
  )
}
