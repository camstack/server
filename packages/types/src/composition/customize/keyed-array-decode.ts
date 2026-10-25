/**
 * Recover keyed-array item drafts only when compiling them again reproduces
 * the stored item. A row this compiler did not write stays unrecognised.
 */
import type {
  CustomizeCatalogField,
  CustomizeCatalogTarget,
} from '../../capabilities/customize-catalog.js'
import { CAP_CUSTOMIZE_CATALOG } from '../../generated/customize-catalog.js'
import type { CustomizeCatalog } from '../../capabilities/customize-catalog.js'
import type {
  CompositionFieldSource,
  CompositionFieldsFeature,
  CompositionItemEntry,
  CompositionSourceRef,
} from '../composition.js'
import { isLiteral } from './field-source.js'
import { enumMapDraft, parseEnumMap } from './keyed-array-expr.js'
import {
  compileKeyedArrayOverride,
  type KeyedArrayItemCompile,
  type KeyedArrayLiteral,
  type KeyedSourceValueKind,
} from './keyed-array-compile.js'
import type { CustomizeTransformDraft, KeyedArrayOverrideDraft } from './override-draft.js'
import { parseLinear, singleFrom } from './scalar-expr.js'
import { sameStored } from './normalize.js'
import type { CustomizeStored } from './stored.js'

const catalog: CustomizeCatalog = CAP_CUSTOMIZE_CATALOG

export interface KeyedArrayItemView {
  readonly key: string
  readonly label: string
  readonly recognized: boolean
  readonly compile: KeyedArrayItemCompile | null
}

export interface KeyedArrayRead {
  readonly canonical: boolean
  readonly apply: 'add' | 'replace'
  readonly items: readonly KeyedArrayItemView[]
}

export function readKeyedArrayItems(
  feature: CompositionFieldsFeature,
  cap: string,
  targetId: string,
): KeyedArrayRead | null {
  const target = catalogTarget(cap, targetId)
  if (target === null || target.cardinality !== 'keyedArray' || feature.cap !== cap) return null
  const apply = inferApply(target, feature.fields)
  const canonical = apply !== null && companionsMatch(target, feature.fields, apply)
  const items = Object.entries(feature.items ?? {}).map(([key, item]) =>
    viewOf(target, cap, targetId, key, item, canonical),
  )
  return { canonical, apply: apply ?? 'add', items }
}

export function decodeKeyedArrayOverride(input: {
  readonly feature: CompositionFieldsFeature
  readonly device: CompositionSourceRef
  readonly cap: string
  readonly targetId: string
}): KeyedArrayRead | null {
  const read = readKeyedArrayItems(input.feature, input.cap, input.targetId)
  if (read === null || !read.canonical) return null
  if (read.items.some((item) => item.compile === null)) return null
  const compiles = read.items.flatMap((item) => (item.compile === null ? [] : [item.compile]))
  const compiled = compileKeyedArrayOverride({
    cap: input.cap,
    targetId: input.targetId,
    device: input.device,
    apply: read.apply,
    items: compiles,
  })
  if (!compiled.ok) return null
  return sameFeature(compiled.value, input.feature) ? read : null
}

function viewOf(
  target: CustomizeCatalogTarget,
  cap: string,
  targetId: string,
  key: string,
  item: CompositionItemEntry,
  canonical: boolean,
): KeyedArrayItemView {
  const blank: KeyedArrayItemView = { key, label: item.label, recognized: false, compile: null }
  if (!canonical) return blank
  const compile = compileOf(target, cap, targetId, key, item)
  if (compile === null) return blank
  return { key, label: item.label, recognized: true, compile }
}

function compileOf(
  target: CustomizeCatalogTarget,
  cap: string,
  targetId: string,
  key: string,
  item: CompositionItemEntry,
): KeyedArrayItemCompile | null {
  const assigned = assignedField(target, item)
  if (assigned === null) return null
  const literals = literalFields(target, assigned.field, item, assigned.path)
  if (literals === null) return null
  const draft = draftOf(cap, targetId, key, item.label, assigned)
  if (draft === null) return null
  const compile: KeyedArrayItemCompile = {
    draft,
    sourceValueKind: assigned.sourceValueKind,
    sourceUnit: null,
    literals,
  }
  return reproduces(cap, targetId, key, compile, item) ? compile : null
}

interface AssignedField {
  readonly path: string
  readonly field: CustomizeCatalogField
  readonly source: CompositionFieldSource
  readonly sourceValueKind: KeyedSourceValueKind
  readonly transform: CustomizeTransformDraft
}

function assignedField(
  target: CustomizeCatalogTarget,
  item: CompositionItemEntry,
): AssignedField | null {
  const paths = Object.keys(item.fields).filter((path) => !isConstant(item.fields[path]))
  if (paths.length !== 1) return null
  const path = paths[0]
  if (path === undefined) return null
  const field = (target.fields ?? []).find((entry) => entry.path === path)
  const source = item.fields[path]
  if (field === undefined || source === undefined) return null
  const read = readTransform(source, field)
  if (read === null) return null
  return { path, field, source, ...read }
}

interface ReadTransform {
  readonly sourceValueKind: KeyedSourceValueKind
  readonly transform: CustomizeTransformDraft
}

function readTransform(
  source: CompositionFieldSource,
  field: CustomizeCatalogField,
): ReadTransform | null {
  if (source.kind === 'from') {
    return field.valueKind === 'enum'
      ? { sourceValueKind: 'enum', transform: { kind: 'identity' } }
      : { sourceValueKind: 'number', transform: { kind: 'identity' } }
  }
  if (source.kind !== 'expression') return null
  const mapped = parseEnumMap(source.expr)
  if (mapped !== null && field.valueKind === 'enum') {
    return { sourceValueKind: 'enum', transform: enumMapDraft(mapped) }
  }
  const linear = parseLinear(source.expr)
  if (linear === null || linear.inner !== 'x' || field.valueKind !== 'number') return null
  const transform: CustomizeTransformDraft = {
    kind: 'linear',
    scale: linear.scale,
    offset: linear.offset,
    ...(linear.clampMin === undefined || linear.clampMax === undefined
      ? {}
      : { clampMin: linear.clampMin, clampMax: linear.clampMax }),
  }
  return { sourceValueKind: 'number', transform }
}

function literalFields(
  target: CustomizeCatalogTarget,
  field: CustomizeCatalogField,
  item: CompositionItemEntry,
  assignedPath: string,
): readonly KeyedArrayLiteral[] | null {
  const required = new Set((field.literals ?? []).map((entry) => entry.path))
  const traits = new Set((target.traits ?? []).map((trait) => trait.path))
  const found = Object.keys(item.fields).filter((path) => path !== assignedPath)
  if (found.some((path) => !required.has(path) && !traits.has(path))) return null
  if ([...required].some((path) => !found.includes(path))) return null
  const literals = found.map((path) => literalValue(item.fields[path], path))
  if (literals.some((entry) => entry === null)) return null
  return literals.flatMap((entry) => (entry === null ? [] : [entry]))
}

function literalValue(
  source: CompositionFieldSource | undefined,
  path: string,
): KeyedArrayLiteral | null {
  if (source?.kind !== 'expression' || Object.keys(source.bindings).length !== 0) return null
  if (!(source.expr.startsWith('"') && source.expr.endsWith('"'))) return null
  try {
    const parsed: unknown = JSON.parse(source.expr)
    return typeof parsed === 'string' ? { path, value: parsed } : null
  } catch {
    return null
  }
}

function draftOf(
  cap: string,
  targetId: string,
  key: string,
  label: string,
  assigned: AssignedField,
): KeyedArrayOverrideDraft | null {
  const bound = singleFrom(assigned.source)
  if (bound === null) return null
  return {
    kind: 'keyedArray',
    cap,
    targetId,
    key,
    label,
    fieldPath: assigned.path,
    source: {
      addonId: bound.addonId,
      stableId: bound.stableId,
      cap: bound.cap,
      fieldPath: bound.fieldPath,
    },
    transform: assigned.transform,
  }
}

function reproduces(
  cap: string,
  targetId: string,
  key: string,
  compile: KeyedArrayItemCompile,
  item: CompositionItemEntry,
): boolean {
  const compiled = compileKeyedArrayOverride({
    cap,
    targetId,
    device: { addonId: 't', stableId: 't' },
    apply: 'add',
    items: [compile],
  })
  if (!compiled.ok) return false
  const written = compiled.value.items?.[key]
  if (written === undefined) return false
  return JSON.stringify(written) === JSON.stringify(item)
}

function isConstant(source: CompositionFieldSource | undefined): boolean {
  return source?.kind === 'expression' && Object.keys(source.bindings).length === 0
}

function inferApply(
  target: CustomizeCatalogTarget,
  fields: CompositionFieldsFeature['fields'],
): 'add' | 'replace' | null {
  const addPaths = (target.companions ?? []).flatMap((companion) =>
    companion.kind !== 'transition-time' && companion.when === 'add' ? [companion.path] : [],
  )
  if (addPaths.length === 0) return 'replace'
  const present = addPaths.filter((path) => fields[path] !== undefined)
  if (present.length === addPaths.length) return 'add'
  if (present.length === 0) return 'replace'
  return null
}

function companionsMatch(
  target: CustomizeCatalogTarget,
  fields: CompositionFieldsFeature['fields'],
  apply: 'add' | 'replace',
): boolean {
  const expected = (target.companions ?? []).flatMap((companion) => {
    if (companion.kind === 'transition-time') return []
    if (companion.when === 'always' || apply === 'add') return [companion.path]
    return []
  })
  const keys = Object.keys(fields).toSorted()
  if (keys.join(',') !== [...expected].toSorted().join(',')) return false
  return expected.every((path) => isLiteral(fields[path], 'now'))
}

function catalogTarget(cap: string, targetId: string): CustomizeCatalogTarget | null {
  const entry = catalog[cap]
  if (entry === undefined) return null
  return entry.targets.find((target) => target.id === targetId) ?? null
}

function sameFeature(
  compiled: CompositionFieldsFeature,
  stored: CompositionFieldsFeature,
): boolean {
  const left = wrap(stripEnabled(compiled))
  const right = wrap(stripEnabled(stored))
  return sameStored(left, right)
}

function stripEnabled(feature: CompositionFieldsFeature): CompositionFieldsFeature {
  const { enabled: _enabled, ...rest } = feature
  return rest
}

function wrap(feature: CompositionFieldsFeature): CustomizeStored {
  return { family: 'composition', target: { addonId: 't', stableId: 't' }, feature }
}
