/**
 * Project a judged Customize declaration into the catalog wire shape (D936).
 * Throws when a path the guard should have rejected does not resolve.
 */
import { z } from 'zod'
import { DeviceType } from '../../packages/types/src/device/device-type.ts'
import type {
  CustomizeCatalogEntry,
  CustomizeCatalogField,
  CustomizeCatalogLiteral,
  CustomizeCatalogSource,
  CustomizeCatalogTarget,
  CustomizeCatalogTrait,
  CustomizeCatalogTransform,
  CustomizeCatalogValueKind,
} from '../../packages/types/src/capabilities/customize-catalog.ts'
import type {
  CapabilityCustomizeTarget,
  ConfigCustomizeTarget,
  CustomizeSourceSpec,
  CustomizeTransformSpec,
  EventCustomizeTarget,
  EventSourceSpec,
  KeyedArrayCustomizeTarget,
  KeyedArrayFieldTarget,
  KeyedArrayLiteralSpec,
  KeyedArrayTraitSpec,
  ScalarCustomizeTarget,
} from '../../packages/types/src/capabilities/customize-spec.ts'
import type { CustomizeCapView } from './customize-declaration.ts'
import { assertProjectedParameters } from './customize-parameters.ts'
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
  if (spec === undefined) {
    throw new Error(`customize catalog: ${view.capName} has nothing to project`)
  }
  const runtime = view.runtimeState ?? z.object({})
  const entry = {
    version: 1 as const,
    targets: spec.targets.map((target) => projectTarget(view, target, runtime)),
  }
  assertProjectedParameters(view.capName, spec, entry)
  return entry
}

function projectTarget(
  view: CustomizeCapView,
  target: CapabilityCustomizeTarget,
  runtime: Schema,
): CustomizeCatalogTarget {
  switch (target.cardinality) {
    case 'config':
      return projectConfig(view, target)
    case 'scalar':
      return projectScalar(view, target, runtime)
    case 'keyedArray':
      return projectKeyed(view, target, runtime)
    case 'event':
      return projectEvent(view, target, runtime)
  }
}

function projectConfig(
  view: CustomizeCapView,
  target: ConfigCustomizeTarget,
): CustomizeCatalogTarget {
  return {
    id: target.id,
    cardinality: 'config',
    deviceTypes: effectiveDeviceTypes(view, target),
    apply: target.apply,
    readMethod: target.readMethod,
    writeMethod: target.writeMethod,
    vocabularyCap: target.vocabulary.cap,
    sources: [],
    sourceReport: { status: 'assignment-status' },
    advancedExpression: false,
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
      defaultEdge: target.defaultEdge,
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
  target: Exclude<CapabilityCustomizeTarget, ConfigCustomizeTarget>,
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
    transforms: source.transforms.map(projectTransform),
  }
}

function projectTransform(transform: CustomizeTransformSpec): CustomizeCatalogTransform {
  switch (transform.kind) {
    case 'identity':
    case 'invert':
      return { kind: transform.kind }
    case 'threshold':
      return {
        kind: 'threshold',
        comparisons: transform.comparisons,
        comparison: transform.comparison,
        defaultThreshold: transform.defaultThreshold,
        defaultStartDwellMs: transform.defaultStartDwellMs,
        defaultStopDwellMs: transform.defaultStopDwellMs,
        ...(transform.thresholdUnit !== undefined
          ? { thresholdUnit: transform.thresholdUnit }
          : {}),
      }
    case 'linear':
      return {
        kind: 'linear',
        defaultScale: transform.defaultScale,
        defaultOffset: transform.defaultOffset,
        ...(transform.clampMin !== undefined ? { clampMin: transform.clampMin } : {}),
        ...(transform.clampMax !== undefined ? { clampMax: transform.clampMax } : {}),
      }
    case 'enum-map':
      return {
        kind: 'enum-map',
        outputValues: transform.outputValues,
        unmapped: transform.unmapped,
      }
  }
}

function projectEventSource(source: EventSourceSpec): CustomizeCatalogSource {
  return { kind: source.kind, transformKinds: [], transforms: [] }
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
