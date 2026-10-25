import { describe, expect, it } from 'vitest'
import type { HubAddressBook } from '@camstack/types'
import {
  advertisedHubOrigins,
  claimedRequestOrigins,
  pickRequestOrigin,
  requestMountPrefix,
} from '../request-origin.js'

const NONE = { flagged: null, resolved: null, source: 'none' as const }

function book(over: Partial<HubAddressBook> = {}): HubAddressBook {
  return {
    rows: [],
    roles: {
      appConnections: { flagged: [], resolved: [], source: 'auto' },
      notificationTaps: NONE,
      internal: NONE,
      publicEndpoint: NONE,
    },
    appLinkHub: null,
    ...over,
  }
}

function row(baseUrl: string, kind: HubAddressBook['rows'][number]['kind']) {
  return {
    label: baseUrl,
    baseUrl,
    kind,
    interfaceKind: 'lan' as const,
    plausible: true,
    plausibleReason: '',
    priority: 0,
    detected: true,
    custom: false,
    flags: [],
    inUse: [],
    eligible: [],
  } as unknown as HubAddressBook['rows'][number]
}

const ALLOWED = new Set(['https://192.0.2.10:4443', 'https://camstack.example.top'])

describe('claimedRequestOrigins', () => {
  it('prefers X-Forwarded-Host over Host', () => {
    expect(
      claimedRequestOrigins({
        host: '192.0.2.10:4443',
        'x-forwarded-host': 'camstack.example.top',
        'x-forwarded-proto': 'https',
      }),
    ).toEqual(['https://camstack.example.top'])
  })

  it('tries https then http when no proto is named', () => {
    expect(claimedRequestOrigins({ host: '192.0.2.10:4443' })).toEqual([
      'https://192.0.2.10:4443',
      'http://192.0.2.10:4443',
    ])
  })

  it('takes the first value of a comma-joined forwarded header', () => {
    expect(
      claimedRequestOrigins({
        'x-forwarded-host': 'a.example, b.example',
        'x-forwarded-proto': 'https,http',
      }),
    ).toEqual(['https://a.example'])
  })

  it('normalises the default port away', () => {
    expect(
      claimedRequestOrigins({ host: 'Camstack.Example.TOP:443', 'x-forwarded-proto': 'https' }),
    ).toEqual(['https://camstack.example.top'])
  })

  it('refuses an authority with userinfo, a path or junk', () => {
    expect(claimedRequestOrigins({ host: '192.0.2.10:4443@evil.example' })).toEqual([])
    expect(claimedRequestOrigins({ host: 'evil.example/x' })).toEqual([])
    expect(claimedRequestOrigins({ host: 'evil example' })).toEqual([])
    expect(claimedRequestOrigins({})).toEqual([])
  })

  it('refuses a scheme other than http(s)', () => {
    expect(
      claimedRequestOrigins({ host: '192.0.2.10:4443', 'x-forwarded-proto': 'javascript' }),
    ).toEqual([])
  })
})

describe('pickRequestOrigin — the allowlist', () => {
  it('returns the LAN origin a LAN request started at', () => {
    expect(pickRequestOrigin({ host: '192.0.2.10:4443' }, ALLOWED)).toBe('https://192.0.2.10:4443')
  })

  it('returns the public origin a tunnelled request started at', () => {
    expect(
      pickRequestOrigin(
        {
          host: '127.0.0.1:4443',
          'x-forwarded-host': 'camstack.example.top',
          'x-forwarded-proto': 'https',
        },
        ALLOWED,
      ),
    ).toBe('https://camstack.example.top')
  })

  it('rejects a forged Host the hub does not advertise', () => {
    expect(pickRequestOrigin({ host: 'evil.example' }, ALLOWED)).toBeNull()
    expect(
      pickRequestOrigin({ host: '192.0.2.10:4443', 'x-forwarded-host': 'evil.example' }, ALLOWED),
    ).toBeNull()
  })

  it('rejects an allowlisted host on another port or scheme', () => {
    expect(pickRequestOrigin({ host: '192.0.2.10:4444' }, ALLOWED)).toBeNull()
    expect(
      pickRequestOrigin({ host: 'camstack.example.top', 'x-forwarded-proto': 'http' }, ALLOWED),
    ).toBeNull()
  })
})

describe('advertisedHubOrigins', () => {
  it('collects rows and role answers, never the app link or loopback', () => {
    const origins = advertisedHubOrigins(
      book({
        rows: [
          row('https://192.0.2.10:4443', 'lan-ipv4'),
          row('https://camstack.zentik.app', 'app-link'),
          row('https://127.0.0.1:4443', 'loopback'),
          row('https://proxy.example:8443/', 'custom'),
        ],
        roles: {
          appConnections: { flagged: [], resolved: ['https://hub.tail.ts.net'], source: 'auto' },
          notificationTaps: NONE,
          internal: { flagged: null, resolved: 'https://10.0.0.2:4443', source: 'auto' },
          publicEndpoint: {
            flagged: null,
            resolved: 'https://camstack.example.top',
            source: 'auto',
          },
        },
      }),
    )
    expect([...origins].sort()).toEqual([
      'https://10.0.0.2:4443',
      'https://192.0.2.10:4443',
      'https://camstack.example.top',
      'https://hub.tail.ts.net',
      'https://proxy.example:8443',
    ])
  })
})

describe('requestMountPrefix', () => {
  it('keeps a clean prefix without its trailing slash', () => {
    expect(requestMountPrefix({ 'x-forwarded-prefix': '/api/camstack/p/abc/' })).toBe(
      '/api/camstack/p/abc',
    )
  })

  it('drops anything that is not clean path segments', () => {
    expect(requestMountPrefix({ 'x-forwarded-prefix': '//evil.example' })).toBe('')
    expect(requestMountPrefix({ 'x-forwarded-prefix': '/a/../b' })).toBe('')
    expect(requestMountPrefix({ 'x-forwarded-prefix': '/a?b' })).toBe('')
    expect(requestMountPrefix({})).toBe('')
  })
})

describe('advertisedHubOrigins — listener origins (D794)', () => {
  // LAN HTTP on: the rows carry http://<lan>:4480 only, so the https origin the
  // admin UI is opened at is in no row and no role.
  const lanHttpOn = (listenerOrigins?: readonly string[]): HubAddressBook =>
    book({
      rows: [
        row('http://192.0.2.10:4480', 'lan-ipv4'),
        row('https://camstack.example.top', 'public'),
      ],
      roles: {
        appConnections: { flagged: [], resolved: ['http://192.0.2.10:4480'], source: 'auto' },
        notificationTaps: NONE,
        internal: { flagged: null, resolved: 'http://192.0.2.10:4480', source: 'auto' },
        publicEndpoint: { flagged: null, resolved: 'https://camstack.example.top', source: 'auto' },
      },
      ...(listenerOrigins === undefined ? {} : { listenerOrigins }),
    })

  const LISTENERS = ['https://192.0.2.10:4443', 'http://192.0.2.10:4480']

  it('lists the https listener origin although LAN HTTP replaced the LAN row', () => {
    const origins = advertisedHubOrigins(lanHttpOn(LISTENERS))
    expect(origins.has('https://192.0.2.10:4443')).toBe(true)
    expect(origins.has('http://192.0.2.10:4480')).toBe(true)
  })

  it('a request at the https LAN listener returns there, not to the public endpoint', () => {
    expect(
      pickRequestOrigin({ host: '192.0.2.10:4443' }, advertisedHubOrigins(lanHttpOn(LISTENERS))),
    ).toBe('https://192.0.2.10:4443')
  })

  it('an older hub without the field behaves as before', () => {
    const origins = advertisedHubOrigins(lanHttpOn())
    expect(origins.has('https://192.0.2.10:4443')).toBe(false)
    expect(pickRequestOrigin({ host: '192.0.2.10:4443' }, origins)).toBeNull()
  })

  it('matches exactly: another port, host or a forged Host still falls back', () => {
    const origins = advertisedHubOrigins(lanHttpOn(LISTENERS))
    expect(pickRequestOrigin({ host: '192.0.2.10:4444' }, origins)).toBeNull()
    expect(pickRequestOrigin({ host: '192.168.1.10:4443' }, origins)).toBeNull()
    expect(pickRequestOrigin({ host: 'evil.example:4443' }, origins)).toBeNull()
  })
})
