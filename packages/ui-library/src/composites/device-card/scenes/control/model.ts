import type { CardCommon, CardCommonActions } from '../../shell/model'

/** A number, in the unit the operator reads (converted by the connected card). */
export interface NumericControlValue {
  readonly kind: 'numeric'
  readonly value: number
  readonly unit: string | null
  readonly min: number | null
  readonly max: number | null
  readonly step: number | null
  readonly precision: number | null
}

export interface SelectControlValue {
  readonly kind: 'select'
  readonly value: string
  readonly options: readonly string[]
}

export interface TextControlValue {
  readonly kind: 'text'
  readonly value: string
}

/** A date, a time or both, in the browser editor's shape, plus how it reads. */
export interface DateTimeControlValue {
  readonly kind: 'datetime'
  readonly editor: 'date' | 'time' | 'datetime-local'
  readonly value: string
  /** The value formatted for reading; null when it is empty. */
  readonly shown: string | null
}

export type ControlCardValue =
  | NumericControlValue
  | SelectControlValue
  | TextControlValue
  | DateTimeControlValue

export interface ControlCardModel {
  readonly common: CardCommon
  readonly control: ControlCardValue
  readonly since: string | null
  /** The binding implements `setValue`; false draws the value read-only. */
  readonly settable: boolean
}

export interface ControlCardActions extends CardCommonActions {
  /** A number in the shown unit, or the string of the other kinds. */
  readonly onSet: (value: number | string) => void
}

/** The number one step away, clamped into the range. */
export function steppedValue(control: NumericControlValue, direction: 1 | -1): number {
  const step = control.step ?? 1
  const next = control.value + direction * step
  const low = control.min ?? Number.NEGATIVE_INFINITY
  const high = control.max ?? Number.POSITIVE_INFINITY
  return Math.min(high, Math.max(low, Number(next.toFixed(10))))
}

export function numericText(control: NumericControlValue): string {
  return control.precision === null
    ? String(control.value)
    : control.value.toFixed(control.precision)
}
