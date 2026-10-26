/**
 * Source selector model (D944 §5): device cap-index filter (D648), value
 * compatibility from the customize catalog (D936), grouped by vocabulary.
 *
 * Enum keyed destinations: devices with `consumables` or any cap listed in
 * `CAP_RUNTIME_FIELD_UNITS` are candidates; other caps may still yield
 * incompatible values, which the value column collapses.
 */
import {
  CAP_CUSTOMIZE_CATALOG,
  CAP_RUNTIME_FIELD_UNITS,
  SOURCE_CAP_ACTIVE_FIELD,
  type CompositionFieldKind,
  type CustomizeCatalogSource,
  type CustomizeCatalogTarget,
} from '@camstack/types'
import { sourceFor } from '../source-for'
import { vocabularyCapTitle, vocabularyFieldLabel } from '../vocabulary-field-label'
import { declarationSourceForField, type ScalarFieldOffer } from '../scalar/scalar-fit'
import { keyedTargetFields } from '../keyed/keyed-fit'

export interface SourceDestination {
  readonly cap: string
  readonly targetId: string
  /** Keyed targets: which destination field is being filled. */
  readonly fieldPath?: string
  readonly title: string
  /** Formula bindings: any non-enum wireable field is direct. */
  readonly acceptAnyField?: boolean
  /** Override / assignment: fit via `sourceFor` instead of the customize catalog. */
  readonly pickerTargetKind?: CompositionFieldKind | null
}

export type SourceCompatibility =
  | { readonly kind: 'direct' }
  | { readonly kind: 'conversion'; readonly name: 'threshold' | 'scale' | 'invert' | 'enum-map' }
  | { readonly kind: 'incompatible'; readonly reason: 'kind' | 'unit' | 'unit-unknown' }

export interface SourceCandidateDevice {
  readonly id: number
  readonly name: string
  readonly type: string
  readonly location: string | null
  readonly parentDeviceId: number | null
  readonly addonId: string
  readonly stableId: string
  readonly caps: readonly string[]
}

export interface SourceWireableField {
  readonly cap: string
  readonly path: string
  readonly kind: 'boolean' | 'number' | 'string' | 'enum'
  readonly unit: string | null
  readonly currentText: string
}

export interface SourceValueRow {
  readonly cap: string
  readonly path: string
  readonly label: string
  readonly currentText: string
  readonly compatibility: SourceCompatibility
}

export interface SourceValueGroup {
  readonly cap: string
  readonly title: string
  readonly rows: readonly SourceValueRow[]
}

const SCALAR_TRANSFORMS = ['identity', 'invert', 'threshold', 'linear'] as const
type ScalarTransform = (typeof SCALAR_TRANSFORMS)[number]

function isCatalogCap(cap: string): cap is keyof typeof CAP_CUSTOMIZE_CATALOG {
  return Object.hasOwn(CAP_CUSTOMIZE_CATALOG, cap)
}

function catalogTarget(cap: string, targetId: string): CustomizeCatalogTarget | null {
  if (!isCatalogCap(cap)) return null
  return CAP_CUSTOMIZE_CATALOG[cap].targets.find((row) => row.id === targetId) ?? null
}

export function destinationSources(
  destination: SourceDestination,
): readonly CustomizeCatalogSource[] {
  const target = catalogTarget(destination.cap, destination.targetId)
  if (target === null) return []
  if (target.cardinality === 'keyedArray') {
    const path = destination.fieldPath
    if (path === undefined) return []
    const field = keyedTargetFields(destination.cap, destination.targetId).find(
      (row) => row.path === path,
    )
    return field?.sources ?? []
  }
  return target.sources
}

function offerFromField(field: SourceWireableField): ScalarFieldOffer {
  return {
    cap: field.cap,
    path: field.path,
    kind: field.kind,
    unit: field.unit,
  }
}

function catalogSourceForKeyed(
  sources: readonly CustomizeCatalogSource[],
  field: SourceWireableField,
): CustomizeCatalogSource | null {
  if (field.kind === 'number') {
    return sources.find((source) => source.kind === 'numeric') ?? null
  }
  if (field.kind === 'enum' || field.kind === 'string') {
    return sources.find((source) => source.kind === 'enum') ?? null
  }
  return null
}

function isScalarTransform(kind: string): kind is ScalarTransform {
  return kind === 'identity' || kind === 'invert' || kind === 'threshold' || kind === 'linear'
}

function compatibilityFromSource(
  source: CustomizeCatalogSource,
  field: SourceWireableField,
): SourceCompatibility {
  if (source.requiredUnit !== undefined && field.unit === null) {
    return { kind: 'incompatible', reason: 'unit-unknown' }
  }
  if (source.requiredUnit !== undefined && field.unit !== source.requiredUnit) {
    return { kind: 'incompatible', reason: 'unit' }
  }
  if (source.transformKinds.includes('enum-map')) {
    return { kind: 'conversion', name: 'enum-map' }
  }
  const transforms = source.transformKinds.filter(isScalarTransform)
  if (transforms.length === 0) return { kind: 'incompatible', reason: 'kind' }
  if (transforms.includes('identity')) return { kind: 'direct' }
  if (transforms.includes('threshold')) return { kind: 'conversion', name: 'threshold' }
  if (transforms.includes('linear')) return { kind: 'conversion', name: 'scale' }
  if (transforms.includes('invert')) return { kind: 'conversion', name: 'invert' }
  return { kind: 'incompatible', reason: 'kind' }
}

export function judgeSourceCompatibility(
  destination: SourceDestination,
  field: SourceWireableField,
): SourceCompatibility {
  if (destination.pickerTargetKind !== undefined) {
    const targetKind = destination.pickerTargetKind
    const ref = { addonId: 'x', stableId: 'y' }
    const source =
      targetKind === null
        ? { kind: 'from' as const, source: ref, cap: field.cap, fieldPath: field.path }
        : sourceFor(targetKind, {
            source: ref,
            cap: field.cap,
            fieldPath: field.path,
            kind: field.kind,
          })
    if (source === null) return { kind: 'incompatible', reason: 'kind' }
    return { kind: 'direct' }
  }
  if (destination.acceptAnyField === true) {
    if (field.kind === 'enum') return { kind: 'incompatible', reason: 'kind' }
    return { kind: 'direct' }
  }
  const target = catalogTarget(destination.cap, destination.targetId)
  if (target?.cardinality === 'event' && field.kind === 'boolean') {
    const sources = destinationSources(destination)
    if (declarationSourceForField(sources, offerFromField(field)) !== null) {
      return { kind: 'direct' }
    }
  }
  const sources = destinationSources(destination)
  if (sources.length === 0) return { kind: 'incompatible', reason: 'kind' }

  const keyed = target?.cardinality === 'keyedArray' && destination.fieldPath !== undefined

  if (field.kind === 'enum' && !keyed) {
    return { kind: 'incompatible', reason: 'kind' }
  }

  const source = keyed
    ? catalogSourceForKeyed(sources, field)
    : declarationSourceForField(sources, offerFromField(field))
  if (source === null) return { kind: 'incompatible', reason: 'kind' }
  return compatibilityFromSource(source, field)
}

function capHasRuntimeUnit(cap: string, unit: string): boolean {
  const table = CAP_RUNTIME_FIELD_UNITS[cap]
  if (table === undefined) return false
  return Object.values(table).includes(unit)
}

function capsWithRuntimeUnits(): readonly string[] {
  return Object.keys(CAP_RUNTIME_FIELD_UNITS)
}

function deviceMatchesSource(
  deviceCaps: readonly string[],
  source: CustomizeCatalogSource,
): boolean {
  if (source.kind === 'binary') {
    return deviceCaps.some((cap) => Object.hasOwn(SOURCE_CAP_ACTIVE_FIELD, cap))
  }
  if (source.kind === 'switch') {
    return deviceCaps.includes('switch')
  }
  if (source.kind === 'numeric') {
    const unit = source.requiredUnit
    if (unit === undefined) {
      return deviceCaps.some(
        (cap) => capsWithRuntimeUnits().includes(cap) || cap === 'numeric-sensor',
      )
    }
    if (unit === 'W') {
      return deviceCaps.some(
        (cap) => cap === 'numeric-sensor' || cap === 'power-meter' || capHasRuntimeUnit(cap, unit),
      )
    }
    return deviceCaps.some((cap) => capHasRuntimeUnit(cap, unit))
  }
  if (source.kind === 'field') {
    return deviceCaps.some(
      (cap) =>
        capsWithRuntimeUnits().includes(cap) || cap === 'numeric-sensor' || cap === 'battery',
    )
  }
  if (source.kind === 'enum') {
    return (
      deviceCaps.includes('consumables') ||
      deviceCaps.some((cap) => capsWithRuntimeUnits().includes(cap))
    )
  }
  return false
}

function deviceIsCompatible(
  device: SourceCandidateDevice,
  destination: SourceDestination,
): boolean {
  if (destination.pickerTargetKind !== undefined || destination.acceptAnyField === true) {
    return true
  }
  const sources = destinationSources(destination)
  if (sources.length === 0) return false
  return sources.some((source) => deviceMatchesSource(device.caps, source))
}

export function partitionSourceDevices(
  devices: readonly SourceCandidateDevice[],
  destination: SourceDestination,
  hostId: number,
): {
  readonly compatible: readonly SourceCandidateDevice[]
  readonly incompatible: readonly SourceCandidateDevice[]
} {
  const compatible: SourceCandidateDevice[] = []
  const incompatible: SourceCandidateDevice[] = []
  for (const device of devices) {
    if (device.id === hostId) continue
    if (deviceIsCompatible(device, destination)) compatible.push(device)
    else incompatible.push(device)
  }
  return { compatible, incompatible }
}

export function groupSourceValues(
  fields: readonly SourceWireableField[],
  destination: SourceDestination,
  language: string,
): {
  readonly groups: readonly SourceValueGroup[]
  readonly incompatible: readonly SourceValueRow[]
} {
  const byCap = new Map<string, SourceValueRow[]>()
  const incompatible: SourceValueRow[] = []
  for (const field of fields) {
    const compatibility = judgeSourceCompatibility(destination, field)
    const label = vocabularyFieldLabel(field.cap, field.path, language)
    const row: SourceValueRow = {
      cap: field.cap,
      path: field.path,
      label,
      currentText: field.currentText,
      compatibility,
    }
    if (compatibility.kind === 'incompatible') {
      incompatible.push(row)
      continue
    }
    const list = byCap.get(field.cap) ?? []
    list.push(row)
    byCap.set(field.cap, list)
  }
  const groups: SourceValueGroup[] = [...byCap.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([cap, rows]) => ({
      cap,
      title: vocabularyCapTitle(cap, language),
      rows: rows.toSorted((a, b) => a.label.localeCompare(b.label)),
    }))
  return { groups, incompatible }
}

/** Cap names for `useCapIndex` while the device column is open. */
export function destinationIsKeyed(destination: SourceDestination): boolean {
  const target = catalogTarget(destination.cap, destination.targetId)
  return target?.cardinality === 'keyedArray' && destination.fieldPath !== undefined
}

export function indexCapsForDestination(destination: SourceDestination): readonly string[] {
  if (destination.pickerTargetKind !== undefined) return []
  if (destination.acceptAnyField === true) return capsWithRuntimeUnits()
  const sources = destinationSources(destination)
  const caps = new Set<string>()
  for (const source of sources) {
    if (source.kind === 'binary') {
      for (const cap of Object.keys(SOURCE_CAP_ACTIVE_FIELD)) caps.add(cap)
    } else if (source.kind === 'switch') {
      caps.add('switch')
    } else if (source.kind === 'numeric') {
      caps.add('numeric-sensor')
      caps.add('power-meter')
      for (const cap of capsWithRuntimeUnits()) {
        if (source.requiredUnit === undefined || capHasRuntimeUnit(cap, source.requiredUnit)) {
          caps.add(cap)
        }
      }
    } else if (source.kind === 'field') {
      caps.add('battery')
      caps.add('numeric-sensor')
      for (const cap of capsWithRuntimeUnits()) caps.add(cap)
    } else if (source.kind === 'enum') {
      caps.add('consumables')
      for (const cap of capsWithRuntimeUnits()) caps.add(cap)
    }
  }
  return [...caps]
}
