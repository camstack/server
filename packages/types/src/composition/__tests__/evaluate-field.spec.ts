import { describe, expect, it } from 'vitest'
import { createStatefulExpressionMemory } from '../../expression/expression-source.js'
import { compositionReadKey } from '../composition.js'
import {
  type SourceReader,
  type SourceReading,
  evaluateCompositionField,
} from '../evaluate-field.js'
import {
  ROOM_EXAMPLE_MOTION_SOURCES,
  ROOM_EXAMPLE_TEMPERATURE_SOURCES,
  ROOM_OCCUPANCY_WINDOW_MS,
  roomCompositionExample,
} from '../examples.js'

const NOW = 1_000_000
const ROOM = roomCompositionExample({
  temperatureSources: ROOM_EXAMPLE_TEMPERATURE_SOURCES,
  motionSources: ROOM_EXAMPLE_MOTION_SOURCES,
  occupancyWindowMs: ROOM_OCCUPANCY_WINDOW_MS,
})

function fieldOf(cap: string, path: string) {
  const feature = ROOM.features.find((f) => f.cap === cap)
  if (feature === undefined || feature.kind !== 'fields') throw new Error(`no ${cap}`)
  const source = feature.fields[path]
  if (source === undefined) throw new Error(`no ${cap}.${path}`)
  return source
}

function reader(entries: ReadonlyArray<readonly [string, SourceReading]>): SourceReader {
  const byKey = new Map(entries)
  return (read) =>
    byKey.get(compositionReadKey(read)) ?? {
      state: 'unavailable',
      reason: 'not in fixture',
      fatal: false,
    }
}

const [T1, T2, T3] = ROOM_EXAMPLE_TEMPERATURE_SOURCES
const [M1, M2] = ROOM_EXAMPLE_MOTION_SOURCES
const key = (source: typeof T1, cap: string, fieldPath: string) =>
  compositionReadKey({ source: source!, cap, fieldPath })

const fresh = (value: number | boolean | null): SourceReading => ({ state: 'fresh', value })

describe('temperature = average of three sensors', () => {
  const temps = [
    [key(T1, 'temperature-sensor', 'celsius'), fresh(21.0)],
    [key(T2, 'temperature-sensor', 'celsius'), fresh(21.5)],
    [key(T3, 'temperature-sensor', 'celsius'), fresh(21.4)],
  ] as const

  it('is fresh when every source is', () => {
    const outcome = evaluateCompositionField({
      source: fieldOf('temperature-sensor', 'celsius'),
      read: reader(temps),
      now: NOW,
    })
    expect(outcome).toEqual({ state: 'fresh', value: 21.3, reason: null, deadline: null })
  })

  it('is STALE (value kept) when one source is stale, naming it (D49)', () => {
    const stale: SourceReading = {
      state: 'stale',
      value: 21.5,
      reason: 'the source device is offline',
    }
    const outcome = evaluateCompositionField({
      source: fieldOf('temperature-sensor', 'celsius'),
      read: reader([temps[0], [temps[1][0], stale], temps[2]]),
      now: NOW,
    })
    expect(outcome.state).toBe('stale')
    expect(outcome.state === 'stale' ? outcome.value : null).toBe(21.3)
    expect(outcome.state === 'stale' ? outcome.reason : '').toContain('`t2`')
  })

  it('is UNAVAILABLE, fatal, when a source is gone, and never a plausible number (D393)', () => {
    const gone: SourceReading = {
      state: 'unavailable',
      reason: 'device not found — two reads agreed',
      fatal: true,
    }
    const outcome = evaluateCompositionField({
      source: fieldOf('temperature-sensor', 'celsius'),
      read: reader([temps[0], [temps[1][0], gone], temps[2]]),
      now: NOW,
    })
    expect(outcome).toEqual({
      state: 'unavailable',
      value: null,
      fatal: true,
      confirmed: true,
      reason: expect.stringContaining('sensor.sofa_temperature'),
    })
  })

  it('is unavailable, NOT fatal, when the expression fails on a value', () => {
    const outcome = evaluateCompositionField({
      source: fieldOf('temperature-sensor', 'celsius'),
      read: reader([temps[0], [temps[1][0], fresh(null)], temps[2]]),
      now: NOW,
    })
    expect(outcome).toEqual({
      state: 'unavailable',
      value: null,
      fatal: false,
      confirmed: true,
      // Every source answered: the failure is the expression's, not an outage (D716).
      expressionFailed: true,
      reason: expect.stringContaining('avg'),
    })
  })
})

describe('occupancy = any motion within five minutes', () => {
  it('carries the deadline at which the window closes', () => {
    const outcome = evaluateCompositionField({
      source: fieldOf('binary', 'on'),
      read: reader([
        [key(M1, 'motion', 'detected'), fresh(false)],
        [key(M2, 'motion', 'detected'), fresh(false)],
        [key(M1, 'motion', 'lastDetectedAt'), fresh(NOW - 60_000)],
        [key(M2, 'motion', 'lastDetectedAt'), fresh(null)],
      ]),
      now: NOW,
    })
    expect(outcome).toEqual({
      state: 'fresh',
      value: true,
      reason: null,
      deadline: NOW - 60_000 + 300_001,
    })
  })

  it('a clock field reads only now', () => {
    const outcome = evaluateCompositionField({
      source: fieldOf('binary', 'lastChangedAt'),
      read: reader([]),
      now: NOW,
    })
    expect(outcome).toEqual({ state: 'fresh', value: NOW, reason: null, deadline: null })
  })
})

describe('from and code', () => {
  it('from copies the reading', () => {
    const outcome = evaluateCompositionField({
      source: { kind: 'from', source: T1!, cap: 'temperature-sensor', fieldPath: 'celsius' },
      read: reader([[key(T1, 'temperature-sensor', 'celsius'), fresh(20)]]),
      now: NOW,
    })
    expect(outcome).toEqual({ state: 'fresh', value: 20, reason: null, deadline: null })
  })

  it('code is not runnable here and says so', () => {
    const outcome = evaluateCompositionField({
      source: { kind: 'code', code: 'return 1' },
      read: reader([]),
      now: NOW,
    })
    expect(outcome).toEqual({
      state: 'unavailable',
      value: null,
      fatal: true,
      confirmed: true,
      reason: expect.stringContaining('slice 4'),
    })
  })

  it('from + stale keeps the last value and names the source (D49)', () => {
    const stale: SourceReading = {
      state: 'stale',
      value: 20.5,
      reason: 'the source device is offline',
    }
    const outcome = evaluateCompositionField({
      source: { kind: 'from', source: T1!, cap: 'temperature-sensor', fieldPath: 'celsius' },
      read: reader([[key(T1, 'temperature-sensor', 'celsius'), stale]]),
      now: NOW,
    })
    expect(outcome).toEqual({
      state: 'stale',
      value: 20.5,
      reason: expect.stringContaining('sensor.living_room_temperature'),
      deadline: null,
    })
  })

  it('from + a non-fatal unavailable source stays non-fatal, value null (R7b)', () => {
    const notGone: SourceReading = {
      state: 'unavailable',
      reason: 'cap not registered yet',
      fatal: false,
    }
    const outcome = evaluateCompositionField({
      source: { kind: 'from', source: T1!, cap: 'temperature-sensor', fieldPath: 'celsius' },
      read: reader([[key(T1, 'temperature-sensor', 'celsius'), notGone]]),
      now: NOW,
    })
    expect(outcome).toEqual({
      state: 'unavailable',
      value: null,
      fatal: false,
      confirmed: false,
      reason: expect.stringContaining('sensor.living_room_temperature'),
    })
  })
})

describe('a fatal unavailable binding always wins, regardless of order', () => {
  const nonFatal: SourceReading = {
    state: 'unavailable',
    reason: 'cap not registered yet',
    fatal: false,
  }
  const fatal: SourceReading = {
    state: 'unavailable',
    reason: 'device not found — two reads agreed',
    fatal: true,
  }
  const twoBindingSource = {
    kind: 'expression' as const,
    expr: 'avg(a, b)',
    bindings: {
      a: { kind: 'from' as const, source: T1!, cap: 'temperature-sensor', fieldPath: 'celsius' },
      b: { kind: 'from' as const, source: T2!, cap: 'temperature-sensor', fieldPath: 'celsius' },
    },
  }
  const aKey = key(T1, 'temperature-sensor', 'celsius')
  const bKey = key(T2, 'temperature-sensor', 'celsius')

  it('non-fatal binding `a` first, fatal binding `b` second: `b` wins, fatal:true', () => {
    const outcome = evaluateCompositionField({
      source: twoBindingSource,
      read: reader([
        [aKey, nonFatal],
        [bKey, fatal],
      ]),
      now: NOW,
    })
    expect(outcome).toEqual({
      state: 'unavailable',
      value: null,
      fatal: true,
      confirmed: true,
      reason: expect.stringContaining('`b`'),
    })
  })

  it('fatal binding `a` first, non-fatal binding `b` second: `a` still wins, fatal:true', () => {
    const outcome = evaluateCompositionField({
      source: twoBindingSource,
      read: reader([
        [aKey, fatal],
        [bKey, nonFatal],
      ]),
      now: NOW,
    })
    expect(outcome).toEqual({
      state: 'unavailable',
      value: null,
      fatal: true,
      confirmed: true,
      reason: expect.stringContaining('`a`'),
    })
  })
})

describe('accumulator source loss', () => {
  const source = {
    kind: 'expression',
    expr: 'count(value)',
    bindings: {
      value: {
        kind: 'from',
        source: T1!,
        cap: 'temperature-sensor',
        fieldPath: 'celsius',
      },
    },
  } as const
  const unavailable: SourceReading = {
    state: 'unavailable',
    reason: 'source device is gone',
    fatal: true,
  }

  it('evaluates count against persistent call memory and the current output', () => {
    const expressionMemory = createStatefulExpressionMemory()
    const run = (value: number, currentOutput: number) =>
      evaluateCompositionField({
        source,
        read: reader([[key(T1, 'temperature-sensor', 'celsius'), fresh(value)]]),
        now: NOW,
        stateful: {
          currentOutput,
          expressionMemory,
          startedAtMs: NOW - 1_000,
        },
      })

    expect(run(100, 2)).toMatchObject({ state: 'fresh', value: 2 })
    expect(run(100, 2)).toMatchObject({ state: 'fresh', value: 2 })
    expect(run(99, 2)).toMatchObject({ state: 'fresh', value: 2 })
    expect(run(101, 2)).toMatchObject({ state: 'fresh', value: 3 })
  })

  it('holds the last accumulator value as stale when its source is unavailable', () => {
    const outcome = evaluateCompositionField({
      source,
      read: reader([[key(T1, 'temperature-sensor', 'celsius'), unavailable]]),
      now: NOW,
      stateful: {
        currentOutput: 3,
        expressionMemory: createStatefulExpressionMemory(),
        startedAtMs: NOW - 1_000,
      },
    })

    expect(outcome).toEqual({
      state: 'stale',
      value: 3,
      reason: expect.stringContaining('source device is gone'),
      deadline: null,
    })
  })

  it('stays unavailable when no accumulator output has ever existed', () => {
    const outcome = evaluateCompositionField({
      source,
      read: reader([[key(T1, 'temperature-sensor', 'celsius'), unavailable]]),
      now: NOW,
      stateful: {
        currentOutput: undefined,
        expressionMemory: createStatefulExpressionMemory(),
        startedAtMs: NOW - 1_000,
      },
    })

    expect(outcome).toMatchObject({ state: 'unavailable', value: null, fatal: true })
  })
})

describe('count starts on the first ANSWERED read (D670 amendment)', () => {
  const source = {
    kind: 'expression',
    expr: 'count(value)',
    bindings: {
      value: { kind: 'from', source: T1!, cap: 'temperature-sensor', fieldPath: 'celsius' },
    },
  } as const
  const at = key(T1, 'temperature-sensor', 'celsius')
  const notYet: SourceReading = {
    state: 'unavailable',
    reason: 'the source has not reported yet',
    fatal: false,
  }

  function counter() {
    const expressionMemory = createStatefulExpressionMemory()
    let output: unknown = undefined
    return (reading: SourceReading) => {
      const outcome = evaluateCompositionField({
        source,
        read: reader([[at, reading]]),
        now: NOW,
        stateful: { currentOutput: output, expressionMemory, startedAtMs: NOW - 1_000 },
      })
      if (outcome.state !== 'unavailable') output = outcome.value
      return outcome
    }
  }

  it('an answered null seeds 0, and the next value counts 1', () => {
    const run = counter()
    expect(run(fresh(null))).toMatchObject({ state: 'fresh', value: 0 })
    expect(run(fresh(1_790_669_392_385))).toMatchObject({ state: 'fresh', value: 1 })
  })

  it('an unavailable read does not start it: the first answered value is the seed', () => {
    const run = counter()
    expect(run(notYet)).toMatchObject({ state: 'unavailable', value: null })
    expect(run(fresh(1_790_669_392_385))).toMatchObject({ state: 'fresh', value: 0 })
    expect(run(fresh(1_790_669_400_000))).toMatchObject({ state: 'fresh', value: 1 })
  })
})

describe('stateful call scoping', () => {
  it('isolates the same structural call path in two output fields', () => {
    const memory = createStatefulExpressionMemory()
    const run = (fieldKey: string, timestamp: number) =>
      evaluateCompositionField({
        source: {
          kind: 'expression',
          expr: 'rose(active, at, 0)',
          bindings: {
            active: { kind: 'literal', value: true },
            at: { kind: 'literal', value: timestamp },
          },
        },
        read: reader([]),
        now: NOW,
        stateful: {
          currentOutput: null,
          expressionMemory: memory,
          startedAtMs: NOW - 1_000,
          callPathPrefix: fieldKey,
        },
      })

    expect(run('doorbell.first', NOW - 10)).toMatchObject({ state: 'fresh', value: NOW - 10 })
    expect(run('doorbell.second', NOW)).toMatchObject({ state: 'fresh', value: NOW })
  })
})

describe('confirmed: only an ANSWER may release a field (D663, D49)', () => {
  const T = ROOM_EXAMPLE_TEMPERATURE_SOURCES[0]!
  const read = key(T, 'temperature-sensor', 'celsius')
  const from = { kind: 'from', source: T, cap: 'temperature-sensor', fieldPath: 'celsius' } as const

  it('a reading without `confirmed` is NOT confirmed; `confirmed: true` passes through', () => {
    const unanswered: SourceReading = { state: 'unavailable', reason: 'read failed', fatal: false }
    const answered: SourceReading = { ...unanswered, reason: 'unregistered', confirmed: true }
    expect(
      evaluateCompositionField({ source: from, read: reader([[read, unanswered]]), now: NOW }),
    ).toMatchObject({ state: 'unavailable', confirmed: false })
    expect(
      evaluateCompositionField({ source: from, read: reader([[read, answered]]), now: NOW }),
    ).toMatchObject({ state: 'unavailable', confirmed: true })
  })

  it('a confirmed unavailable binding wins over an unconfirmed one, in either order', () => {
    const [A, B] = ROOM_EXAMPLE_TEMPERATURE_SOURCES
    const source = {
      kind: 'expression',
      expr: 'a + b',
      bindings: {
        a: { kind: 'from', source: A!, cap: 'temperature-sensor', fieldPath: 'celsius' },
        b: { kind: 'from', source: B!, cap: 'temperature-sensor', fieldPath: 'celsius' },
      },
    } as const
    const unanswered: SourceReading = { state: 'unavailable', reason: 'read failed', fatal: false }
    const answered: SourceReading = {
      state: 'unavailable',
      reason: 'gone',
      fatal: false,
      confirmed: true,
    }
    const ka = key(A, 'temperature-sensor', 'celsius')
    const kb = key(B, 'temperature-sensor', 'celsius')
    for (const pair of [
      [
        [ka, unanswered],
        [kb, answered],
      ],
      [
        [ka, answered],
        [kb, unanswered],
      ],
    ] as const) {
      expect(evaluateCompositionField({ source, read: reader(pair), now: NOW })).toMatchObject({
        confirmed: true,
      })
    }
  })
})

describe('D393: an unavailable outcome is never a stand-in value', () => {
  it('carries value null whether the source is gone, the expression failed, the field is code, or a `from` source is gone', () => {
    const t1 = key(T1, 'temperature-sensor', 'celsius')
    const t2 = key(T2, 'temperature-sensor', 'celsius')
    const t3 = key(T3, 'temperature-sensor', 'celsius')
    const gone: SourceReading = { state: 'unavailable', reason: 'device not found', fatal: true }

    const bySourceGone = evaluateCompositionField({
      source: fieldOf('temperature-sensor', 'celsius'),
      read: reader([
        [t1, fresh(21.0)],
        [t2, gone],
        [t3, fresh(21.4)],
      ]),
      now: NOW,
    })
    const byExpressionFailure = evaluateCompositionField({
      source: fieldOf('temperature-sensor', 'celsius'),
      read: reader([
        [t1, fresh(21.0)],
        [t2, fresh(null)],
        [t3, fresh(21.4)],
      ]),
      now: NOW,
    })
    const byCode = evaluateCompositionField({
      source: { kind: 'code', code: 'return 1' },
      read: reader([]),
      now: NOW,
    })
    const byFromGone = evaluateCompositionField({
      source: { kind: 'from', source: T1!, cap: 'temperature-sensor', fieldPath: 'celsius' },
      read: reader([[t1, gone]]),
      now: NOW,
    })

    for (const outcome of [bySourceGone, byExpressionFailure, byCode, byFromGone]) {
      expect(outcome.state).toBe('unavailable')
      expect(outcome.state === 'unavailable' ? outcome.value : 'not unavailable').toBeNull()
    }
    // `from` also passes the reading's `fatal` through unchanged.
    expect(byFromGone).toEqual({
      state: 'unavailable',
      value: null,
      fatal: true,
      confirmed: true,
      reason: expect.stringContaining('sensor.living_room_temperature'),
    })
  })
})
