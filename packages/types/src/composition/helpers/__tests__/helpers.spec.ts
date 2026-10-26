/**
 * Group helpers (D944 phase 1a). A free expression still includes a stale
 * value; only `kind: 'aggregate'` leaves unknown members out and counts them.
 */
import { describe, expect, it } from 'vitest'
import { ambientLightSensorCapability } from '../../../capabilities/ambient-light-sensor.cap.js'
import { batteryCapability } from '../../../capabilities/battery.cap.js'
import { binaryCapability } from '../../../capabilities/binary.cap.js'
import { contactCapability } from '../../../capabilities/contact.cap.js'
import { floodCapability } from '../../../capabilities/flood.cap.js'
import { groupStatusCapability } from '../../../capabilities/group-status.cap.js'
import { humiditySensorCapability } from '../../../capabilities/humidity-sensor.cap.js'
import { motionCapability } from '../../../capabilities/motion.cap.js'
import { numericSensorCapability } from '../../../capabilities/numeric-sensor.cap.js'
import { powerMeterCapability } from '../../../capabilities/power-meter.cap.js'
import { pressureSensorCapability } from '../../../capabilities/pressure-sensor.cap.js'
import { smokeCapability } from '../../../capabilities/smoke.cap.js'
import { switchCapability } from '../../../capabilities/switch.cap.js'
import { temperatureSensorCapability } from '../../../capabilities/temperature-sensor.cap.js'
import { DeviceRole, DeviceType } from '../../../device/device-type.js'
import type { ReadingQuantity } from '../../../units/quantity.js'
import {
  type Composition,
  CompositionSchema,
  compositionReadKey,
  compositionSourceKey,
  type CompositionSourceRef,
} from '../../composition.js'
import {
  ROOM_EXAMPLE_MOTION_SOURCES,
  ROOM_EXAMPLE_TEMPERATURE_SOURCES,
  ROOM_OCCUPANCY_WINDOW_MS,
  roomCompositionExample,
} from '../../examples.js'
import { evaluateCompositionField, type SourceReading } from '../../evaluate-field.js'
import {
  buildCapabilityLookup,
  type CompositionSourceDescription,
  type ValidateCompositionContext,
  validateComposition,
} from '../../validate-composition.js'
import { evaluateAggregate } from '../aggregate.js'
import { GROUP_TEMPLATES, groupTemplate } from '../catalog.js'
import { compileHelper } from '../compile.js'
import { helperSaveProblems, type HelperMemberFact } from '../save.js'
import { sourcePickForTemplate } from '../source-pick.js'
import {
  GROUP_TEMPLATE_IDS,
  type GroupHelperSpec,
  type GroupTemplateId,
  type HelperMember,
} from '../spec.js'

const lookupCap = buildCapabilityLookup([
  temperatureSensorCapability,
  humiditySensorCapability,
  pressureSensorCapability,
  ambientLightSensorCapability,
  powerMeterCapability,
  numericSensorCapability,
  batteryCapability,
  motionCapability,
  contactCapability,
  floodCapability,
  smokeCapability,
  binaryCapability,
  groupStatusCapability,
  switchCapability,
])

function ref(n: number): CompositionSourceRef {
  return { addonId: 'addon-sensors', stableId: `sensor-${n}` }
}

function member(n: number, cap: string, fieldPath: string): HelperMember {
  return { source: ref(n), cap, fieldPath }
}

function group(
  templateId: GroupTemplateId,
  aggregate: GroupHelperSpec['aggregate'],
  members: readonly HelperMember[],
): GroupHelperSpec {
  return { kind: 'group', templateId, aggregate, members: [...members] }
}

function fresh(value: number | boolean | null) {
  return { state: 'fresh' as const, value }
}

function stale(value: number | boolean) {
  return { state: 'stale' as const, value, reason: 'offline' }
}

describe('aggregate reducers', () => {
  it('means only the fresh finite numbers and counts the rest', () => {
    const outcome = evaluateAggregate({
      reducer: 'mean',
      publish: 'value',
      empty: 'null',
      members: [
        fresh(10),
        stale(99),
        fresh(null),
        { state: 'unavailable', fatal: false, reason: 'unread' },
        fresh(20),
      ],
    })
    expect(outcome).toEqual({
      kind: 'value',
      value: 15,
      counts: { included: 2, excluded: 3, total: 5 },
    })
  })

  it('is null, not 0, when every member is offline, and still counts them', () => {
    const outcome = evaluateAggregate({
      reducer: 'mean',
      publish: 'value',
      empty: 'null',
      members: [stale(1), stale(2), { state: 'unavailable', fatal: false }],
    })
    expect(outcome.kind).toBe('value')
    expect(outcome.kind === 'value' ? outcome.value : 0).toBeNull()
    expect(outcome.counts).toEqual({ included: 0, excluded: 3, total: 3 })
  })

  it('publishes the counts even when the value is empty', () => {
    const outcome = evaluateAggregate({
      reducer: 'mean',
      publish: 'excluded',
      empty: 'null',
      members: [stale(1), fresh(4)],
    })
    expect(outcome).toMatchObject({
      kind: 'value',
      value: 1,
      counts: { included: 1, excluded: 1, total: 2 },
    })
  })

  it('takes the mean of the two middle values for an even median', () => {
    const outcome = evaluateAggregate({
      reducer: 'median',
      publish: 'value',
      empty: 'null',
      members: [fresh(1), fresh(7), fresh(3), fresh(5)],
    })
    expect(outcome).toMatchObject({ kind: 'value', value: 4 })
  })

  it('does not read an unknown binary member as false', () => {
    const anyOn = evaluateAggregate({
      reducer: 'any',
      publish: 'value',
      empty: 'offline',
      members: [fresh(true), stale(false), { state: 'unavailable', fatal: false }],
    })
    const allOn = evaluateAggregate({
      reducer: 'all',
      publish: 'value',
      empty: 'offline',
      members: [fresh(false), stale(true)],
    })
    const none = evaluateAggregate({
      reducer: 'any',
      publish: 'value',
      empty: 'offline',
      members: [stale(true), { state: 'unavailable', fatal: false }],
    })
    expect(anyOn).toMatchObject({
      kind: 'value',
      value: true,
      counts: { included: 1, excluded: 2, total: 3 },
    })
    expect(allOn).toMatchObject({
      kind: 'value',
      value: false,
      counts: { included: 1, excluded: 1, total: 2 },
    })
    expect(none.kind).toBe('unavailable')
    expect(none.kind === 'unavailable' ? none.fatal : true).toBe(false)
  })

  it('fails the whole field when a member is gone', () => {
    const outcome = evaluateAggregate({
      reducer: 'sum',
      publish: 'value',
      empty: 'omit',
      members: [fresh(4), { state: 'unavailable', fatal: true, reason: 'gone' }],
    })
    expect(outcome).toMatchObject({ kind: 'unavailable', fatal: true })
  })
})

describe('template compile and save', () => {
  it('declares one template per base reading', () => {
    expect(GROUP_TEMPLATES.map((row) => row.id)).toEqual([...GROUP_TEMPLATE_IDS])
    expect(groupTemplate('temperature')?.aggregates).toEqual([
      'mean',
      'median',
      'min',
      'max',
      'sum',
    ])
    expect(groupTemplate('motion')?.aggregates).toEqual(['any', 'all'])
  })

  it('validates every catalog row as a new device', () => {
    for (const template of GROUP_TEMPLATES) {
      const field = template.accept[0]
      expect(field, template.id).toBeDefined()
      if (field === undefined) continue
      const base = group(template.id, template.defaultAggregate, [
        member(1, field.cap, field.fieldPath),
      ])
      const compiled = compileHelper(
        template.family === 'actuator' ? { ...base, active: 'at-least-one' } : base,
      )
      expect(compiled.ok, template.id).toBe(true)
      if (!compiled.ok) continue
      const quantity = template.quantity === 'device' ? 'power' : template.quantity
      const judged = validateComposition(
        compiled.composition,
        context(compiled.composition, quantity, template.memberDeviceType),
      )
      expect(judged.problems, template.id).toEqual([])
    }
  })

  it('compiles a temperature group and reads back as the same spec', () => {
    const spec = group('temperature', 'mean', [
      member(1, 'temperature-sensor', 'celsius'),
      member(2, 'temperature-sensor', 'celsius'),
    ])
    const compiled = compileHelper(spec)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const stored = CompositionSchema.parse(compiled.composition)
    expect(stored.helper).toEqual(spec)
    expect(stored.target).toEqual({
      kind: 'new',
      type: DeviceType.Sensor,
      role: DeviceRole.TemperatureSensor,
    })
    const again = compileHelper(spec)
    expect(
      again.ok && JSON.stringify(again.composition.features) === JSON.stringify(stored.features),
    ).toBe(true)
    expect(validateComposition(stored, context(stored, 'temperature')).problems).toEqual([])
  })

  it('compiles seventeen members, past the expression call cap', () => {
    const members = Array.from({ length: 17 }, (_, index) =>
      member(index + 1, 'temperature-sensor', 'celsius'),
    )
    const compiled = compileHelper(group('temperature', 'mean', members))
    expect(compiled.ok).toBe(true)
  })

  it('compiles a motion group whose isDetected is a slice answer', () => {
    const spec = group('motion', 'any', [
      member(1, 'motion', 'detected'),
      member(2, 'motion', 'detected'),
    ])
    const compiled = compileHelper(spec)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const problems = validateComposition(
      compiled.composition,
      context(compiled.composition, 'temperature'),
    )
    expect(problems.problems.map((item) => item.code)).not.toContain('has-commands')
    expect(problems.problems).toEqual([])
  })

  it('refuses a numeric group whose members mix quantities', () => {
    const spec = group('numeric', 'mean', [
      member(1, 'numeric-sensor', 'value'),
      member(2, 'numeric-sensor', 'value'),
    ])
    const compiled = compileHelper(spec)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const facts = factMap(compiled.composition, {
      1: { deviceType: DeviceType.Sensor, quantity: 'power' },
      2: { deviceType: DeviceType.Sensor, quantity: 'energy' },
    })
    expect(helperSaveProblems(compiled.composition, facts).map((item) => item.code)).toContain(
      'mixed-quantity',
    )
  })

  it('accepts one quantity, and a typed template whose members did not report one', () => {
    const numeric = compileHelper(
      group('numeric', 'sum', [
        member(1, 'numeric-sensor', 'value'),
        member(2, 'numeric-sensor', 'value'),
      ]),
    )
    const temperature = compileHelper(
      group('temperature', 'min', [member(1, 'temperature-sensor', 'celsius')]),
    )
    expect(numeric.ok && temperature.ok).toBe(true)
    if (!numeric.ok || !temperature.ok) return
    const same = factMap(numeric.composition, {
      1: { deviceType: DeviceType.Sensor, quantity: 'power' },
      2: { deviceType: DeviceType.Sensor, quantity: 'power' },
    })
    expect(helperSaveProblems(numeric.composition, same)).toEqual([])
    expect(helperSaveProblems(temperature.composition, new Map())).toEqual([])
  })

  it('refuses a temperature member that reports another quantity', () => {
    const compiled = compileHelper(
      group('temperature', 'mean', [member(1, 'temperature-sensor', 'celsius')]),
    )
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const facts = factMap(compiled.composition, {
      1: { deviceType: DeviceType.Sensor, quantity: 'power' },
    })
    expect(helperSaveProblems(compiled.composition, facts).map((item) => item.code)).toEqual([
      'mixed-quantity',
    ])
  })

  it('refuses features that are not the compiled template', () => {
    const compiled = compileHelper(
      group('humidity', 'mean', [member(1, 'humidity-sensor', 'percent')]),
    )
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const tampered: Composition = {
      ...compiled.composition,
      features: compiled.composition.features.slice(0, 1),
    }
    expect(helperSaveProblems(tampered, new Map()).map((item) => item.code)).toEqual([
      'helper-mismatch',
    ])
  })

  it('asks the source selector for members of one device type', () => {
    const template = groupTemplate('power')
    expect(template).not.toBeNull()
    if (template === null) return
    expect(sourcePickForTemplate(template)).toMatchObject({
      purpose: 'member',
      multiple: true,
      max: 64,
      deviceTypes: [DeviceType.Sensor],
      accept: [{ cap: 'power-meter', fieldPath: 'watts', valueKind: 'number' }],
    })
  })
})

describe('a free expression is not a helper', () => {
  const room = roomCompositionExample({
    temperatureSources: ROOM_EXAMPLE_TEMPERATURE_SOURCES,
    motionSources: ROOM_EXAMPLE_MOTION_SOURCES,
    occupancyWindowMs: ROOM_OCCUPANCY_WINDOW_MS,
  })
  const [t1, t2, t3] = ROOM_EXAMPLE_TEMPERATURE_SOURCES

  it('still averages a stale sensor into the room temperature', () => {
    const feature = room.features.find((item) => item.cap === 'temperature-sensor')
    const source = feature?.kind === 'fields' ? feature.fields.celsius : undefined
    expect(source?.kind).toBe('expression')
    if (source === undefined || t1 === undefined || t2 === undefined || t3 === undefined) return
    const reading = (value: SourceReading, item: CompositionSourceRef) =>
      [
        compositionReadKey({ source: item, cap: 'temperature-sensor', fieldPath: 'celsius' }),
        value,
      ] as const
    const outcome = evaluateCompositionField({
      source,
      now: 1_000_000,
      read: (item) => {
        const table = new Map<string, SourceReading>([
          reading({ state: 'fresh', value: 21 }, t1),
          reading({ state: 'stale', value: 21.5, reason: 'offline' }, t2),
          reading({ state: 'fresh', value: 21.4 }, t3),
        ])
        return (
          table.get(compositionReadKey(item)) ?? {
            state: 'unavailable',
            fatal: false,
            reason: 'missing',
          }
        )
      },
    })
    expect(outcome.state).toBe('stale')
    expect(outcome.state === 'stale' ? outcome.value : null).toBe(21.3)
    expect(helperSaveProblems(room, new Map())).toEqual([])
  })
})

function context(
  composition: Composition,
  quantity: ReadingQuantity,
  deviceType: DeviceType = DeviceType.Sensor,
): ValidateCompositionContext {
  const sources = new Map<string, CompositionSourceDescription>()
  const members =
    composition.helper === undefined
      ? []
      : composition.helper.kind === 'group'
        ? composition.helper.members
        : [composition.helper.member]
  for (const [index, item] of members.entries()) {
    sources.set(compositionSourceKey(item.source), {
      kind: 'found',
      deviceId: 4000 + index,
      caps: new Set([item.cap]),
      deviceType,
      quantity,
    })
  }
  return { lookupCap, sources, self: null, blockId: null, target: null, peers: [] }
}

function factMap(
  composition: Composition,
  bySensor: Readonly<Record<number, HelperMemberFact>>,
): ReadonlyMap<string, HelperMemberFact> {
  const facts = new Map<string, HelperMemberFact>()
  const members =
    composition.helper === undefined
      ? []
      : composition.helper.kind === 'group'
        ? composition.helper.members
        : [composition.helper.member]
  for (const item of members) {
    const n = Number(item.source.stableId.replace('sensor-', ''))
    const fact = bySensor[n]
    if (fact !== undefined) facts.set(compositionSourceKey(item.source), fact)
  }
  return facts
}
