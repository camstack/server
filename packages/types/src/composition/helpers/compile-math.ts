/**
 * Math helpers projected onto a new sensor (D944 phase 3). A threshold is the
 * `schmitt` builtin, a difference and a ratio are small expressions, a sum is
 * the group reducer (so an unreporting input is left out, not read as 0), and
 * a free expression is the expression engine unchanged — it still includes a
 * stale input, and the template says so.
 */
import { DeviceRole, DeviceType } from '../../device/device-type.js'
import { validateExpressionSource } from '../../expression/expression-source.js'
import { isIdentifier, signedToken, unsignedToken } from '../customize/scalar-expr.js'
import type { CompositionAggregateSource, CompositionFieldSource } from '../composition.js'
import type { CompositionProblem } from '../composition-report.js'
import { problem } from '../plan-result.js'
import type {
  ArithmeticHelperSpec,
  ExpressionHelperSpec,
  HelperMember,
  ThresholdHelperSpec,
} from './spec.js'

export interface MathDraft {
  readonly draft: unknown
  readonly problems: readonly CompositionProblem[]
}

const NOW: CompositionFieldSource = { kind: 'expression', expr: 'now', bindings: {} }

type FromSource = Extract<CompositionFieldSource, { kind: 'from' }>

function from(member: HelperMember): FromSource {
  return {
    kind: 'from',
    source: member.source,
    cap: member.cap,
    fieldPath: member.fieldPath,
  }
}

function expression(
  expr: string,
  bindings: Readonly<Record<string, FromSource>>,
): CompositionFieldSource {
  return { kind: 'expression', expr, bindings }
}

function sameMember(a: HelperMember, b: HelperMember): boolean {
  return (
    a.source.addonId === b.source.addonId &&
    a.source.stableId === b.source.stableId &&
    a.cap === b.cap &&
    a.fieldPath === b.fieldPath
  )
}

function numericSensor(
  helper: unknown,
  value: CompositionFieldSource,
  extra: readonly unknown[] = [],
): unknown {
  return {
    target: { kind: 'new', type: DeviceType.Sensor, role: DeviceRole.NumericSensor },
    helper,
    features: [
      { kind: 'fields', cap: 'numeric-sensor', fields: { value, lastFetchedAt: NOW } },
      ...extra,
    ],
  }
}

function binarySensor(helper: unknown, on: CompositionFieldSource): unknown {
  return {
    target: { kind: 'new', type: DeviceType.Sensor, role: DeviceRole.BinarySensor },
    helper,
    features: [{ kind: 'fields', cap: 'binary', fields: { on, lastChangedAt: NOW } }],
  }
}

export function thresholdDraft(spec: ThresholdHelperSpec): MathDraft {
  const problems: CompositionProblem[] = []
  const high = signedToken(spec.high)
  const low = signedToken(spec.low)
  if (high === null) {
    problems.push(problem('kind-mismatch', 'helper.high', 'the high edge is a finite number'))
  }
  if (low === null) {
    problems.push(problem('kind-mismatch', 'helper.low', 'the low edge is a finite number'))
  }
  if (high !== null && low !== null && spec.low > spec.high) {
    problems.push(
      problem(
        'kind-mismatch',
        'helper.low',
        `the low edge (${spec.low}) is above the high edge (${spec.high}) — it turns on at the high edge and off at the low one`,
      ),
    )
  }
  const onFor = unsignedToken(spec.onForMs)
  const offFor = unsignedToken(spec.offForMs)
  if (onFor === null || offFor === null) {
    problems.push(
      problem(
        'kind-mismatch',
        'helper.onForMs',
        'the on and off delays are a non-negative number of milliseconds',
      ),
    )
  }
  const delays =
    onFor !== null && offFor !== null && (spec.onForMs > 0 || spec.offForMs > 0)
      ? `, ${onFor}, ${offFor}`
      : ''
  // Nothing has crossed the high edge yet, so a new threshold is off: binary.on has no unknown.
  const expr = `coalesce(schmitt(x, ${high ?? '0'}, ${low ?? '0'}${delays}), false)`
  return {
    problems,
    draft: binarySensor(spec, expression(expr, { x: from(spec.source) })),
  }
}

const NAMES = ['a', 'b'] as const

function arithmeticProblems(spec: ArithmeticHelperSpec): readonly CompositionProblem[] {
  const problems: CompositionProblem[] = []
  const exactlyTwo = spec.op !== 'sum'
  if (exactlyTwo && spec.inputs.length !== 2) {
    problems.push(
      problem(
        'member-constraint',
        'helper.inputs',
        `a ${spec.op} takes exactly two readings, the first ${spec.op === 'ratio' ? 'over' : 'minus'} the second`,
      ),
    )
  }
  if (!exactlyTwo && spec.inputs.length < 2) {
    problems.push(problem('member-constraint', 'helper.inputs', 'a sum takes two or more readings'))
  }
  spec.inputs.forEach((input, index) => {
    const earlier = spec.inputs.slice(0, index).some((other) => sameMember(other, input))
    if (earlier) {
      problems.push(
        problem('member-constraint', `helper.inputs[${index}]`, 'this reading is already an input'),
      )
    }
  })
  return problems
}

const GROUP_COUNTS = ['included', 'excluded', 'total'] as const

export function arithmeticDraft(spec: ArithmeticHelperSpec): MathDraft {
  const problems = arithmeticProblems(spec)
  if (spec.op === 'sum') {
    const reads = spec.inputs.map((input) => ({
      source: input.source,
      cap: input.cap,
      fieldPath: input.fieldPath,
    }))
    const aggregate = (
      publish: CompositionAggregateSource['publish'],
    ): CompositionAggregateSource => ({
      kind: 'aggregate',
      reducer: 'sum',
      reads,
      publish,
      empty: 'null',
    })
    const counts = Object.fromEntries(GROUP_COUNTS.map((name) => [name, aggregate(name)]))
    return {
      problems,
      draft: numericSensor(spec, aggregate('value'), [
        { kind: 'fields', cap: 'group-status', fields: counts },
      ]),
    }
  }
  const bindings = Object.fromEntries(
    spec.inputs.slice(0, 2).map((input, index) => [NAMES[index] ?? 'a', from(input)]),
  )
  const expr = spec.op === 'difference' ? 'a - b' : 'b == 0 ? null : a / b'
  return { problems, draft: numericSensor(spec, expression(expr, bindings)) }
}

function expressionProblems(spec: ExpressionHelperSpec): readonly CompositionProblem[] {
  const problems: CompositionProblem[] = []
  const seen = new Set<string>()
  spec.inputs.forEach((input, index) => {
    const at = `helper.inputs[${index}].name`
    if (!isIdentifier(input.name)) {
      problems.push(
        problem(
          'expression-invalid',
          at,
          `\`${input.name}\` is not a name — use letters, digits and _, starting with a letter`,
        ),
      )
    }
    if (seen.has(input.name)) {
      problems.push(problem('expression-invalid', at, `the name \`${input.name}\` is used twice`))
    }
    seen.add(input.name)
  })
  if (problems.length > 0) return problems
  const bindings = Object.fromEntries(spec.inputs.map((input) => [input.name, from(input.member)]))
  const message = validateExpressionSource({ expr: spec.expr, bindings })
  return message === null ? [] : [problem('expression-invalid', 'helper.expr', message)]
}

export function expressionDraft(spec: ExpressionHelperSpec): MathDraft {
  const problems = expressionProblems(spec)
  const bindings = Object.fromEntries(spec.inputs.map((input) => [input.name, from(input.member)]))
  const source = expression(spec.expr, bindings)
  return {
    problems,
    draft: spec.output === 'boolean' ? binarySensor(spec, source) : numericSensor(spec, source),
  }
}
