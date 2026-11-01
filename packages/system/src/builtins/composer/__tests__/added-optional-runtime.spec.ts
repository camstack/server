/**
 * An ADDED capability whose fields are OPTIONAL (`power-meter.power`, D944/D951)
 * through the REAL composition runtime: the source's reading is carried, and a
 * source that goes unavailable leaves the key OUT of the composed status —
 * never the last number, never 0 (D393).
 */
import {
  CompositionSchema,
  compileScalarOverride,
  compositionReadKey,
  compositionSliceKey,
  DeviceType,
  mergeScalarTarget,
  planComposition,
  type CompositionFieldsFeature,
  type CompositionSourceRef,
  type SourceReading,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { CompositionRuntime } from '../composition-runtime.js'
import { FakeTarget, FakeTimer, LOOKUP_CAP, recordingLogger } from './fixtures.js'

const DISHWASHER: CompositionSourceRef = { addonId: 'bosch', stableId: 'dw-1' }
const PLUG: CompositionSourceRef = { addonId: 'zigbee', stableId: 'plug-1' }
const fresh = (value: number): SourceReading => ({ state: 'fresh', value })

function plan() {
  const targets = [
    { id: 'power', field: 'power', unit: 'W' },
    { id: 'energy', field: 'energy', unit: 'kWh' },
  ]
  const compiled = targets.map(({ id, field, unit }) => {
    const out = compileScalarOverride({
      draft: {
        kind: 'scalar',
        cap: 'power-meter',
        targetId: id,
        source: { ...PLUG, cap: 'power-meter', fieldPath: field },
        transform: { kind: 'identity' },
      },
      device: DISHWASHER,
      apply: 'add',
      sourceValueKind: 'number',
      changedAtField: null,
      sourceUnit: unit,
    })
    if (!out.ok) throw new Error(out.reason)
    return { id, value: out.value }
  })
  const feature = compiled.reduce<CompositionFieldsFeature | null>(
    (acc, next) => mergeScalarTarget(acc, next.value, 'power-meter', next.id),
    null,
  )
  if (feature === null) throw new Error('no feature')
  const planned = planComposition(
    CompositionSchema.parse({
      target: { kind: 'existing', device: DISHWASHER },
      features: [feature],
    }),
    LOOKUP_CAP,
    {
      kind: 'found',
      deviceId: 78,
      type: DeviceType.Dishwasher,
      nativeCaps: new Map(),
    },
  )
  return planned
}

const KEY = (field: string) =>
  compositionReadKey({ source: PLUG, cap: 'power-meter', fieldPath: field })

let readings: Map<string, SourceReading>
let target: FakeTarget
let runtime: CompositionRuntime

const lastWrite = () => target.writes.filter((w) => w.cap === 'power-meter').at(-1)

beforeEach(() => {
  readings = new Map()
  target = new FakeTarget(78)
  const planned = plan()
  if (planned.problems.length > 0)
    throw new Error(planned.problems.map((p) => p.message).join('; '))
  runtime = new CompositionRuntime({
    blockId: 'b-pm',
    fields: planned.fields,
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
    now: () => 1_000,
    timer: new FakeTimer(),
    logger: recordingLogger().logger,
  })
})

describe('an added optional reading', () => {
  it('carries the source value, then leaves the key out when the source is lost', () => {
    readings.set(KEY('power'), fresh(42))
    readings.set(KEY('energy'), fresh(3.5))
    runtime.start()
    expect(lastWrite()?.values['power']).toBe(42)
    expect(lastWrite()?.values['energy']).toBe(3.5)

    readings.set(KEY('power'), {
      state: 'unavailable',
      reason: 'lost',
      fatal: false,
    })
    runtime.onSourcesChanged(new Set([compositionSliceKey(PLUG, 'power-meter')]))
    const after = lastWrite()
    expect(after?.values).not.toHaveProperty('power')
    expect(after?.values['power']).not.toBe(0)
    expect(after?.values['power']).not.toBe(42)
    expect(after?.values['energy']).toBe(3.5)
  })
})
