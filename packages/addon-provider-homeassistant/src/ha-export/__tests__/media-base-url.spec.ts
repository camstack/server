/**
 * Home Assistant pulls images from the hub, so the media base is a hub address ROLE
 * (D734, D986 §5): `internal` by default, `publicEndpoint` when that broker's
 * integration says so. Read per use from the palette, never stored as a URL.
 */
import { describe, expect, it } from 'vitest'
import {
  haMediaBaseUrl,
  haMediaRoleOf,
  mediaBasesByBroker,
  mediaRoleKey,
  type MediaAddressAnswer,
} from '../media-url.js'

const book = (internal: string | null, publicEndpoint: string | null): MediaAddressAnswer => ({
  roles: {
    internal: { resolved: internal },
    publicEndpoint: { resolved: publicEndpoint },
  },
})

describe('haMediaBaseUrl', () => {
  it('is the internal address by default, even when a public endpoint is set', () => {
    expect(haMediaBaseUrl(book('http://192.0.2.10:4480', 'https://cams.example.org'))).toBe(
      'http://192.0.2.10:4480',
    )
  })

  it('is the public endpoint when that role is asked for', () => {
    expect(
      haMediaBaseUrl(book('http://192.0.2.10:4480', 'https://cams.example.org'), 'publicEndpoint'),
    ).toBe('https://cams.example.org')
  })

  it('is null when the role resolves to nothing — never a loopback substitute', () => {
    expect(haMediaBaseUrl(book(null, 'https://cams.example.org'))).toBeNull()
    expect(haMediaBaseUrl(book('http://192.0.2.10:4480', null), 'publicEndpoint')).toBeNull()
  })
})

describe('haMediaRoleOf', () => {
  it('defaults to internal and ignores anything that is not a known role', () => {
    expect(haMediaRoleOf({}, 'b1')).toBe('internal')
    expect(haMediaRoleOf({ [mediaRoleKey('b1')]: 'https://typed-url' }, 'b1')).toBe('internal')
    expect(haMediaRoleOf({ [mediaRoleKey('b1')]: 'publicEndpoint' }, 'b1')).toBe('publicEndpoint')
  })
})

describe('mediaBasesByBroker', () => {
  it('gives two brokers two roles and two bases', () => {
    const store = {
      [mediaRoleKey('lan-ha')]: 'internal',
      [mediaRoleKey('remote-ha')]: 'publicEndpoint',
    }
    const bases = mediaBasesByBroker(
      store,
      ['lan-ha', 'remote-ha', 'unset-ha'],
      book('http://192.0.2.10:4480', 'https://cams.example.org'),
    )
    expect(Object.fromEntries(bases)).toEqual({
      'lan-ha': 'http://192.0.2.10:4480',
      'remote-ha': 'https://cams.example.org',
      'unset-ha': 'http://192.0.2.10:4480',
    })
  })

  it('follows a role change on the next read, with no restart', () => {
    const store = { [mediaRoleKey('b1')]: 'publicEndpoint' }
    expect(
      mediaBasesByBroker(store, ['b1'], book('http://a', 'https://one.example.org')).get('b1'),
    ).toBe('https://one.example.org')
    expect(
      mediaBasesByBroker(store, ['b1'], book('http://a', 'https://two.example.org')).get('b1'),
    ).toBe('https://two.example.org')
  })
})
