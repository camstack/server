import { describe, it, expect } from 'vitest'
import { DeviceFeature } from '../device/device-type.js'

describe('HA actuator DeviceFeature flags — Phase C1/C2 retroactive', () => {
  it('C1 color sub-mode flags are present', () => {
    expect(DeviceFeature.LightColorRgb).toBe('light-color-rgb')
    expect(DeviceFeature.LightColorHsv).toBe('light-color-hsv')
    expect(DeviceFeature.LightColorMired).toBe('light-color-mired')
  })

  it('C1 climate-control sub-surface flags are present', () => {
    expect(DeviceFeature.ClimateDualSetpoint).toBe('climate-dual-setpoint')
    expect(DeviceFeature.ClimateHumidity).toBe('climate-humidity')
    expect(DeviceFeature.ClimateFanMode).toBe('climate-fan-mode')
    expect(DeviceFeature.ClimatePreset).toBe('climate-preset')
  })

  it('C2 cover sub-surface flags are present', () => {
    expect(DeviceFeature.CoverPositionable).toBe('cover-positionable')
    expect(DeviceFeature.CoverTilt).toBe('cover-tilt')
  })

  it('C2 fan-control sub-surface flags are present', () => {
    expect(DeviceFeature.FanSpeed).toBe('fan-speed')
    expect(DeviceFeature.FanPreset).toBe('fan-preset')
    expect(DeviceFeature.FanDirection).toBe('fan-direction')
    expect(DeviceFeature.FanOscillating).toBe('fan-oscillating')
  })

  it('C2 lock-control PIN flag is present', () => {
    expect(DeviceFeature.LockPinRequired).toBe('lock-pin-required')
  })

  it('all 14 retroactive feature values are unique', () => {
    const values: string[] = [
      DeviceFeature.LightColorRgb,
      DeviceFeature.LightColorHsv,
      DeviceFeature.LightColorMired,
      DeviceFeature.ClimateDualSetpoint,
      DeviceFeature.ClimateHumidity,
      DeviceFeature.ClimateFanMode,
      DeviceFeature.ClimatePreset,
      DeviceFeature.CoverPositionable,
      DeviceFeature.CoverTilt,
      DeviceFeature.FanSpeed,
      DeviceFeature.FanPreset,
      DeviceFeature.FanDirection,
      DeviceFeature.FanOscillating,
      DeviceFeature.LockPinRequired,
    ]
    expect(new Set(values).size).toBe(values.length)
  })

  it('every retroactive flag uses kebab-case naming', () => {
    const flags: string[] = [
      DeviceFeature.LightColorRgb,
      DeviceFeature.LightColorHsv,
      DeviceFeature.LightColorMired,
      DeviceFeature.ClimateDualSetpoint,
      DeviceFeature.ClimateHumidity,
      DeviceFeature.ClimateFanMode,
      DeviceFeature.ClimatePreset,
      DeviceFeature.CoverPositionable,
      DeviceFeature.CoverTilt,
      DeviceFeature.FanSpeed,
      DeviceFeature.FanPreset,
      DeviceFeature.FanDirection,
      DeviceFeature.FanOscillating,
      DeviceFeature.LockPinRequired,
    ]
    for (const value of flags) {
      expect(value).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/)
    }
  })

  it('does not collide with existing camera feature flags', () => {
    const cameraFlags: string[] = [
      DeviceFeature.BatteryOperated,
      DeviceFeature.Rebootable,
      DeviceFeature.NativeSnapshot,
      DeviceFeature.DoorbellButton,
      DeviceFeature.TwoWayAudio,
      DeviceFeature.PanTiltZoom,
      DeviceFeature.PtzAutotrack,
      DeviceFeature.MotionTrigger,
    ]
    const retroactiveFlags: string[] = [
      DeviceFeature.LightColorRgb,
      DeviceFeature.LightColorHsv,
      DeviceFeature.LightColorMired,
      DeviceFeature.ClimateDualSetpoint,
      DeviceFeature.ClimateHumidity,
      DeviceFeature.ClimateFanMode,
      DeviceFeature.ClimatePreset,
      DeviceFeature.CoverPositionable,
      DeviceFeature.CoverTilt,
      DeviceFeature.FanSpeed,
      DeviceFeature.FanPreset,
      DeviceFeature.FanDirection,
      DeviceFeature.FanOscillating,
      DeviceFeature.LockPinRequired,
    ]
    const merged = new Set([...cameraFlags, ...retroactiveFlags])
    expect(merged.size).toBe(cameraFlags.length + retroactiveFlags.length)
  })
})
