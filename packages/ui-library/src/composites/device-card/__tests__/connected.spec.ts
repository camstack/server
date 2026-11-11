import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { climateRoleOf } from '../connected/climate-model'
import { connectedCardKindOf } from '../connected/ConnectedDeviceCard'
import { defaultUiText } from '../../../contexts/ui-text'
import { coarseDuration } from '../connected/coarse-duration'

describe('connectedCardKindOf — a card only for what the device IS and binds', () => {
  it('draws a switch that binds the switch cap as a plug', () => {
    expect(connectedCardKindOf(DeviceType.Switch, ['switch', 'power-meter'])).toBe('plug')
    expect(connectedCardKindOf(DeviceType.Switch, ['power-meter'])).toBeNull()
  })

  it('draws a thermostat or an air conditioner that binds climate-control as climate', () => {
    expect(connectedCardKindOf(DeviceType.Thermostat, ['climate-control'])).toBe('climate')
    expect(connectedCardKindOf(DeviceType.Climate, ['climate-control'])).toBe('climate')
    expect(connectedCardKindOf(DeviceType.Climate, ['switch'])).toBeNull()
  })

  it('leaves every other type to the hero it already has', () => {
    expect(connectedCardKindOf(DeviceType.Siren, ['switch'])).toBeNull()
    expect(connectedCardKindOf(DeviceType.Light, ['switch'])).toBeNull()
    expect(connectedCardKindOf(null, ['switch', 'climate-control'])).toBeNull()
  })
})

describe('climateRoleOf', () => {
  it('reads the role from the type, and a bound valve makes it a radiator', () => {
    expect(climateRoleOf(DeviceType.Thermostat, false)).toBe('thermostat')
    expect(climateRoleOf(DeviceType.Thermostat, true)).toBe('radiator')
    expect(climateRoleOf(DeviceType.Heater, false)).toBe('heater')
    expect(climateRoleOf(DeviceType.Climate, false)).toBe('ac')
    expect(climateRoleOf(null, false)).toBe('ac')
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
