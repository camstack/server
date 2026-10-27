import { describe, expect, it } from 'vitest'
import {
  isWirelessLabel,
  linkTypeOf,
  mapNetworkReadout,
  signalPercentOf,
} from '../network-link-mapping.js'

describe('linkTypeOf', () => {
  it('reads the firmware label', () => {
    expect(linkTypeOf({ activeLink: 'Wifi', ssid: undefined })).toBe('wifi')
    expect(linkTypeOf({ activeLink: 'LAN', ssid: undefined })).toBe('ethernet')
    expect(linkTypeOf({ activeLink: '4G', ssid: undefined })).toBe('cellular')
  })

  it('is unknown when the firmware said nothing — never a default wire', () => {
    expect(linkTypeOf({ activeLink: undefined, ssid: undefined })).toBe('unknown')
  })

  it('a camera that named the network it joined is on wifi whatever its label', () => {
    expect(linkTypeOf({ activeLink: undefined, ssid: 'casa' })).toBe('wifi')
  })

  it('a bare signal number without an SSID is NOT a wifi link (the PoE camera that answered -10)', () => {
    expect(
      mapNetworkReadout({ activeLink: undefined, wifiSignal: -10, ssid: undefined }, 1),
    ).toEqual({ type: 'unknown', signal: null, lastUpdated: 1 })
  })

  it('only a wireless label is worth a signal read', () => {
    expect(isWirelessLabel('Wifi')).toBe(true)
    expect(isWirelessLabel('LAN')).toBe(false)
    expect(isWirelessLabel(undefined)).toBe(false)
  })
})

describe('signalPercentOf — the scale is read off the number', () => {
  it('treats 0..4 as bars', () => {
    expect(signalPercentOf(3)).toBe(75)
    expect(signalPercentOf(0)).toBe(0)
  })

  it('treats 5..100 as a percent already', () => {
    expect(signalPercentOf(67)).toBe(67)
  })

  it('treats a negative value as dBm', () => {
    expect(signalPercentOf(-75)).toBe(50)
  })

  it('is not a reading beyond 100 or when absent', () => {
    expect(signalPercentOf(250)).toBeNull()
    expect(signalPercentOf(undefined)).toBeNull()
  })
})

describe('mapNetworkReadout', () => {
  it('a wifi link carries its normalised signal and its network name', () => {
    expect(mapNetworkReadout({ activeLink: 'Wifi', wifiSignal: 4, ssid: 'casa' }, 1000)).toEqual({
      type: 'wifi',
      signal: 100,
      ssid: 'casa',
      lastUpdated: 1000,
    })
  })

  it('a wired link has no signal and no network name, whatever the firmware left behind', () => {
    expect(mapNetworkReadout({ activeLink: 'LAN', wifiSignal: 4, ssid: 'casa' }, 1000)).toEqual({
      type: 'ethernet',
      signal: null,
      lastUpdated: 1000,
    })
  })

  it('keeps the raw dBm next to the percent', () => {
    expect(mapNetworkReadout({ activeLink: 'Wifi', wifiSignal: -60, ssid: 'casa' }, 1000)).toEqual({
      type: 'wifi',
      signal: 80,
      rssi: -60,
      ssid: 'casa',
      lastUpdated: 1000,
    })
  })
})
