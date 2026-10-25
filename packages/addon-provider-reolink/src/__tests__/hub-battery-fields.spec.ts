import { describe, expect, it } from 'vitest'
import { mapHubBatteryPower, UnmappedCodeLedger } from '../hub-battery-fields.js'

/**
 * The hub boundary translates the firmware's numeric `chargeStatus` /
 * `adapterStatus` (0/1/2) into the standalone path's string vocabulary. A code
 * outside 0..2 used to vanish: `undefined`, the field dropped from the push,
 * and the derivation fell back to "nothing was said". A new firmware value
 * (a fourth power state, a different encoding) would therefore have been
 * INVISIBLE — no log line, the previous belief kept forever.
 */
describe('mapHubBatteryPower', () => {
  it('maps the known codes to the standalone vocabulary', () => {
    const r = mapHubBatteryPower({ chargeStatus: 2, adapterStatus: 1 })
    expect(r.fields).toEqual({ chargeStatus: 'chargeComplete', adapterStatus: 'dc' })
    expect(r.unmapped).toEqual([])
  })

  it('passes a string vocabulary through untouched', () => {
    const r = mapHubBatteryPower({ chargeStatus: 'charging', adapterStatus: 'solarPanel' })
    expect(r.fields).toEqual({ chargeStatus: 'charging', adapterStatus: 'solarPanel' })
  })

  it('drops the field AND names the code it could not map', () => {
    const r = mapHubBatteryPower({ chargeStatus: 7, adapterStatus: 0 })
    expect(r.fields).toEqual({ adapterStatus: 'none' })
    expect(r.unmapped).toEqual([{ field: 'chargeStatus', value: 7 }])
  })

  it('an absent field is absent, not unmapped', () => {
    const r = mapHubBatteryPower({ chargeStatus: 1 })
    expect(r.fields).toEqual({ chargeStatus: 'charging' })
    expect(r.unmapped).toEqual([])
    expect(mapHubBatteryPower(undefined)).toEqual({ fields: {}, unmapped: [] })
  })
})

describe('UnmappedCodeLedger', () => {
  it('reports a (device, field, code) triple the first time only', () => {
    const ledger = new UnmappedCodeLedger()
    expect(ledger.firstSeen(101, 'chargeStatus', 7)).toBe(true)
    expect(ledger.firstSeen(101, 'chargeStatus', 7)).toBe(false)
    // A different code, or a different camera, is its own finding.
    expect(ledger.firstSeen(101, 'chargeStatus', 8)).toBe(true)
    expect(ledger.firstSeen(102, 'chargeStatus', 7)).toBe(true)
  })
})
