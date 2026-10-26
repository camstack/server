/**
 * Which source fields one keyed-array item field can read (D936).
 */
import {
  CAP_CUSTOMIZE_CATALOG,
  type CustomizeCatalogField,
  type CustomizeCatalogSource,
  type CustomizeCatalogTarget,
} from '@camstack/types'
import type { DeviceSnapshot, WireableCatalog } from '../source-picker-model'
import { readPath } from '../source-picker-model'
import {
  type ScalarFieldFit,
  type ScalarFieldOffer,
  type ScalarFitReason,
  type ScalarTransformKind,
} from '../scalar/scalar-fit'

export interface KeyedFieldOffer extends ScalarFieldOffer {
  readonly enumValues: readonly string[]
}

function isTransformKind(kind: string): kind is ScalarTransformKind {
  return kind === 'identity' || kind === 'invert' || kind === 'threshold' || kind === 'linear'
}

function isCatalogCap(cap: string): cap is keyof typeof CAP_CUSTOMIZE_CATALOG {
  return Object.hasOwn(CAP_CUSTOMIZE_CATALOG, cap)
}

function catalogTargets(cap: string): readonly CustomizeCatalogTarget[] {
  if (!isCatalogCap(cap)) return []
  return CAP_CUSTOMIZE_CATALOG[cap].targets
}

export function keyedTargetFields(cap: string, targetId: string): readonly CustomizeCatalogField[] {
  const target = catalogTargets(cap).find((entry) => entry.id === targetId)
  return target?.cardinality === 'keyedArray' ? (target.fields ?? []) : []
}

export function keyedTraits(
  cap: string,
  targetId: string,
): NonNullable<CustomizeCatalogTarget['traits']> {
  const target = catalogTargets(cap).find((entry) => entry.id === targetId)
  return target?.traits ?? []
}

export function keyedFieldOffers(
  catalog: WireableCatalog,
  snapshot: DeviceSnapshot | null,
): readonly KeyedFieldOffer[] {
  return catalog.caps.flatMap((cap) => {
    const unit = capUnit(snapshot, cap.cap)
    return cap.fields
      .filter((field) => field.item !== true)
      .map((field) => ({
        cap: cap.cap,
        path: field.path,
        kind: field.kind,
        unit,
        enumValues: field.enumValues ?? [],
      }))
  })
}

function capUnit(snapshot: DeviceSnapshot | null, cap: string): string | null {
  if (snapshot === null) return null
  const unit = readPath(snapshot[cap], 'unit')
  return typeof unit === 'string' && unit.length > 0 ? unit : null
}

function catalogSource(
  sources: readonly CustomizeCatalogSource[],
  field: KeyedFieldOffer,
): CustomizeCatalogSource | null {
  if (field.kind === 'number') return sources.find((source) => source.kind === 'numeric') ?? null
  if (field.kind === 'enum' || field.kind === 'string') {
    return sources.find((source) => source.kind === 'enum') ?? null
  }
  return null
}

export type KeyedFit =
  | { readonly ok: true; readonly mode: 'scalar'; readonly fit: ScalarFieldFit }
  | { readonly ok: true; readonly mode: 'enum' }
  | { readonly ok: false; readonly reason: ScalarFitReason }

export function keyedFieldFit(
  cap: string,
  targetId: string,
  fieldPath: string,
  offer: KeyedFieldOffer,
): KeyedFit {
  const field = keyedTargetFields(cap, targetId).find((entry) => entry.path === fieldPath)
  if (field === undefined) return { ok: false, reason: 'kind' } // i18n-ignore: fit reason code
  const source = catalogSource(field.sources, offer)
  if (source === null) return { ok: false, reason: 'kind' } // i18n-ignore: fit reason code
  if (source.requiredUnit !== undefined && offer.unit === null) {
    return { ok: false, reason: 'unit-unknown' } // i18n-ignore: fit reason code
  }
  if (source.requiredUnit !== undefined && offer.unit !== source.requiredUnit) {
    return { ok: false, reason: 'unit' } // i18n-ignore: fit reason code
  }
  if (source.transformKinds.includes('enum-map')) return { ok: true, mode: 'enum' }
  const transforms = source.transformKinds.filter(isTransformKind)
  if (transforms.length === 0 || offer.kind !== 'number') {
    return { ok: false, reason: 'kind' } // i18n-ignore: fit reason code
  }
  return {
    ok: true,
    mode: 'scalar',
    fit: {
      ok: true,
      valueKind: 'number',
      sourceUnit: source.requiredUnit ?? null,
      transforms,
      declared: source.transforms,
    },
  }
}

export function keyedEnumOutputs(
  cap: string,
  targetId: string,
  fieldPath: string,
): readonly string[] {
  const field = keyedTargetFields(cap, targetId).find((entry) => entry.path === fieldPath)
  return field?.enumValues ?? []
}
