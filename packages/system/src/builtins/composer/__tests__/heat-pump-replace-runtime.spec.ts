/**
 * A heat pump's electrical power and energy replaced by a picked device's
 * power-meter (#476), through the REAL composition runtime and the REAL merge:
 * the served `heat-pump-status` carries the assigned reading (so the instant COP
 * uses it), a source that does not answer RELEASES the field back to the native
 * one (never a 0, D393), and an unlinked pump keeps its native kWh.
 */
import {
  CompositionSchema,
  compileScalarOverride,
  compositionReadKey,
  compositionSliceKey,
  DeviceType,
  HeatPumpStatusSchema,
  heatPumpInstantCop,
  planComposition,
  type CompositionSourceRef,
  type HeatPumpStatus,
  type SourceReading,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { CompositionRuntime } from '../composition-runtime.js'
import { mergeOwned, type OwnedCap } from '../../device-manager/field-ownership.js'
import { FakeTarget, FakeTimer, LOOKUP_CAP, recordingLogger } from './fixtures.js'

const PUMP: CompositionSourceRef = { addonId: 'bosch', stableId: 'hp-1' }
const METER: CompositionSourceRef = { addonId: 'enpal', stableId: 'hp-meter' }
const CAP = 'heat-pump-status'
const fresh = (value: number): SourceReading => ({ state: 'fresh', value })

const NATIVE: HeatPumpStatus = HeatPumpStatusSchema.parse({
  circuits: [],
  system: { silent: null, away: null, additionalHeater: null, holiday: null },
  power: { thermalW: 3000, electricalW: null, compressorPct: 40 },
  temperatures: { supply: null, return: null, outdoor: null },
  energy: { thermalKwh: 100, electricalKwh: 321 },
  waterPressureBar: null,
  starts: null,
  workingTime: null,
  heatDemand: null,
  heatSourceType: null,
  compressorRunning: null,
  hourAverage: null,
  lastFetchedAt: 1,
})

function link(targetId: string, fieldPath: string, unit: string) {
  const compiled = compileScalarOverride({
    draft: {
      kind: 'scalar',
      cap: CAP,
      targetId,
      source: { ...METER, cap: 'power-meter', fieldPath },
      transform: { kind: 'identity' },
    },
    device: PUMP,
    apply: 'replace',
    sourceValueKind: 'number',
    changedAtField: null,
    sourceUnit: unit,
  })
  if (!compiled.ok) throw new Error(compiled.reason)
  return compiled.value
}

function plan(features: readonly ReturnType<typeof link>[]) {
  const planned = planComposition(
    CompositionSchema.parse({ target: { kind: 'existing', device: PUMP }, features }),
    LOOKUP_CAP,
    {
      kind: 'found',
      deviceId: 7,
      type: DeviceType.HeatPump,
      nativeCaps: new Map([[CAP, 'bosch']]),
    },
  )
  if (planned.problems.length > 0)
    throw new Error(planned.problems.map((p) => p.message).join('; '))
  return planned.fields
}

const POWER_KEY = compositionReadKey({ source: METER, cap: 'power-meter', fieldPath: 'power' })
const ENERGY_KEY = compositionReadKey({ source: METER, cap: 'power-meter', fieldPath: 'energy' })

let readings: Map<string, SourceReading>
let target: FakeTarget
let runtime: CompositionRuntime

function start(features: readonly ReturnType<typeof link>[]) {
  runtime = new CompositionRuntime({
    blockId: 'b-hp',
    fields: plan(features),
    eventPlans: [],
    events: { emit: () => undefined },
    target,
    lookupCap: LOOKUP_CAP,
    read: (r) =>
      readings.get(compositionReadKey(r)) ?? { state: 'unavailable', reason: 'none', fatal: false },
    now: () => 1_000,
    timer: new FakeTimer(),
    logger: recordingLogger().logger,
  })
  runtime.start()
}

/** What the hub serves: the claimed values merged over the native slice. */
function served(): HeatPumpStatus {
  const values: Record<string, unknown> = {}
  for (const w of target.writes) if (w.cap === CAP) Object.assign(values, w.values)
  const owned: OwnedCap = {
    owner: 'b-hp',
    mode: 'replace',
    fields: Object.keys(values),
    values,
  }
  const merged = mergeOwned(NATIVE, owned, HeatPumpStatusSchema)
  if (merged.kind !== 'slice') throw new Error(`held: ${merged.reason}`)
  return HeatPumpStatusSchema.parse(merged.slice)
}

beforeEach(() => {
  readings = new Map()
  target = new FakeTarget(7)
})

describe('heat-pump-status electrical fields read from a picked device', () => {
  it('serves the meter power, and the instant COP uses it', () => {
    readings.set(POWER_KEY, fresh(1234))
    start([link('electrical-power', 'power', 'W')])
    const status = served()
    expect(status.power.electricalW).toBe(1234)
    expect(status.power.thermalW).toBe(3000)
    expect(status.energy.electricalKwh).toBe(321)
    expect(heatPumpInstantCop(status.power)).toBeCloseTo(3000 / 1234)
  })

  it('replaces the native kWh when linked', () => {
    readings.set(ENERGY_KEY, fresh(555.5))
    start([link('electrical-energy', 'energy', 'kWh')])
    expect(served().energy.electricalKwh).toBe(555.5)
    expect(served().power.electricalW).toBeNull()
  })

  it('a source confirmed unreachable releases the field to the native null, never 0 (D393)', () => {
    readings.set(POWER_KEY, fresh(1234))
    start([link('electrical-power', 'power', 'W')])
    readings.set(POWER_KEY, {
      state: 'unavailable',
      reason: 'meter unreachable',
      fatal: false,
      confirmed: true,
    })
    runtime.onSourcesChanged(new Set([compositionSliceKey(METER, 'power-meter')]))
    expect(target.withholds.at(-1)).toEqual({ cap: CAP, fields: ['power.electricalW'] })
  })

  it('an unlinked pump writes nothing, so the native values stand', () => {
    start([])
    expect(target.writes).toEqual([])
  })
})
