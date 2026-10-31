/**
 * Compile one scalar OverrideDraft into the composition feature the current
 * battery and running builders already store (D936). No second stored shape.
 */
import type {
  CustomizeCatalogSource,
  CustomizeCatalogTarget,
} from '../../capabilities/customize-catalog.js'
import type {
  CustomizeCompanion,
  CustomizeOverrideRule,
} from '../../capabilities/customize-spec.js'
import { CAP_CUSTOMIZE_CATALOG } from '../../generated/customize-catalog.js'
import type { CustomizeCatalog } from '../../capabilities/customize-catalog.js'
import type {
  CompositionExpressionSource,
  CompositionFieldSource,
  CompositionFieldsFeature,
  CompositionFromSource,
  CompositionSourceRef,
} from '../composition.js'
import { expression, fromRead, literal } from './field-source.js'
import type { CustomizeTransformDraft, ScalarOverrideDraft } from './override-draft.js'
import {
  constantExpr,
  dwellExpr,
  isIdentifier,
  linearExpr,
  overrideExpr,
  signedToken,
  unsignedToken,
} from './scalar-expr.js'
import type { CustomizeRoundTrip } from './stored.js'

const catalog: CustomizeCatalog = CAP_CUSTOMIZE_CATALOG

export type ScalarValueKind = 'boolean' | 'number' | 'string'

export interface ScalarCompileInput {
  readonly draft: ScalarOverrideDraft
  readonly device: CompositionSourceRef
  readonly apply: 'add' | 'replace'
  readonly sourceValueKind: ScalarValueKind
  readonly changedAtField: string | null
  readonly sourceUnit: string | null
}

export function compileScalarOverride(
  input: ScalarCompileInput,
): CustomizeRoundTrip<CompositionFieldsFeature> {
  const target = catalogTarget(input.draft.cap, input.draft.targetId)
  if (target === null || target.cardinality !== 'scalar' || target.path === undefined) {
    return fail('target')
  }
  if (input.draft.transform.kind === 'enum-map') return fail('enum')
  const source = sourceSpec(target, input.sourceValueKind, input.draft.source.cap)
  if (source === null) return fail('source-kind')
  if (source.requiredUnit !== undefined && input.sourceUnit !== source.requiredUnit)
    return fail('unit')
  const allowed = input.draft.transform.kind === 'number' ? 'identity' : input.draft.transform.kind
  if (!source.transformKinds.includes(allowed)) return fail('transform')
  if (target.override !== undefined) return compileOverride(input, target.path, target.override)
  const value = compileValue(input)
  if (!value.ok) return value
  const fields = compileCompanions(input, target, value.value)
  if (!fields.ok) return fields
  return {
    ok: true,
    value: { kind: 'fields', cap: input.draft.cap, fields: fields.value },
  }
}

/**
 * A replace target (D984): ONE field, derived from the boolean source and the
 * device's own NATIVE value, which the composer reads from the shadow. No
 * companion — the native slice keeps its own clock.
 */
function compileOverride(
  input: ScalarCompileInput,
  path: string,
  rule: CustomizeOverrideRule,
): CustomizeRoundTrip<CompositionFieldsFeature> {
  if (input.sourceValueKind !== 'boolean' || input.draft.transform.kind !== 'identity') {
    return fail('source-kind')
  }
  const read = fromRead(refOf(input.draft), input.draft.source.cap, input.draft.source.fieldPath)
  const field = expression(overrideExpr(rule.whenSourceTrue, rule.unlessNative), {
    x: read,
    native: fromRead(input.device, input.draft.cap, path),
  })
  return {
    ok: true,
    value: { kind: 'fields', cap: input.draft.cap, fields: { [path]: field } },
  }
}

function fail<T>(reason: string): CustomizeRoundTrip<T> {
  return { ok: false, reason }
}

function catalogTarget(cap: string, targetId: string): CustomizeCatalogTarget | null {
  const entry = catalog[cap]
  if (entry === undefined) return null
  return entry.targets.find((target) => target.id === targetId) ?? null
}

function sourceSpec(
  target: CustomizeCatalogTarget,
  valueKind: ScalarValueKind,
  sourceCap: string,
): CustomizeCatalogSource | null {
  if (valueKind === 'boolean' && sourceCap === 'switch') {
    return target.sources.find((source) => source.kind === 'switch') ?? null
  }
  if (valueKind === 'boolean') {
    return (
      target.sources.find((source) => source.kind === 'binary') ?? fieldSource(target, 'boolean')
    )
  }
  if (valueKind === 'number') {
    return (
      target.sources.find((source) => source.kind === 'numeric') ?? fieldSource(target, 'number')
    )
  }
  return fieldSource(target, 'string')
}

function fieldSource(
  target: CustomizeCatalogTarget,
  valueKind: ScalarValueKind,
): CustomizeCatalogSource | null {
  return (
    target.sources.find(
      (source) => source.kind === 'field' && (source.valueKinds ?? []).includes(valueKind),
    ) ?? null
  )
}

function compileValue(input: ScalarCompileInput): CustomizeRoundTrip<CompositionFieldSource> {
  const read = fromRead(refOf(input.draft), input.draft.source.cap, input.draft.source.fieldPath)
  const transform = input.draft.transform
  if (transform.kind === 'identity' || transform.kind === 'number') {
    return { ok: true, value: identityValue(read, input.sourceValueKind) }
  }
  if (transform.kind === 'invert') {
    if (input.sourceValueKind !== 'boolean') return fail('source-kind')
    return { ok: true, value: expression('!x', { x: read }) }
  }
  if (transform.kind === 'threshold') return thresholdValue(transform, read)
  if (transform.kind === 'linear') return linearValue(transform, read, input.sourceValueKind)
  return fail('transform')
}

function identityValue(
  read: CompositionFromSource,
  valueKind: ScalarValueKind,
): CompositionFieldSource {
  if (valueKind === 'string') return expression('number(x)', { x: read })
  return read
}

function thresholdValue(
  transform: Extract<CustomizeTransformDraft, { kind: 'threshold' }>,
  read: CompositionFromSource,
): CustomizeRoundTrip<CompositionFieldSource> {
  const threshold = unsignedToken(transform.threshold)
  if (threshold === null) return fail('threshold')
  const start = unsignedToken(transform.startDwellMs)
  const stop = unsignedToken(transform.stopDwellMs)
  if (start === null || stop === null) return fail('dwell')
  return {
    ok: true,
    value: expression(dwellExpr(transform.comparison, threshold, start, stop), { x: read }),
  }
}

function linearValue(
  transform: Extract<CustomizeTransformDraft, { kind: 'linear' }>,
  read: CompositionFromSource,
  valueKind: ScalarValueKind,
): CustomizeRoundTrip<CompositionFieldSource> {
  const scale = signedToken(transform.scale)
  const offset = signedToken(transform.offset)
  if (scale === null || offset === null) return fail('scale')
  const clamps = clampTokens(transform.clampMin, transform.clampMax)
  if (!clamps.ok) return clamps
  const inner = valueKind === 'string' ? 'number(x)' : 'x'
  return {
    ok: true,
    value: expression(linearExpr(inner, scale, offset, clamps.value.min, clamps.value.max), {
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
  if (clampMin === undefined && clampMax === undefined)
    return { ok: true, value: { min: null, max: null } }
  if (clampMin === undefined || clampMax === undefined) return fail('clamp')
  const min = signedToken(clampMin)
  const max = signedToken(clampMax)
  if (min === null || max === null || clampMin > clampMax) return fail('clamp')
  return { ok: true, value: { min, max } }
}

function compileCompanions(
  input: ScalarCompileInput,
  target: CustomizeCatalogTarget,
  value: CompositionFieldSource,
): CustomizeRoundTrip<Record<string, CompositionFieldSource>> {
  if (target.path === undefined) return fail('target')
  const path = target.path
  const included = (target.companions ?? []).filter((companion) =>
    companionIncluded(companion, input.apply),
  )
  const fields = included.reduce<CustomizeRoundTrip<Record<string, CompositionFieldSource>>>(
    (acc, companion) => {
      if (!acc.ok) return acc
      const built = companionField(input, path, companion)
      if (!built.ok) return { ok: false, reason: built.reason }
      return { ok: true, value: { ...acc.value, [companion.path]: built.value } }
    },
    { ok: true, value: { [path]: value } },
  )
  return fields
}

function companionIncluded(companion: CustomizeCompanion, apply: 'add' | 'replace'): boolean {
  if (companion.kind === 'transition-time') return true
  return companion.when === 'always' || apply === 'add'
}

function companionField(
  input: ScalarCompileInput,
  path: string,
  companion: CustomizeCompanion,
): CustomizeRoundTrip<CompositionFieldSource> {
  if (companion.kind === 'constant') {
    const expr = constantExpr(companion.value)
    if (expr === null) return fail('scale')
    return { ok: true, value: literal(expr) }
  }
  if (companion.kind === 'clock') return { ok: true, value: literal('now') }
  return transitionField(input, path, companion.sourceChangedAt)
}

function transitionField(
  input: ScalarCompileInput,
  path: string,
  sourceChangedAt: 'prefer' | 'ignore',
): CustomizeRoundTrip<CompositionFieldSource> {
  if (
    sourceChangedAt === 'prefer' &&
    input.sourceValueKind === 'boolean' &&
    input.changedAtField !== null &&
    isIdentifier(input.changedAtField)
  ) {
    return {
      ok: true,
      value: fromRead(refOf(input.draft), input.draft.source.cap, input.changedAtField),
    }
  }
  if (!isIdentifier(path)) return fail('transform')
  const bindings: CompositionExpressionSource['bindings'] = {
    [path]: fromRead(input.device, input.draft.cap, path),
  }
  return { ok: true, value: expression(`latchedAt(${path})`, bindings) }
}

function refOf(draft: ScalarOverrideDraft): CompositionSourceRef {
  return { addonId: draft.source.addonId, stableId: draft.source.stableId }
}
