import { type ClimateControlStatus, DeviceRole, type HvacMode } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { type ClimateCommands, climateModelOf } from '../connected/climate-model'

const NONE: ClimateCommands = {
  targetRange: false,
  fanMode: false,
  preset: false,
  swingVertical: false,
  swingHorizontal: false,
}

function autoAboveTarget(
  availableModes: HvacMode[],
  mode: HvacMode = 'auto',
): ClimateControlStatus {
  return {
    mode,
    availableModes,
    fanMode: '',
    availableFanModes: [],
    preset: '',
    availablePresets: [],
    target: 20,
    targetHigh: null,
    targetLow: null,
    targetHumidity: null,
    currentTemp: 20.5,
    currentHumidity: null,
    swingVertical: null,
    swingHorizontal: null,
    minTemp: 5,
    maxTemp: 30,
    tempStep: 0.5,
    lastFetchedAt: 0,
  }
}

function activityOf(climate: ClimateControlStatus): string | undefined {
  return climateModelOf({
    role: DeviceRole.ClimateThermostat,
    climate,
    valve: undefined,
    commands: NONE,
    modeLabel: (mode) => mode,
  })?.activity
}

describe('climate activity — cooling only on a device that can cool', () => {
  it('a heat-only thermostat in auto, half a degree over its target, is idle, never cooling', () => {
    expect(activityOf(autoAboveTarget(['off', 'heat', 'auto']))).toBe('idle')
  })

  it('an air conditioner that offers cool still reads cooling in auto over its target', () => {
    expect(activityOf(autoAboveTarget(['off', 'heat', 'cool', 'auto']))).toBe('cool')
  })

  it('a device that reports no modes is unknown, not heat-only: it keeps reading cooling', () => {
    expect(activityOf(autoAboveTarget([]))).toBe('cool')
  })

  it('heat_cool over its target reads cooling on a device that offers heat_cool', () => {
    expect(activityOf(autoAboveTarget(['off', 'heat', 'heat_cool'], 'heat_cool'))).toBe('cool')
  })

  it('heat_cool over its target is idle on a device whose reported modes cannot cool', () => {
    expect(activityOf(autoAboveTarget(['off', 'heat'], 'heat_cool'))).toBe('idle')
  })
})
