import { describe, expect, it } from 'vitest'
import { timedRunCapability, timedRunLimitOf } from '../../capabilities/timed-run.cap.js'
import {
  canonicalStoredDeviceType,
  capAppliesToDeviceKind,
  climateRoleOf,
  isAirConditioner,
  isSwitchLight,
} from '../device-kind.js'
import { DeviceRole, DeviceType } from '../device-type.js'
import { resolveDeviceControlKind } from '../device-control-resolution.js'
import { resolveHeroLayout } from '../hero/hero-layout.js'
import { resolveHeroLook } from '../hero/hero-look.js'
import { resolveHeroSceneId } from '../hero/hero-scene.js'

// D1033 — a type is a set of controls; devices with the same controls differ by role.
describe('device kind (D1033)', () => {
  describe('timed-run is offered by type AND role', () => {
    it('a switch with the heater role has the heater limit', () => {
      expect(timedRunLimitOf(DeviceType.Switch, DeviceRole.SwitchHeater)).toEqual(
        expect.objectContaining({ actuator: 'switch', unit: 'min', maxSeconds: 180 * 60 }),
      )
      expect(timedRunLimitOf(DeviceType.Switch, DeviceRole.SwitchHeater)?.quickRunDefault).toBe(30)
    })

    it('a plain switch, an outlet and a role-less switch have none', () => {
      expect(timedRunLimitOf(DeviceType.Switch, null)).toBeNull()
      expect(timedRunLimitOf(DeviceType.Switch, DeviceRole.Outlet)).toBeNull()
    })

    it('a pet fountain keeps its limit whatever its role', () => {
      expect(timedRunLimitOf(DeviceType.PetFountain, null)?.actuator).toBe('pet-fountain')
    })

    it('the cap binds to a heater switch, not to a plain one', () => {
      expect(
        capAppliesToDeviceKind(timedRunCapability, DeviceType.Switch, DeviceRole.SwitchHeater),
      ).toBe(true)
      expect(capAppliesToDeviceKind(timedRunCapability, DeviceType.Switch, null)).toBe(false)
      expect(capAppliesToDeviceKind(timedRunCapability, DeviceType.Switch, 'unknown-role')).toBe(
        false,
      )
      expect(capAppliesToDeviceKind(timedRunCapability, DeviceType.PetFountain, null)).toBe(true)
      expect(capAppliesToDeviceKind(timedRunCapability, DeviceType.Light, null)).toBe(false)
    })

    it('a gate without roles is the type gate, and an unknown type stays fail-open', () => {
      expect(
        capAppliesToDeviceKind({ deviceTypes: [DeviceType.Switch] }, DeviceType.Switch, null),
      ).toBe(true)
      expect(capAppliesToDeviceKind({}, DeviceType.Switch, null)).toBe(true)
      expect(capAppliesToDeviceKind({ deviceTypes: [DeviceType.Switch] }, undefined, null)).toBe(
        true,
      )
    })
  })

  describe('a switch with the fan role', () => {
    it('is drawn as a fan', () => {
      expect(resolveHeroSceneId(DeviceRole.SwitchFan, DeviceType.Switch)).toBe('fan')
      expect(resolveHeroLook(DeviceRole.SwitchFan, DeviceType.Switch, 'on')).toEqual(
        resolveHeroLook(null, DeviceType.Fan, 'on'),
      )
      expect(resolveHeroSceneId(null, DeviceType.Switch)).not.toBe('fan')
    })

    it("keeps the switch's on/off: no fan speed row, the switch control, no timed run", () => {
      expect(resolveHeroLayout(DeviceType.Switch, DeviceRole.SwitchFan)).toEqual(
        resolveHeroLayout(DeviceType.Switch, null),
      )
      expect(resolveHeroLayout(DeviceType.Switch, DeviceRole.SwitchFan).rows).not.toContain('fan')
      expect(resolveDeviceControlKind(DeviceType.Switch, DeviceRole.SwitchFan)).toBe(
        resolveDeviceControlKind(DeviceType.Switch, null),
      )
      expect(timedRunLimitOf(DeviceType.Switch, DeviceRole.SwitchFan)).toBeNull()
    })
  })

  describe('a switch with the light role (switch-light)', () => {
    it('is drawn as a light: the bulb scene and the light look, on and off', () => {
      expect(resolveHeroSceneId(DeviceRole.SwitchLight, DeviceType.Switch)).toBe('light')
      for (const state of ['on', 'off'] as const) {
        expect(resolveHeroLook(DeviceRole.SwitchLight, DeviceType.Switch, state)).toEqual(
          resolveHeroLook(null, DeviceType.Light, state),
        )
      }
    })

    it("keeps the switch's on/off only: no brightness or colour row, the switch control", () => {
      expect(resolveHeroLayout(DeviceType.Switch, DeviceRole.SwitchLight)).toEqual(
        resolveHeroLayout(DeviceType.Switch, null),
      )
      expect(resolveHeroLayout(DeviceType.Switch, DeviceRole.SwitchLight).rows).not.toContain(
        'brightness',
      )
      expect(resolveDeviceControlKind(DeviceType.Switch, DeviceRole.SwitchLight)).toBe(
        resolveDeviceControlKind(DeviceType.Switch, null),
      )
      expect(timedRunLimitOf(DeviceType.Switch, DeviceRole.SwitchLight)).toBeNull()
    })

    it('is told apart by one accessor: a switch with the role, nothing else', () => {
      expect(isSwitchLight(DeviceType.Switch, DeviceRole.SwitchLight)).toBe(true)
      expect(isSwitchLight(DeviceType.Switch, DeviceRole.Outlet)).toBe(false)
      expect(isSwitchLight(DeviceType.Switch, null)).toBe(false)
      expect(isSwitchLight(DeviceType.Light, null)).toBe(false)
      expect(isSwitchLight(DeviceType.Light, DeviceRole.SwitchLight)).toBe(false)
    })
  })

  describe('the retired thermostat type', () => {
    it('reads as climate', () => {
      expect(canonicalStoredDeviceType('thermostat')).toBe(DeviceType.Climate)
      expect(canonicalStoredDeviceType(DeviceType.Climate)).toBe(DeviceType.Climate)
    })

    it('a retired heater is NOT aliased: it stays an unknown type, rendered generic', () => {
      expect(canonicalStoredDeviceType('heater')).toBe('heater')
    })
  })

  describe('climate roles', () => {
    it('a climate device without a role is a thermostat', () => {
      expect(climateRoleOf(null)).toBe(DeviceRole.ClimateThermostat)
      expect(climateRoleOf(DeviceRole.ClimateHeatPumpCircuit)).toBe(
        DeviceRole.ClimateHeatPumpCircuit,
      )
    })

    it('only the AC role makes an air conditioner', () => {
      expect(isAirConditioner(DeviceType.Climate, DeviceRole.ClimateAc)).toBe(true)
      expect(isAirConditioner(DeviceType.Climate, null)).toBe(false)
      expect(isAirConditioner(DeviceType.Climate, DeviceRole.ClimateHeatPumpCircuit)).toBe(false)
      expect(isAirConditioner(DeviceType.Switch, DeviceRole.ClimateAc)).toBe(false)
    })
  })
})
