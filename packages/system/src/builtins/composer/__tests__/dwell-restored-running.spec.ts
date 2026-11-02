/**
 * (restored-dwell) A restored running slice seeds the dwell after a boot (#354).
 * A replaced native `running` (D990) through the REAL composition runtime: the
 * written `running` and `since` follow the ASSIGNED value (power with dwell),
 * never the native running the device itself reports, and `phase` is not
 * written — the claimed slice merges over the native one, which keeps it.
 */
import {
  CompositionSchema,
  compileScalarOverride,
  compositionReadKey,
  DeviceType,
  planComposition,
  type CompositionSourceRef,
  type SourceReading,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { CompositionRuntime } from '../composition-runtime.js'
import { FakeTarget, FakeTimer, LOOKUP_CAP, recordingLogger } from './fixtures.js'

const DISHWASHER: CompositionSourceRef = { addonId: 'bosch', stableId: 'dw-1' }
const PLUG: CompositionSourceRef = { addonId: 'zigbee', stableId: 'plug-1' }
const fresh = (value: string | boolean | number): SourceReading => ({ state: 'fresh', value })

function plan(startDwellMs = 0, stopDwellMs = 0) {
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
        startDwellMs,
        stopDwellMs,
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

function boot(restored: boolean, power: number) {
  const target = new FakeTarget(78)
  const runtime = new CompositionRuntime({
    blockId: 'b-run',
    fields: plan(30_000, 600_000),
    eventPlans: [],
    events: { emit: () => undefined },
    target,
    lookupCap: LOOKUP_CAP,
    initialByCap: new Map([['running-state', { running: restored }]]),
    read: (r) =>
      compositionReadKey(r) === POWER_KEY
        ? fresh(power)
        : { state: 'unavailable', reason: 'none', fatal: false },
    now: () => 1_000,
    timer: new FakeTimer(),
    logger: recordingLogger().logger,
  })
  runtime.start()
  return target.writes
    .filter((w) => w.cap === 'running-state')
    .map((w) => w.values['running'])
    .filter((v) => v !== undefined)
    .at(-1)
}

describe('a restored running seeds the dwell after a boot', () => {
  it('restored false with the power low reads false right after boot, not unknown', () => {
    expect(boot(false, 1)).toBe(false)
  })
  it('restored true with the power low keeps true through the stop delay', () => {
    expect(boot(true, 1)).toBe(true)
  })
})
