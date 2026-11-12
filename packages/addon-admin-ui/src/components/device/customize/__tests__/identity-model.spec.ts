import { DeviceRole, DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { displayWithHidden, roleOptions, rolesForDeviceType } from '../identity-model'

describe('displayWithHidden — one override object', () => {
  it('keeps every other key', () => {
    expect(displayWithHidden({ icon: 'door', label: 'Front' }, true)).toEqual({
      icon: 'door',
      label: 'Front',
      hidden: true,
    })
  })
  it('clearing the last key clears the override', () => {
    expect(displayWithHidden({ hidden: true }, false)).toBeNull()
    expect(displayWithHidden(undefined, false)).toBeNull()
  })
})

describe('roleOptions — filtered by device type', () => {
  it('offers the cover kinds on a Cover, and nothing else', () => {
    const options = roleOptions(null, DeviceType.Cover)
    expect(options).toContain(DeviceRole.CoverShutter)
    expect(options).toContain(DeviceRole.CoverWindow)
    expect(options).not.toContain(DeviceRole.Siren)
  })
  it('offers switch accessory roles on a Switch, not sensor roles', () => {
    const options = roleOptions(null, DeviceType.Switch)
    expect(options).toContain(DeviceRole.Floodlight)
    expect(options).not.toContain(DeviceRole.TemperatureSensor)
  })

  it('offers sensor roles on a Sensor, not switch roles', () => {
    const options = roleOptions(null, DeviceType.Sensor)
    expect(options).toContain(DeviceRole.TemperatureSensor)
    expect(options).not.toContain(DeviceRole.Floodlight)
  })

  // D1033 — same controls, different thing: the operator picks which one.
  it('offers the heater and fan roles on a Switch, and the climate roles on Climate', () => {
    expect(roleOptions(null, DeviceType.Switch)).toEqual(
      expect.arrayContaining([DeviceRole.SwitchHeater, DeviceRole.SwitchFan]),
    )
    expect(roleOptions(null, DeviceType.Climate)).toEqual([
      DeviceRole.ClimateThermostat,
      DeviceRole.ClimateAc,
      DeviceRole.ClimateFloor,
      DeviceRole.ClimateRadiator,
      DeviceRole.ClimateHeater,
      DeviceRole.ClimateHeatPumpCircuit,
    ])
    expect(roleOptions(null, DeviceType.Climate)).not.toContain(DeviceRole.SwitchHeater)
  })

  it('offers nothing on a Camera (role is an accessory fact)', () => {
    expect(rolesForDeviceType(DeviceType.Camera)).toEqual([])
  })

  it('keeps a stored unmatched role so the select never shows none (L5)', () => {
    expect(roleOptions('legacy-role', DeviceType.Camera)).toEqual(['legacy-role'])
    expect(roleOptions(DeviceRole.Floodlight, DeviceType.Sensor)).toContain(DeviceRole.Floodlight)
  })
})
