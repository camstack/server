import { describe, expect, it } from 'vitest'
import {
  AUTOMATIC_HUB_ADDRESS_FLAGS,
  checkRoleAddress,
  type HubAddressFlags,
  resolveInternalAddress,
  resolveNotificationTapAddress,
  resolvePublicEndpoint,
  resolveAppConnections,
  validateCustomAddress,
} from '../hub-address.js'
import type { ConnectionEndpoint } from '../local-network.cap.js'

function ep(over: Partial<ConnectionEndpoint> & Pick<ConnectionEndpoint, 'baseUrl'>) {
  const base: ConnectionEndpoint = {
    label: 'LAN — eth0',
    baseUrl: over.baseUrl,
    kind: 'lan-ipv4',
    interfaceKind: 'lan',
    plausible: true,
    plausibleReason: '',
    priority: 0,
  }
  return { ...base, ...over }
}

const loopback = ep({
  baseUrl: 'https://127.0.0.1:4443',
  kind: 'loopback',
  interfaceKind: 'loopback',
  plausible: false,
  priority: 1000,
})
const lan = ep({ baseUrl: 'https://192.0.2.10:4443', priority: 0 })
const localName = ep({ baseUrl: 'http://camstack.local:4480', priority: 0 })
const dockerBridge = ep({
  baseUrl: 'https://172.17.0.2:4443',
  interfaceKind: 'docker',
  plausible: false,
  priority: 11,
})
const ipv6 = ep({ baseUrl: 'https://[fd00::9]:4443', kind: 'lan-ipv6', priority: 12 })
const tunnel = ep({
  baseUrl: 'https://cams.example.com/',
  kind: 'public',
  interfaceKind: 'public',
  priority: 100,
})
const mesh = ep({
  baseUrl: 'https://hub.tail1234.ts.net:4443',
  kind: 'public',
  interfaceKind: 'vpn',
  priority: 150,
})
const appLink = ep({
  baseUrl: 'https://camstack.zentik.app',
  kind: 'app-link',
  interfaceKind: 'public',
  priority: -1,
})

const custom = ep({
  label: 'Custom',
  baseUrl: 'https://cams.example.org',
  kind: 'custom',
  interfaceKind: 'other',
  priority: 200,
})

function flags(over: Partial<HubAddressFlags> = {}): HubAddressFlags {
  return { ...AUTOMATIC_HUB_ADDRESS_FLAGS, ...over }
}

const internal = (endpoints: readonly ConnectionEndpoint[], f = flags()) =>
  resolveInternalAddress(endpoints, f).resolved
const publicEndpoint = (endpoints: readonly ConnectionEndpoint[], f = flags()) =>
  resolvePublicEndpoint(endpoints, f).resolved

describe('internal — automatic (agents, LAN devices)', () => {
  it('hands out the LAN IPv4 literal, never loopback or the tunnel', () => {
    expect(internal([appLink, tunnel, loopback, lan, mesh])).toBe('https://192.0.2.10:4443')
  })

  it('prefers an IP literal over a local name an agent container may not resolve', () => {
    expect(internal([localName, lan])).toBe('https://192.0.2.10:4443')
  })

  it('falls back to a plausible LAN IPv6, then the mesh', () => {
    expect(internal([ipv6, mesh, loopback])).toBe('https://[fd00::9]:4443')
    expect(internal([mesh, tunnel, loopback])).toBe('https://hub.tail1234.ts.net:4443')
  })

  it('answers null — never loopback — when nothing reachable is advertised', () => {
    expect(resolveInternalAddress([loopback, dockerBridge, tunnel, appLink], flags())).toEqual({
      flagged: null,
      resolved: null,
      source: 'none',
    })
    expect(internal([])).toBeNull()
  })

  it('a custom address is never an automatic pick', () => {
    expect(internal([custom])).toBeNull()
    expect(publicEndpoint([custom])).toBeNull()
  })
})

describe('publicEndpoint — automatic (auth links, callbacks, relying party, notification links)', () => {
  it('prefers the public tunnel, then the mesh, then the LAN', () => {
    expect(publicEndpoint([lan, mesh, tunnel, appLink])).toBe('https://cams.example.com')
    expect(publicEndpoint([lan, mesh])).toBe('https://hub.tail1234.ts.net:4443')
    expect(publicEndpoint([loopback, lan])).toBe('https://192.0.2.10:4443')
  })

  it('never answers loopback or the app link', () => {
    expect(publicEndpoint([loopback, appLink])).toBeNull()
  })
})

describe('an unstable address (a Quick tunnel, D860)', () => {
  const quick = ep({
    baseUrl: 'https://random-words.trycloudflare.com',
    kind: 'public',
    interfaceKind: 'public',
    priority: 100,
    stable: false,
  })

  it('is never the automatic public endpoint: the next best address answers', () => {
    expect(publicEndpoint([lan, quick])).toBe('https://192.0.2.10:4443')
    expect(publicEndpoint([lan, mesh, quick])).toBe('https://hub.tail1234.ts.net:4443')
    expect(publicEndpoint([quick])).toBeNull()
  })

  it('is never an automatic app connection', () => {
    expect(resolveAppConnections([lan, quick], flags()).resolved).toEqual([lan.baseUrl])
  })

  it('a named tunnel (stable) is picked as before', () => {
    expect(publicEndpoint([lan, { ...quick, stable: true }])).toBe(
      'https://random-words.trycloudflare.com',
    )
  })

  it('an explicit flag still wins', () => {
    const res = resolvePublicEndpoint([lan, quick], flags({ publicEndpoint: quick.baseUrl }))
    expect(res).toMatchObject({ resolved: quick.baseUrl, source: 'flagged' })
  })
})

describe('a flagged address', () => {
  it('wins over detection for its role only', () => {
    const f = flags({ internal: 'https://10.8.0.1:4443' })
    expect(resolveInternalAddress([lan, mesh], f)).toEqual({
      flagged: 'https://10.8.0.1:4443',
      resolved: 'https://10.8.0.1:4443',
      source: 'flagged',
    })
    expect(resolvePublicEndpoint([lan, tunnel], f).source).toBe('auto')
  })

  it('a flagged detected address and a flagged custom one resolve the same way', () => {
    expect(publicEndpoint([lan, tunnel, custom], flags({ publicEndpoint: lan.baseUrl }))).toBe(
      lan.baseUrl,
    )
    expect(publicEndpoint([lan, tunnel, custom], flags({ publicEndpoint: custom.baseUrl }))).toBe(
      custom.baseUrl,
    )
  })

  it('a stored value that is not valid is never handed out', () => {
    expect(internal([lan], flags({ internal: 'https://127.0.0.1:4443' }))).toBe(
      'https://192.0.2.10:4443',
    )
    expect(internal([lan], flags({ internal: 'https://camstack.zentik.app' }))).toBe(
      'https://192.0.2.10:4443',
    )
  })
})

describe('notificationTaps', () => {
  it('automatic is the CamStack app link (D709)', () => {
    expect(resolveNotificationTapAddress(flags())).toEqual({
      flagged: null,
      resolved: 'https://camstack.zentik.app',
      source: 'auto',
    })
  })

  it('a flagged address wins; the app link flagged is automatic', () => {
    expect(
      resolveNotificationTapAddress(flags({ notificationTaps: custom.baseUrl })).resolved,
    ).toBe(custom.baseUrl)
    expect(
      resolveNotificationTapAddress(flags({ notificationTaps: 'https://camstack.zentik.app' }))
        .source,
    ).toBe('auto')
  })
})

describe('appConnections', () => {
  it('automatic is LAN IPv4 + the tunnel, never a custom address', () => {
    expect(resolveAppConnections([lan, ipv6, tunnel, mesh, custom], flags())).toEqual({
      flagged: [],
      resolved: [lan.baseUrl, tunnel.baseUrl],
      source: 'auto',
    })
  })

  it('flagged addresses — detected or custom — are what the apps race', () => {
    const res = resolveAppConnections(
      [lan, tunnel, custom],
      flags({ appConnections: [lan.baseUrl, custom.baseUrl] }),
    )
    expect(res.resolved).toEqual([lan.baseUrl, custom.baseUrl])
    expect(res.source).toBe('flagged')
  })
})

describe('validateCustomAddress', () => {
  it('accepts an http(s) origin and normalises it', () => {
    expect(validateCustomAddress(' https://192.0.2.20:4443/ ')).toEqual({
      ok: true,
      baseUrl: 'https://192.0.2.20:4443',
    })
    expect(validateCustomAddress('http://hub.lan:8080')).toEqual({
      ok: true,
      baseUrl: 'http://hub.lan:8080',
    })
  })

  it.each([
    'https://127.0.0.1:4443',
    'https://127.1.2.3',
    'http://localhost:4443',
    'https://[::1]:4443',
    'https://0.0.0.0:4443',
  ])('rejects loopback %s', (raw) => {
    const check = validateCustomAddress(raw)
    expect(check.ok).toBe(false)
  })

  it.each([
    '',
    'not a url',
    'ftp://hub.lan',
    'https://user:pw@hub.lan',
    'https://hub.lan/path',
  ])('rejects %s', (raw) => {
    expect(validateCustomAddress(raw).ok).toBe(false)
  })
})

describe('checkRoleAddress', () => {
  it('refuses a plain-http public endpoint unless accepted; other roles take http', () => {
    expect(checkRoleAddress('publicEndpoint', 'http://hub.lan:4480').ok).toBe(false)
    expect(
      checkRoleAddress('publicEndpoint', 'http://hub.lan:4480', { acceptInsecureHttp: true }).ok,
    ).toBe(true)
    expect(checkRoleAddress('internal', 'http://hub.lan:4480').ok).toBe(true)
    expect(checkRoleAddress('publicEndpoint', 'https://hub.lan').ok).toBe(true)
  })

  it('the app link carries notificationTaps only — never the public endpoint', () => {
    expect(checkRoleAddress('notificationTaps', 'https://camstack.zentik.app').ok).toBe(true)
    expect(checkRoleAddress('internal', 'https://camstack.zentik.app').ok).toBe(false)
    expect(checkRoleAddress('appConnections', 'https://camstack.zentik.app').ok).toBe(false)
    // Even with http accepted: the app link is no hub address, and a signed
    // link or a sign-in callback minted on it would 404 at the central domain.
    expect(
      checkRoleAddress('publicEndpoint', 'https://camstack.zentik.app', {
        acceptInsecureHttp: true,
      }).ok,
    ).toBe(false)
    expect(publicEndpoint([lan], flags({ publicEndpoint: 'https://camstack.zentik.app' }))).toBe(
      lan.baseUrl,
    )
  })
})
