/**
 * Math helpers (D944 phase 3): threshold with hysteresis, sum / difference /
 * ratio of one quantity, a validated expression, and a derivative from history.
 * The old code knows none of these kinds, so each case fails for that reason.
 */
import { describe, expect, it } from 'vitest'
import { binaryCapability } from '../../../capabilities/binary.cap.js'
import { groupStatusCapability } from '../../../capabilities/group-status.cap.js'
import { numericSensorCapability } from '../../../capabilities/numeric-sensor.cap.js'
import { powerMeterCapability } from '../../../capabilities/power-meter.cap.js'
import { temperatureSensorCapability } from '../../../capabilities/temperature-sensor.cap.js'
import { DeviceType } from '../../../device/device-type.js'
import { evaluateExpressionSource } from '../../../expression/expression-source.js'
import type { ReadingQuantity } from '../../../units/quantity.js'
import {
  type Composition,
  type CompositionFieldSource,
  compositionSourceKey,
  type CompositionSourceRef,
} from '../../composition.js'
import {
  buildCapabilityLookup,
  type CompositionSourceDescription,
  type ValidateCompositionContext,
  validateComposition,
} from '../../validate-composition.js'
import { compileHelper } from '../compile.js'
import { evaluateDerivative, type SeriesPoint, type SeriesRead } from '../history-math.js'
import { DAY_MS, DEFAULT_HISTORY_RETENTION } from '../history-window.js'
import { helperSaveProblems, type HelperMemberFact } from '../save.js'
import { sourcePickForMath } from '../source-pick.js'
import {
  type ArithmeticHelperSpec,
  type DerivativeHelperSpec,
  type ExpressionHelperSpec,
  helperMembers,
  type HelperMember,
  type ThresholdHelperSpec,
} from '../spec.js'

const lookupCap = buildCapabilityLookup([
  temperatureSensorCapability,
  numericSensorCapability,
  powerMeterCapability,
  binaryCapability,
  groupStatusCapability,
])

function ref(n: number): CompositionSourceRef {
  return { addonId: 'addon-sensors', stableId: `sensor-${n}` }
}

function reading(n: number, cap = 'numeric-sensor', fieldPath = 'value'): HelperMember {
  return { source: ref(n), cap, fieldPath }
}

function context(composition: Composition, quantity: ReadingQuantity): ValidateCompositionContext {
  const sources = new Map<string, CompositionSourceDescription>()
  const members = composition.helper === undefined ? [] : helperMembers(composition.helper)
  for (const [index, item] of members.entries()) {
    sources.set(compositionSourceKey(item.source), {
      kind: 'found',
      deviceId: 4000 + index,
      caps: new Set([item.cap]),
      deviceType: DeviceType.Sensor,
      quantity,
    })
  }
  return { lookupCap, sources, self: null, blockId: null, target: null, peers: [] }
}

function facts(
  composition: Composition,
  quantities: readonly ReadingQuantity[],
): ReadonlyMap<string, HelperMemberFact> {
  const members = composition.helper === undefined ? [] : helperMembers(composition.helper)
  return new Map(
    members.flatMap((item, index) => {
      const quantity = quantities[index]
      return quantity === undefined
        ? []
        : [
            [
              compositionSourceKey(item.source),
              { deviceType: DeviceType.Sensor, quantity },
            ] as const,
          ]
    }),
  )
}

function fieldOf(composition: Composition, cap: string, field: string): CompositionFieldSource {
  for (const feature of composition.features) {
    if (feature.kind !== 'fields' || feature.cap !== cap) continue
    const source = feature.fields[field]
    if (source !== undefined) return source
  }
  throw new Error(`no ${cap}.${field}`)
}

function expressionOf(source: CompositionFieldSource): string {
  if (source.kind !== 'expression') throw new Error(`expected an expression, got ${source.kind}`)
  return source.expr
}

function threshold(over: Partial<ThresholdHelperSpec> = {}): ThresholdHelperSpec {
  return {
    kind: 'threshold',
    source: reading(1, 'temperature-sensor', 'celsius'),
    high: 25,
    low: 20,
    onForMs: 0,
    offForMs: 0,
    ...over,
  }
}

function arithmetic(
  op: ArithmeticHelperSpec['op'],
  inputs: readonly HelperMember[],
): ArithmeticHelperSpec {
  return { kind: 'arithmetic', op, inputs: [...inputs] }
}

describe('threshold with hysteresis', () => {
  it('compiles to a binary sensor driven by schmitt and validates', () => {
    const compiled = compileHelper(threshold({ onForMs: 5000, offForMs: 60_000 }))
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(expressionOf(fieldOf(compiled.composition, 'binary', 'on'))).toBe(
      'coalesce(schmitt(x, 25, 20, 5000, 60000), false)',
    )
    expect(compiled.composition.target).toMatchObject({ kind: 'new', type: DeviceType.Sensor })
    expect(
      validateComposition(compiled.composition, context(compiled.composition, 'temperature'))
        .problems,
    ).toEqual([])
  })

  it('leaves the delays out when there are none', () => {
    const compiled = compileHelper(threshold())
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(expressionOf(fieldOf(compiled.composition, 'binary', 'on'))).toBe(
      'coalesce(schmitt(x, 25, 20), false)',
    )
  })

  it('refuses a low edge above the high edge, by name', () => {
    const compiled = compileHelper(threshold({ high: 20, low: 25 }))
    expect(compiled.ok).toBe(false)
    if (compiled.ok) return
    expect(compiled.problems.map((item) => item.path)).toContain('helper.low')
  })

  it('refuses a negative delay', () => {
    const compiled = compileHelper(threshold({ onForMs: -1 }))
    expect(compiled.ok).toBe(false)
  })
})

describe('sum, difference and ratio', () => {
  const inputs = [reading(1), reading(2)]

  it('compiles a sum to the aggregate reducer, never to sum()', () => {
    const compiled = compileHelper(arithmetic('sum', [...inputs, reading(3)]))
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const value = fieldOf(compiled.composition, 'numeric-sensor', 'value')
    expect(value).toMatchObject({ kind: 'aggregate', reducer: 'sum', publish: 'value' })
    expect(
      validateComposition(compiled.composition, context(compiled.composition, 'power')).problems,
    ).toEqual([])
  })

  it('compiles a difference to a minus the engine evaluates', () => {
    const compiled = compileHelper(arithmetic('difference', inputs))
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const expr = expressionOf(fieldOf(compiled.composition, 'numeric-sensor', 'value'))
    expect(evaluateExpressionSource(expr, { a: 10, b: 4 }, 0)).toEqual({ ok: true, value: 6 })
    expect(
      validateComposition(compiled.composition, context(compiled.composition, 'power')).problems,
    ).toEqual([])
  })

  it('a ratio with a zero divisor is null, not Infinity and not an error', () => {
    const compiled = compileHelper(arithmetic('ratio', inputs))
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const expr = expressionOf(fieldOf(compiled.composition, 'numeric-sensor', 'value'))
    expect(evaluateExpressionSource(expr, { a: 6, b: 4 }, 0)).toEqual({ ok: true, value: 1.5 })
    expect(evaluateExpressionSource(expr, { a: 6, b: 0 }, 0)).toEqual({ ok: true, value: null })
    expect(
      validateComposition(compiled.composition, context(compiled.composition, 'power')).problems,
    ).toEqual([])
  })

  it('wants two readings for a difference or a ratio, and two or more for a sum', () => {
    expect(compileHelper(arithmetic('difference', [reading(1)])).ok).toBe(false)
    expect(compileHelper(arithmetic('ratio', [reading(1), reading(2), reading(3)])).ok).toBe(false)
    expect(compileHelper(arithmetic('sum', [reading(1)])).ok).toBe(false)
  })

  it('refuses the same reading twice', () => {
    expect(compileHelper(arithmetic('difference', [reading(1), reading(1)])).ok).toBe(false)
  })

  it('refuses mixed quantities at save, naming both', () => {
    for (const op of ['sum', 'difference', 'ratio'] as const) {
      const compiled = compileHelper(arithmetic(op, inputs))
      expect(compiled.ok).toBe(true)
      if (!compiled.ok) continue
      const refused = helperSaveProblems(
        compiled.composition,
        facts(compiled.composition, ['power', 'energy']),
      )
      expect(
        refused.map((item) => item.code),
        op,
      ).toEqual(['mixed-quantity'])
      expect(refused[0]?.message, op).toContain('power')
      expect(refused[0]?.message, op).toContain('energy')
      expect(
        helperSaveProblems(compiled.composition, facts(compiled.composition, ['power', 'power'])),
        op,
      ).toEqual([])
    }
  })
})

describe('expression helper', () => {
  function expression(over: Partial<ExpressionHelperSpec> = {}): ExpressionHelperSpec {
    return {
      kind: 'expression',
      expr: 'inlet - outlet',
      inputs: [
        { name: 'inlet', member: reading(1, 'temperature-sensor', 'celsius') },
        { name: 'outlet', member: reading(2, 'temperature-sensor', 'celsius') },
      ],
      output: 'number',
      ...over,
    }
  }

  it('binds the members by name and publishes a number', () => {
    const compiled = compileHelper(expression())
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const source = fieldOf(compiled.composition, 'numeric-sensor', 'value')
    expect(source.kind).toBe('expression')
    expect(expressionOf(source)).toBe('inlet - outlet')
    expect(
      validateComposition(compiled.composition, context(compiled.composition, 'temperature'))
        .problems,
    ).toEqual([])
  })

  it('publishes a yes/no when the output is a boolean', () => {
    const compiled = compileHelper(expression({ expr: 'inlet > outlet', output: 'boolean' }))
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(fieldOf(compiled.composition, 'binary', 'on').kind).toBe('expression')
  })

  it('refuses an expression that does not parse, with the engine message', () => {
    const compiled = compileHelper(expression({ expr: 'inlet - ' }))
    expect(compiled.ok).toBe(false)
    if (compiled.ok) return
    expect(compiled.problems[0]?.code).toBe('expression-invalid')
    expect(compiled.problems[0]?.path).toBe('helper.expr')
  })

  it('refuses a name the expression uses but no input provides', () => {
    expect(compileHelper(expression({ expr: 'inlet - missing' })).ok).toBe(false)
  })

  it('refuses a name that is not an identifier or is used twice', () => {
    expect(
      compileHelper(
        expression({
          inputs: [
            { name: 'in let', member: reading(1) },
            { name: 'outlet', member: reading(2) },
          ],
        }),
      ).ok,
    ).toBe(false)
    expect(
      compileHelper(
        expression({
          expr: 'a - a',
          inputs: [
            { name: 'a', member: reading(1) },
            { name: 'a', member: reading(2) },
          ],
        }),
      ).ok,
    ).toBe(false)
  })

  it('a number expression that yields a yes/no is refused at validate, not stored', () => {
    const compiled = compileHelper(expression({ expr: 'inlet > outlet' }))
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(
      validateComposition(compiled.composition, context(compiled.composition, 'temperature'))
        .problems.length,
    ).toBeGreaterThan(0)
  })
})

describe('derivative', () => {
  const MINUTE = 60_000
  const HOUR = 60 * MINUTE

  function derivative(over: Partial<DerivativeHelperSpec> = {}): DerivativeHelperSpec {
    return {
      kind: 'derivative',
      window: { kind: 'rolling', span: '1h' },
      per: 'hour',
      source: reading(1, 'temperature-sensor', 'celsius'),
      ...over,
    }
  }

  function point(t: number, value: number): SeriesPoint {
    return { t, value, twMean: null, twMs: null, min: value, max: value, last: value, delta: null }
  }

  function read(over: Partial<SeriesRead> & Pick<SeriesRead, 'points'>): SeriesRead {
    return {
      kind: 'gauge',
      tier: 'raw',
      from: 0,
      to: HOUR,
      before: null,
      truncated: false,
      ...over,
    }
  }

  it('compiles to a history field on a numeric sensor and validates', () => {
    const compiled = compileHelper(derivative())
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(fieldOf(compiled.composition, 'numeric-sensor', 'value').kind).toBe('series')
    expect(
      validateComposition(compiled.composition, context(compiled.composition, 'temperature'))
        .problems,
    ).toEqual([])
  })

  it('refuses a window longer than any tier retains', () => {
    const compiled = compileHelper(
      derivative({ window: { kind: 'rolling', span: 'custom', customMinutes: 400 * 24 * 60 } }),
      { ...DEFAULT_HISTORY_RETENTION, dayMs: 400 * DAY_MS },
    )
    expect(compiled.ok).toBe(false)
    if (compiled.ok) return
    expect(compiled.problems.map((item) => item.code)).toContain('retention')
  })

  it('refuses a state or a source with no history declaration', () => {
    expect(compileHelper(derivative({ source: reading(1, 'switch', 'on') })).ok).toBe(false)
  })

  it('is the change over the elapsed time, in the requested unit', () => {
    const answer = evaluateDerivative(
      read({ points: [point(0, 10), point(60 * MINUTE - 1, 16)] }),
      HOUR,
    )
    expect(answer.write).toBe('number')
    expect(answer.value).toBeCloseTo(6, 3)
    const perMinute = evaluateDerivative(
      read({ points: [point(0, 10), point(30 * MINUTE, 40)] }),
      MINUTE,
    )
    expect(perMinute.value).toBeCloseTo(1, 5)
  })

  it('starts from the value held before the window', () => {
    const answer = evaluateDerivative(
      read({ before: { t: -MINUTE, value: 10 }, points: [point(30 * MINUTE, 40)] }),
      HOUR,
    )
    expect(answer.value).toBeCloseTo(60, 5)
  })

  it('across a gap the rate is the slope of what was measured, never diluted by zero fill', () => {
    // Samples at the start and the end of the hour, nothing in between.
    const answer = evaluateDerivative(read({ points: [point(0, 10), point(HOUR, 70)] }), HOUR)
    expect(answer.value).toBeCloseTo(60, 5)
    // A silent tail: the last sample is 20 minutes in, so the elapsed time is 20 minutes.
    const tail = evaluateDerivative(read({ points: [point(0, 10), point(20 * MINUTE, 20)] }), HOUR)
    expect(tail.value).toBeCloseTo(30, 5)
    expect(tail.excluded).toBeGreaterThan(0)
    expect(tail.reason).not.toBeNull()
  })

  it('is null, a known gap, with fewer than two finite points', () => {
    expect(evaluateDerivative(read({ points: [point(10, 5)] }), HOUR)).toMatchObject({
      write: 'null',
      value: null,
    })
    expect(evaluateDerivative(read({ points: [] }), HOUR)).toMatchObject({
      write: 'null',
      value: null,
    })
  })

  it('keeps the last answer when the read was truncated', () => {
    expect(
      evaluateDerivative(read({ truncated: true, points: [point(0, 1), point(1, 2)] }), HOUR).write,
    ).toBe('hold')
  })

  it('is the growth over the elapsed time for a counter', () => {
    const answer = evaluateDerivative(
      read({
        kind: 'counter',
        points: [
          { ...point(0, 100), delta: 0 },
          { ...point(30 * MINUTE, 103), delta: 3 },
          { ...point(60 * MINUTE - 1, 106), delta: 3 },
        ],
      }),
      HOUR,
    )
    expect(answer.value).toBeCloseTo(6, 2)
  })
})

describe('source request', () => {
  it('asks for a historised field for a derivative and a reading for the others', () => {
    expect(sourcePickForMath('derivative').history.required).toBe(true)
    expect(sourcePickForMath('threshold').multiple).toBe(false)
    expect(sourcePickForMath('sum').multiple).toBe(true)
    expect(sourcePickForMath('difference').max).toBe(2)
  })
})
