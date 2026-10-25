import { describe, it, expect } from 'vitest'
import { DeviceType } from '@camstack/types'
import {
  capsForKind,
  classifyDreoModel,
  clampPercent,
  deviceTypeForKind,
  DREO_MAX_FAN_LEVEL,
  levelToPercentage,
  percentageStep,
  percentageToLevel,
} from '../dreo-domain-mapping.js'

describe('classifyDreoModel', () => {
  it('classifies tower fans / air circulators as fan', () => {
    // DR-HTF* tower fan, DR-HAF* air circulator (library model prefixes).
    expect(classifyDreoModel('DR-HTF008S')).toBe('fan')
    expect(classifyDreoModel('DR-HAF004S')).toBe('fan')
  })

  it('classifies air purifiers as purifier', () => {
    expect(classifyDreoModel('DR-HAP004S')).toBe('purifier')
  })

  it('classifies heaters as heater', () => {
    expect(classifyDreoModel('DR-HSH009S')).toBe('heater')
  })

  it('classifies humidifiers as humidifier', () => {
    expect(classifyDreoModel('DR-HHM001S')).toBe('humidifier')
  })

  it('treats unknown / portable AC models as unsupported', () => {
    expect(classifyDreoModel('TOTALLY-UNKNOWN')).toBe('unsupported')
  })
})

describe('deviceTypeForKind', () => {
  it('maps fan + purifier to Fan, heater to Sensor, humidifier to Humidifier', () => {
    expect(deviceTypeForKind('fan')).toBe(DeviceType.Fan)
    expect(deviceTypeForKind('purifier')).toBe(DeviceType.Fan)
    expect(deviceTypeForKind('heater')).toBe(DeviceType.Sensor)
    expect(deviceTypeForKind('humidifier')).toBe(DeviceType.Humidifier)
  })
})

describe('capsForKind', () => {
  it('returns switch + fan-control for a fan', () => {
    expect(capsForKind('fan')).toEqual(['switch', 'fan-control'])
  })

  it('returns switch + fan-control + air-quality-sensor for a purifier', () => {
    expect(capsForKind('purifier')).toEqual(['switch', 'fan-control', 'air-quality-sensor'])
  })

  it('returns switch + temperature-sensor for a heater', () => {
    expect(capsForKind('heater')).toEqual(['switch', 'temperature-sensor'])
  })

  it('returns switch + humidity-sensor for a humidifier', () => {
    expect(capsForKind('humidifier')).toEqual(['switch', 'humidity-sensor'])
  })
})

describe('fan speed mapping', () => {
  it('maps level to percentage against the max level', () => {
    expect(levelToPercentage(0)).toBe(0)
    expect(levelToPercentage(DREO_MAX_FAN_LEVEL)).toBe(100)
    expect(levelToPercentage(DREO_MAX_FAN_LEVEL, DREO_MAX_FAN_LEVEL)).toBe(100)
    // Mid-range is monotonic.
    expect(levelToPercentage(1)).toBeGreaterThan(0)
    expect(levelToPercentage(1)).toBeLessThan(levelToPercentage(2))
  })

  it('clamps levels above the max to 100%', () => {
    expect(levelToPercentage(DREO_MAX_FAN_LEVEL + 5)).toBe(100)
  })

  it('maps percentage back to a level in [1, max] when on, 0 when off', () => {
    expect(percentageToLevel(0)).toBe(0)
    expect(percentageToLevel(100)).toBe(DREO_MAX_FAN_LEVEL)
    // Any positive percentage rounds to at least level 1.
    expect(percentageToLevel(1)).toBeGreaterThanOrEqual(1)
    expect(percentageToLevel(100)).toBeLessThanOrEqual(DREO_MAX_FAN_LEVEL)
  })

  it('round-trips boundary values', () => {
    expect(levelToPercentage(percentageToLevel(100))).toBe(100)
  })

  it('produces a sane percentage step', () => {
    expect(percentageStep()).toBeGreaterThan(0)
    expect(percentageStep()).toBeLessThanOrEqual(100)
  })
})

describe('clampPercent', () => {
  it('clamps into [0, 100] and passes through null on undefined/NaN', () => {
    expect(clampPercent(undefined)).toBeNull()
    expect(clampPercent(Number.NaN)).toBeNull()
    expect(clampPercent(-5)).toBe(0)
    expect(clampPercent(150)).toBe(100)
    expect(clampPercent(42)).toBe(42)
  })
})
