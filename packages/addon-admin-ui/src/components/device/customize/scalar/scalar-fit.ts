/**
 * Which fields of a source device a declared scalar target can read (D936).
 * A number with the wrong unit is named, never accepted.
 */
import {
  CAP_CUSTOMIZE_CATALOG,
  runtimeFieldUnit,
  SOURCE_CAP_ACTIVE_FIELD,
  type CustomizeCatalogTarget,
  type CustomizeCatalogTransform,
} from '@camstack/types'
import type { DeviceSnapshot, WireableCatalog } from '../source-picker-model'
import { readPath } from '../source-picker-model'
import {
  SCALAR_FIT_REASON_KIND,
  SCALAR_FIT_REASON_UNIT,
  SCALAR_FIT_REASON_UNIT_UNKNOWN,
} from './scalar-reason'

export const SCALAR_TRANSFORM_KINDS = ['identity', 'invert', 'threshold', 'linear'] as const
export type ScalarTransformKind = (typeof SCALAR_TRANSFORM_KINDS)[number]

export interface ScalarFieldOffer {
  readonly cap: string
  readonly path: string
  readonly kind: 'boolean' | 'number' | 'string' | 'enum'
  readonly unit: string | null
}

export type ScalarFitReason = 'kind' | 'unit' | 'unit-unknown'

export interface ScalarFieldFit {
  readonly ok: true
  readonly valueKind: 'boolean' | 'number' | 'string'
  readonly sourceUnit: string | null
  readonly transforms: readonly ScalarTransformKind[]
  /** Declared parameters for those transforms. The form copies defaults from here. */
  readonly declared: readonly CustomizeCatalogTransform[]
}

export type ScalarFieldVerdict =
  | ScalarFieldFit
  | { readonly ok: false; readonly reason: ScalarFitReason }

function isTransformKind(kind: string): kind is ScalarTransformKind {
  return kind === 'identity' || kind === 'invert' || kind === 'threshold' || kind === 'linear'
}

function catalogTarget(cap: string, targetId: string): CustomizeCatalogTarget | null {
  const entry = Object.entries(CAP_CUSTOMIZE_CATALOG).find(([name]) => name === cap)?.[1]
  if (entry === undefined) return null
  return entry.targets.find((target) => target.id === targetId) ?? null
}

export function scalarOutputPath(cap: string, targetId: string): string | null {
  return catalogTarget(cap, targetId)?.path ?? null
}

export function scalarFieldOffers(
  catalog: WireableCatalog,
  snapshot: DeviceSnapshot | null,
): readonly ScalarFieldOffer[] {
  return catalog.caps.flatMap((cap) => {
    const slice = capUnit(snapshot, cap.cap)
    return cap.fields
      .filter((field) => field.item !== true)
      .map((field) => ({
        cap: cap.cap,
        path: field.path,
        kind: field.kind,
        unit: fieldUnit(slice, cap.cap, field.path),
      }))
  })
}

/**
 * The unit of one field: the slice's own `unit` when it publishes one (a sensor
 * reports what it measures), else the unit its quantity is stored in. A meter
 * slice carries several quantities and no single unit (D951).
 */
export function fieldUnit(sliceUnit: string | null, cap: string, path: string): string | null {
  return sliceUnit ?? runtimeFieldUnit(cap, path) ?? null
}

function capUnit(snapshot: DeviceSnapshot | null, cap: string): string | null {
  if (snapshot === null) return null
  const unit = readPath(snapshot[cap], 'unit')
  return typeof unit === 'string' && unit.length > 0 ? unit : null
}

/** Which declaration source entry accepts this wireable field (scalar, keyed, event). */
export function declarationSourceForField(
  sources: CustomizeCatalogTarget['sources'],
  field: ScalarFieldOffer,
): CustomizeCatalogTarget['sources'][number] | null {
  if (field.kind === 'boolean') {
    // The declaration's binary/switch source is the cap's active on/off
    // (`SOURCE_CAP_ACTIVE_FIELD`), never every boolean the device happens to
    // publish (reachability, a broker flag).
    const active = SOURCE_CAP_ACTIVE_FIELD[field.cap]
    if (active === undefined || active !== field.path) return null
    if (field.cap === 'switch') {
      return (
        sources.find((source) => source.kind === 'switch') ??
        sources.find((source) => source.kind === 'binary') ??
        null
      )
    }
    return (
      sources.find((source) => source.kind === 'binary') ??
      sources.find((source) => source.kind === 'field' && source.valueKinds?.includes('boolean')) ??
      null
    )
  }
  if (field.kind === 'number') {
    return (
      sources.find((source) => source.kind === 'numeric') ??
      sources.find((source) => source.kind === 'field' && source.valueKinds?.includes('number')) ??
      null
    )
  }
  if (field.kind === 'string') {
    return (
      sources.find((source) => source.kind === 'field' && source.valueKinds?.includes('string')) ??
      null
    )
  }
  return null
}

export function scalarFieldFit(
  cap: string,
  targetId: string,
  field: ScalarFieldOffer,
): ScalarFieldVerdict {
  const target = catalogTarget(cap, targetId)
  if (target === null || target.cardinality !== 'scalar') {
    return { ok: false, reason: SCALAR_FIT_REASON_KIND }
  }
  if (field.kind === 'enum') return { ok: false, reason: SCALAR_FIT_REASON_KIND }
  const source = declarationSourceForField(target.sources, field)
  if (source === null) return { ok: false, reason: SCALAR_FIT_REASON_KIND }
  if (source.requiredUnit !== undefined && field.unit === null) {
    return { ok: false, reason: SCALAR_FIT_REASON_UNIT_UNKNOWN }
  }
  if (source.requiredUnit !== undefined && field.unit !== source.requiredUnit) {
    return { ok: false, reason: SCALAR_FIT_REASON_UNIT }
  }
  const transforms = source.transformKinds.filter(isTransformKind)
  if (transforms.length === 0) return { ok: false, reason: SCALAR_FIT_REASON_KIND }
  return {
    ok: true,
    valueKind: field.kind,
    sourceUnit: source.requiredUnit ?? null,
    transforms,
    declared: source.transforms,
  }
}
