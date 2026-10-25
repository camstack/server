/**
 * Shared, pure resolution of a sensor's DISPLAY unit + precision + value
 * transform. One function so the two renderers (`SensorValueAtom`,
 * `SensorHeroCard`) can never diverge — they duplicated this precedence before.
 *
 * Resolution order (device override → role default → live slice →
 * ROLE_DESCRIPTOR canonicalUnit). `??` everywhere, never `||`: `precision: 0`
 * is a legal override and must win over a slice `precision: 2`.
 *
 * Conversion happens at RENDER only — storage stays in source units. An
 * override unit converts the raw slice value ONLY when it shares a dimension
 * with the source unit (`canConvertUnit`); on refusal the display falls back to
 * identity + the SOURCE unit so a unit label and its value math can never
 * disagree. Precision applies AFTER conversion (by construction — the caller
 * runs `formatNumeric(toDisplayValue(raw), precision)`).
 */
import type { DeviceDisplayOverride, RoleDisplayDefault } from '@camstack/types'
import { canConvertUnit, normalizeUnit, tryConvertUnit } from '@camstack/types'

/** Table keys are canonical spellings; providers often send `C` / `F` / `celsius`. */
function canonUnit(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  return normalizeUnit(raw) ?? raw
}

export interface SensorDisplayInput {
  /** Per-device override from the row (`DeviceInfo.display`). */
  readonly display?: DeviceDisplayOverride
  /** Cap name for `perCap` refinement (e.g. 'numeric-sensor'); undefined skips it. */
  readonly capName?: string
  /** Role default (`roleDisplayDefaults[device.role]`). */
  readonly roleDefault?: RoleDisplayDefault
  /** Live slice unit (the unit the raw VALUE is actually in, for generic sensors). */
  readonly sliceUnit?: string
  /** Live slice precision. */
  readonly slicePrecision?: number
  /** ROLE_DESCRIPTOR canonical unit fallback (typed roles). */
  readonly canonicalUnit?: string
}

export interface ResolvedSensorDisplay {
  /** Display unit — `''` when none resolves anywhere. */
  readonly unit: string
  /** Display precision (int 0-10) or undefined for auto-format. */
  readonly precision: number | undefined
  /** Convert a raw slice value into the display unit. Identity unless an
   *  override unit differs from the source unit AND both share a dimension. */
  readonly toDisplayValue: (raw: number) => number
}

const identity = (raw: number): number => raw

export function resolveSensorDisplay(input: SensorDisplayInput): ResolvedSensorDisplay {
  const perCap = input.capName !== undefined ? input.display?.perCap?.[input.capName] : undefined

  // Precision: device perCap → device-level → role default → live slice.
  const precision =
    perCap?.precision ??
    input.display?.precision ??
    input.roleDefault?.precision ??
    input.slicePrecision

  // The unit the raw VALUE is actually in: live slice unit wins, else the
  // typed role's canonical unit. Normalize before convert (UNIT_TABLE keys
  // only) — Ecowitt / HA often publish `C` rather than `°C`.
  const sourceUnit = canonUnit(input.sliceUnit ?? input.canonicalUnit)
  // Operator-chosen override unit (device perCap → device-level → role default).
  const overrideUnit = canonUnit(perCap?.unit ?? input.display?.unit ?? input.roleDefault?.unit)

  // Real conversion only when the override differs from the source AND both
  // share a dimension. sourceUnit/overrideUnit are narrowed to string here, so
  // no casts are needed to feed `tryConvertUnit`.
  if (
    overrideUnit !== undefined &&
    sourceUnit !== undefined &&
    overrideUnit !== sourceUnit &&
    canConvertUnit(sourceUnit, overrideUnit)
  ) {
    return {
      unit: overrideUnit,
      precision,
      toDisplayValue: (raw: number): number => tryConvertUnit(raw, sourceUnit, overrideUnit) ?? raw,
    }
  }

  // No override, same unit, cross-dimension refusal, or no source unit: show
  // the source unit and render the value verbatim (label and math consistent).
  return { unit: sourceUnit ?? '', precision, toDisplayValue: identity }
}
