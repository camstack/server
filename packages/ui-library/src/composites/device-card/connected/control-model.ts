import type { ControlKind, ControlSetValueInput, ControlStatus } from '@camstack/types'
import type { ControlDateTimeFormat } from '../../../lib/format-control-datetime'
import {
  type NumericControlDisplay,
  toDateInput,
  toDateTimeInput,
  toTimeInput,
} from '../../device-controls/control-panel'
import type { ControlCardValue } from '../scenes/control/model'

const EDITOR: Readonly<Record<ControlDateTimeFormat, 'date' | 'time' | 'datetime-local'>> = {
  date: 'date',
  time: 'time',
  datetime: 'datetime-local',
}

function editorValue(shape: ControlDateTimeFormat, raw: string): string {
  if (shape === 'date') return toDateInput(raw)
  if (shape === 'time') return toTimeInput(raw)
  return toDateTimeInput(raw)
}

/** The card's value from the `control` status: a number converted to the shown unit. */
export function controlCardValueOf(
  status: ControlStatus,
  numeric: NumericControlDisplay,
  shape: ControlDateTimeFormat,
  format: (raw: string) => string,
): ControlCardValue {
  switch (status.kind) {
    case 'numeric': {
      const value = typeof status.value === 'number' ? status.value : Number(status.value)
      const shown = (base: number | undefined): number | null =>
        base === undefined ? null : numeric.toShown(base)
      return {
        kind: 'numeric',
        value: numeric.toShown(value),
        unit: numeric.unit ?? null,
        min: shown(status.min),
        max: shown(status.max),
        step: shown(status.step),
        precision: numeric.precision ?? null,
      }
    }
    case 'select':
      return { kind: 'select', value: String(status.value), options: status.options }
    case 'text':
      return { kind: 'text', value: String(status.value) }
    case 'datetime': {
      const raw = String(status.value)
      return {
        kind: 'datetime',
        editor: EDITOR[shape],
        value: editorValue(shape, raw),
        shown: raw === '' ? null : format(raw),
      }
    }
  }
}

/** What `setValue` is sent: a number back in the device's unit; null when the value does not fit the kind. */
export function controlSetInput(
  kind: ControlKind,
  value: number | string,
  numeric: NumericControlDisplay,
): ControlSetValueInput | null {
  if (kind === 'numeric')
    return typeof value === 'number' ? { kind, value: numeric.toBase(value) } : null
  if (typeof value !== 'string') return null
  if ((kind === 'select' || kind === 'datetime') && value === '') return null
  return { kind, value }
}
