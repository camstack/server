import { describe, expect, it } from 'vitest'
import { timedRunCapability, timedRunLimitOf } from '../../capabilities/timed-run.cap.js'
import {
  canonicalStoredDeviceType,
  capAdmitsDevice,
  climateRoleOf,
  isAirConditioner,
  isTv,
  isVehicleClimate,
  isVehicleLock,
  isOutlet,
  isSwitchFan,
  isSwitchHeater,
  isSwitchLight,
} from '../device-kind.js'
import { DeviceRole, DeviceType } from '../device-type.js'
import { resolveDeviceControlKind } from '../device-control-resolution.js'
import { resolveHeroLayout } from '../hero/hero-layout.js'
import { resolveHeroLook } from '../hero/hero-look.js'
import { resolveHeroSceneId } from '../hero/hero-scene.js'

// D1033 — a type is a set of controls; devices with the same controls differ by role.
describe('device kind (D1033)', () => {
  describe('timed-run is offered on every device that has a switch (D1097)', () => {
    it('every switch kind has the one limit of switchRunLimitOf, in its own unit', () => {
      expect(timedRunLimitOf(DeviceType.Switch, DeviceRole.SwitchHeater)).toEqual({
        actuator: 'switch',
        unit: 'min',
        maxSeconds: 180 * 60,
        quickRunDefault: 30,
      })
      expect(timedRunLimitOf(DeviceType.Switch, null)).toEqual({
        actuator: 'switch',
        unit: 'min',
        maxSeconds: 24 * 3600,
        quickRunDefault: 15,
      })
      expect(timedRunLimitOf(DeviceType.Light, null).actuator).toBe('switch')
      expect(timedRunLimitOf(DeviceType.Switch, DeviceRole.Siren).maxSeconds).toBe(600)
    })

    it('a pet fountain keeps its pump actuator and its seconds, whatever its role', () => {
      expect(timedRunLimitOf(DeviceType.PetFountain, null)).toEqual({
        actuator: 'pet-fountain',
        unit: 's',
        maxSeconds: 300,
        quickRunDefault: 60,
      })
    })

    it('the cap admits a pet fountain by type and any device by its switch', () => {
      const none = (): boolean => false
      const hasSwitch = (name: string): boolean => name === 'switch'
      expect(capAdmitsDevice(timedRunCapability, DeviceType.PetFountain, null, none)).toBe(true)
      expect(capAdmitsDevice(timedRunCapability, DeviceType.Switch, null, hasSwitch)).toBe(true)
      expect(capAdmitsDevice(timedRunCapability, DeviceType.Light, null, hasSwitch)).toBe(true)
      // no switch, no timed run: no phantom feature
      expect(capAdmitsDevice(timedRunCapability, DeviceType.Switch, null, none)).toBe(false)
      expect(capAdmitsDevice(timedRunCapability, DeviceType.Camera, null, none)).toBe(false)
      // an unresolved type never admits by type: only the switch does
      expect(capAdmitsDevice(timedRunCapability, undefined, null, none)).toBe(false)
      expect(capAdmitsDevice(timedRunCapability, undefined, null, hasSwitch)).toBe(true)
    })

    it('a gate without companions is the type gate, and an unknown type stays fail-open', () => {
      const none = (): boolean => false
      expect(
        capAdmitsDevice({ deviceTypes: [DeviceType.Switch] }, DeviceType.Switch, null, none),
      ).toBe(true)
      expect(capAdmitsDevice({}, DeviceType.Switch, null, none)).toBe(true)
      expect(capAdmitsDevice({ deviceTypes: [DeviceType.Switch] }, undefined, null, none)).toBe(
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
      expect(timedRunLimitOf(DeviceType.Switch, DeviceRole.SwitchFan).actuator).toBe('switch')
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
      expect(timedRunLimitOf(DeviceType.Switch, DeviceRole.SwitchLight).actuator).toBe('switch')
    })

    it('is told apart by one accessor: a switch with the role, nothing else', () => {
      expect(isSwitchLight(DeviceType.Switch, DeviceRole.SwitchLight)).toBe(true)
      expect(isSwitchLight(DeviceType.Switch, DeviceRole.Outlet)).toBe(false)
      expect(isSwitchLight(DeviceType.Switch, null)).toBe(false)
      expect(isSwitchLight(DeviceType.Light, null)).toBe(false)
      expect(isSwitchLight(DeviceType.Light, DeviceRole.SwitchLight)).toBe(false)
    })
  })

  describe('every switch sub-role has one accessor (exports read only these)', () => {
    it.each([
      ['outlet', isOutlet, DeviceRole.Outlet],
      ['switch-fan', isSwitchFan, DeviceRole.SwitchFan],
      ['switch-heater', isSwitchHeater, DeviceRole.SwitchHeater],
      ['switch-light', isSwitchLight, DeviceRole.SwitchLight],
    ] as const)('%s: a switch with that role, nothing else', (_name, accessor, role) => {
      expect(accessor(DeviceType.Switch, role)).toBe(true)
      expect(accessor(DeviceType.Switch, null)).toBe(false)
      expect(accessor(DeviceType.Switch, undefined)).toBe(false)
      expect(accessor(DeviceType.Switch, DeviceRole.BinaryHelper)).toBe(false)
      expect(accessor(DeviceType.Light, role)).toBe(false)
      expect(accessor(DeviceType.Fan, role)).toBe(false)
    })

    it('the four accessors never overlap', () => {
      const roles = [
        DeviceRole.Outlet,
        DeviceRole.SwitchFan,
        DeviceRole.SwitchHeater,
        DeviceRole.SwitchLight,
      ]
      for (const role of roles) {
        const hits = [isOutlet, isSwitchFan, isSwitchHeater, isSwitchLight].filter((accessor) =>
          accessor(DeviceType.Switch, role),
        )
        expect(hits).toHaveLength(1)
      }
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

// The vehicle and TV roles (phase 1): a role is told apart by type AND role.
describe('vehicle and TV roles', () => {
  it('a climate-vehicle is a climate role and not an air conditioner', () => {
    expect(climateRoleOf(DeviceRole.ClimateVehicle)).toBe(DeviceRole.ClimateVehicle)
    expect(isAirConditioner(DeviceType.Climate, DeviceRole.ClimateVehicle)).toBe(false)
  })

  it('isVehicleLock / isVehicleClimate / isTv hold only for the right type AND role', () => {
    expect(isVehicleLock(DeviceType.Lock, DeviceRole.LockVehicle)).toBe(true)
    expect(isVehicleLock(DeviceType.Switch, DeviceRole.LockVehicle)).toBe(false)
    expect(isVehicleLock(DeviceType.Lock, null)).toBe(false)
    expect(isVehicleClimate(DeviceType.Climate, DeviceRole.ClimateVehicle)).toBe(true)
    expect(isVehicleClimate(DeviceType.Climate, DeviceRole.ClimateThermostat)).toBe(false)
    expect(isVehicleClimate(DeviceType.Lock, DeviceRole.ClimateVehicle)).toBe(false)
    expect(isTv(DeviceType.MediaPlayer, DeviceRole.MediaPlayerTv)).toBe(true)
    expect(isTv(DeviceType.MediaPlayer, null)).toBe(false)
    expect(isTv(DeviceType.Switch, DeviceRole.MediaPlayerTv)).toBe(false)
  })

  it('a TV keeps the tv scene and a vehicle lock the lock scene (the roles inherit the type)', () => {
    expect(resolveHeroSceneId(DeviceRole.MediaPlayerTv, DeviceType.MediaPlayer)).toBe('tv')
    expect(resolveHeroSceneId(DeviceRole.LockVehicle, DeviceType.Lock)).toBe('lock')
    expect(resolveHeroSceneId(DeviceRole.ClimateVehicle, DeviceType.Climate)).toBe(
      resolveHeroSceneId(DeviceRole.ClimateThermostat, DeviceType.Climate),
    )
  })
})
