import { describe, expect, it } from 'vitest'
import {
  coldStartFeederStatus,
  decodeFeederError,
  decodeFeederStatus,
  type FeederReading,
  mapFeederToStatus,
  feedMemoryPatch,
  PETKIT_POWER_MODE_BATTERY,
  PETKIT_POWER_MODE_MAINS,
} from '../petkit-feeder-mapping.js'

/** A healthy single-hopper feeder reading (Fresh Element 3-style). */
function singleHopperReading(overrides: Partial<FeederReading> = {}): FeederReading {
  return {
    online: true,
    deviceType: 'feeder',
    isDualHopper: false,
    feeding: false,
    eating: false,
    bowl: null,
    food: 120,
    food1: null,
    food2: null,
    batteryPower: 80,
    desiccantLeftDays: 20,
    errorCode: 0,
    errorMsg: null,
    powerMode: PETKIT_POWER_MODE_MAINS,
    childLock: false,
    indicatorLight: true,
    feedSound: true,
    volume: 3,
    ...overrides,
  }
}

/** A dual-hopper feeder reading (D4SH-style). */
function dualHopperReading(overrides: Partial<FeederReading> = {}): FeederReading {
  return {
    ...singleHopperReading(),
    isDualHopper: true,
    food: null,
    food1: 40,
    food2: 60,
    ...overrides,
  }
}

const NOW = 1_700_000_000_000

describe('powerSource', () => {
  it('maps pim 1 to mains, pim 2 to battery, anything else to null', () => {
    const src = (powerMode: number | null) =>
      mapFeederToStatus(singleHopperReading({ powerMode }), NOW).powerSource
    expect(src(1)).toBe('mains')
    expect(src(2)).toBe('battery')
    expect(src(null)).toBeNull()
    expect(src(7)).toBeNull()
  })
})

describe('decodeFeederStatus', () => {
  it('maps an unreachable feeder to offline', () => {
    expect(decodeFeederStatus(singleHopperReading({ online: false }))).toBe('offline')
  })

  it('maps a battery-backup feeder to on_batteries', () => {
    expect(decodeFeederStatus(singleHopperReading({ powerMode: PETKIT_POWER_MODE_BATTERY }))).toBe(
      'on_batteries',
    )
  })

  it('maps a mains-powered online feeder to normal', () => {
    expect(decodeFeederStatus(singleHopperReading())).toBe('normal')
  })

  it('prefers offline over the battery indicator', () => {
    expect(
      decodeFeederStatus(
        singleHopperReading({ online: false, powerMode: PETKIT_POWER_MODE_BATTERY }),
      ),
    ).toBe('offline')
  })

  it('treats an unknown power mode as normal when online', () => {
    expect(decodeFeederStatus(singleHopperReading({ powerMode: null }))).toBe('normal')
  })
})

describe('decodeFeederError', () => {
  it('returns null for code 0 (healthy)', () => {
    expect(decodeFeederError(0, null)).toBeNull()
  })

  it('returns null for a null code', () => {
    expect(decodeFeederError(null, 'ignored')).toBeNull()
  })

  it('prefers the cloud-decoded message when present', () => {
    expect(decodeFeederError(7, 'Food dispenser jammed')).toBe('Food dispenser jammed')
  })

  it('falls back to a stable token when no message is given', () => {
    expect(decodeFeederError(7, null)).toBe('feeder_error_7')
  })

  it('falls back when the message is blank', () => {
    expect(decodeFeederError(7, '   ')).toBe('feeder_error_7')
  })
})

describe('mapFeederToStatus — single hopper', () => {
  it('maps the full slice from a healthy reading', () => {
    const slice = mapFeederToStatus(singleHopperReading(), NOW)
    expect(slice).toEqual({
      foodLevel: 120,
      bowlFood: null,
      eating: false,
      supportsMarkRefilled: false,
      food1: null,
      food2: null,
      lowFood: false,
      powerSource: 'mains',
      batteryPower: 80,
      desiccantLeftDays: 20 * 86_400,
      feeding: false,
      status: 'normal',
      error: null,
      errorCode: 0,
      isDualHopper: false,
      childLock: false,
      indicatorLight: true,
      feedSound: true,
      volume: 3,
      lastFeedGrams: null,
      lastFeedHopper1: null,
      lastFeedHopper2: null,
      lastFetchedAt: NOW,
    })
  })

  it('derives lowFood when the tank reports empty', () => {
    expect(mapFeederToStatus(singleHopperReading({ food: 0 }), NOW).lowFood).toBe(true)
  })

  it('keeps the bowl amount and the eating flag apart from the tank level', () => {
    const slice = mapFeederToStatus(singleHopperReading({ food: 1, bowl: 35, eating: true }), NOW)
    expect(slice.foodLevel).toBe(1)
    expect(slice.bowlFood).toBe(35)
    expect(slice.eating).toBe(true)
  })

  it('offers "mark refilled" only on the models the library documents it for', () => {
    const supports = (deviceType: string): boolean =>
      mapFeederToStatus(singleHopperReading({ deviceType }), NOW).supportsMarkRefilled
    expect(supports('feeder')).toBe(false)
    expect(supports('d3')).toBe(false)
    expect(supports('d4h')).toBe(true)
    expect(supports('D4S')).toBe(true)
    expect(supports('d4sh')).toBe(true)
  })

  it('does not surface per-hopper levels on a single-hopper model', () => {
    const slice = mapFeederToStatus(singleHopperReading({ food1: 99, food2: 99 }), NOW)
    expect(slice.food1).toBeNull()
    expect(slice.food2).toBeNull()
  })

  it('clamps an out-of-range battery reading', () => {
    expect(mapFeederToStatus(singleHopperReading({ batteryPower: 140 }), NOW).batteryPower).toBe(
      100,
    )
    expect(mapFeederToStatus(singleHopperReading({ batteryPower: -5 }), NOW).batteryPower).toBe(0)
  })

  it('carries the decoded error + raw code together', () => {
    const slice = mapFeederToStatus(
      singleHopperReading({ errorCode: 12, errorMsg: 'Lid open' }),
      NOW,
    )
    expect(slice.error).toBe('Lid open')
    expect(slice.errorCode).toBe(12)
  })
})

describe('mapFeederToStatus — dual hopper', () => {
  it('exposes per-hopper levels and a combined bowl reading', () => {
    const slice = mapFeederToStatus(dualHopperReading(), NOW)
    expect(slice.isDualHopper).toBe(true)
    expect(slice.food1).toBe(40)
    expect(slice.food2).toBe(60)
    // combined bowl derived from the two hoppers when `food` is absent
    expect(slice.foodLevel).toBe(100)
  })

  it('prefers the explicit combined bowl reading when present', () => {
    const slice = mapFeederToStatus(dualHopperReading({ food: 75 }), NOW)
    expect(slice.foodLevel).toBe(75)
  })

  it('flags lowFood when ONE hopper is empty even though the sum is not', () => {
    const slice = mapFeederToStatus(dualHopperReading({ food1: 0, food2: 60, food: null }), NOW)
    expect(slice.foodLevel).toBe(60)
    expect(slice.lowFood).toBe(true)
  })

  it('leaves foodLevel null when neither hopper reports', () => {
    const slice = mapFeederToStatus(dualHopperReading({ food1: null, food2: null }), NOW)
    expect(slice.foodLevel).toBeNull()
    expect(slice.lowFood).toBe(false)
  })
})

describe('coldStartFeederStatus', () => {
  it('withholds status until the first poll and preserves the dual-hopper flag', () => {
    const cold = coldStartFeederStatus(true)
    expect(cold.status).toBeNull()
    expect(cold.foodLevel).toBeNull()
    expect(cold.bowlFood).toBeNull()
    expect(cold.eating).toBe(false)
    expect(cold.supportsMarkRefilled).toBe(false)
    expect(cold.isDualHopper).toBe(true)
    expect(cold.lastFetchedAt).toBe(0)
  })
})

describe('last manual feed memory', () => {
  it('the slice carries the remembered portions; none remembered is null', () => {
    const fresh = mapFeederToStatus(singleHopperReading(), NOW)
    expect([fresh.lastFeedGrams, fresh.lastFeedHopper1, fresh.lastFeedHopper2]).toEqual([
      null,
      null,
      null,
    ])
    const slice = mapFeederToStatus(singleHopperReading(), NOW, {
      grams: 45,
      hopper1: 30,
      hopper2: null,
    })
    expect([slice.lastFeedGrams, slice.lastFeedHopper1, slice.lastFeedHopper2]).toEqual([
      45,
      30,
      null,
    ])
  })

  it('the cold-start slice already shows the remembered portion', () => {
    expect(
      coldStartFeederStatus(false, { grams: 60, hopper1: null, hopper2: null }).lastFeedGrams,
    ).toBe(60)
  })

  it('remembers only the portions that were fed', () => {
    expect(feedMemoryPatch({ grams: 45 })).toEqual({ lastFeedGrams: 45 })
    expect(feedMemoryPatch({ hopper2: 20 })).toEqual({ lastFeedHopper2: 20 })
    expect(feedMemoryPatch({ hopper1: 10, hopper2: 12 })).toEqual({
      lastFeedHopper1: 10,
      lastFeedHopper2: 12,
    })
  })
})
