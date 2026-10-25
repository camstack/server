import { describe, expect, it } from 'vitest'
import {
  deriveChargingSource,
  reportsPowerSource,
  type PowerSourceFields,
} from '../battery-charging.js'

/**
 * REGRESSION, measured on the live fleet 2026-09-05.
 *
 * `adapterStatus` says whether mains power is CONNECTED (0 none · 1 DC · 2
 * solar, translated at the hub boundary to 'none' / 'dc' / 'solarPanel').
 * `chargeStatus` says what the CELL is doing (0 none · 1 charging · 2 complete).
 *
 * The old derivation consulted `adapter` only for 'solar', so a connected DC
 * adapter fell through to 'none'. Two Argus 3E (batteryVersion 2) hid it by
 * accident: full and plugged they answer `chargeStatus: 2` (chargeComplete),
 * which the `isCharging` branch mapped to 'dc' for the wrong reason. The Argus
 * MagiCam (batteryVersion 1, 2026 firmware) answers `chargeStatus: 0` while
 * plugged in permanently, and was reported NOT CHARGING for its whole life.
 *
 * Proof `adapterStatus` is a real signal and not a constant: on 2026-09-05 the
 * operator unplugged device 3628 and the raw hub payload moved from
 * `adapterStatus: 1` to `adapterStatus: 0`, with `chargeStatus: 0` on BOTH
 * sides — i.e. `chargeStatus` alone cannot tell the two states apart.
 */
describe('deriveChargingSource', () => {
  it('reports dc when the adapter is connected even if the cell is idle (Argus MagiCam)', () => {
    expect(deriveChargingSource('dc', 'none')).toBe('dc')
  })

  it('reports none when the adapter is gone and the cell is idle (3628 unplugged)', () => {
    expect(deriveChargingSource('none', 'none')).toBe('none')
  })

  it('still reports dc from the cell alone when the adapter field is absent', () => {
    expect(deriveChargingSource(undefined, 'charging')).toBe('dc')
    expect(deriveChargingSource(undefined, 'chargeComplete')).toBe('dc')
  })

  it('prefers solar over dc — the panel is the source, whatever the cell says', () => {
    expect(deriveChargingSource('solarPanel', 'charging')).toBe('solar')
    expect(deriveChargingSource('solarPanel', 'none')).toBe('solar')
  })

  it('is case-insensitive on both vocabularies', () => {
    expect(deriveChargingSource('DC', 'NONE')).toBe('dc')
    expect(deriveChargingSource('SolarPanel', 'none')).toBe('solar')
  })

  it('says UNKNOWN — never none, never dc — when neither field was reported', () => {
    // 'none' is a NEGATIVE ("running on battery alone"); two unreadable
    // fields are not that, they are the absence of an answer (D315).
    expect(deriveChargingSource(undefined, undefined)).toBe('unknown')
  })

  it('still says none when the firmware SAID none on both fields', () => {
    expect(deriveChargingSource('none', 'none')).toBe('none')
  })
})

/**
 * A battery push (`batteryPush` frame, nodelink `parseBatteryInfoXml`) may
 * carry ONLY `batteryPercent`: every field of `BatteryInfo` is optional and the
 * parser dispatches as soon as one of the three is present. Feeding such a push
 * through `deriveChargingSource` answers 'none' — a NEGATIVE standing in for
 * "nothing was said" — and overwrites a known 'dc'. The caller keeps its
 * previous belief when the push reports no power source, exactly as it already
 * does for a push with no numeric level.
 */
describe('reportsPowerSource', () => {
  it('is true when either field is present', () => {
    expect(reportsPowerSource({ adapterStatus: 'dc' })).toBe(true)
    expect(reportsPowerSource({ chargeStatus: 'none' })).toBe(true)
  })

  it('is false when the push says nothing about power', () => {
    const levelOnly: PowerSourceFields & { batteryPercent: number } = { batteryPercent: 83 }
    expect(reportsPowerSource(levelOnly)).toBe(false)
    expect(reportsPowerSource({})).toBe(false)
  })
})
