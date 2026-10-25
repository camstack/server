import { compositionSliceKey, type CompositionFieldSource } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { previewField, type SliceReading } from '../field-preview'

const T1 = { addonId: 'provider-homeassistant', stableId: 'climate.porch' }
const T2 = { addonId: 'provider-homeassistant', stableId: 'sensor.porch_temperature' }
const M1 = { addonId: 'provider-homeassistant', stableId: 'binary_sensor.porch_motion' }
const from = (source: typeof T1, cap: string, fieldPath: string) =>
  ({ kind: 'from', source, cap, fieldPath }) as const

const AVG: CompositionFieldSource = {
  kind: 'expression',
  expr: 'round(avg(t1, t2), 1)',
  bindings: {
    t1: from(T1, 'temperature-sensor', 'celsius'),
    t2: from(T2, 'temperature-sensor', 'celsius'),
  },
}

function slices(
  entries: readonly (readonly [typeof T1, string, SliceReading])[],
): ReadonlyMap<string, SliceReading> {
  return new Map(entries.map(([ref, cap, reading]) => [compositionSliceKey(ref, cap), reading]))
}

describe('previewField (ruling 10)', () => {
  it('evaluates the formula over live values, as the composer would', () => {
    const out = previewField(
      AVG,
      slices([
        [T1, 'temperature-sensor', { kind: 'value', slice: { celsius: 20.9 } }],
        [T2, 'temperature-sensor', { kind: 'value', slice: { celsius: 20.9 } }],
      ]),
      1_000,
    )
    expect(out).toEqual({ kind: 'value', value: 20.9, stale: null })
  })
  it('waits while ANY source has not answered — never computes over a hole', () => {
    const out = previewField(
      AVG,
      slices([
        [T1, 'temperature-sensor', { kind: 'value', slice: { celsius: 20.9 } }],
        [T2, 'temperature-sensor', { kind: 'pending' }],
      ]),
      1_000,
    )
    expect(out.kind).toBe('waiting')
  })
  it('a field the source does not report is unavailable, named — never 0', () => {
    const out = previewField(
      AVG,
      slices([
        [T1, 'temperature-sensor', { kind: 'value', slice: {} }],
        [T2, 'temperature-sensor', { kind: 'value', slice: { celsius: 20.9 } }],
      ]),
      1_000,
    )
    expect(out.kind).toBe('unavailable')
    expect(out.kind === 'unavailable' && out.reason).toContain('temperature-sensor.celsius')
  })
  it('windows use the clock it is given', () => {
    const within: CompositionFieldSource = {
      kind: 'expression',
      expr: 'within(m1, 300000)',
      bindings: { m1: from(M1, 'motion', 'lastDetectedAt') },
    }
    const s = slices([[M1, 'motion', { kind: 'value', slice: { lastDetectedAt: 1_000_000 } }]])
    expect(previewField(within, s, 1_100_000)).toEqual({ kind: 'value', value: true, stale: null })
    expect(previewField(within, s, 1_400_001)).toEqual({ kind: 'value', value: false, stale: null })
  })
  it('a formula with memory is the composer’s to evaluate', () => {
    const rose: CompositionFieldSource = {
      kind: 'expression',
      expr: 'latest(rose(a, c, 2000))',
      bindings: { a: from(M1, 'binary', 'on'), c: from(M1, 'binary', 'lastChangedAt') },
    }
    expect(previewField(rose, new Map(), 1)).toEqual({ kind: 'runtime-only' })
  })
})
