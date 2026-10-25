import { describe, it, expect } from 'vitest'
import {
  colorCapability,
  ColorStatusSchema,
  climateControlCapability,
  ClimateControlStatusSchema,
  HvacModeSchema,
} from '../index.js'
import { DeviceType } from '../device/device-type.js'

describe('HA actuator caps — Phase C1', () => {
  describe('color cap', () => {
    it('registers as singleton device-scoped command-driven cap on Light', () => {
      expect(colorCapability.name).toBe('color')
      expect(colorCapability.scope).toBe('device')
      expect(colorCapability.mode).toBe('singleton')
      expect(colorCapability.deviceTypes).toEqual([DeviceType.Light])
      expect(colorCapability.status.kind).toBe('command-driven')
    })

    it('runtimeState mirrors the status schema', () => {
      expect(colorCapability.runtimeState).toBe(ColorStatusSchema)
    })

    it('exposes setColor as a mutation requiring admin auth', () => {
      const setColor = colorCapability.methods.setColor
      expect(setColor.kind).toBe('mutation')
      expect(setColor.auth).toBe('protected')
    })

    it('declares onColorChanged event', () => {
      expect(colorCapability.events).toBeDefined()
      expect(colorCapability.events.onColorChanged).toBeDefined()
    })

    it('status schema accepts rgb mode sample', () => {
      const sample = {
        mode: 'rgb' as const,
        rgb: { r: 255, g: 128, b: 0 },
        lastChangedAt: 1,
      }
      expect(ColorStatusSchema.parse(sample)).toEqual(sample)
    })

    it('status schema accepts hsv mode sample', () => {
      const sample = {
        mode: 'hsv' as const,
        hsv: { h: 200, s: 80, v: 60 },
        lastChangedAt: 1,
      }
      expect(ColorStatusSchema.parse(sample)).toEqual(sample)
    })

    it('status schema accepts mired mode sample', () => {
      const sample = {
        mode: 'mired' as const,
        mireds: 370,
        lastChangedAt: 1,
      }
      expect(ColorStatusSchema.parse(sample)).toEqual(sample)
    })

    it('setColor input — rgb branch accepts in-range triplet', () => {
      const input = {
        deviceId: 7,
        color: { mode: 'rgb' as const, rgb: { r: 0, g: 0, b: 255 } },
      }
      expect(colorCapability.methods.setColor.input.parse(input)).toEqual(input)
    })

    it('setColor input — rgb branch rejects out-of-range channel', () => {
      expect(() =>
        colorCapability.methods.setColor.input.parse({
          deviceId: 7,
          color: { mode: 'rgb', rgb: { r: 999, g: 0, b: 0 } },
        }),
      ).toThrow()
    })

    it('setColor input — hsv branch rejects saturation > 100', () => {
      expect(() =>
        colorCapability.methods.setColor.input.parse({
          deviceId: 7,
          color: { mode: 'hsv', hsv: { h: 180, s: 150, v: 50 } },
        }),
      ).toThrow()
    })

    it('setColor input — mired branch rejects negative mireds', () => {
      expect(() =>
        colorCapability.methods.setColor.input.parse({
          deviceId: 7,
          color: { mode: 'mired', mireds: -10 },
        }),
      ).toThrow()
    })

    it('setColor input — rejects unknown mode', () => {
      expect(() =>
        colorCapability.methods.setColor.input.parse({
          deviceId: 7,
          color: { mode: 'xyz', value: 0 },
        }),
      ).toThrow()
    })
  })

  describe('climate-control cap', () => {
    it('registers as singleton device-scoped push cap on Thermostat', () => {
      expect(climateControlCapability.name).toBe('climate-control')
      expect(climateControlCapability.scope).toBe('device')
      expect(climateControlCapability.mode).toBe('singleton')
      expect(climateControlCapability.deviceTypes).toEqual([
        DeviceType.Thermostat,
        DeviceType.Climate,
      ])
      expect(climateControlCapability.status.kind).toBe('push')
    })

    it('runtimeState mirrors the status schema', () => {
      expect(climateControlCapability.runtimeState).toBe(ClimateControlStatusSchema)
    })

    it('exposes all six setters as mutations requiring admin auth', () => {
      const methodNames = [
        'setMode',
        'setFanMode',
        'setPreset',
        'setTarget',
        'setTargetRange',
        'setTargetHumidity',
      ] as const
      for (const name of methodNames) {
        const m = climateControlCapability.methods[name]
        expect(m.kind).toBe('mutation')
        expect(m.auth).toBe('protected')
      }
    })

    it('HvacMode enum covers the canonical HA modes', () => {
      const modes = HvacModeSchema.options
      expect(modes).toContain('off')
      expect(modes).toContain('heat')
      expect(modes).toContain('cool')
      expect(modes).toContain('auto')
      expect(modes).toContain('heat_cool')
      expect(modes).toContain('fan_only')
      expect(modes).toContain('dry')
    })

    it('status schema accepts a fully-populated single-setpoint sample', () => {
      const sample = {
        mode: 'heat' as const,
        availableModes: ['off', 'heat', 'cool'] as const,
        fanMode: 'auto',
        availableFanModes: ['auto', 'low', 'high'],
        preset: 'eco',
        availablePresets: ['eco', 'comfort', 'away'],
        target: 21.5,
        targetHigh: null,
        targetLow: null,
        targetHumidity: 50,
        currentTemp: 20.1,
        currentHumidity: 48,
        swingVertical: null,
        swingHorizontal: null,
        lastFetchedAt: 1,
      }
      expect(ClimateControlStatusSchema.parse(sample)).toEqual(sample)
    })

    it('status schema accepts a dual-setpoint heat_cool sample with nulled single target', () => {
      const sample = {
        mode: 'heat_cool' as const,
        availableModes: ['off', 'heat_cool'] as const,
        fanMode: '',
        availableFanModes: [],
        preset: '',
        availablePresets: [],
        target: null,
        targetHigh: 25,
        targetLow: 19,
        targetHumidity: null,
        currentTemp: 22,
        currentHumidity: null,
        swingVertical: null,
        swingHorizontal: null,
        lastFetchedAt: 0,
      }
      expect(ClimateControlStatusSchema.parse(sample)).toEqual(sample)
    })

    it('setTarget input rejects missing target', () => {
      expect(() =>
        climateControlCapability.methods.setTarget.input.parse({ deviceId: 1 }),
      ).toThrow()
    })

    it('setTargetHumidity input rejects out-of-range humidity', () => {
      expect(() =>
        climateControlCapability.methods.setTargetHumidity.input.parse({
          deviceId: 1,
          targetHumidity: 150,
        }),
      ).toThrow()
    })

    it('setMode input rejects unknown HVAC mode', () => {
      expect(() =>
        climateControlCapability.methods.setMode.input.parse({
          deviceId: 1,
          mode: 'turbo',
        }),
      ).toThrow()
    })

    it('setTargetRange input requires both bounds', () => {
      expect(() =>
        climateControlCapability.methods.setTargetRange.input.parse({
          deviceId: 1,
          targetLow: 18,
        }),
      ).toThrow()
    })
  })
})
