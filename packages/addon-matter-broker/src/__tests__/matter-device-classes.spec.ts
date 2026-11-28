/**
 * Device classes a Matter endpoint maps onto, chosen from the Descriptor device
 * type where the cluster alone is ambiguous, and the attribute decode behind
 * each. Every case fails on the mapping/decoder that existed before.
 */
import { DeviceType } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { decodeMatterAttribute, MatterAttributeId } from '../matter-attr-decode.js'
import {
  MatterClusterId,
  MatterDeviceTypeId,
  mapMatterEndpointToCamStack,
} from '../matter-cluster-mapping.js'

const DOOR_STATE = `${MatterClusterId.DoorLock}:3`
const SMOKE_STATE = `${MatterClusterId.SmokeCoAlarm}:1`
const CO_STATE = `${MatterClusterId.SmokeCoAlarm}:2`

describe('mapping from the Descriptor fixture', () => {
  it('BooleanState on a water-leak detector is flood, never a door contact', () => {
    const leak = mapMatterEndpointToCamStack([MatterClusterId.BooleanState], {
      deviceTypeIds: [MatterDeviceTypeId.WaterLeakDetector],
    })
    expect(leak).toEqual({ deviceType: DeviceType.Sensor, capabilities: ['flood'] })
    const rain = mapMatterEndpointToCamStack([MatterClusterId.BooleanState], {
      deviceTypeIds: [MatterDeviceTypeId.RainSensor],
    })
    expect(rain.capabilities).toEqual(['flood'])
  })

  it('BooleanState on a contact sensor (or with no Descriptor) stays a contact', () => {
    expect(
      mapMatterEndpointToCamStack([MatterClusterId.BooleanState], {
        deviceTypeIds: [MatterDeviceTypeId.ContactSensor],
      }).capabilities,
    ).toEqual(['contact'])
    expect(mapMatterEndpointToCamStack([MatterClusterId.BooleanState]).capabilities).toEqual([
      'contact',
    ])
  })

  it('a lock with a door sensor gains the door contact; one without does not invent it', () => {
    const withSensor = mapMatterEndpointToCamStack(
      [MatterClusterId.DoorLock, MatterClusterId.PowerSource],
      { attributes: [DOOR_STATE] },
    )
    expect(withSensor.deviceType).toBe(DeviceType.Lock)
    expect(withSensor.capabilities).toEqual(['lock-control', 'contact', 'event-emitter', 'battery'])
    const without = mapMatterEndpointToCamStack([MatterClusterId.DoorLock], { attributes: [] })
    expect(without.capabilities).toEqual(['lock-control', 'event-emitter'])
  })

  it('a dimmable plug is a switch device, a dimmable light stays a light', () => {
    const clusters = [MatterClusterId.OnOff, MatterClusterId.LevelControl]
    expect(
      mapMatterEndpointToCamStack(clusters, {
        deviceTypeIds: [MatterDeviceTypeId.DimmablePlugInUnit],
      }).deviceType,
    ).toBe(DeviceType.Switch)
    expect(mapMatterEndpointToCamStack(clusters, { deviceTypeIds: [0x0101] }).deviceType).toBe(
      DeviceType.Light,
    )
  })

  it('Smoke/CO alarm registers only the detectors the unit has', () => {
    const both = mapMatterEndpointToCamStack([MatterClusterId.SmokeCoAlarm], {
      attributes: [SMOKE_STATE, CO_STATE],
    })
    expect(both).toEqual({
      deviceType: DeviceType.Sensor,
      capabilities: ['smoke', 'carbon-monoxide'],
    })
    expect(
      mapMatterEndpointToCamStack([MatterClusterId.SmokeCoAlarm], { attributes: [SMOKE_STATE] })
        .capabilities,
    ).toEqual(['smoke'])
  })

  it('valve, air quality concentrations and a generic switch (button + events)', () => {
    expect(mapMatterEndpointToCamStack([MatterClusterId.ValveConfigurationAndControl])).toEqual({
      deviceType: DeviceType.Valve,
      capabilities: ['valve'],
    })
    const air = mapMatterEndpointToCamStack([
      MatterClusterId.CarbonDioxideConcentration,
      MatterClusterId.Pm25Concentration,
      MatterClusterId.Pm10Concentration,
      MatterClusterId.TvocConcentration,
    ])
    expect(air).toEqual({ deviceType: DeviceType.Sensor, capabilities: ['air-quality-sensor'] })
    expect(mapMatterEndpointToCamStack([MatterClusterId.Switch])).toEqual({
      deviceType: DeviceType.Button,
      capabilities: ['button', 'event-emitter'],
    })
  })
})

describe('attribute decode', () => {
  const decode = (clusterId: number, attributeId: number, value: unknown) =>
    decodeMatterAttribute({ clusterId, attributeId, value })

  it('LockState and DoorState: not-fully-locked is not "locked"; the door feeds the contact', () => {
    expect(decode(MatterClusterId.DoorLock, MatterAttributeId.LockState, 1)?.patch).toMatchObject({
      state: 'locked',
    })
    expect(decode(MatterClusterId.DoorLock, MatterAttributeId.LockState, 0)?.patch).toMatchObject({
      state: 'jammed',
    })
    const open = decode(MatterClusterId.DoorLock, MatterAttributeId.DoorState, 0)
    expect(open?.cap).toBe('contact')
    expect(open?.patch).toMatchObject({ entryOpen: true })
    const closed = decode(MatterClusterId.DoorLock, MatterAttributeId.DoorState, 1)
    expect(closed?.patch).toMatchObject({ entryOpen: false })
    // DoorJammed is the bolt failing, not the door position.
    expect(decode(MatterClusterId.DoorLock, MatterAttributeId.DoorState, 2)?.cap).toBe(
      'lock-control',
    )
  })

  it('BooleanState is a detection for a leak endpoint and "closed" for a contact', () => {
    const leak = decodeMatterAttribute({
      clusterId: MatterClusterId.BooleanState,
      attributeId: MatterAttributeId.StateValue,
      value: true,
      booleanState: 'flood',
    })
    expect(leak).toMatchObject({ cap: 'flood', patch: { flooded: true } })
    const contact = decode(MatterClusterId.BooleanState, MatterAttributeId.StateValue, true)
    expect(contact).toMatchObject({ cap: 'contact', patch: { entryOpen: false } })
  })

  it('battery: percent, the level-only enum fallback, and the real charge-state id', () => {
    const percent = decode(MatterClusterId.PowerSource, MatterAttributeId.BatPercentRemaining, 150)
    expect(percent?.patch).toMatchObject({ level: 75, binary: false })
    const warning = decode(MatterClusterId.PowerSource, MatterAttributeId.BatChargeLevel, 1)
    expect(warning).toMatchObject({
      cap: 'battery',
      detail: 'battery-level-only',
      patch: { level: 20, binary: true },
    })
    expect(MatterAttributeId.BatChargeLevel).toBe(0x0e)
    expect(MatterAttributeId.BatChargeState).toBe(0x1a)
    // The cap's `charging` enum is dc | solar | none | unknown — never 'in'.
    const charging = decode(MatterClusterId.PowerSource, MatterAttributeId.BatChargeState, 1)
    expect(charging?.patch).toMatchObject({ charging: 'dc' })
    expect(
      decode(MatterClusterId.PowerSource, MatterAttributeId.BatChargeState, 3)?.patch,
    ).toMatchObject({ charging: 'none' })
  })

  it('smoke and CO alarm states: anything but Normal is detected', () => {
    expect(decode(MatterClusterId.SmokeCoAlarm, MatterAttributeId.SmokeState, 0)).toMatchObject({
      cap: 'smoke',
      patch: { detected: false },
    })
    expect(decode(MatterClusterId.SmokeCoAlarm, MatterAttributeId.SmokeState, 2)).toMatchObject({
      cap: 'smoke',
      patch: { detected: true },
    })
    expect(decode(MatterClusterId.SmokeCoAlarm, MatterAttributeId.CoState, 1)).toMatchObject({
      cap: 'carbon-monoxide',
      patch: { detected: true },
    })
  })

  it('valve state and level; transitioning leaves the slice to the command that moved it', () => {
    const v = MatterClusterId.ValveConfigurationAndControl
    expect(decode(v, MatterAttributeId.ValveCurrentState, 1)?.patch).toMatchObject({
      state: 'open',
    })
    expect(decode(v, MatterAttributeId.ValveCurrentState, 0)?.patch).toMatchObject({
      state: 'closed',
    })
    expect(decode(v, MatterAttributeId.ValveCurrentState, 2)?.patch).toEqual({})
    expect(decode(v, MatterAttributeId.ValveCurrentLevel, 40)?.patch).toMatchObject({
      position: 40,
    })
  })

  it('air quality concentrations land on the right field; "not measured" is no value', () => {
    expect(
      decode(MatterClusterId.CarbonDioxideConcentration, MatterAttributeId.MeasuredValue, 612),
    ).toMatchObject({ cap: 'air-quality-sensor', patch: { co2: 612 } })
    expect(
      decode(MatterClusterId.Pm25Concentration, MatterAttributeId.MeasuredValue, 8.5)?.patch,
    ).toMatchObject({ pm25: 8.5 })
    expect(
      decode(MatterClusterId.Pm10Concentration, MatterAttributeId.MeasuredValue, 14)?.patch,
    ).toMatchObject({ pm10: 14 })
    expect(
      decode(MatterClusterId.TvocConcentration, MatterAttributeId.MeasuredValue, 220)?.patch,
    ).toMatchObject({ voc: 220 })
    expect(
      decode(MatterClusterId.Pm25Concentration, MatterAttributeId.MeasuredValue, null),
    ).toBeNull()
  })
})
