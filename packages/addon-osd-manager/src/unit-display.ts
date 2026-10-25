/**
 * Convert a numeric state value for OSD display using `@camstack/types`
 * UNIT_TABLE / tryConvertUnit (same set as D699).
 */
import { normalizeUnit, tryConvertUnit, unitDimension, type UnitDimension } from '@camstack/types'

export interface UnitDisplayResult {
  readonly value: number
  readonly unit: string
}

/**
 * Dimension for a UnitPicker from a raw source unit (may be bare `C`).
 * Normalize before `unitDimension` — the table only knows canonical spellings.
 */
export function dimensionFromSourceUnit(sourceUnit: string | undefined): UnitDimension | undefined {
  if (sourceUnit === undefined) return undefined
  const normalized = normalizeUnit(sourceUnit)
  if (normalized === undefined) return undefined
  return unitDimension(normalized)
}

/**
 * Convert `raw` from `sourceUnit` to `displayUnit` when both are known and
 * same-dimension. On refusal, keep the raw value and the source unit so the
 * label never lies about the number.
 */
export function convertForDisplay(
  raw: number,
  sourceUnit: string | undefined,
  displayUnit: string | undefined,
): UnitDisplayResult {
  const from = sourceUnit !== undefined ? normalizeUnit(sourceUnit) : undefined
  const to = displayUnit !== undefined ? normalizeUnit(displayUnit) : undefined
  if (from === undefined || to === undefined || from === to) {
    return { value: raw, unit: to ?? from ?? '' }
  }
  const converted = tryConvertUnit(raw, from, to)
  if (converted === undefined) return { value: raw, unit: from }
  return { value: converted, unit: to }
}

/**
 * Best-effort unit from a state slice: sibling `unit` at the same depth as
 * `valuePath`, else top-level `unit`.
 */
export function inferSourceUnit(slice: unknown, valuePath: string): string | undefined {
  if (typeof slice !== 'object' || slice === null || Array.isArray(slice)) return undefined
  const root: Record<string, unknown> = { ...slice }
  const segments = valuePath.split('.')
  if (segments.length >= 1) {
    let parent: unknown = root
    for (const segment of segments.slice(0, -1)) {
      if (typeof parent !== 'object' || parent === null || Array.isArray(parent)) {
        parent = undefined
        break
      }
      const next: Record<string, unknown> = { ...parent }
      parent = next[segment]
    }
    if (typeof parent === 'object' && parent !== null && !Array.isArray(parent)) {
      const unit = ({ ...parent } as Record<string, unknown>).unit
      if (typeof unit === 'string' && unit.length > 0) return unit
    }
  }
  const top = root.unit
  return typeof top === 'string' && top.length > 0 ? top : undefined
}
