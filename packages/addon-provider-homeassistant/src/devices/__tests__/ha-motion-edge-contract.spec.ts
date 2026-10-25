/**
 * Contract, provider half: the slices `HaBinarySensorDevice` REALLY commits
 * are (1) valid `MotionStatusSchema` values and (2) read by the SHARED edge
 * rule, `evaluateSensorEdge` in `@camstack/types`, as exactly one rise per HA
 * `on` and never a rise on an `off`.
 *
 * Why this half stops at the shared rule: addons never import each other,
 * not even from a spec. Every consumer of a sensor edge — the orchestrator's
 * `CameraSensorsSource`, the recorder's sensor trigger, post-analysis —
 * reaches it through `evaluateSensorEdge`, so the rule in
 * `@camstack/types` IS the contract. The consumer half,
 * `addon-pipeline-orchestrator/src/__tests__/camera-sensors-kept-rise.spec.ts`,
 * drives schema-valid slices of this exact shape through the real source.
 *
 * `lastDetectedAt` now survives an `off`, so an `off` slice carries a STALE
 * rise time. That is harmless only because the rule requires the LEVEL to be
 * true before it reads the time — which is what this file pins.
 */
import {
  DEFAULT_FIRST_SIGHTING_FRESHNESS_MS,
  evaluateSensorEdge,
  MotionStatusSchema,
  type SensorEdgeVerdict,
  sliceChangedAt,
} from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeMotionSensor } from './ha-binary-sensor-harness.js'

const START = Date.parse('2026-09-29T17:00:00.000Z')

/** One observed slice and the shared rule's verdict on it. */
interface Observation {
  /** The slice the device committed — what `DeviceStateChanged` would carry. */
  readonly slice: Readonly<Record<string, unknown>>
  readonly verdict: SensorEdgeVerdict
  /** The rise time a consumer would read — `sliceChangedAt` — on a rising verdict only. */
  readonly riseAt: number | null
}

interface EdgeHarness {
  /** HA pushes `state`; the committed slice is judged as a consumer would. */
  readonly haSays: (state: string, lastChangedAtMs: number) => Observation
  /** The constructor seed, judged as a consumer's first sighting. */
  readonly seed: Observation
}

/** A consumer's view: its own `prior` level and its own `startedAtMs`, like every observer keeps. */
function edgeHarness(initialRuntimeState: Record<string, unknown> = {}): EdgeHarness {
  const sensor = makeMotionSensor(initialRuntimeState)
  const startedAtMs = Date.now()
  let prior: boolean | undefined
  const observe = (): Observation => {
    const slice = sensor.slice()
    if (slice === undefined) throw new Error('the device holds no motion slice')
    // (1) the slice is a valid value of the cap's own schema.
    MotionStatusSchema.parse(slice)
    // (2) the shared edge rule, exactly as a consumer calls it.
    const verdict = evaluateSensorEdge({
      capName: 'motion',
      slice,
      prior,
      startedAtMs,
      nowMs: Date.now(),
      firstSightingFreshnessMs: DEFAULT_FIRST_SIGHTING_FRESHNESS_MS,
    })
    if (verdict.value !== null) prior = verdict.value
    return {
      slice,
      verdict,
      riseAt: verdict.edge === 'rising' ? sliceChangedAt('motion', slice) : null,
    }
  }
  const seed = observe()
  return {
    seed,
    haSays: (state, lastChangedAtMs) => {
      sensor.push(state, lastChangedAtMs)
      return observe()
    },
  }
}

describe('HA motion slice → shared edge rule (contract, provider half)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('off → on: one rise, at the rise', () => {
    const h = edgeHarness()
    expect(h.haSays('off', START - 3_600_000).verdict.edge).toBe('none')
    vi.setSystemTime(START + 1_000)
    const rise = h.haSays('on', START + 1_000)
    expect(rise.verdict).toEqual({ edge: 'rising', value: true })
    expect(rise.riseAt).toBe(START + 1_000)
  })

  it('on → off: the off slice carries the kept rise and reads as the fall', () => {
    const h = edgeHarness()
    vi.setSystemTime(START + 1_000)
    h.haSays('on', START + 1_000)
    vi.setSystemTime(START + 5_000)
    const fall = h.haSays('off', START + 5_000)
    // The stale stamp IS on the slice the rule judges — that is the point.
    expect(fall.slice).toMatchObject({ detected: false, lastDetectedAt: START + 1_000 })
    expect(fall.verdict).toEqual({ edge: 'none', value: false, reason: 'falling-edge' })
  })

  it('on → off → off → on with a new time: exactly one rise per rise', () => {
    const h = edgeHarness()
    const seen: Observation[] = []
    vi.setSystemTime(START + 1_000)
    seen.push(h.haSays('on', START + 1_000))
    vi.setSystemTime(START + 5_000)
    seen.push(h.haSays('off', START + 5_000))
    seen.push(h.haSays('off', START + 5_000))
    vi.setSystemTime(START + 60_000)
    seen.push(h.haSays('on', START + 60_000))

    expect(seen.map((o) => o.riseAt)).toEqual([START + 1_000, null, null, START + 60_000])
    expect(seen.map((o) => o.verdict.edge)).toEqual(['rising', 'none', 'none', 'rising'])
  })

  it('restart: a stored rise inside the freshness window is not a rise, on the seed or a first off', () => {
    // 20 s old — fresh enough that a level-blind rule WOULD call it a rise.
    const h = edgeHarness({
      motion: { detected: false, lastDetectedAt: START - 20_000, autoClearAfterMs: null },
    })
    expect(h.seed.slice).toMatchObject({ detected: false, lastDetectedAt: START - 20_000 })
    expect(h.seed.verdict).toEqual({
      edge: 'none',
      value: false,
      reason: 'baseline-seeded-inactive',
    })
    expect(h.haSays('off', START - 10_000).verdict).toEqual({
      edge: 'none',
      value: false,
      reason: 'no-change',
    })
    vi.setSystemTime(START + 30_000)
    expect(h.haSays('on', START + 30_000).riseAt).toBe(START + 30_000)
  })
})
