/**
 * Recover a scalar draft only when compiling it again reproduces the stored
 * feature. Anything else is another formula.
 */
import type { CustomizeCatalogTarget } from '../../capabilities/customize-catalog.js'
import type { CustomizeCompanion } from '../../capabilities/customize-spec.js'
import { CAP_CUSTOMIZE_CATALOG } from '../../generated/customize-catalog.js'
import type { CustomizeCatalog } from '../../capabilities/customize-catalog.js'
import type {
  CompositionFieldSource,
  CompositionFieldsFeature,
  CompositionSourceRef,
} from '../composition.js'
import type { CustomizeTransformDraft, ScalarOverrideDraft } from './override-draft.js'
import {
  compileScalarOverride,
  type ScalarCompileInput,
  type ScalarValueKind,
} from './scalar-compile.js'
import {
  constantExpr,
  dwellExpr,
  overrideExpr,
  parseDwell,
  parseLinear,
  singleFrom,
  unsignedToken,
} from './scalar-expr.js'
import { sameStored } from './normalize.js'
import { ownedSlice } from './scalar-merge.js'
import type { CustomizeStored } from './stored.js'

const catalog: CustomizeCatalog = CAP_CUSTOMIZE_CATALOG

export interface ScalarDecoded {
  readonly draft: ScalarOverrideDraft
  readonly apply: 'add' | 'replace'
  readonly sourceValueKind: ScalarValueKind
  readonly changedAtField: string | null
  readonly sourceUnit: string | null
}

export interface ScalarDecodeInput {
  readonly feature: CompositionFieldsFeature
  readonly device: CompositionSourceRef
  readonly cap: string
  readonly targetId: string
}

export function decodeScalarOverride(input: ScalarDecodeInput): ScalarDecoded | null {
  const target = catalogTarget(input.cap, input.targetId)
  if (target === null || target.cardinality !== 'scalar' || target.path === undefined) return null
  if (input.feature.cap !== input.cap || input.feature.kind !== 'fields') return null
  const value = input.feature.fields[target.path]
  if (target.override !== undefined) return decodeOverride(input, target.override, value)
  const outputKind = scalarOutputKind(target.valueKind)
  if (outputKind === null) return null
  const read = readValue(value, outputKind, input.cap, input.targetId)
  if (read === null) return null
  const apply = inferApply(target, input.feature.fields)
  if (apply === null) return null
  const changedAtField = inferChangedAt(target, input.feature.fields, read)
  const sourceUnit = unitFor(target, read.sourceValueKind, read.draft.source.cap)
  const decoded: ScalarDecoded = { ...read, apply, changedAtField, sourceUnit }
  return reproduces(decoded, input.device, input.feature) ? decoded : null
}

/** A replace target reads back only its own canonical text, with its one source bound to `x`. */
function decodeOverride(
  input: ScalarDecodeInput,
  rule: NonNullable<CustomizeCatalogTarget['override']>,
  field: CompositionFieldSource | undefined,
): ScalarDecoded | null {
  if (field?.kind !== 'expression') return null
  if (field.expr !== overrideExpr(rule.whenSourceTrue, rule.unlessNative)) return null
  const bound = field.bindings['x']
  if (bound?.kind !== 'from') return null
  const decoded: ScalarDecoded = {
    draft: {
      kind: 'scalar',
      cap: input.cap,
      targetId: input.targetId,
      source: {
        addonId: bound.source.addonId,
        stableId: bound.source.stableId,
        cap: bound.cap,
        fieldPath: bound.fieldPath,
      },
      transform: { kind: 'identity' },
    },
    apply: 'replace',
    sourceValueKind: 'boolean',
    changedAtField: null,
    sourceUnit: null,
  }
  return reproduces(decoded, input.device, input.feature) ? decoded : null
}

interface ReadValue {
  readonly draft: ScalarOverrideDraft
  readonly sourceValueKind: ScalarValueKind
}

function catalogTarget(cap: string, targetId: string): CustomizeCatalogTarget | null {
  const entry = catalog[cap]
  if (entry === undefined) return null
  return entry.targets.find((target) => target.id === targetId) ?? null
}

function scalarOutputKind(valueKind: CustomizeCatalogTarget['valueKind']): ScalarValueKind | null {
  if (valueKind === 'boolean' || valueKind === 'number' || valueKind === 'string') return valueKind
  return null
}

function readValue(
  field: CompositionFieldSource | undefined,
  outputKind: ScalarValueKind,
  cap: string,
  targetId: string,
): ReadValue | null {
  if (field === undefined) return null
  if (field.kind === 'from') return drafted(field, { kind: 'identity' }, outputKind, cap, targetId)
  if (field.kind !== 'expression') return null
  if (field.expr === 'number(x)' && outputKind === 'number') {
    return drafted(field, { kind: 'identity' }, 'string', cap, targetId)
  }
  if (field.expr === '!x' && outputKind === 'boolean') {
    return drafted(field, { kind: 'invert' }, 'boolean', cap, targetId)
  }
  const dwell = parseDwell(field.expr)
  if (dwell !== null) {
    return drafted(
      field,
      {
        kind: 'threshold',
        comparison: dwell.comparison,
        threshold: dwell.threshold,
        startDwellMs: dwell.startDwellMs,
        stopDwellMs: dwell.stopDwellMs,
        minSamples: dwell.minSamples,
      },
      'number',
      cap,
      targetId,
    )
  }
  const linear = parseLinear(field.expr)
  if (linear === null || outputKind !== 'number') return null
  const transform: CustomizeTransformDraft = {
    kind: 'linear',
    scale: linear.scale,
    offset: linear.offset,
    ...(linear.clampMin === undefined || linear.clampMax === undefined
      ? {}
      : { clampMin: linear.clampMin, clampMax: linear.clampMax }),
  }
  const sourceValueKind = linear.inner === 'number(x)' ? 'string' : 'number'
  return drafted(field, transform, sourceValueKind, cap, targetId)
}

function drafted(
  field: CompositionFieldSource,
  transform: CustomizeTransformDraft,
  sourceValueKind: ScalarValueKind,
  cap: string,
  targetId: string,
): ReadValue | null {
  const bound = singleFrom(field)
  if (bound === null) return null
  return {
    sourceValueKind,
    draft: {
      kind: 'scalar',
      cap,
      targetId,
      source: {
        addonId: bound.addonId,
        stableId: bound.stableId,
        cap: bound.cap,
        fieldPath: bound.fieldPath,
      },
      transform,
    },
  }
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

function inferChangedAt(
  target: CustomizeCatalogTarget,
  fields: CompositionFieldsFeature['fields'],
  read: ReadValue,
): string | null {
  if (read.sourceValueKind !== 'boolean') return null
  const transition = (target.companions ?? []).find(
    (companion): companion is Extract<CustomizeCompanion, { kind: 'transition-time' }> =>
      companion.kind === 'transition-time',
  )
  if (transition === undefined || transition.sourceChangedAt !== 'prefer') return null
  const since = fields[transition.path]
  if (since?.kind !== 'from') return null
  if (since.cap !== read.draft.source.cap) return null
  if (
    since.source.addonId !== read.draft.source.addonId ||
    since.source.stableId !== read.draft.source.stableId
  ) {
    return null
  }
  return since.fieldPath
}

function unitFor(
  target: CustomizeCatalogTarget,
  valueKind: ScalarValueKind,
  sourceCap: string,
): string | null {
  if (valueKind === 'boolean' && sourceCap === 'switch') return null
  if (valueKind === 'number') {
    const numeric = target.sources.find((source) => source.kind === 'numeric')
    return numeric?.requiredUnit ?? null
  }
  return null
}

function reproduces(
  decoded: ScalarDecoded,
  device: CompositionSourceRef,
  stored: CompositionFieldsFeature,
): boolean {
  const input: ScalarCompileInput = {
    draft: decoded.draft,
    device,
    apply: decoded.apply,
    sourceValueKind: decoded.sourceValueKind,
    changedAtField: decoded.changedAtField,
    sourceUnit: decoded.sourceUnit,
  }
  const compiled = compileScalarOverride(input)
  if (!compiled.ok) return false
  const target = catalogTarget(decoded.draft.cap, decoded.draft.targetId)
  return sameFeature(
    compiled.value,
    ownedSlice(stored, decoded.draft.cap, decoded.draft.targetId),
    target?.companions ?? [],
  )
}

/**
 * The compiled feature and the stored one say the same thing. Text is compared
 * after canonicalising what an EARLIER compiler spelled differently: a dwell
 * that wrote its default `, 1` sample count, and a constant companion whose
 * literal the catalog has since changed (`offSeconds` 0 → 10). The operator
 * never sees a companion, and the evaluator reads `dwell(…)` and `dwell(…, 1)`
 * alike — so neither may turn a source link into "another formula".
 */
function sameFeature(
  compiled: CompositionFieldsFeature,
  stored: CompositionFieldsFeature,
  companions: readonly CustomizeCompanion[],
): boolean {
  const left = wrap(withoutEnabled(canonicalFields(compiled)))
  const right = wrap(withoutEnabled(canonicalFields(adoptConstants(stored, compiled, companions))))
  return sameStored(left, right)
}

/** Every dwell expression re-spelled by the current builder; other text is left alone. */
function canonicalFields(feature: CompositionFieldsFeature): CompositionFieldsFeature {
  const fields = Object.fromEntries(
    Object.entries(feature.fields).map(([path, field]) => [path, canonicalField(field)]),
  )
  return { ...feature, fields }
}

function canonicalField(field: CompositionFieldSource): CompositionFieldSource {
  if (field.kind !== 'expression') return field
  const dwell = parseDwell(field.expr)
  if (dwell === null) return field
  const threshold = unsignedToken(dwell.threshold)
  const start = unsignedToken(dwell.startDwellMs)
  const stop = unsignedToken(dwell.stopDwellMs)
  if (threshold === null || start === null || stop === null) return field
  return {
    ...field,
    expr: dwellExpr(dwell.comparison, threshold, start, stop, dwell.minSamples),
  }
}

/**
 * A constant companion stored with a literal an earlier builder wrote
 * (`formerValues`) takes the compiled literal: the value is the catalog's
 * business, not the row's. Any other literal, and anything that reads a
 * device, stays as it is and fails the comparison: that row was written by hand.
 */
function adoptConstants(
  stored: CompositionFieldsFeature,
  compiled: CompositionFieldsFeature,
  companions: readonly CustomizeCompanion[],
): CompositionFieldsFeature {
  const fields = { ...stored.fields }
  for (const companion of companions) {
    if (companion.kind !== 'constant') continue
    const own = fields[companion.path]
    const built = compiled.fields[companion.path]
    if (own?.kind !== 'expression' || built === undefined) continue
    if (Object.keys(own.bindings).length > 0) continue
    const former = (companion.formerValues ?? []).map((value) => constantExpr(value))
    if (!former.includes(own.expr)) continue
    fields[companion.path] = built
  }
  return { ...stored, fields }
}

function withoutEnabled(feature: CompositionFieldsFeature): CompositionFieldsFeature {
  const { enabled: _enabled, ...rest } = feature
  return rest
}

function wrap(feature: CompositionFieldsFeature): CustomizeStored {
  return { family: 'composition', target: { addonId: 't', stableId: 't' }, feature }
}
