import { describe, expect, it } from 'vitest'
import {
  NETWORK_LINK_UNKNOWN,
  NetworkLinkStatusSchema,
  signalPercentFromBars,
  signalPercentFromRssi,
} from '../network-link.cap.js'

describe('network-link — the seed is unknown, not a wire', () => {
  it('seeds with type unknown and no signal, and the schema accepts it', () => {
    expect(NetworkLinkStatusSchema.parse(NETWORK_LINK_UNKNOWN)).toEqual({
      type: 'unknown',
      signalPercent: null,
      lastUpdated: 0,
    })
  })

  it('refuses a signal outside 0..100 — a provider must normalise, never pass through', () => {
    expect(() =>
      NetworkLinkStatusSchema.parse({ type: 'wifi', signalPercent: 250, lastUpdated: 1 }),
    ).toThrow()
  })
})

describe('signalPercentFromBars', () => {
  it('maps 0..4 bars linearly to 0..100', () => {
    expect(signalPercentFromBars(0, 4)).toBe(0)
    expect(signalPercentFromBars(1, 4)).toBe(25)
    expect(signalPercentFromBars(3, 4)).toBe(75)
    expect(signalPercentFromBars(4, 4)).toBe(100)
  })

  it('is null for an absent, non-finite or out-of-range reading', () => {
    expect(signalPercentFromBars(undefined, 4)).toBeNull()
    expect(signalPercentFromBars(Number.NaN, 4)).toBeNull()
    expect(signalPercentFromBars(5, 4)).toBeNull()
    expect(signalPercentFromBars(-1, 4)).toBeNull()
    expect(signalPercentFromBars(2, 0)).toBeNull()
  })
})

describe('signalPercentFromRssi', () => {
  it('maps -100..-50 dBm linearly to 0..100 and clamps beyond', () => {
    expect(signalPercentFromRssi(-100)).toBe(0)
    expect(signalPercentFromRssi(-75)).toBe(50)
    expect(signalPercentFromRssi(-50)).toBe(100)
    expect(signalPercentFromRssi(-30)).toBe(100)
    expect(signalPercentFromRssi(-120)).toBe(0)
  })

  it('is null for an absent, non-finite or positive value — that is not an RSSI', () => {
    expect(signalPercentFromRssi(undefined)).toBeNull()
    expect(signalPercentFromRssi(Number.POSITIVE_INFINITY)).toBeNull()
    expect(signalPercentFromRssi(12)).toBeNull()
  })
})
