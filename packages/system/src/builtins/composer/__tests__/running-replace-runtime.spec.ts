/**
 * A replaced native `running` (D990) through the REAL composition runtime: the
 * written `running` and `since` follow the ASSIGNED value (power with dwell),
 * never the native running the device itself reports, and `phase` is not
 * written — the claimed slice merges over the native one, which keeps it.
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
const fresh = (value: string | boolean | number): SourceReading => ({ state: 'fresh', value })

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
        threshold: 8,
        startDwellMs: 0,
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

const POWER_KEY = compositionReadKey({ source: PLUG, cap: 'power-meter', fieldPath: 'power' })
const NATIVE_RUNNING_KEY = compositionReadKey({
  source: DISHWASHER,
  cap: 'running-state',
  fieldPath: 'running',
})

let readings: Map<string, SourceReading>
let target: FakeTarget
let runtime: CompositionRuntime
let clock: number

beforeEach(() => {
  readings = new Map()
  target = new FakeTarget(78)
  clock = 1_000
  runtime = new CompositionRuntime({
    blockId: 'b-run',
    fields: plan(),
    eventPlans: [],
    events: { emit: () => undefined },
    target,
    lookupCap: LOOKUP_CAP,
    read: (r) =>
      readings.get(compositionReadKey(r)) ?? { state: 'unavailable', reason: 'none', fatal: false },
    now: () => clock,
    timer: new FakeTimer(),
    logger: recordingLogger().logger,
  })
})

const written = (field: string) =>
  target.writes
    .filter((w) => w.cap === 'running-state')
    .map((w) => w.values[field])
    .filter((v) => v !== undefined)
    .at(-1)

const wroteField = (field: string) =>
  target.writes.some((w) => w.cap === 'running-state' && field in w.values)

describe('a replaced running follows the assigned source', () => {
  it('writes running and since from the power, whatever the native running says', () => {
    readings.set(NATIVE_RUNNING_KEY, fresh(false))
    readings.set(POWER_KEY, fresh(30))
    runtime.start()
    expect(written('running')).toBe(true)
    expect(written('source')).toBe('assigned')
    const since = written('since')
    expect(since).toBe(1_000)

    // The NATIVE running flips while the power stays high: the stamp must not move.
    clock = 5_000
    readings.set(NATIVE_RUNNING_KEY, fresh(true))
    runtime.onSourcesChanged(new Set([compositionSliceKey(DISHWASHER, 'running-state')]))
    expect(written('running')).toBe(true)
    expect(written('since')).toBe(since)

    // The power drops: the assigned running ends, and the stamp moves with it.
    clock = 9_000
    readings.set(POWER_KEY, fresh(1))
    runtime.onSourcesChanged(new Set([compositionSliceKey(PLUG, 'power-meter')]))
    expect(written('running')).toBe(false)
    expect(written('since')).toBe(9_000)
  })

  it('never writes phase: the native one is kept by the merge', () => {
    readings.set(NATIVE_RUNNING_KEY, fresh(false))
    readings.set(POWER_KEY, fresh(30))
    runtime.start()
    expect(wroteField('phase')).toBe(false)
  })
})
