import { describe, it, expect } from 'vitest'
import {
  evaluateSensorEdge,
  evaluateSensorLevelEdge,
  SOURCE_CAP_ACTIVE_FIELD,
  SOURCE_CAP_CHANGED_AT_FIELD,
  SOURCE_CAPS,
  type SensorEdgeInput,
  type SensorLevelEdgeInput,
} from '../sensor-active-state.js'

const base = (over: Partial<SensorEdgeInput>): SensorEdgeInput => ({
  capName: 'contact',
  slice: { entryOpen: true, lastChangedAt: 5_000 },
  prior: undefined,
  startedAtMs: 0,
  nowMs: 5_100,
  firstSightingFreshnessMs: 30_000,
  ...over,
})

const levelBase = (over: Partial<SensorLevelEdgeInput>): SensorLevelEdgeInput => ({
  level: true,
  changedAt: 99_000,
  priorLevel: undefined,
  startedAtMs: 98_000,
  nowMs: 100_000,
  firstSightingFreshnessMs: 30_000,
  ...over,
})

describe('evaluateSensorLevelEdge', () => {
  it('accepts a fresh first active sighting at the source timestamp', () => {
    expect(evaluateSensorLevelEdge(levelBase({}))).toEqual({
      kind: 'rise',
      timestamp: 99_000,
    })
  })

  it('rejects a stale first active sighting', () => {
    expect(evaluateSensorLevelEdge(levelBase({ changedAt: 60_000, startedAtMs: 50_000 }))).toEqual({
      kind: 'none',
      nextPriorLevel: true,
    })
  })

  it('rejects a first active sighting without a timestamp', () => {
    expect(evaluateSensorLevelEdge(levelBase({ changedAt: null }))).toEqual({
      kind: 'none',
      nextPriorLevel: true,
    })
  })

  it('accepts only a timestamped false-to-true transition', () => {
    expect(evaluateSensorLevelEdge(levelBase({ priorLevel: false }))).toEqual({
      kind: 'rise',
      timestamp: 99_000,
    })
    expect(evaluateSensorLevelEdge(levelBase({ priorLevel: false, changedAt: null }))).toEqual({
      kind: 'none',
      nextPriorLevel: true,
    })
  })

  it('returns the next baseline for inactive first sightings, equality, and falls', () => {
    expect(evaluateSensorLevelEdge(levelBase({ level: false }))).toEqual({
      kind: 'none',
      nextPriorLevel: false,
    })
    expect(evaluateSensorLevelEdge(levelBase({ priorLevel: true }))).toEqual({
      kind: 'none',
      nextPriorLevel: true,
    })
    expect(evaluateSensorLevelEdge(levelBase({ level: false, priorLevel: true }))).toEqual({
      kind: 'none',
      nextPriorLevel: false,
    })
  })
})

describe('evaluateSensorEdge', () => {
  it('the rising edge is false→true', () => {
    expect(evaluateSensorEdge(base({ prior: false }))).toEqual({ edge: 'rising', value: true })
  })

  it('the falling edge opens nothing', () => {
    const r = evaluateSensorEdge(
      base({ prior: true, slice: { entryOpen: false, lastChangedAt: 5_000 } }),
    )
    expect(r).toEqual({ edge: 'none', value: false, reason: 'falling-edge' })
  })

  it('a re-emission with the same value is not an edge', () => {
    expect(evaluateSensorEdge(base({ prior: true }))).toMatchObject({ reason: 'no-change' })
  })

  it('a rise without a timestamp cannot be dated and is not an edge', () => {
    expect(evaluateSensorEdge(base({ prior: false, slice: { entryOpen: true } }))).toMatchObject({
      reason: 'missing-timestamp',
    })
  })

  it('reads the RIGHT field for the device type — motion uses detected', () => {
    const r = evaluateSensorEdge(
      base({ capName: 'motion', prior: false, slice: { detected: true, lastDetectedAt: 5_000 } }),
    )
    expect(r).toEqual({ edge: 'rising', value: true })
  })

  it('does not coerce truth: a non-boolean field is not a value', () => {
    const r = evaluateSensorEdge(base({ prior: false, slice: { entryOpen: 'open' } }))
    expect(r).toEqual({ edge: 'none', value: null, reason: 'non-boolean-value' })
  })

  it('first observation INACTIVE: baseline only, nothing to lose', () => {
    const r = evaluateSensorEdge(base({ slice: { entryOpen: false, lastChangedAt: 5_000 } }))
    expect(r).toMatchObject({ reason: 'baseline-seeded-inactive' })
  })

  it('first observation already ACTIVE and FRESH: it is the press itself', () => {
    expect(evaluateSensorEdge(base({}))).toEqual({ edge: 'rising', value: true })
  })

  it('first observation already active but OLD: silence, and it says so', () => {
    const r = evaluateSensorEdge(
      base({ slice: { entryOpen: true, lastChangedAt: 1 }, nowMs: 10_000_000 }),
    )
    expect(r).toMatchObject({ reason: 'baseline-seeded-stale-active' })
  })

  it('presence and connectivity are not sources — a string state is not an edge', () => {
    expect(SOURCE_CAP_ACTIVE_FIELD['presence']).toBeUndefined()
    expect(SOURCE_CAP_ACTIVE_FIELD['connectivity']).toBeUndefined()
    expect(
      evaluateSensorEdge(base({ capName: 'presence', slice: { state: 'home' } })),
    ).toMatchObject({
      reason: 'unknown-cap',
    })
  })
})

describe('le due tabelle restano allineate', () => {
  it('every source cap has a transition field — without one, the first sighting stays silent forever', () => {
    for (const cap of SOURCE_CAPS) {
      expect(SOURCE_CAP_CHANGED_AT_FIELD[cap]).toBeTypeOf('string')
    }
  })
})
