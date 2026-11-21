/**
 * A duration as one number input and one unit select: the control of a
 * `wait-until` timeout and of a `wait` step. The caller owns the split and
 * join (`wait-until-model.ts`); this draws them.
 */
import { Input, Select } from '@camstack/ui-library'
import { PickerLabel } from './FieldPicker'

export interface DurationFieldProps<U extends string> {
  readonly label: string
  readonly unitAriaLabel: string
  readonly value: number
  readonly unit: U
  readonly units: readonly U[]
  readonly unitLabel: Readonly<Record<U, string>>
  readonly isUnit: (text: string) => text is U
  readonly min: number
  /** Called with what the operator typed or picked; the caller joins it into the stored value. */
  readonly onChange: (value: number, unit: U) => void
  readonly valueTestId: string
  readonly unitTestId: string
}

export function DurationField<U extends string>({
  label,
  unitAriaLabel,
  value,
  unit,
  units,
  unitLabel,
  isUnit,
  min,
  onChange,
  valueTestId,
  unitTestId,
}: DurationFieldProps<U>) {
  return (
    <>
      <label className="w-24">
        <PickerLabel>{label}</PickerLabel>
        <Input
          type="number"
          min={min}
          data-testid={valueTestId}
          value={String(value)}
          onChange={(e) => onChange(Number(e.target.value), unit)}
        />
      </label>
      <div className="w-32">
        <Select
          data-testid={unitTestId}
          aria-label={unitAriaLabel}
          value={unit}
          onChange={(e) => onChange(value, isUnit(e.target.value) ? e.target.value : unit)}
          options={units.map((u) => ({ value: u, label: unitLabel[u] }))}
        />
      </div>
    </>
  )
}
