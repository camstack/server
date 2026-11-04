/**
 * Home Assistant pulls images from the hub, so the media base is a hub address ROLE
 * (D734, D986 §5): `publicEndpoint` by default (falling back to `internal` when none is set), `internal` when that broker's
 * `ha-export-links` record says so. Read per use from the palette, never stored as a URL.
 */
import { describe, expect, it } from 'vitest'
import {
  haMediaBaseUrl,
  mediaBasesByBroker,
  usedInternalFallback,
  type HaMediaRole,
  type MediaAddressAnswer,
} from '../media-url.js'

const book = (internal: string | null, publicEndpoint: string | null): MediaAddressAnswer => ({
  roles: {
    internal: { resolved: internal },
    publicEndpoint: { resolved: publicEndpoint },
  },
})

describe('haMediaBaseUrl', () => {
  it('is the public endpoint when that role is chosen and resolved', () => {
    expect(
      haMediaBaseUrl(book('http://192.0.2.10:4480', 'https://cams.example.org'), 'publicEndpoint'),
    ).toBe('https://cams.example.org')
  })

  it('is the internal address when internal is chosen, even with a public endpoint set', () => {
    expect(
      haMediaBaseUrl(book('http://192.0.2.10:4480', 'https://cams.example.org'), 'internal'),
    ).toBe('http://192.0.2.10:4480')
  })

  it('falls back to internal when the public endpoint resolves to nothing', () => {
    expect(haMediaBaseUrl(book('http://192.0.2.10:4480', null), 'publicEndpoint')).toBe(
      'http://192.0.2.10:4480',
    )
  })

  it('never falls back to public when internal is chosen and unresolved', () => {
    expect(haMediaBaseUrl(book(null, 'https://cams.example.org'), 'internal')).toBeNull()
  })

  it('is null when neither role resolves — never a loopback substitute', () => {
    expect(haMediaBaseUrl(book(null, null), 'publicEndpoint')).toBeNull()
  })
})

describe('usedInternalFallback', () => {
  it('is true only when public was chosen, is unresolved, and internal answered', () => {
    expect(usedInternalFallback(book('http://a', null), 'publicEndpoint')).toBe(true)
    expect(usedInternalFallback(book('http://a', 'https://p'), 'publicEndpoint')).toBe(false)
    expect(usedInternalFallback(book('http://a', null), 'internal')).toBe(false)
    expect(usedInternalFallback(book(null, null), 'publicEndpoint')).toBe(false)
  })
})

describe('mediaBasesByBroker', () => {
  it('gives two brokers two roles and two bases', () => {
    const roles: Record<string, HaMediaRole> = {
      'lan-ha': 'internal',
      'remote-ha': 'publicEndpoint',
    }
    const bases = mediaBasesByBroker(
      ['lan-ha', 'remote-ha', 'unset-ha'],
      book('http://192.0.2.10:4480', 'https://cams.example.org'),
      (id) => roles[id] ?? 'publicEndpoint',
    )
    expect(Object.fromEntries(bases)).toEqual({
      'lan-ha': 'http://192.0.2.10:4480',
      'remote-ha': 'https://cams.example.org',
      'unset-ha': 'https://cams.example.org',
    })
  })

  it('follows a role change on the next read, with no restart', () => {
    const role = (): HaMediaRole => 'publicEndpoint'
    expect(
      mediaBasesByBroker(['b1'], book('http://a', 'https://one.example.org'), role).get('b1'),
    ).toBe('https://one.example.org')
    expect(
      mediaBasesByBroker(['b1'], book('http://a', 'https://two.example.org'), role).get('b1'),
    ).toBe('https://two.example.org')
  })
})
