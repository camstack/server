/**
 * A temperature or humidity group also takes thermostats and climate devices,
 * read through `climate-control` (D944 addendum). Each member is read from the
 * field it actually satisfies; an unknown climate reading is left out.
 */
import { describe, expect, it } from 'vitest'
import { DeviceType } from '../../../device/device-type.js'
import {
  compositionReadKey,
  compositionSourceKey,
  type CompositionSourceRef,
} from '../../composition.js'
import { evaluateCompositionField, type SourceReading } from '../../evaluate-field.js'
import { groupTemplate } from '../catalog.js'
import { compileHelper } from '../compile.js'
import { helperSaveProblems, type HelperMemberFact } from '../save.js'
import { sourcePickForTemplate } from '../source-pick.js'
import type { GroupHelperSpec, HelperMember } from '../spec.js'

const SENSOR: CompositionSourceRef = { addonId: 'addon-a', stableId: 'sensor-1' }
const CLIMATE: CompositionSourceRef = { addonId: 'addon-b', stableId: 'climate-1' }

const sensorMember: HelperMember = {
  source: SENSOR,
  cap: 'temperature-sensor',
  fieldPath: 'temperature',
}
const climateMember: HelperMember = {
  source: CLIMATE,
  cap: 'climate-control',
  fieldPath: 'currentTemp',
}

function spec(members: readonly HelperMember[]): GroupHelperSpec {
  return { kind: 'group', templateId: 'temperature', aggregate: 'mean', members: [...members] }
}

function meanOf(climate: SourceReading): number | null {
  const compiled = compileHelper(spec([sensorMember, climateMember]))
  if (!compiled.ok) throw new Error('did not compile')
  const feature = compiled.composition.features[0]
  const source = feature?.kind === 'fields' ? feature.fields.temperature : undefined
  if (source === undefined) throw new Error('no temperature field')
  const table = new Map<string, SourceReading>([
    [compositionReadKey(sensorMember), { state: 'fresh', value: 20 }],
    [compositionReadKey(climateMember), climate],
  ])
  const outcome = evaluateCompositionField({
    source,
    now: 1_000_000,
    read: (item) =>
      table.get(compositionReadKey(item)) ?? {
        state: 'unavailable',
        fatal: false,
        reason: 'wrong field',
      },
  })
  if (outcome.state === 'unavailable') throw new Error('unavailable')
  return typeof outcome.value === 'number' ? outcome.value : null
}

describe('a group takes climate devices through climate-control', () => {
  it('lists the climate field next to the sensor field, sensor first, for both readings', () => {
    for (const [id, cap, field] of [
      ['temperature', 'temperature-sensor', 'currentTemp'],
      ['humidity', 'humidity-sensor', 'currentHumidity'],
    ] as const) {
      const template = groupTemplate(id)
      expect(template?.memberDeviceTypes).toEqual([
        DeviceType.Sensor,
        DeviceType.Thermostat,
        DeviceType.Climate,
      ])
      expect(template?.accept.map((a) => `${a.cap}.${a.fieldPath}`)).toEqual([
        `${cap}.${id}`,
        `climate-control.${field}`,
      ])
    }
  })

  it('the selector request offers the climate device types and both fields', () => {
    const template = groupTemplate('temperature')
    if (template === null) throw new Error('no template')
    const request = sourcePickForTemplate(template)
    expect(request.deviceTypes).toContain(DeviceType.Climate)
    expect(request.accept.map((a) => a.cap)).toEqual(['temperature-sensor', 'climate-control'])
    expect(request.fieldChoice).toBe('first-match')
  })

  it('compiles a mixed group, each read keeping its own cap and field', () => {
    const compiled = compileHelper(spec([sensorMember, climateMember]))
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const feature = compiled.composition.features[0]
    const source = feature?.kind === 'fields' ? feature.fields.temperature : undefined
    expect(
      source?.kind === 'aggregate' ? source.reads.map((r) => `${r.cap}.${r.fieldPath}`) : [],
    ).toEqual(['temperature-sensor.temperature', 'climate-control.currentTemp'])
  })

  it('still refuses a field no entry lists', () => {
    const wrong = compileHelper(
      spec([{ source: CLIMATE, cap: 'climate-control', fieldPath: 'targetTemp' }]),
    )
    expect(wrong.ok).toBe(false)
  })

  it('means a sensor at 20 and a climate device at 15.4 as 17.7', () => {
    expect(meanOf({ state: 'fresh', value: 15.4 })).toBeCloseTo(17.7, 5)
  })

  it('leaves an unknown climate reading out, never reads it as 0', () => {
    expect(meanOf({ state: 'fresh', value: null })).toBe(20)
  })

  it('saves a climate member whose reading is a temperature, refuses one that is not', () => {
    const compiled = compileHelper(spec([sensorMember, climateMember]))
    if (!compiled.ok) throw new Error('did not compile')
    const facts = (quantity: HelperMemberFact['quantity']) =>
      new Map<string, HelperMemberFact>([
        [compositionSourceKey(SENSOR), { deviceType: DeviceType.Sensor, quantity: 'temperature' }],
        [compositionSourceKey(CLIMATE), { deviceType: DeviceType.Climate, quantity }],
      ])
    expect(helperSaveProblems(compiled.composition, facts('temperature'))).toEqual([])
    expect(helperSaveProblems(compiled.composition, facts('humidity')).map((p) => p.code)).toEqual([
      'mixed-quantity',
    ])
  })
})
