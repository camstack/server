/**
 * The kind half of planning a composition field (D659): which kinds a source
 * can produce, whether they fit a target field, and the field's role.
 * Shared by the top-level planner (`validate-composition.ts`) and the item
 * planner (`composition-items.ts`). Internal to the composition module — NOT
 * in the barrel: these are planner internals, not a published contract.
 */
import { compileExpressionSafe } from '../expression/compile.js'
import { EXPRESSION_INJECTED_NOW } from '../expression/expression-source.js'
import {
  type CompositionAggregateSource,
  type CompositionFieldRead,
  type CompositionFieldSource,
  fieldReads,
} from './composition.js'
import type {
  CompositionFeatureMode,
  CompositionFieldRole,
  CompositionProblem,
  CompositionProblemCode,
  CompositionUnavailableMode,
} from './composition-report.js'
import {
  type ExpressionKindSet,
  type ExpressionValueKind,
  expressionContainsBuiltinCall,
  inferExpressionKinds,
  kindOfValue,
} from './expression-kinds.js'
import { problem } from './plan-result.js'
import { describeStateField, type StateFieldDescription } from './state-fields.js'
import type { CapabilityLookup } from './validate-composition.js'

interface KindsFound {
  readonly ok: true
  readonly kinds: ExpressionKindSet
}
interface KindsRefused {
  readonly ok: false
  readonly code: CompositionProblemCode
  readonly message: string
}
type KindsResult = KindsFound | KindsRefused

function aggregateKinds(source: CompositionAggregateSource): KindsResult {
  if (source.publish !== 'value') return { ok: true, kinds: new Set(['number']) }
  if (source.reducer === 'any' || source.reducer === 'all') {
    return { ok: true, kinds: new Set(['boolean']) }
  }
  if (source.empty === 'null') return { ok: true, kinds: new Set(['number', 'null']) }
  return { ok: true, kinds: new Set(['number']) }
}

function readKinds(read: CompositionFieldRead, lookupCap: CapabilityLookup): KindsResult {
  const def = lookupCap(read.cap)
  const schema = def?.runtimeState ?? def?.status?.schema
  if (def === null || schema === undefined) {
    return {
      ok: false,
      code: 'source-field-unknown',
      message: `no capability \`${read.cap}\` with state to read`,
    }
  }
  const field = describeStateField(schema, read.fieldPath)
  if (field === null) {
    return {
      ok: false,
      code: 'source-field-unknown',
      message: `\`${read.cap}\` has no field \`${read.fieldPath}\``,
    }
  }
  const base: ExpressionValueKind = field.kind === 'enum' ? 'string' : field.kind
  return { ok: true, kinds: new Set<ExpressionValueKind>(field.nullable ? [base, 'null'] : [base]) }
}

export function sourceKinds(
  source: CompositionFieldSource,
  lookupCap: CapabilityLookup,
): KindsResult {
  if (source.kind === 'from') return readKinds(source, lookupCap)
  if (source.kind === 'code') {
    return { ok: false, code: 'reserved-variant', message: 'code fields arrive in slice 4' }
  }
  if (source.kind === 'aggregate') return aggregateKinds(source)
  const bindingKinds = new Map<string, ExpressionKindSet>()
  for (const [name, binding] of Object.entries(source.bindings)) {
    if (binding.kind === 'literal') {
      bindingKinds.set(name, new Set([kindOfValue(binding.value)]))
      continue
    }
    const kinds = readKinds(binding, lookupCap)
    if (!kinds.ok) return { ...kinds, message: `binding \`${name}\`: ${kinds.message}` }
    bindingKinds.set(name, kinds.kinds)
  }
  const inferred = inferExpressionKinds({ expr: source.expr, bindingKinds })
  return inferred.ok
    ? { ok: true, kinds: inferred.kinds }
    : { ok: false, code: 'expression-invalid', message: inferred.error }
}

export function compatibility(
  cap: string,
  target: StateFieldDescription,
  kinds: ExpressionKindSet,
  at: string,
): readonly CompositionProblem[] {
  const allowed: ExpressionValueKind = target.kind === 'enum' ? 'string' : target.kind
  const offending = [...kinds].filter((k) => k !== 'null' && k !== allowed)
  const problems: CompositionProblem[] = []
  if (offending.length > 0) {
    problems.push(
      problem(
        'kind-mismatch',
        at,
        `\`${cap}.${target.path}\` is a ${target.kind}; this source can produce ${offending.join(' or ')}`,
      ),
    )
  }
  if (kinds.has('null') && !target.nullable) {
    problems.push(
      problem(
        'may-be-null',
        at,
        `\`${cap}.${target.path}\` cannot be null and this source can produce null — wrap it in coalesce(…) or pick a non-null source`,
      ),
    )
  }
  return problems
}

/**
 * A string a source produces WITHOUT reading any device — a field-level
 * `expression` source whose compiled AST is a bare string literal (`"red"`,
 * never `a` or `a + "x"`). Anything else that can only produce `'string'` at
 * the kind level (a `from` read of an enum-typed source field, a computed
 * expression) is NOT checked against the target's `enumValues` here: the
 * kind inference already collapsed it to the coarse `'string'` kind, losing
 * whichever enum it actually came from, so membership can only be judged at
 * write time against the runtime-state schema. Known limitation — see the
 * fix report for Task 6 round 1.
 */
function literalStringValue(source: CompositionFieldSource): string | null {
  if (source.kind !== 'expression') return null
  const compiled = compileExpressionSafe(source.expr)
  if (!compiled.ok) return null
  const ast = compiled.parsed.ast
  return ast.kind === 'literal' && typeof ast.value === 'string' ? ast.value : null
}

/**
 * An enum target whose source is a save-time-KNOWN string literal outside its
 * `enumValues` is refused now rather than left to fail the write later. A
 * dynamic source (a `from` read, a non-literal expression) is left to
 * runtime — see {@link literalStringValue}.
 */
export function enumLiteralProblem(
  cap: string,
  target: StateFieldDescription,
  source: CompositionFieldSource,
  at: string,
): CompositionProblem | null {
  if (target.kind !== 'enum' || target.enumValues === undefined) return null
  const value = literalStringValue(source)
  if (value === null || target.enumValues.includes(value)) return null
  const allowed = target.enumValues.map((v) => `\`${v}\``).join(', ')
  return problem(
    'kind-mismatch',
    at,
    `\`${cap}.${target.path}\` accepts only ${allowed}; this source is the literal \`${value}\``,
  )
}

export function roleOf(source: CompositionFieldSource): CompositionFieldRole {
  if (source.kind !== 'expression') return 'derived'
  if (expressionContainsBuiltinCall(source.expr, 'count')) return 'accumulator'
  if (fieldReads(source).length > 0) return 'derived'
  const compiled = compileExpressionSafe(source.expr)
  return compiled.ok && compiled.parsed.identifiers.has(EXPRESSION_INJECTED_NOW)
    ? 'clock'
    : 'constant'
}

interface UnavailableChosen {
  readonly ok: true
  readonly unavailable: CompositionUnavailableMode
}
interface UnavailableRefused {
  readonly ok: false
  readonly problem: CompositionProblem
}
export type UnavailableResult = UnavailableChosen | UnavailableRefused

/**
 * How a planned field says "unavailable", per feature mode and AFTER `roleOf`
 * (D393, D663 rulings S1 + S1b). The composer cannot take a device it does not
 * own offline, and D393 forbids a stale number, so on an existing target a
 * field that READS a source never gets `offline`.
 */
export function unavailableFor(
  tf: StateFieldDescription,
  role: CompositionFieldRole,
  mode: CompositionFeatureMode,
  cap: string,
  at: string,
): UnavailableResult {
  // A replaced accumulator keeps release as its no-seed/no-value fallback, just
  // like any other source-derived field.
  if (mode === 'replace' && (role === 'derived' || role === 'accumulator')) {
    return { ok: true, unavailable: 'release' }
  }
  // A new device, or a field that reads nothing and can never lose its source:
  // the slice-1 mapping (S1). An accumulator is allowed on ADD because it holds
  // its target seed/current output when the source disappears.
  if (mode === 'new' || role !== 'derived') {
    return { ok: true, unavailable: tf.nullable ? 'null' : 'offline' }
  }
  // The only remaining case is an ADDED derived field.
  if (tf.nullable) return { ok: true, unavailable: 'null' }
  if (tf.enumValues?.includes('unknown') === true) return { ok: true, unavailable: 'unknown' }
  return {
    ok: false,
    problem: problem(
      'not-replaceable',
      at,
      `\`${cap}.${tf.path}\` reads a source but can say neither null nor 'unknown', and an ADDED capability has no native reading to fall back to`,
    ),
  }
}
