/**
 * The washer's fake cycles, replayed through the REAL composition runtime: a
 * standby plug sends ONE 5-9 W sample and stays silent for over 30 s. The start
 * dwell's own deadline timer fired over that held value and confirmed a start on
 * a single sample; a start needs a second reading that still satisfies it.
 */
import {
  CompositionSchema,
  compileScalarOverride,
  compositionReadKey,
  compositionSliceKey,
  DeviceType,
  planComposition,
  type CompositionSourceRef,
  type SourceReading,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { CompositionRuntime } from '../composition-runtime.js'
import { FakeTarget, FakeTimer, LOOKUP_CAP, recordingLogger } from './fixtures.js'

const DISHWASHER: CompositionSourceRef = { addonId: 'bosch', stableId: 'dw-1' }
const PLUG: CompositionSourceRef = { addonId: 'zigbee', stableId: 'plug-1' }
const fresh = (value: string | boolean | number): SourceReading => ({
  state: 'fresh',
  value,
})

function plan() {
  const compiled = compileScalarOverride({
    draft: {
      kind: 'scalar',
      cap: 'running-state',
      targetId: 'running',
      source: { ...PLUG, cap: 'power-meter', fieldPath: 'power' },
      transform: {
        kind: 'threshold',
        comparison: 'gte',
        threshold: 5,
        startDwellMs: 30_000,
        stopDwellMs: 0,
      },
    },
    device: DISHWASHER,
    apply: 'replace',
    sourceValueKind: 'number',
    changedAtField: null,
    sourceUnit: 'W',
  })
  if (!compiled.ok) throw new Error(compiled.reason)
  const planned = planComposition(
    CompositionSchema.parse({
      target: { kind: 'existing', device: DISHWASHER },
      features: [compiled.value],
    }),
    LOOKUP_CAP,
    {
      kind: 'found',
      deviceId: 78,
      type: DeviceType.Dishwasher,
      nativeCaps: new Map([['running-state', 'bosch']]),
    },
  )
  if (planned.problems.length > 0)
    throw new Error(planned.problems.map((p) => p.message).join('; '))
  return planned.fields
}

const POWER_KEY = compositionReadKey({
  source: PLUG,
  cap: 'power-meter',
  fieldPath: 'power',
})
const NATIVE_RUNNING_KEY = compositionReadKey({
  source: DISHWASHER,
  cap: 'running-state',
  fieldPath: 'running',
})

let readings: Map<string, SourceReading>
let target: FakeTarget
let runtime: CompositionRuntime
let clock: number
let timer: FakeTimer

beforeEach(() => {
  readings = new Map()
  target = new FakeTarget(78)
  clock = 1_000
  timer = new FakeTimer()
  runtime = new CompositionRuntime({
    blockId: 'b-run',
    fields: plan(),
    eventPlans: [],
    events: { emit: () => undefined },
    target,
    lookupCap: LOOKUP_CAP,
    read: (r) =>
      readings.get(compositionReadKey(r)) ?? {
        state: 'unavailable',
        reason: 'none',
        fatal: false,
      },
    now: () => clock,
    timer,
    logger: recordingLogger().logger,
  })
})

const running = (): unknown =>
  target.writes
    .filter((w) => w.cap === 'running-state')
    .map((w) => w.values['running'])
    .filter((v) => v !== undefined)
    .at(-1)

const sample = (watts: number, at: number): void => {
  clock = at
  readings.set(POWER_KEY, fresh(watts))
  runtime.onSourcesChanged(new Set([compositionSliceKey(PLUG, 'power-meter')]))
}

describe('a standby blip is not a start', () => {
  beforeEach(() => {
    readings.set(NATIVE_RUNNING_KEY, fresh(false))
    readings.set(POWER_KEY, fresh(1))
    runtime.start()
    expect(running()).toBe(false)
  })

  it('7.44 W, silence past the dwell, then 1.13 W: never running', () => {
    sample(7.44, 100_000)
    clock = 130_000
    timer.trigger()
    expect(running()).toBe(false)
    sample(1.13, 131_000)
    expect(running()).toBe(false)
  })

  it('a second sample at or above the threshold after the dwell is a real start', () => {
    sample(7.44, 100_000)
    clock = 130_000
    timer.trigger()
    expect(running()).toBe(false)
    sample(2_000, 140_000)
    expect(running()).toBe(true)
  })
})
