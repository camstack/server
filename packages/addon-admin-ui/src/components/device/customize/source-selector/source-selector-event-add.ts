import type { CameraSensorMode } from '@camstack/types'
import { SOURCE_CAP_CHANGED_AT_FIELD } from '@camstack/types'
import type { EventShape } from '../event/event-fit'
import { pulseFieldFits } from '../event/event-fit'
import type { PickerDevice, WireableCatalog } from '../source-picker-model'

export interface EventPickedRow {
  readonly deviceId: number
  readonly addonId: string
  readonly stableId: string
  readonly cap: string
  readonly fieldPath: string
  readonly deviceName: string
  readonly changedAtField?: string
  readonly mode?: CameraSensorMode
}

function rowKey(row: EventPickedRow): string {
  return `${row.addonId}/${row.stableId}/${row.cap}.${row.fieldPath}`
}

export function appendEventPick(
  rows: readonly EventPickedRow[],
  device: PickerDevice,
  catalog: WireableCatalog,
  cap: string,
  fieldPath: string,
  shape: EventShape,
  pendingMode: CameraSensorMode,
): readonly EventPickedRow[] {
  if (shape === 'pulse' && !pulseFieldFits(catalog, cap, fieldPath)) return rows
  const changedAtField = shape === 'pulse' ? SOURCE_CAP_CHANGED_AT_FIELD[cap] : undefined
  if (shape === 'pulse' && changedAtField === undefined) return rows
  const next: EventPickedRow = {
    deviceId: device.id,
    addonId: device.addonId,
    stableId: device.stableId,
    cap,
    fieldPath,
    deviceName: device.name,
    ...(changedAtField !== undefined ? { changedAtField } : {}),
    ...(shape === 'span' ? { mode: pendingMode } : {}),
  }
  if (rows.some((row) => rowKey(row) === rowKey(next))) return rows
  return [...rows, next]
}

export function removeEventPick(
  rows: readonly EventPickedRow[],
  row: EventPickedRow,
): readonly EventPickedRow[] {
  const key = rowKey(row)
  return rows.filter((item) => rowKey(item) !== key)
}

export function updateEventPickMode(
  rows: readonly EventPickedRow[],
  row: EventPickedRow,
  mode: CameraSensorMode,
): readonly EventPickedRow[] {
  const key = rowKey(row)
  return rows.map((item) => (rowKey(item) === key ? { ...item, mode } : item))
}
