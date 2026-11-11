import {
  CLIMATE_ROLES,
  DeviceRole,
  DeviceType,
  TIMED_RUN_HEATER_LIMIT,
  timedRunLimitOf,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { climateRoleOf } from '../connected/climate-model'
import { connectedCardKindOf } from '../connected/ConnectedDeviceCard'
import { defaultUiText } from '../../../contexts/ui-text'
import { coarseDuration } from '../connected/coarse-duration'

describe('connectedCardKindOf — a card only for what the device IS (type + role) and binds', () => {
  it('draws a switch that binds the switch cap as a plug', () => {
    expect(connectedCardKindOf(DeviceType.Switch, null, ['switch', 'power-meter'])).toBe('plug')
    expect(connectedCardKindOf(DeviceType.Switch, null, ['power-meter'])).toBeNull()
  })

  it('draws a heater (switch + switch-heater) as a plug, with its timed run', () => {
    expect(
      connectedCardKindOf(DeviceType.Switch, DeviceRole.SwitchHeater, ['switch', 'timed-run']),
    ).toBe('plug')
    expect(timedRunLimitOf(DeviceType.Switch, DeviceRole.SwitchHeater)).toBe(TIMED_RUN_HEATER_LIMIT)
    expect(timedRunLimitOf(DeviceType.Switch, null)).toBeNull()
  })

  it('draws every climate role that binds climate-control as climate', () => {
    for (const role of CLIMATE_ROLES)
      expect(connectedCardKindOf(DeviceType.Climate, role, ['climate-control'])).toBe('climate')
    expect(connectedCardKindOf(DeviceType.Climate, null, ['climate-control'])).toBe('climate')
    expect(connectedCardKindOf(DeviceType.Climate, null, ['switch'])).toBeNull()
  })

  it('leaves every other type to the hero it already has', () => {
    expect(connectedCardKindOf(DeviceType.Siren, null, ['switch'])).toBeNull()
    expect(connectedCardKindOf(DeviceType.Light, null, ['switch'])).toBeNull()
    expect(connectedCardKindOf(null, null, ['switch', 'climate-control'])).toBeNull()
  })
})

describe('climateRoleOf — the card reads the device ROLE', () => {
  it('maps every climate role to its card role', () => {
    expect(climateRoleOf(DeviceRole.ClimateThermostat, false)).toBe('thermostat')
    expect(climateRoleOf(DeviceRole.ClimateAc, false)).toBe('ac')
    expect(climateRoleOf(DeviceRole.ClimateFloor, false)).toBe('floor')
    expect(climateRoleOf(DeviceRole.ClimateRadiator, false)).toBe('radiator')
    expect(climateRoleOf(DeviceRole.ClimateHeater, false)).toBe('heater')
    expect(climateRoleOf(DeviceRole.ClimateHeatPumpCircuit, false)).toBe('hpcircuit')
  })

  it('a climate device with no role is a thermostat, and a bound valve makes it a radiator', () => {
    expect(climateRoleOf(null, false)).toBe('thermostat')
    expect(climateRoleOf(null, true)).toBe('radiator')
    expect(climateRoleOf(DeviceRole.ClimateThermostat, true)).toBe('radiator')
    expect(climateRoleOf(DeviceRole.ClimateFloor, true)).toBe('floor')
  })
})

describe('coarseDuration', () => {
  const t = defaultUiText

  it('names the largest whole unit and never says zero minutes', () => {
    expect(coarseDuration(10_000, t)).toBe('1 min')
    expect(coarseDuration(45 * 60_000, t)).toBe('45 min')
    expect(coarseDuration(2.5 * 3_600_000, t)).toBe('2 h')
    expect(coarseDuration(3 * 86_400_000, t)).toBe('3 d')
  })
})
