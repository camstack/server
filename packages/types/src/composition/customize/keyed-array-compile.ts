/**
 * Compile keyed-array item drafts into the one composition feature that owns
 * the array (D936). Names are the cardinality, not a capability.
 */
import type {
  CustomizeCatalogField,
  CustomizeCatalogSource,
  CustomizeCatalogTarget,
} from '../../capabilities/customize-catalog.js'
import type { CustomizeCompanion } from '../../capabilities/customize-spec.js'
import { CAP_CUSTOMIZE_CATALOG } from '../../generated/customize-catalog.js'
import type { CustomizeCatalog } from '../../capabilities/customize-catalog.js'
import {
  COMPOSITION_ITEM_KEY_RE,
  type CompositionFieldSource,
  type CompositionFieldsFeature,
  type CompositionFromSource,
  type CompositionItemEntry,
  type CompositionSourceRef,
} from '../composition.js'
import { expression, fromRead, literal } from './field-source.js'
import { enumMapExpr } from './keyed-array-expr.js'
import type { CustomizeTransformDraft, KeyedArrayOverrideDraft } from './override-draft.js'
import { constantExpr, linearExpr, signedToken } from './scalar-expr.js'
import type { CustomizeRoundTrip } from './stored.js'

const catalog: CustomizeCatalog = CAP_CUSTOMIZE_CATALOG

export type KeyedSourceValueKind = 'boolean' | 'number' | 'string' | 'enum'

export interface KeyedArrayLiteral {
  readonly path: string
  readonly value: string
}

export interface KeyedArrayItemCompile {
  readonly draft: KeyedArrayOverrideDraft
  readonly sourceValueKind: KeyedSourceValueKind
  readonly sourceUnit: string | null
  readonly literals: readonly KeyedArrayLiteral[]
}

export interface KeyedArrayCompileInput {
  readonly cap: string
  readonly targetId: string
  readonly device: CompositionSourceRef
  readonly apply: 'add' | 'replace'
  readonly items: readonly KeyedArrayItemCompile[]
}

export function compileKeyedArrayOverride(
  input: KeyedArrayCompileInput,
): CustomizeRoundTrip<CompositionFieldsFeature> {
  const target = catalogTarget(input.cap, input.targetId)
  if (target === null || target.cardinality !== 'keyedArray') return fail('target')
  if (input.items.length === 0) return fail('items')
  if (
    input.items.some(
      (item) => item.draft.cap !== input.cap || item.draft.targetId !== input.targetId,
    )
  ) {
    return fail('target')
  }
  const keys = input.items.map((item) => item.draft.key)
  if (new Set(keys).size !== keys.length) return fail('key')
  const built = input.items.reduce<
    CustomizeRoundTrip<Readonly<Record<string, CompositionItemEntry>>>
  >(
    (acc, item) => {
      if (!acc.ok) return acc
      const entry = compileItem(target, item)
      if (!entry.ok) return entry
      return { ok: true, value: { ...acc.value, [item.draft.key]: entry.value } }
    },
    { ok: true, value: {} },
  )
  if (!built.ok) return built
  const fields = compileCompanions(target, input.apply)
  if (!fields.ok) return fields
  return {
    ok: true,
    value: { kind: 'fields', cap: input.cap, fields: fields.value, items: { ...built.value } },
  }
}

/** Put one compiled item into an existing feature. Other items stay as stored. */
export function mergeKeyedArrayItem(
  current: CompositionFieldsFeature | null,
  compiled: CompositionFieldsFeature,
  key: string,
): CompositionFieldsFeature | null {
  const item = compiled.items?.[key]
  if (item === undefined) return null
  return {
    kind: 'fields',
    cap: compiled.cap,
    ...(current?.enabled === undefined ? {} : { enabled: current.enabled }),
    fields: current === null ? compiled.fields : current.fields,
    items: { ...current?.items, [key]: item },
  }
}

/** The feature without item `key`. Null when that item was the last one. */
export function withoutKeyedArrayItem(
  feature: CompositionFieldsFeature,
  key: string,
): CompositionFieldsFeature | null {
  const rest = Object.fromEntries(
    Object.entries(feature.items ?? {}).filter(([name]) => name !== key),
  )
  if (Object.keys(rest).length === 0) return null
  return { ...feature, items: rest }
}

function fail<T>(reason: string): CustomizeRoundTrip<T> {
  return { ok: false, reason }
}

function catalogTarget(cap: string, targetId: string): CustomizeCatalogTarget | null {
  const entry = catalog[cap]
  if (entry === undefined) return null
  return entry.targets.find((target) => target.id === targetId) ?? null
}

function compileItem(
  target: CustomizeCatalogTarget,
  item: KeyedArrayItemCompile,
): CustomizeRoundTrip<CompositionItemEntry> {
  if (!COMPOSITION_ITEM_KEY_RE.test(item.draft.key) || item.draft.label.trim() === '') {
    return fail('key')
  }
  const field = (target.fields ?? []).find((entry) => entry.path === item.draft.fieldPath)
  if (field === undefined) return fail('field')
  const source = sourceSpec(field, item)
  if (source === null) return fail('source-kind')
  if (source.requiredUnit !== undefined && item.sourceUnit !== source.requiredUnit)
    return fail('unit')
  const allowed = item.draft.transform.kind
  if (!source.transformKinds.includes(allowed)) return fail('transform')
  const value = compileValue(item, field)
  if (!value.ok) return value
  const fields = compileLiterals(target, field, item, value.value)
  if (!fields.ok) return fields
  return { ok: true, value: { label: item.draft.label.trim(), fields: fields.value } }
}

function sourceSpec(
  field: CustomizeCatalogField,
  item: KeyedArrayItemCompile,
): CustomizeCatalogSource | null {
  if (item.sourceValueKind === 'number') {
    return field.sources.find((source) => source.kind === 'numeric') ?? null
  }
  if (item.sourceValueKind === 'enum' || item.sourceValueKind === 'string') {
    return field.sources.find((source) => source.kind === 'enum') ?? null
  }
  return null
}

function compileValue(
  item: KeyedArrayItemCompile,
  field: CustomizeCatalogField,
): CustomizeRoundTrip<CompositionFieldSource> {
  const read = fromRead(refOf(item.draft), item.draft.source.cap, item.draft.source.fieldPath)
  const transform = item.draft.transform
  if (transform.kind === 'identity') return { ok: true, value: read }
  if (transform.kind === 'linear') return linearValue(transform, read)
  if (transform.kind === 'enum-map') return enumValue(transform, read, field)
  return fail('transform')
}

function linearValue(
  transform: Extract<CustomizeTransformDraft, { kind: 'linear' }>,
  read: CompositionFromSource,
): CustomizeRoundTrip<CompositionFieldSource> {
  const scale = signedToken(transform.scale)
  const offset = signedToken(transform.offset)
  if (scale === null || offset === null) return fail('scale')
  const clamps = clampTokens(transform.clampMin, transform.clampMax)
  if (!clamps.ok) return clamps
  return {
    ok: true,
    value: expression(linearExpr('x', scale, offset, clamps.value.min, clamps.value.max), {
      x: read,
    }),
  }
}

interface ClampTokens {
  readonly min: string | null
  readonly max: string | null
}

function clampTokens(
  clampMin: number | undefined,
  clampMax: number | undefined,
): CustomizeRoundTrip<ClampTokens> {
  if (clampMin === undefined && clampMax === undefined) {
    return { ok: true, value: { min: null, max: null } }
  }
  if (clampMin === undefined || clampMax === undefined) return fail('clamp')
  const min = signedToken(clampMin)
  const max = signedToken(clampMax)
  if (min === null || max === null || clampMin > clampMax) return fail('clamp')
  return { ok: true, value: { min, max } }
}

function enumValue(
  transform: Extract<CustomizeTransformDraft, { kind: 'enum-map' }>,
  read: CompositionFromSource,
  field: CustomizeCatalogField,
): CustomizeRoundTrip<CompositionFieldSource> {
  const allowed = new Set(field.enumValues ?? [])
  const entries = Object.entries(transform.mapping)
  if (entries.length === 0) return fail('enum')
  if (entries.some(([key, value]) => key.length === 0 || (value !== null && !allowed.has(value)))) {
    return fail('enum')
  }
  const expr = enumMapExpr(transform.mapping)
  if (expr === null) return fail('enum')
  return { ok: true, value: expression(expr, { x: read }) }
}

function compileLiterals(
  target: CustomizeCatalogTarget,
  field: CustomizeCatalogField,
  item: KeyedArrayItemCompile,
  value: CompositionFieldSource,
): CustomizeRoundTrip<Record<string, CompositionFieldSource>> {
  const required = new Set((field.literals ?? []).map((literalSpec) => literalSpec.path))
  const traits = new Map((target.traits ?? []).map((trait) => [trait.path, new Set(trait.values)]))
  const missing = [...required].filter(
    (path) => !item.literals.some((literalSpec) => literalSpec.path === path),
  )
  if (missing.length > 0) return fail('literal')
  const written = item.literals.reduce<CustomizeRoundTrip<Record<string, CompositionFieldSource>>>(
    (acc, entry) => {
      if (!acc.ok) return acc
      if (entry.path === field.path || acc.value[entry.path] !== undefined) return fail('literal')
      const allowed = allowedLiteral(field, traits, entry.path)
      if (allowed === null || !allowed.has(entry.value)) return fail('literal')
      const expr = constantExpr(entry.value)
      if (expr === null) return fail('literal')
      return { ok: true, value: { ...acc.value, [entry.path]: literal(expr) } }
    },
    { ok: true, value: { [field.path]: value } },
  )
  return written
}

function allowedLiteral(
  field: CustomizeCatalogField,
  traits: ReadonlyMap<string, ReadonlySet<string>>,
  path: string,
): ReadonlySet<string> | null {
  const trait = traits.get(path)
  if (trait !== undefined) return trait
  const required = (field.literals ?? []).find((entry) => entry.path === path)
  return required === undefined ? null : new Set(required.values)
}

function compileCompanions(
  target: CustomizeCatalogTarget,
  apply: 'add' | 'replace',
): CustomizeRoundTrip<Record<string, CompositionFieldSource>> {
  const included = (target.companions ?? []).filter((companion) =>
    companionIncluded(companion, apply),
  )
  return included.reduce<CustomizeRoundTrip<Record<string, CompositionFieldSource>>>(
    (acc, companion) => {
      if (!acc.ok) return acc
      if (companion.kind !== 'clock') return fail('companion')
      return { ok: true, value: { ...acc.value, [companion.path]: literal('now') } }
    },
    { ok: true, value: {} },
  )
}

function companionIncluded(companion: CustomizeCompanion, apply: 'add' | 'replace'): boolean {
  if (companion.kind === 'transition-time') return false
  return companion.when === 'always' || apply === 'add'
}

function refOf(draft: KeyedArrayOverrideDraft): CompositionSourceRef {
  return { addonId: draft.source.addonId, stableId: draft.source.stableId }
}
