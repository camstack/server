import { describe, it, expect } from 'vitest'
import { FanSpeed, HvacMode, HorizontalSwing, VerticalSwing } from '@apocaliss92/nodegree'
import {
  ADVERTISED_CAP_MODES,
  GREE_FAN_MODES,
  GREE_FAN_PERCENTAGE_STEP,
  GREE_PRESETS,
  boolToHorizontalSwing,
  boolToVerticalSwing,
  capModeToLibMode,
  fanModeToFanSpeed,
  fanSpeedToFanMode,
  fanSpeedToPercentage,
  horizontalSwingToBool,
  isAutoFan,
  libModeToCapMode,
  oscillatingToVerticalSwing,
  percentageToFanSpeed,
  presetFromFlags,
  presetToFlagWrites,
  swingToOscillating,
  verticalSwingToBool,
} from '../gree-domain-mapping.js'

const NO_FLAGS = {
  turbo: false,
  quiet: false,
  sleep: false,
  powerSave: false,
  steadyHeat: false,
}

describe('HVAC mode mapping', () => {
  it('round-trips every library mode through the cap vocabulary', () => {
    for (const lib of [HvacMode.Auto, HvacMode.Cool, HvacMode.Dry, HvacMode.Fan, HvacMode.Heat]) {
      const capMode = libModeToCapMode(lib)
      expect(capModeToLibMode(capMode)).toBe(lib)
    }
  })

  it('maps fan-only correctly (lib Fan ↔ cap fan_only)', () => {
    expect(libModeToCapMode(HvacMode.Fan)).toBe('fan_only')
    expect(capModeToLibMode('fan_only')).toBe(HvacMode.Fan)
  })

  it('returns null for cap modes with no Gree device equivalent', () => {
    expect(capModeToLibMode('off')).toBeNull()
    expect(capModeToLibMode('heat_cool')).toBeNull()
  })

  it('advertises off plus the five supported device modes', () => {
    expect(ADVERTISED_CAP_MODES).toContain('off')
    expect(ADVERTISED_CAP_MODES).toContain('cool')
    expect(ADVERTISED_CAP_MODES).toContain('heat')
    expect(ADVERTISED_CAP_MODES).toContain('auto')
    expect(ADVERTISED_CAP_MODES).toContain('dry')
    expect(ADVERTISED_CAP_MODES).toContain('fan_only')
    expect(ADVERTISED_CAP_MODES).not.toContain('heat_cool')
  })
})

describe('fan speed mapping', () => {
  it('maps Auto to null percentage', () => {
    expect(fanSpeedToPercentage(FanSpeed.Auto)).toBeNull()
    expect(isAutoFan(FanSpeed.Auto)).toBe(true)
    expect(isAutoFan(FanSpeed.High)).toBe(false)
  })

  it('maps Low..High to ascending percentages ending at 100', () => {
    const low = fanSpeedToPercentage(FanSpeed.Low)
    const high = fanSpeedToPercentage(FanSpeed.High)
    expect(low).not.toBeNull()
    expect(high).toBe(100)
    expect(low).toBeLessThan(high as number)
  })

  it('buckets a percentage into a concrete FanSpeed (0 → Auto)', () => {
    expect(percentageToFanSpeed(0)).toBe(FanSpeed.Auto)
    expect(percentageToFanSpeed(100)).toBe(FanSpeed.High)
    expect(percentageToFanSpeed(20)).toBe(FanSpeed.Low)
  })

  it('round-trips 100% through the speed mapping', () => {
    const speed = percentageToFanSpeed(100)
    expect(fanSpeedToPercentage(speed)).toBe(100)
  })

  it('exposes a sane percentage step', () => {
    expect(GREE_FAN_PERCENTAGE_STEP).toBeGreaterThan(0)
    expect(GREE_FAN_PERCENTAGE_STEP).toBeLessThanOrEqual(100)
  })
})

describe('swing ↔ oscillating', () => {
  it('reports oscillating when either louver is in full swing', () => {
    expect(swingToOscillating(VerticalSwing.FullSwing, HorizontalSwing.Default)).toBe(true)
    expect(swingToOscillating(VerticalSwing.Default, HorizontalSwing.FullSwing)).toBe(true)
    expect(swingToOscillating(VerticalSwing.Default, HorizontalSwing.Default)).toBe(false)
  })

  it('maps the oscillating toggle to a vertical swing position', () => {
    expect(oscillatingToVerticalSwing(true)).toBe(VerticalSwing.FullSwing)
    expect(oscillatingToVerticalSwing(false)).toBe(VerticalSwing.Default)
  })
})

describe('independent swing booleans (climate surface)', () => {
  it('reports vertical swing true only in the full-swing position', () => {
    expect(verticalSwingToBool(VerticalSwing.FullSwing)).toBe(true)
    expect(verticalSwingToBool(VerticalSwing.Default)).toBe(false)
    expect(verticalSwingToBool(VerticalSwing.FixedMiddle)).toBe(false)
    expect(verticalSwingToBool(VerticalSwing.SwingLower)).toBe(false)
  })

  it('reports horizontal swing true only in the full-swing position', () => {
    expect(horizontalSwingToBool(HorizontalSwing.FullSwing)).toBe(true)
    expect(horizontalSwingToBool(HorizontalSwing.Default)).toBe(false)
    expect(horizontalSwingToBool(HorizontalSwing.Center)).toBe(false)
    expect(horizontalSwingToBool(HorizontalSwing.Right)).toBe(false)
  })

  it('maps a vertical bool to the full-swing/default position', () => {
    expect(boolToVerticalSwing(true)).toBe(VerticalSwing.FullSwing)
    expect(boolToVerticalSwing(false)).toBe(VerticalSwing.Default)
  })

  it('maps a horizontal bool to the full-swing/default position', () => {
    expect(boolToHorizontalSwing(true)).toBe(HorizontalSwing.FullSwing)
    expect(boolToHorizontalSwing(false)).toBe(HorizontalSwing.Default)
  })

  it('round-trips both swing booleans through write → read', () => {
    for (const on of [true, false]) {
      expect(verticalSwingToBool(boolToVerticalSwing(on))).toBe(on)
      expect(horizontalSwingToBool(boolToHorizontalSwing(on))).toBe(on)
    }
  })
})

describe('fan mode mapping', () => {
  it('round-trips every library speed through the fan-mode string', () => {
    for (const speed of [
      FanSpeed.Auto,
      FanSpeed.Low,
      FanSpeed.MediumLow,
      FanSpeed.Medium,
      FanSpeed.MediumHigh,
      FanSpeed.High,
    ]) {
      expect(fanModeToFanSpeed(fanSpeedToFanMode(speed))).toBe(speed)
    }
  })

  it('advertises the six Gree speeds and matches every advertised mode', () => {
    expect(GREE_FAN_MODES).toEqual(['auto', 'low', 'medium_low', 'medium', 'medium_high', 'high'])
    for (const m of GREE_FAN_MODES) {
      expect(fanModeToFanSpeed(m)).not.toBeNull()
    }
  })

  it('rejects an unknown fan mode', () => {
    expect(fanModeToFanSpeed('turbo')).toBeNull()
    expect(fanModeToFanSpeed('nope')).toBeNull()
  })
})

describe('preset mapping', () => {
  it('reports none when no comfort flag is set', () => {
    expect(presetFromFlags(NO_FLAGS)).toBe('none')
  })

  it('derives each preset from its flag', () => {
    expect(presetFromFlags({ ...NO_FLAGS, turbo: true })).toBe('turbo')
    expect(presetFromFlags({ ...NO_FLAGS, quiet: true })).toBe('quiet')
    expect(presetFromFlags({ ...NO_FLAGS, sleep: true })).toBe('sleep')
    expect(presetFromFlags({ ...NO_FLAGS, powerSave: true })).toBe('eco')
    expect(presetFromFlags({ ...NO_FLAGS, steadyHeat: true })).toBe('8c_heat')
  })

  it('applies a fixed precedence when several flags are set', () => {
    expect(presetFromFlags({ ...NO_FLAGS, turbo: true, quiet: true })).toBe('turbo')
    expect(presetFromFlags({ ...NO_FLAGS, quiet: true, sleep: true })).toBe('quiet')
  })

  it('resolves a preset to exclusive flag writes', () => {
    expect(presetToFlagWrites('turbo')).toEqual({ ...NO_FLAGS, turbo: true })
    expect(presetToFlagWrites('eco')).toEqual({ ...NO_FLAGS, powerSave: true })
    expect(presetToFlagWrites('8c_heat')).toEqual({ ...NO_FLAGS, steadyHeat: true })
    expect(presetToFlagWrites('none')).toEqual(NO_FLAGS)
  })

  it('rejects an unknown preset', () => {
    expect(presetToFlagWrites('boost')).toBeNull()
  })

  it('round-trips a single-flag preset through derive → writes', () => {
    for (const p of GREE_PRESETS) {
      const writes = presetToFlagWrites(p)
      expect(writes).not.toBeNull()
      if (writes) expect(presetFromFlags(writes)).toBe(p)
    }
  })
})
