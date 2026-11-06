/**
 * "Fill from device": the operator picks one device for a cap, each field still to
 * fill proposes its best fitting value, and the operator confirms row by row. This
 * is the pure half: which values fit a row, and which one is the best.
 */
import type {
  CompositionFieldKind,
  CompositionFieldSource,
  CompositionSourceRef,
} from '@camstack/types'
import { runtimeFieldUnit } from '@camstack/types'
import {
  type DeviceSnapshot,
  type PickerDevice,
  pickerFieldRows,
  type WireableCatalog,
} from '../source-picker-model'
import type { FieldRow } from './field-rows'

export interface FillCandidate {
  readonly cap: string
  readonly path: string
  readonly source: CompositionFieldSource
  readonly value: unknown
}

export interface FillProposal {
  readonly row: FieldRow
  /** The fitting values, best first. Empty = nothing on this device fits the row. */
  readonly candidates: readonly FillCandidate[]
}

/** A row with a unit reads a number; any other row takes whatever the field holds. */
export function fillTargetKind(row: FieldRow): CompositionFieldKind | null {
  return runtimeFieldUnit(row.cap, row.path) !== undefined ? 'number' : null
}

/** The same field of the same cap is the best fit, the same field name of another cap next. */
function rank(row: FieldRow, candidate: FillCandidate): number {
  if (candidate.cap === row.cap && candidate.path === row.path) return 2
  if (candidate.path === row.path) return 1
  return 0
}

/**
 * A value is proposed only when it names the same field: a number never fills a row
 * because it happens to be a number. Anything else stays for the operator to bind by hand.
 */
export function proposeFills(
  rows: readonly FieldRow[],
  device: PickerDevice,
  catalog: WireableCatalog,
  snapshot: DeviceSnapshot | null,
): readonly FillProposal[] {
  return rows
    .filter((row) => row.entry === null && row.item === null)
    .map((row): FillProposal => {
      const candidates = pickerFieldRows(device, catalog, snapshot, fillTargetKind(row))
        .flatMap((found): FillCandidate[] =>
          found.source === null
            ? []
            : [{ cap: found.cap, path: found.path, source: found.source, value: found.value }],
        )
        .map((candidate) => ({ candidate, score: rank(row, candidate) }))
        .filter((entry) => entry.score > 0)
        .toSorted((a, b) => b.score - a.score)
        .map((entry) => entry.candidate)
      return { row, candidates }
    })
}

export function sourceRefOf(device: PickerDevice): CompositionSourceRef {
  return { addonId: device.addonId, stableId: device.stableId }
}
