import { describe, it, expect } from 'vitest'
import { DeviceType } from '@camstack/types'
import { FanSpeed, HvacMode, HorizontalSwing, VerticalSwing } from '@apocaliss92/nodegree'
import {
  ADVERTISED_CAP_MODES,
  SUPPORTED_CAP_MODES,
  GREE_FAN_PERCENTAGE_STEP,
  capModeToLibMode,
  fanSpeedToPercentage,
  isAutoFan,
  libModeToCapMode,
  oscillatingToVerticalSwing,
  percentageToFanSpeed,
  swingToOscillating,
} from '../gree-domain-mapping.js'
import { buildGreeCandidates, type GreeDiscoverable } from '../gree-discovery.js'

describe('HVAC mode mapping', () => {
  it('maps every library mode to a cap mode and back (round-trip)', () => {
    const libModes = [HvacMode.Auto, HvacMode.Cool, HvacMode.Dry, HvacMode.Fan, HvacMode.Heat]
    for (const lib of libModes) {
      const cap = libModeToCapMode(lib)
      expect(SUPPORTED_CAP_MODES).toContain(cap)
      expect(capModeToLibMode(cap)).toBe(lib)
    }
  })

  it('maps the specific cap strings', () => {
    expect(libModeToCapMode(HvacMode.Auto)).toBe('auto')
    expect(libModeToCapMode(HvacMode.Cool)).toBe('cool')
    expect(libModeToCapMode(HvacMode.Dry)).toBe('dry')
    expect(libModeToCapMode(HvacMode.Fan)).toBe('fan_only')
    expect(libModeToCapMode(HvacMode.Heat)).toBe('heat')
  })

  it('returns null for cap modes with no Gree device equivalent', () => {
    // `off` is power state, `heat_cool` is unsupported on single-setpoint Gree.
    expect(capModeToLibMode('off')).toBeNull()
    expect(capModeToLibMode('heat_cool')).toBeNull()
  })

  it('advertises off + the five supported modes', () => {
    expect(ADVERTISED_CAP_MODES).toEqual(['off', ...SUPPORTED_CAP_MODES])
    expect(ADVERTISED_CAP_MODES[0]).toBe('off')
  })
})

describe('fan speed ↔ percentage mapping', () => {
  it('maps Auto to null (no fixed percentage)', () => {
    expect(fanSpeedToPercentage(FanSpeed.Auto)).toBeNull()
    expect(isAutoFan(FanSpeed.Auto)).toBe(true)
    expect(isAutoFan(FanSpeed.High)).toBe(false)
  })

  it('maps the discrete speeds monotonically 20..100', () => {
    expect(fanSpeedToPercentage(FanSpeed.Low)).toBe(20)
    expect(fanSpeedToPercentage(FanSpeed.MediumLow)).toBe(40)
    expect(fanSpeedToPercentage(FanSpeed.Medium)).toBe(60)
    expect(fanSpeedToPercentage(FanSpeed.MediumHigh)).toBe(80)
    expect(fanSpeedToPercentage(FanSpeed.High)).toBe(100)
  })

  it('buckets a percentage to the nearest discrete speed', () => {
    // 0% → Auto (no "fan off" distinct from power off).
    expect(percentageToFanSpeed(0)).toBe(FanSpeed.Auto)
    expect(percentageToFanSpeed(20)).toBe(FanSpeed.Low)
    expect(percentageToFanSpeed(100)).toBe(FanSpeed.High)
    // Out-of-band clamps.
    expect(percentageToFanSpeed(150)).toBe(FanSpeed.High)
    expect(percentageToFanSpeed(-5)).toBe(FanSpeed.Auto)
  })

  it('round-trips the discrete speeds through percentage', () => {
    const speeds = [
      FanSpeed.Low,
      FanSpeed.MediumLow,
      FanSpeed.Medium,
      FanSpeed.MediumHigh,
      FanSpeed.High,
    ]
    for (const s of speeds) {
      const pct = fanSpeedToPercentage(s)
      expect(pct).not.toBeNull()
      if (pct !== null) expect(percentageToFanSpeed(pct)).toBe(s)
    }
  })

  it('exposes a sane percentage step (5 speeds → 20)', () => {
    expect(GREE_FAN_PERCENTAGE_STEP).toBe(20)
  })
})

describe('swing ↔ oscillating mapping', () => {
  it('is oscillating when either louver is in full-swing', () => {
    expect(swingToOscillating(VerticalSwing.FullSwing, HorizontalSwing.Default)).toBe(true)
    expect(swingToOscillating(VerticalSwing.Default, HorizontalSwing.FullSwing)).toBe(true)
    expect(swingToOscillating(VerticalSwing.FullSwing, HorizontalSwing.FullSwing)).toBe(true)
  })

  it('is not oscillating when both louvers are fixed', () => {
    expect(swingToOscillating(VerticalSwing.Default, HorizontalSwing.Default)).toBe(false)
    expect(swingToOscillating(VerticalSwing.FixedMiddle, HorizontalSwing.Center)).toBe(false)
  })

  it('maps an oscillating toggle to the vertical swing position', () => {
    expect(oscillatingToVerticalSwing(true)).toBe(VerticalSwing.FullSwing)
    expect(oscillatingToVerticalSwing(false)).toBe(VerticalSwing.Default)
  })
})

describe('buildGreeCandidates', () => {
  const rows: GreeDiscoverable[] = [
    { mac: 'AABBCCDDEEFF', name: 'Living Room AC', model: 'GREE-XYZ' },
    { mac: '001122334455', name: '' },
  ]

  it('produces one Climate candidate per AC, lowercasing the MAC childNativeId', () => {
    const cands = buildGreeCandidates({ devices: rows, adopted: new Map() })
    expect(cands).toHaveLength(2)
    expect(cands[0]?.type).toBe(DeviceType.Climate)
    expect(cands[0]?.childNativeId).toBe('aabbccddeeff')
    expect(cands[0]?.capabilities).toEqual(['climate-control', 'fan-control'])
    // Empty name falls back to the MAC.
    expect(cands[1]?.name).toBe('001122334455')
  })

  it('flags already-adopted ACs by lowercased MAC', () => {
    const adopted = new Map<string, number>([['aabbccddeeff', 42]])
    const cands = buildGreeCandidates({ devices: rows, adopted })
    expect(cands[0]?.alreadyAdopted).toBe(true)
    expect(cands[0]?.adoptedDeviceId).toBe(42)
    expect(cands[1]?.alreadyAdopted).toBe(false)
    expect(cands[1]?.adoptedDeviceId).toBeNull()
  })

  it('carries the model into candidate metadata when present', () => {
    const cands = buildGreeCandidates({ devices: rows, adopted: new Map() })
    expect(cands[0]?.metadata.model).toBe('GREE-XYZ')
    expect(cands[1]?.metadata.model).toBeUndefined()
  })
})
