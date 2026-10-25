import { describe, it, expect } from 'vitest'
import { pickHaChildClass, tryPickHaChildClass } from '../ha-child-class-factory.js'
import { HaImageDevice } from '../devices/ha-image-device.js'
import { HaSwitchDevice } from '../devices/ha-switch-device.js'
import { HaNumericSensorDevice } from '../devices/ha-numeric-sensor-device.js'
import { HaBinarySensorDevice } from '../devices/ha-binary-sensor-device.js'
import { HaLightDevice } from '../devices/ha-light-device.js'
import { HaCoverDevice } from '../devices/ha-cover-device.js'
import { HaValveDevice } from '../devices/ha-valve-device.js'
import { HaLockDevice } from '../devices/ha-lock-device.js'
import { HaClimateDevice } from '../devices/ha-climate-device.js'
import { HaHumidifierDevice } from '../devices/ha-humidifier-device.js'
import { HaWaterHeaterDevice } from '../devices/ha-water-heater-device.js'
import { HaFanDevice } from '../devices/ha-fan-device.js'
import { HaVacuumDevice } from '../devices/ha-vacuum-device.js'
import { HaLawnMowerDevice } from '../devices/ha-lawn-mower-device.js'
import { HaMediaPlayerDevice } from '../devices/ha-media-player-device.js'
import { HaAlarmPanelDevice } from '../devices/ha-alarm-panel-device.js'
import { HaPresenceDevice } from '../devices/ha-presence-device.js'
import { HaControlDevice } from '../devices/ha-control-device.js'
import { HaScriptDevice } from '../devices/ha-script-device.js'
import { HaAutomationDevice } from '../devices/ha-automation-device.js'
import { HaNotifierDevice } from '../devices/ha-notifier-device.js'
import { HaWeatherDevice } from '../devices/ha-weather-device.js'

describe('pickHaChildClass — child-device-class factory', () => {
  describe('phase F1 — switch + sensors', () => {
    it('picks HaSwitchDevice for plain switch cap', () => {
      expect(pickHaChildClass(['switch'])).toBe(HaSwitchDevice)
    })

    it.each([
      'temperature-sensor',
      'humidity-sensor',
      'ambient-light-sensor',
      'pressure-sensor',
      'numeric-sensor',
    ])('picks HaNumericSensorDevice for %s', (cap) => {
      expect(pickHaChildClass([cap])).toBe(HaNumericSensorDevice)
    })

    it.each([
      'contact',
      'flood',
      'smoke',
      'carbon-monoxide',
      'gas',
      'tamper',
      'vibration',
      'connectivity',
      'binary',
      'motion',
    ])('picks HaBinarySensorDevice for %s', (cap) => {
      expect(pickHaChildClass([cap])).toBe(HaBinarySensorDevice)
    })
  })

  describe('phase F3 — light / cover / lock / climate', () => {
    it('picks HaLightDevice for [switch, brightness]', () => {
      expect(pickHaChildClass(['switch', 'brightness'])).toBe(HaLightDevice)
    })

    it('picks HaLightDevice for [switch, brightness, color] (full Hue bulb)', () => {
      expect(pickHaChildClass(['switch', 'brightness', 'color'])).toBe(HaLightDevice)
    })

    it('picks HaLightDevice for [switch, color] (CCT-only tunable white)', () => {
      expect(pickHaChildClass(['switch', 'color'])).toBe(HaLightDevice)
    })

    it('picks HaLightDevice over HaSwitchDevice when brightness is present', () => {
      // Light precedence over switch — same entity gets all 3 caps.
      expect(pickHaChildClass(['switch', 'brightness'])).not.toBe(HaSwitchDevice)
    })

    it('picks HaCoverDevice for cover cap', () => {
      expect(pickHaChildClass(['cover'])).toBe(HaCoverDevice)
    })

    it('picks HaValveDevice for valve cap', () => {
      expect(pickHaChildClass(['valve'])).toBe(HaValveDevice)
    })

    it('picks HaLockDevice for lock-control cap', () => {
      expect(pickHaChildClass(['lock-control'])).toBe(HaLockDevice)
    })

    it('picks HaClimateDevice for climate-control cap', () => {
      expect(pickHaChildClass(['climate-control'])).toBe(HaClimateDevice)
    })

    it('picks HaHumidifierDevice for humidifier cap', () => {
      expect(pickHaChildClass(['humidifier'])).toBe(HaHumidifierDevice)
    })

    it('picks HaWaterHeaterDevice for water-heater cap', () => {
      expect(pickHaChildClass(['water-heater'])).toBe(HaWaterHeaterDevice)
    })

    it('picks HaVacuumDevice for vacuum-control cap', () => {
      expect(pickHaChildClass(['vacuum-control'])).toBe(HaVacuumDevice)
    })

    it('picks HaLawnMowerDevice for lawn-mower-control cap', () => {
      expect(pickHaChildClass(['lawn-mower-control'])).toBe(HaLawnMowerDevice)
    })
  })

  describe('phase F4 — fan / media / alarm / presence / control / script / automation / notifier', () => {
    it('picks HaFanDevice for fan-control cap', () => {
      expect(pickHaChildClass(['switch', 'fan-control'])).toBe(HaFanDevice)
    })

    it('picks HaMediaPlayerDevice for media-player cap', () => {
      expect(pickHaChildClass(['media-player'])).toBe(HaMediaPlayerDevice)
    })

    it('picks HaAlarmPanelDevice for alarm-panel cap', () => {
      expect(pickHaChildClass(['alarm-panel'])).toBe(HaAlarmPanelDevice)
    })

    it('picks HaPresenceDevice for presence cap', () => {
      expect(pickHaChildClass(['presence'])).toBe(HaPresenceDevice)
    })

    it('picks HaControlDevice for control cap', () => {
      expect(pickHaChildClass(['control'])).toBe(HaControlDevice)
    })

    it('picks HaWeatherDevice for weather cap', () => {
      expect(pickHaChildClass(['weather'])).toBe(HaWeatherDevice)
    })

    it('picks HaImageDevice for image cap', () => {
      expect(pickHaChildClass(['image'])).toBe(HaImageDevice)
    })

    it('picks HaScriptDevice for script-runner cap', () => {
      expect(pickHaChildClass(['script-runner'])).toBe(HaScriptDevice)
    })

    it('picks HaAutomationDevice for automation-control cap', () => {
      expect(pickHaChildClass(['automation-control'])).toBe(HaAutomationDevice)
    })

    it('picks HaNotifierDevice for notifier cap', () => {
      expect(pickHaChildClass(['notifier'])).toBe(HaNotifierDevice)
    })
  })

  describe('phase F5 — multi-metric sensors', () => {
    it('picks HaPowerMeterDevice for power-meter cap', async () => {
      const { HaPowerMeterDevice } = await import('../devices/ha-power-meter-device.js')
      expect(pickHaChildClass(['power-meter'])).toBe(HaPowerMeterDevice)
    })

    it('picks HaAirQualityDevice for air-quality-sensor cap', async () => {
      const { HaAirQualityDevice } = await import('../devices/ha-air-quality-device.js')
      expect(pickHaChildClass(['air-quality-sensor'])).toBe(HaAirQualityDevice)
    })

    it('picks HaEnumSensorDevice for enum-sensor cap', async () => {
      const { HaEnumSensorDevice } = await import('../devices/ha-enum-sensor-device.js')
      expect(pickHaChildClass(['enum-sensor'])).toBe(HaEnumSensorDevice)
    })
  })

  describe('unrecognised cap list throws', () => {
    it('throws for empty cap list', () => {
      expect(() => pickHaChildClass([])).toThrow(
        'pickHaChildClass: no HA child class for capabilities:',
      )
    })

    it('throws for unknown cap names', () => {
      expect(() => pickHaChildClass(['unknown-cap-name'])).toThrow(
        'pickHaChildClass: no HA child class for capabilities: unknown-cap-name',
      )
    })
  })

  describe('priority invariants', () => {
    it('switch wins over numeric/binary sensors when mixed', () => {
      expect(pickHaChildClass(['switch', 'temperature-sensor'])).toBe(HaSwitchDevice)
    })

    it('climate wins over everything when present', () => {
      expect(pickHaChildClass(['climate-control', 'switch', 'temperature-sensor'])).toBe(
        HaClimateDevice,
      )
    })

    it('light precedence: brightness/color before switch', () => {
      expect(pickHaChildClass(['brightness', 'switch'])).toBe(HaLightDevice)
    })
  })

  describe('tryPickHaChildClass (nullable variant)', () => {
    it('returns the class for a known cap', () => {
      expect(tryPickHaChildClass(['image'])).toBe(HaImageDevice)
    })

    it('returns null for a retired/unknown cap instead of throwing', () => {
      // `snapshot` was retired from the HA factory by the camera→image
      // migration; a child still carrying it must resolve to null so the
      // container factory can fall back to its `entities[]` spec caps.
      expect(tryPickHaChildClass(['snapshot'])).toBeNull()
      expect(tryPickHaChildClass(['unknown-cap-name'])).toBeNull()
    })
  })
})
