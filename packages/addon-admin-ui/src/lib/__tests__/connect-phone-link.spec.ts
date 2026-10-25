import type { ConnectionEndpoint } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  buildConnectLink,
  classifyPhoneTier,
  rankPhoneCandidates,
  selectPhoneCandidate,
  toHubOrigin,
} from '../connect-phone-link'

function ep(overrides: Partial<ConnectionEndpoint> & Pick<ConnectionEndpoint, 'baseUrl'>) {
  const base: ConnectionEndpoint = {
    label: 'LAN — eth0',
    baseUrl: overrides.baseUrl,
    kind: 'lan-ipv4',
    interfaceKind: 'lan',
    plausible: true,
    plausibleReason: '',
    priority: 0,
  }
  return { ...base, ...overrides }
}

/** The palette shape `buildEndpoints` returns: sorted by the SDK race order. */
const PALETTE: readonly ConnectionEndpoint[] = [
  ep({ baseUrl: 'http://192.168.10.9:4080', priority: 0 }),
  ep({
    baseUrl: 'http://172.17.0.1:4080',
    label: 'Docker — docker0',
    interfaceKind: 'docker',
    plausible: false,
    plausibleReason: 'docker bridge',
    priority: 10,
  }),
  ep({ baseUrl: 'http://[fd00::9]:4080', kind: 'lan-ipv6', label: 'LAN (IPv6)', priority: 11 }),
  ep({
    baseUrl: 'https://cam.example.top',
    kind: 'public',
    interfaceKind: 'public',
    label: 'Public tunnel',
    priority: 100,
  }),
  ep({
    baseUrl: 'https://hub.tail1234.ts.net:4443',
    kind: 'public',
    interfaceKind: 'vpn',
    label: 'Mesh (Tailscale)',
    priority: 150,
  }),
  ep({
    baseUrl: 'https://127.0.0.1:4443',
    kind: 'loopback',
    interfaceKind: 'loopback',
    plausible: false,
    priority: 1000,
  }),
]

describe('classifyPhoneTier', () => {
  it('tells the mesh apart from the tunnel by interfaceKind', () => {
    expect(classifyPhoneTier(PALETTE[3])).toBe('public')
    expect(classifyPhoneTier(PALETTE[4])).toBe('mesh')
  })

  it('refuses loopback — it is no phone route', () => {
    expect(classifyPhoneTier(PALETTE[5])).toBeNull()
  })
})

describe('toHubOrigin', () => {
  it('keeps a non-default port and drops a default one', () => {
    expect(toHubOrigin('https://hub.tail1234.ts.net:4443')).toBe('https://hub.tail1234.ts.net:4443')
    expect(toHubOrigin('https://cam.example.top:443')).toBe('https://cam.example.top')
  })

  it('reduces a base with a path, query or fragment to its origin', () => {
    expect(toHubOrigin('https://cam.example.top/viewer/camstack/?x=1#y')).toBe(
      'https://cam.example.top',
    )
  })

  it('refuses credentials, non-http schemes and garbage', () => {
    expect(toHubOrigin('https://user:pw@cam.example.top')).toBeNull()
    expect(toHubOrigin('camstack://auth-callback')).toBeNull()
    expect(toHubOrigin('not a url')).toBeNull()
  })

  it('keeps an IPv6 literal bracketed', () => {
    expect(toHubOrigin('http://[fd00::9]:4080')).toBe('http://[fd00::9]:4080')
  })
})

describe('rankPhoneCandidates', () => {
  it('orders public tunnel, then mesh, then LAN, then LAN IPv6 — never loopback', () => {
    const origins = rankPhoneCandidates(PALETTE).map((c) => c.origin)
    expect(origins).toEqual([
      'https://cam.example.top',
      'https://hub.tail1234.ts.net:4443',
      'http://192.168.10.9:4080',
      'http://172.17.0.1:4080',
      'http://[fd00::9]:4080',
    ])
  })

  it('puts a plausible LAN address ahead of an implausible one even at worse priority', () => {
    const ranked = rankPhoneCandidates([
      ep({ baseUrl: 'http://172.17.0.1:4080', plausible: false, priority: 0 }),
      ep({ baseUrl: 'http://192.168.10.9:4080', plausible: true, priority: 20 }),
    ])
    expect(ranked.map((c) => c.origin)).toEqual([
      'http://192.168.10.9:4080',
      'http://172.17.0.1:4080',
    ])
  })

  it('without a tunnel, Tailscale MagicDNS leads', () => {
    const ranked = rankPhoneCandidates(PALETTE.filter((e) => e.interfaceKind !== 'public'))
    expect(ranked[0]?.tier).toBe('mesh')
    expect(ranked[0]?.origin).toBe('https://hub.tail1234.ts.net:4443')
  })

  it('collapses two endpoints that reduce to the same origin', () => {
    const ranked = rankPhoneCandidates([
      ep({ baseUrl: 'https://cam.example.top', kind: 'public', interfaceKind: 'public' }),
      ep({ baseUrl: 'https://cam.example.top:443/', kind: 'public', interfaceKind: 'public' }),
    ])
    expect(ranked).toHaveLength(1)
  })

  it('flags plain-http origins as not secure', () => {
    const ranked = rankPhoneCandidates(PALETTE)
    expect(ranked.find((c) => c.tier === 'public')?.secure).toBe(true)
    expect(ranked.find((c) => c.tier === 'lan')?.secure).toBe(false)
  })

  it('answers an empty palette with an empty list', () => {
    expect(rankPhoneCandidates([])).toEqual([])
  })
})

describe('selectPhoneCandidate', () => {
  const candidates = rankPhoneCandidates(PALETTE)

  it('defaults to the best-ranked candidate', () => {
    expect(selectPhoneCandidate(candidates, null)?.origin).toBe('https://cam.example.top')
  })

  it('honours the operator pick while it is still advertised', () => {
    expect(selectPhoneCandidate(candidates, 'http://192.168.10.9:4080')?.origin).toBe(
      'http://192.168.10.9:4080',
    )
  })

  it('falls back to the best when the pick is no longer advertised', () => {
    expect(selectPhoneCandidate(candidates, 'https://gone.example')?.origin).toBe(
      'https://cam.example.top',
    )
  })

  it('is null only for an empty list', () => {
    expect(selectPhoneCandidate([], null)).toBeNull()
  })
})

describe('buildConnectLink', () => {
  it('carries only the encoded origin on the central domain', () => {
    const link = buildConnectLink('https://hub.tail1234.ts.net:4443')
    expect(link).toBe(
      'https://camstack.zentik.app/connect?hub=https%3A%2F%2Fhub.tail1234.ts.net%3A4443',
    )
    const parsed = new URL(link)
    expect([...parsed.searchParams.keys()]).toEqual(['hub'])
    expect(parsed.searchParams.get('hub')).toBe('https://hub.tail1234.ts.net:4443')
  })

  it('round-trips an IPv6 LAN origin', () => {
    const link = buildConnectLink('http://[fd00::9]:4080')
    expect(new URL(link).searchParams.get('hub')).toBe('http://[fd00::9]:4080')
  })
})
