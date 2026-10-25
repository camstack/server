/**
 * Project a judged Customize declaration into the catalog wire shape (D936).
 * Throws when a path the guard should have rejected does not resolve.
 */
import { z } from 'zod'
import { DeviceType } from '../../packages/types/src/device/device-type.ts'
import type {
  CustomizeCatalogAdvancedParameter,
  CustomizeCatalogEntry,
  CustomizeCatalogField,
  CustomizeCatalogLiteral,
  CustomizeCatalogSource,
  CustomizeCatalogTarget,
  CustomizeCatalogTrait,
  CustomizeCatalogValueKind,
} from '../../packages/types/src/capabilities/customize-catalog.ts'
import {
  collectCustomizeOwnedPaths,
  collectEventTimestampPaths,
  deriveAdvancedParameters,
  type DerivedAdvancedParameter,
} from '../../packages/types/src/capabilities/advanced-parameters.ts'
import type {
  CapabilityCustomizeTarget,
  CustomizeSourceSpec,
  EventCustomizeTarget,
  EventSourceSpec,
  KeyedArrayCustomizeTarget,
  KeyedArrayFieldTarget,
  KeyedArrayLiteralSpec,
  KeyedArrayTraitSpec,
  ScalarCustomizeTarget,
} from '../../packages/types/src/capabilities/customize-spec.ts'
import type { CustomizeCapView } from './customize-declaration.ts'
import { arrayElement, isValueLeaf, resolveCustomizePath } from './customize-path.ts'

type Schema = z.ZodType

interface ProjectedLeaf {
  readonly kind: CustomizeCatalogValueKind
  readonly nullable: boolean
  readonly enumValues: readonly string[]
}

interface ListedEnums {
  readonly enumValues?: readonly string[]
}

interface ListedCompanions {
  readonly companions?: ScalarCustomizeTarget['companions']
}

export function projectCustomize(view: CustomizeCapView): CustomizeCatalogEntry {
  const spec = view.customize
  const runtime = view.runtimeState
  if (spec === undefined || runtime === undefined) {
    throw new Error(`customize catalog: ${view.capName} has nothing to project`)
  }
  return {
    version: 1,
    targets: spec.targets.map((target) => projectTarget(view, target, runtime)),
    advancedParameters: projectAdvancedParameters(view, runtime),
  }
}

function projectAdvancedParameters(
  view: CustomizeCapView,
  runtime: Schema,
): readonly CustomizeCatalogAdvancedParameter[] {
  const spec = view.customize
  if (spec === undefined || spec.advanced === undefined) return []
  const owned = collectCustomizeOwnedPaths(spec)
  const eventTs = collectEventTimestampPaths(spec)
  const derived = deriveAdvancedParameters(runtime, owned, eventTs)
  if (spec.advanced === 'derive') {
    return derived.map(toCatalogAdvanced)
  }
  const byPath = new Map(derived.map((row) => [row.path, row]))
  const listed: CustomizeCatalogAdvancedParameter[] = []
  for (const path of spec.advanced) {
    const row = byPath.get(path)
    if (row !== undefined) listed.push(toCatalogAdvanced(row))
  }
  return listed
}

function toCatalogAdvanced(row: DerivedAdvancedParameter): CustomizeCatalogAdvancedParameter {
  return {
    path: row.path,
    kind: row.kind,
    label: row.label,
    ...(row.unit !== undefined ? { unit: row.unit } : {}),
    ...(row.enumValues !== undefined ? { enumValues: row.enumValues } : {}),
  }
}

function projectTarget(
  view: CustomizeCapView,
  target: CapabilityCustomizeTarget,
  runtime: Schema,
): CustomizeCatalogTarget {
  switch (target.cardinality) {
    case 'scalar':
      return projectScalar(view, target, runtime)
    case 'keyedArray':
      return projectKeyed(view, target, runtime)
    case 'event':
      return projectEvent(view, target, runtime)
  }
}

function projectScalar(
  view: CustomizeCapView,
  target: ScalarCustomizeTarget,
  runtime: Schema,
): CustomizeCatalogTarget {
  const hit = requireLeaf(view, target.id, runtime, target.path)
  return {
    ...identity(view, target),
    cardinality: 'scalar',
    path: target.path,
    valueKind: hit.kind,
    nullable: hit.nullable,
    ...listedEnums(hit),
    sources: target.sources.map(projectDeclaredSource),
    ...listedCompanions(target.companions),
  }
}

function projectKeyed(
  view: CustomizeCapView,
  target: KeyedArrayCustomizeTarget,
  runtime: Schema,
): CustomizeCatalogTarget {
  return {
    ...identity(view, target),
    cardinality: 'keyedArray',
    path: target.path,
    keyField: target.keyField,
    labelField: target.labelField,
    nativeItems: target.nativeItems,
    fields: target.fields.map((field) => projectField(view, target, runtime, field)),
    ...(target.traits !== undefined && target.traits.length > 0
      ? { traits: target.traits.map(projectTrait) }
      : {}),
    sources: [],
    ...listedCompanions(target.companions),
  }
}

function projectEvent(
  view: CustomizeCapView,
  target: EventCustomizeTarget,
  runtime: Schema,
): CustomizeCatalogTarget {
  const shared = {
    ...identity(view, target),
    cardinality: 'event' as const,
    shape: target.shape,
    applyAuthority: target.applyAuthority,
    eventName: target.eventName,
    combine: target.combine,
    sources: target.sources.map(projectEventSource),
  }
  if (target.shape === 'pulse') {
    requireLeaf(view, target.id, runtime, target.timestampPath)
    requireLeaf(view, target.id, runtime, target.counterPath)
    return {
      ...shared,
      edges: target.edges,
      timestampPath: target.timestampPath,
      counterPath: target.counterPath,
      highWater: target.highWater,
      debounceMs: target.debounce.defaultDebounceMs,
    }
  }
  return {
    ...shared,
    start: target.start,
    end: target.end,
    timeoutMs: target.timeoutMs,
    ...(target.cooldownMs !== undefined ? { cooldownMs: target.cooldownMs } : {}),
    ...(target.sourceModes !== undefined ? { sourceModes: target.sourceModes } : {}),
  }
}

function projectField(
  view: CustomizeCapView,
  target: KeyedArrayCustomizeTarget,
  runtime: Schema,
  field: KeyedArrayFieldTarget,
): CustomizeCatalogField {
  const element = itemSchema(view, target, runtime)
  const hit = requireLeaf(view, target.id, element, field.path)
  return {
    path: field.path,
    valueKind: hit.kind,
    nullable: hit.nullable,
    ...listedEnums(hit),
    sources: field.sources.map(projectDeclaredSource),
    ...listedLiterals(field.literals),
  }
}

function projectTrait(trait: KeyedArrayTraitSpec): CustomizeCatalogTrait {
  return { path: trait.path, values: trait.values, defaultValue: trait.defaultValue }
}

interface ListedLiterals {
  readonly literals?: readonly CustomizeCatalogLiteral[]
}

function listedLiterals(literals: readonly KeyedArrayLiteralSpec[] | undefined): ListedLiterals {
  if (literals === undefined || literals.length === 0) return {}
  return { literals: literals.map((literal) => ({ path: literal.path, values: literal.values })) }
}

function identity(
  view: CustomizeCapView,
  target: CapabilityCustomizeTarget,
): CustomizeCatalogTarget {
  return {
    id: target.id,
    cardinality: target.cardinality,
    deviceTypes: effectiveDeviceTypes(view, target),
    apply: target.apply,
    vocabularyCap: target.vocabulary.cap,
    ...(target.vocabulary.stateField !== undefined
      ? { vocabularyStateField: target.vocabulary.stateField }
      : {}),
    ...(target.vocabulary.eventName !== undefined
      ? { vocabularyEvent: target.vocabulary.eventName }
      : {}),
    sources: [],
    sourceReport: target.sourceReport,
    advancedExpression: target.advancedExpression === true,
  }
}

function projectDeclaredSource(source: CustomizeSourceSpec): CustomizeCatalogSource {
  return {
    kind: source.kind,
    ...(source.kind === 'field' ? { valueKinds: source.valueKinds } : {}),
    ...(source.kind === 'numeric' && source.requiredUnit !== undefined
      ? { requiredUnit: source.requiredUnit }
      : {}),
    transformKinds: source.transforms.map((transform) => transform.kind),
  }
}

function projectEventSource(source: EventSourceSpec): CustomizeCatalogSource {
  return { kind: source.kind, transformKinds: [] }
}

function requireLeaf(
  view: CustomizeCapView,
  targetId: string,
  root: Schema,
  dotted: string,
): ProjectedLeaf {
  const resolved = resolveCustomizePath(root, dotted)
  if (!resolved.ok || !isValueLeaf(resolved.hit.kind)) {
    throw new Error(
      `customize catalog: ${view.capName}.${targetId} path \`${dotted}\` is not a leaf`,
    )
  }
  return {
    kind: resolved.hit.kind,
    nullable: resolved.hit.nullable,
    enumValues: resolved.hit.enumValues,
  }
}

function itemSchema(
  view: CustomizeCapView,
  target: KeyedArrayCustomizeTarget,
  runtime: Schema,
): Schema {
  const array = resolveCustomizePath(runtime, target.path)
  if (!array.ok || array.hit.kind !== 'array') {
    throw new Error(
      `customize catalog: ${view.capName}.${target.id} ${target.path} is not an array`,
    )
  }
  const element = arrayElement(array.hit.schema)
  if (element === undefined) {
    throw new Error(`customize catalog: ${view.capName}.${target.id} item is missing`)
  }
  return element
}

function listedEnums(hit: ProjectedLeaf): ListedEnums {
  return hit.enumValues.length > 0 ? { enumValues: hit.enumValues } : {}
}

function listedCompanions(companions: ScalarCustomizeTarget['companions']): ListedCompanions {
  return companions !== undefined && companions.length > 0 ? { companions } : {}
}

function effectiveDeviceTypes(
  view: CustomizeCapView,
  target: CapabilityCustomizeTarget,
): readonly DeviceType[] {
  if (target.deviceTypes !== undefined) return target.deviceTypes
  if (view.deviceTypes !== undefined) return deviceTypesFromStrings(view.deviceTypes)
  return Object.values(DeviceType)
}

function deviceTypesFromStrings(values: readonly string[]): readonly DeviceType[] {
  return values.map((value) => {
    const match = Object.values(DeviceType).find((item) => item === value)
    if (match === undefined) throw new Error(`customize catalog: \`${value}\` is not a DeviceType`)
    return match
  })
}
