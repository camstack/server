/**
 * local-network — pure-helper test suite.
 *
 * Covers classification, preferred-interface selection, endpoint
 * ranking, and netmask → prefix-length conversion. The addon class
 * itself is a thin shell over `os.networkInterfaces()` + an event
 * subscription; the rest of the logic lives in pure helpers that this
 * suite exercises with synthetic interface lists.
 */

import type { LocalInterface } from '@camstack/types'
import {
  AUTOMATIC_HUB_ADDRESS_FLAGS,
  pickAppLinkHub,
  selectAppConnectionEndpoints,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  ALLOWLIST_RECONCILE_INTERVAL_MS,
  appLinkEndpoint,
  applyAllowlist,
  autoSeedAllowlist,
  buildEndpoints,
  classifyKind,
  enumerateOsInterfaces,
  explainNonPlausible,
  ipv6Prefix64Key,
  isPlausibleAutoSeed,
  parseProcIfInet6,
  pickPreferred,
  prefixLen,
  reconcileAllowlist,
  shouldAdvertiseIpv6,
} from '../local-network.addon.js'

// ── Fixtures ─────────────────────────────────────────────────────────

function iface(over: Partial<LocalInterface> & { name: string; address: string }): LocalInterface {
  return {
    family: 'IPv4',
    cidr: '',
    netmask: '255.255.255.0',
    internal: false,
    mac: '00:00:00:00:00:00',
    kind: classifyKind(over.name, over.address, over.internal ?? false),
    preferred: false,
    plausible: true,
    plausibleReason: '',
    ...over,
  }
}

// ── classifyKind ─────────────────────────────────────────────────────

describe('classifyKind', () => {
  it('classifies loopback by internal flag', () => {
    expect(classifyKind('lo0', '127.0.0.1', true)).toBe('loopback')
  })
  it('classifies docker bridges', () => {
    expect(classifyKind('docker0', '172.17.0.1', false)).toBe('docker')
    expect(classifyKind('br-abc123', '172.18.0.1', false)).toBe('docker')
    expect(classifyKind('veth1234', '172.19.0.1', false)).toBe('docker')
  })
  it('classifies vpn tunnels', () => {
    expect(classifyKind('tun0', '10.8.0.2', false)).toBe('vpn')
    expect(classifyKind('utun5', '100.64.0.1', false)).toBe('vpn')
    expect(classifyKind('wg0', '10.6.0.2', false)).toBe('vpn')
  })
  it('classifies wifi on linux', () => {
    expect(classifyKind('wlan0', '192.168.10.10', false)).toBe('wifi')
    expect(classifyKind('wlp3s0', '192.168.10.10', false)).toBe('wifi')
  })
  it('classifies eth* as lan', () => {
    expect(classifyKind('eth0', '192.168.10.10', false)).toBe('lan')
  })
  it('classifies macOS en0 as lan, en1+ as wifi (heuristic)', () => {
    // The platform check inspects `process.platform` — test the rule
    // it implements rather than the runtime branch (this file always
    // runs on the maintainer's machine).
    const isDarwin = process.platform === 'darwin'
    expect(classifyKind('en0', '192.168.10.10', false)).toBe('lan')
    if (isDarwin) {
      expect(classifyKind('en1', '192.168.10.10', false)).toBe('wifi')
    } else {
      expect(classifyKind('en1', '192.168.10.10', false)).toBe('lan')
    }
  })
  it('falls back to other for unknown names', () => {
    expect(classifyKind('zt0', '10.0.0.1', false)).toBe('other')
  })
})

// ── prefixLen ────────────────────────────────────────────────────────

describe('prefixLen', () => {
  it('handles common IPv4 masks', () => {
    expect(prefixLen('255.255.255.0')).toBe(24)
    expect(prefixLen('255.255.0.0')).toBe(16)
    expect(prefixLen('255.0.0.0')).toBe(8)
    expect(prefixLen('255.255.255.255')).toBe(32)
    expect(prefixLen('0.0.0.0')).toBe(0)
  })
  it('handles IPv6 masks', () => {
    expect(prefixLen('ffff:ffff:ffff:ffff::')).toBe(64)
    expect(prefixLen('ffff:ffff::')).toBe(32)
  })
  it('returns 0 for empty/garbage', () => {
    expect(prefixLen('')).toBe(0)
    expect(prefixLen('garbage')).toBe(0)
  })
})

// ── pickPreferred ────────────────────────────────────────────────────

describe('pickPreferred', () => {
  it('returns null when no usable interface exists', () => {
    expect(pickPreferred([])).toBeNull()
    expect(
      pickPreferred([
        iface({ name: 'lo0', address: '127.0.0.1', internal: true, kind: 'loopback' }),
      ]),
    ).toBeNull()
  })

  it('drops link-local 169.254.*', () => {
    const list: LocalInterface[] = [iface({ name: 'en0', address: '169.254.1.2', kind: 'lan' })]
    expect(pickPreferred(list)).toBeNull()
  })

  it('drops IPv6 candidates', () => {
    const list: LocalInterface[] = [
      iface({
        name: 'en0',
        address: 'fe80::1',
        family: 'IPv6',
        kind: 'lan',
        netmask: 'ffff:ffff:ffff:ffff::',
      }),
    ]
    expect(pickPreferred(list)).toBeNull()
  })

  it('prefers lan over wifi over docker', () => {
    const list: LocalInterface[] = [
      iface({ name: 'docker0', address: '172.17.0.1', kind: 'docker' }),
      iface({ name: 'wlan0', address: '192.168.10.10', kind: 'wifi' }),
      iface({ name: 'eth0', address: '10.0.0.5', kind: 'lan' }),
    ]
    const winner = pickPreferred(list)
    expect(winner?.name).toBe('eth0')
  })

  it('tie-breaks on most-specific netmask', () => {
    const list: LocalInterface[] = [
      iface({ name: 'eth0', address: '10.0.0.5', kind: 'lan', netmask: '255.255.0.0' }), // /16
      iface({ name: 'eth1', address: '192.168.10.5', kind: 'lan', netmask: '255.255.255.0' }), // /24
    ]
    expect(pickPreferred(list)?.name).toBe('eth1')
  })

  it('only considers IPv4 even when an IPv6 LAN exists', () => {
    const list: LocalInterface[] = [
      iface({
        name: 'en0',
        address: 'fd00::1',
        family: 'IPv6',
        kind: 'lan',
        netmask: 'ffff:ffff::',
      }),
      iface({ name: 'en0', address: '192.168.10.10', kind: 'lan' }),
    ]
    expect(pickPreferred(list)?.address).toBe('192.168.10.10')
  })
})

// ── buildEndpoints ───────────────────────────────────────────────────

describe('buildEndpoints', () => {
  const lanV4 = iface({ name: 'en0', address: '192.168.10.10', kind: 'lan' })
  const docker = iface({ name: 'docker0', address: '172.17.0.1', kind: 'docker' })
  const ipv6 = iface({
    name: 'en0',
    address: 'fd00::1',
    family: 'IPv6',
    kind: 'lan',
    netmask: 'ffff:ffff::',
  })

  it('puts the preferred interface at priority 0', () => {
    const eps = buildEndpoints([lanV4, docker], 4000, true, false, '')
    expect(eps[0]?.baseUrl).toBe('http://192.168.10.10:4000')
    expect(eps[0]?.priority).toBe(0)
    expect(eps[0]?.kind).toBe('lan-ipv4')
  })

  it('appends the public tunnel at priority 100', () => {
    const eps = buildEndpoints([lanV4], 4000, true, false, 'camstack.example.com')
    const pub = eps.find((e) => e.kind === 'public')
    expect(pub?.baseUrl).toBe('https://camstack.example.com')
    expect(pub?.priority).toBe(100)
  })

  it('ranks LAN IPv6 with LAN IPv4, before public and loopback', () => {
    const eps = buildEndpoints([lanV4, ipv6], 4000, true, false, 'example.com')
    const v4 = eps.find((e) => e.kind === 'lan-ipv4')
    const v6 = eps.find((e) => e.kind === 'lan-ipv6')
    const pub = eps.find((e) => e.kind === 'public')
    expect(v6?.baseUrl).toBe('http://[fd00::1]:4000')
    expect(v6?.priority).toBeGreaterThan(v4?.priority ?? -1)
    expect(v6?.priority).toBeLessThan(pub?.priority ?? Number.POSITIVE_INFINITY)
    expect(eps[eps.length - 1]?.kind).toBe('loopback')
  })

  it('does not advertise non-plausible IPv6 (privacy / link-local leftovers)', () => {
    const privacy = iface({
      name: 'en0',
      address: '2a02:908:3614:bfa0:10ff:e000:3980:5ecf',
      family: 'IPv6',
      kind: 'lan',
      netmask: 'ffff:ffff:ffff:ffff::',
      plausible: false,
      plausibleReason: 'IPv6 temporary / privacy address — rotates and is not advertised.',
    })
    const eps = buildEndpoints([lanV4, privacy], 4000, false, false, '')
    expect(eps.find((e) => e.kind === 'lan-ipv6')).toBeUndefined()
  })

  it('drops IPv6 when ipv4Only=true', () => {
    const eps = buildEndpoints([lanV4, ipv6], 4000, true, true, '')
    expect(eps.find((e) => e.kind === 'lan-ipv6')).toBeUndefined()
  })

  it('drops loopback when includeLoopback=false', () => {
    const eps = buildEndpoints([lanV4], 4000, false, false, '')
    expect(eps.find((e) => e.kind === 'loopback')).toBeUndefined()
  })

  it('skips link-local IPv6 (fe80:*)', () => {
    const llIpv6 = iface({
      name: 'en0',
      address: 'fe80::abcd',
      family: 'IPv6',
      kind: 'lan',
      netmask: 'ffff:ffff:ffff:ffff::',
    })
    const eps = buildEndpoints([lanV4, llIpv6], 4000, false, false, '')
    expect(eps.find((e) => e.baseUrl.includes('fe80'))).toBeUndefined()
  })

  it('propagates interfaceKind + plausible from the source interface', () => {
    const vpnV4 = iface({
      name: 'utun0',
      address: '100.64.0.1',
      kind: 'vpn',
      plausible: false,
      plausibleReason: 'VPN tunnel',
    })
    const eps = buildEndpoints([lanV4, vpnV4], 4000, false, false, '')
    const vpn = eps.find((e) => e.baseUrl.includes('100.64.0.1'))
    expect(vpn?.interfaceKind).toBe('vpn')
    expect(vpn?.plausible).toBe(false)
    expect(vpn?.plausibleReason).toContain('VPN')
    const lan = eps.find((e) => e.baseUrl.includes('192.168.10.10'))
    expect(lan?.interfaceKind).toBe('lan')
    expect(lan?.plausible).toBe(true)
    expect(lan?.plausibleReason).toBe('')
  })

  it('tags the public endpoint as plausible', () => {
    const eps = buildEndpoints([lanV4], 4000, false, false, 'camstack.example.com')
    const pub = eps.find((e) => e.kind === 'public')
    expect(pub?.interfaceKind).toBe('public')
    expect(pub?.plausible).toBe(true)
  })

  it('emits priorities in ascending order overall', () => {
    const eps = buildEndpoints([lanV4, docker, ipv6], 4000, true, false, 'pub.example.com')
    const priorities = eps.map((e) => e.priority)
    expect(priorities).toEqual([...priorities].toSorted((a, b) => a - b))
  })

  // ── mesh endpoint (Part 2) ──────────────────────────────────────────

  it('omits the mesh endpoint when none is cached', () => {
    const eps = buildEndpoints([lanV4], 4443, true, false, '', 'https', null)
    expect(eps.find((e) => e.interfaceKind === 'vpn')).toBeUndefined()
  })

  it('omits the mesh endpoint when the cached host is empty', () => {
    const eps = buildEndpoints([lanV4], 4443, true, false, '', 'https', { host: '', port: 4443 })
    expect(eps.find((e) => e.interfaceKind === 'vpn')).toBeUndefined()
  })

  it('emits the mesh endpoint as a public-kind HTTPS URL with the stamped port', () => {
    const eps = buildEndpoints([lanV4], 4443, true, false, '', 'https', {
      host: 'camstack.tail-abc.ts.net',
      port: 4443,
    })
    const mesh = eps.find((e) => e.interfaceKind === 'vpn')
    expect(mesh?.baseUrl).toBe('https://camstack.tail-abc.ts.net:4443')
    expect(mesh?.kind).toBe('public')
    expect(mesh?.plausible).toBe(true)
    expect(mesh?.priority).toBe(150)
  })

  it('ranks the mesh endpoint below a public funnel, with LAN IPv6 still in the LAN band', () => {
    const eps = buildEndpoints([lanV4, ipv6], 4443, true, false, 'pub.example.com', 'https', {
      host: 'camstack.tail-abc.ts.net',
      port: 4443,
    })
    const pub = eps.find((e) => e.kind === 'public' && e.interfaceKind === 'public')
    const mesh = eps.find((e) => e.interfaceKind === 'vpn')
    const v6 = eps.find((e) => e.kind === 'lan-ipv6')
    expect(pub?.priority).toBe(100)
    expect(mesh?.priority).toBe(150)
    expect(v6?.priority).toBeLessThan(100)
    expect(eps[0]?.kind).toBe('lan-ipv4')
  })

  it('keeps the overall priority ordering ascending with a mesh endpoint present', () => {
    const eps = buildEndpoints(
      [lanV4, docker, ipv6],
      4443,
      true,
      false,
      'pub.example.com',
      'https',
      { host: 'mesh.tail-abc.ts.net', port: 4443 },
    )
    const priorities = eps.map((e) => e.priority)
    expect(priorities).toEqual([...priorities].toSorted((a, b) => a - b))
  })

  // ── LAN HTTP advertisement (2026-08-22 local-access spec) ──────────

  const lanHttpOn = {
    enabled: true,
    listening: true,
    httpPort: 4480,
    httpsPort: 4443,
    localHostname: null as string | null,
  }

  it('advertises LAN over HTTP when the LAN HTTP listener is up', () => {
    const eps = buildEndpoints([lanV4], 4443, true, false, '', 'https', null, lanHttpOn)
    const lan = eps.find((e) => e.kind === 'lan-ipv4')
    expect(lan?.baseUrl).toBe('http://192.168.10.10:4480')
  })

  it('advertises LAN IPv6 over HTTP on the same listener', () => {
    const eps = buildEndpoints([lanV4, ipv6], 4443, false, false, '', 'https', null, lanHttpOn)
    expect(eps.find((e) => e.kind === 'lan-ipv6')?.baseUrl).toBe('http://[fd00::1]:4480')
  })

  it('does not stamp HTTP onto the public tunnel or mesh', () => {
    const eps = buildEndpoints(
      [lanV4],
      4443,
      true,
      false,
      'pub.example.com',
      'https',
      {
        host: 'mesh.tail-abc.ts.net',
        port: 4443,
      },
      lanHttpOn,
    )
    expect(eps.find((e) => e.interfaceKind === 'public')?.baseUrl).toBe('https://pub.example.com')
    expect(eps.find((e) => e.interfaceKind === 'vpn')?.baseUrl).toBe(
      'https://mesh.tail-abc.ts.net:4443',
    )
  })

  it('keeps loopback on the HTTPS listen port', () => {
    const eps = buildEndpoints([lanV4], 4443, true, false, '', 'https', null, lanHttpOn)
    expect(eps.find((e) => e.kind === 'loopback')?.baseUrl).toBe('https://127.0.0.1:4443')
  })

  it('inserts the local hostname ahead of the raw LAN IP', () => {
    const eps = buildEndpoints([lanV4], 4443, false, false, '', 'https', null, {
      ...lanHttpOn,
      localHostname: 'camstack.lan',
    })
    const named = eps.find((e) => e.label === 'Local name')
    const raw = eps.find((e) => e.baseUrl.includes('192.168.10.10'))
    expect(named?.baseUrl).toBe('http://camstack.lan:4480')
    expect(named?.kind).toBe('lan-ipv4')
    expect(named?.priority).toBeLessThan(raw?.priority ?? Number.POSITIVE_INFINITY)
  })

  it('falls back to HTTPS LAN URLs when HTTP is off or not listening', () => {
    const off = buildEndpoints([lanV4], 4443, false, false, '', 'https', null, {
      ...lanHttpOn,
      enabled: false,
    })
    expect(off.find((e) => e.kind === 'lan-ipv4')?.baseUrl).toBe('https://192.168.10.10:4443')
    const down = buildEndpoints([lanV4], 4443, false, false, '', 'https', null, {
      ...lanHttpOn,
      listening: false,
    })
    expect(down.find((e) => e.kind === 'lan-ipv4')?.baseUrl).toBe('https://192.168.10.10:4443')
  })
})

// ── applyAllowlist ───────────────────────────────────────────────────

describe('applyAllowlist', () => {
  const en0 = iface({ name: 'en0', address: '192.168.10.10', kind: 'lan' })
  const en1 = iface({ name: 'en1', address: '10.0.0.5', kind: 'lan' })
  const lo = iface({ name: 'lo0', address: '127.0.0.1', internal: true, kind: 'loopback' })

  it('passes everything through when the allowlist is empty', () => {
    expect(applyAllowlist([en0, en1, lo], [])).toEqual([en0, en1, lo])
  })

  it('keeps only addresses in the allowlist', () => {
    const out = applyAllowlist([en0, en1, lo], ['192.168.10.10'])
    expect(out.map((i) => i.address)).toContain('192.168.10.10')
    expect(out.map((i) => i.address)).not.toContain('10.0.0.5')
  })

  it('does not keep loopback when it is not in the allowlist', () => {
    const out = applyAllowlist([en0, en1, lo], ['192.168.10.10'])
    expect(out.find((i) => i.kind === 'loopback')).toBeUndefined()
  })

  it('treats unknown allowlist entries as a no-op (no spurious matches)', () => {
    const out = applyAllowlist([en0], ['10.99.99.99'])
    // The bogus address doesn't match anything; en0 gets dropped.
    expect(out.find((i) => i.name === 'en0')).toBeUndefined()
    // Still no false positives — empty result.
    expect(out.filter((i) => i.kind !== 'loopback')).toEqual([])
  })

  it('keeps a live IPv6 when the allowlist holds a stale address on the same /64', () => {
    const stable = iface({
      name: 'eth0',
      address: '2a02:908:3614:bfa0::2',
      family: 'IPv6',
      kind: 'lan',
      netmask: 'ffff:ffff:ffff:ffff::',
    })
    const rotated = iface({
      name: 'eth0',
      address: '2a02:908:3614:bfa0:10ff:e000:3980:5ecf',
      family: 'IPv6',
      kind: 'lan',
      netmask: 'ffff:ffff:ffff:ffff::',
    })
    const v4 = iface({ name: 'eth0', address: '192.168.10.9', kind: 'lan' })
    const out = applyAllowlist(
      [v4, stable, rotated],
      ['192.168.10.9', '2a02:908:3614:bfa0:10ff:e000:3480:5ecf'],
    )
    expect(out.map((i) => i.address)).toEqual(
      expect.arrayContaining(['192.168.10.9', '2a02:908:3614:bfa0::2']),
    )
    expect(out.map((i) => i.address)).toContain('2a02:908:3614:bfa0:10ff:e000:3980:5ecf')
  })

  it('does not match IPv6 on a different /64', () => {
    const other = iface({
      name: 'eth0',
      address: '2a02:908:ffff::1',
      family: 'IPv6',
      kind: 'lan',
      netmask: 'ffff:ffff:ffff:ffff::',
    })
    const out = applyAllowlist([other], ['2a02:908:3614:bfa0::2'])
    expect(out.filter((i) => i.kind !== 'loopback')).toEqual([])
  })
})

// ── autoSeedAllowlist ────────────────────────────────────────────────

describe('isPlausibleAutoSeed', () => {
  it('keeps RFC1918 IPv4 addresses', () => {
    expect(isPlausibleAutoSeed('192.168.10.10', 'IPv4')).toBe(true)
    expect(isPlausibleAutoSeed('10.0.0.5', 'IPv4')).toBe(true)
    expect(isPlausibleAutoSeed('172.20.5.1', 'IPv4')).toBe(true)
  })
  it('drops IPv4 link-local 169.254.*', () => {
    expect(isPlausibleAutoSeed('169.254.1.2', 'IPv4')).toBe(false)
  })
  it('keeps IPv6 ULA addresses (fc00::/7)', () => {
    expect(isPlausibleAutoSeed('fd00::1234', 'IPv6')).toBe(true)
    expect(isPlausibleAutoSeed('fd12:3456:789a::42', 'IPv6')).toBe(true)
    expect(isPlausibleAutoSeed('fc00::1', 'IPv6')).toBe(true)
  })
  it('keeps IPv6 GUA addresses (2000::/3)', () => {
    expect(isPlausibleAutoSeed('2a02:908:3614:bfa0::5', 'IPv6')).toBe(true)
    expect(isPlausibleAutoSeed('2001:db8::1', 'IPv6')).toBe(true)
    expect(isPlausibleAutoSeed('3fff::1', 'IPv6')).toBe(true)
  })
  it('drops IPv6 link-local fe80::*', () => {
    expect(isPlausibleAutoSeed('fe80::1', 'IPv6')).toBe(false)
    expect(isPlausibleAutoSeed('fe80::abcd:1234', 'IPv6')).toBe(false)
  })
  it('drops IPv6 loopback + unspecified + multicast', () => {
    expect(isPlausibleAutoSeed('::1', 'IPv6')).toBe(false)
    expect(isPlausibleAutoSeed('::', 'IPv6')).toBe(false)
    expect(isPlausibleAutoSeed('ff02::1', 'IPv6')).toBe(false)
  })
  it('is case-insensitive on IPv6 prefixes', () => {
    expect(isPlausibleAutoSeed('FD00::1', 'IPv6')).toBe(true)
    expect(isPlausibleAutoSeed('FE80::1', 'IPv6')).toBe(false)
  })
})

describe('autoSeedAllowlist', () => {
  it('returns LAN + Wi-Fi addresses across both IPv4 and IPv6', () => {
    const out = autoSeedAllowlist([
      iface({ name: 'en0', address: '192.168.10.10', kind: 'lan' }),
      iface({
        name: 'en0',
        address: 'fd00::1234',
        family: 'IPv6',
        kind: 'lan',
        netmask: 'ffff:ffff:ffff:ffff::',
      }),
      iface({
        name: 'en1',
        address: '2a02:908:3614:bfa0::5',
        family: 'IPv6',
        kind: 'wifi',
        netmask: 'ffff:ffff:ffff:ffff::',
      }),
      iface({ name: 'docker0', address: '172.17.0.1', kind: 'docker' }),
      iface({ name: 'utun0', address: '100.64.0.1', kind: 'vpn' }),
      iface({
        name: 'en0',
        address: 'fe80::1',
        family: 'IPv6',
        kind: 'lan',
        netmask: 'ffff:ffff:ffff:ffff::',
      }),
    ])
    expect(out).toContain('192.168.10.10')
    expect(out).toContain('fd00::1234')
    expect(out).toContain('2a02:908:3614:bfa0::5')
    // docker/vpn/link-local skipped.
    expect(out).not.toContain('172.17.0.1')
    expect(out).not.toContain('100.64.0.1')
    expect(out).not.toContain('fe80::1')
  })

  it('deduplicates identical addresses', () => {
    const out = autoSeedAllowlist([
      iface({ name: 'en0', address: '192.168.10.10', kind: 'lan' }),
      iface({ name: 'en0', address: '192.168.10.10', kind: 'lan' }),
    ])
    expect(out).toEqual(['192.168.10.10'])
  })

  it('returns empty when no lan/wifi interfaces exist', () => {
    expect(
      autoSeedAllowlist([
        iface({ name: 'docker0', address: '172.17.0.1', kind: 'docker' }),
        iface({ name: 'lo0', address: '127.0.0.1', internal: true, kind: 'loopback' }),
      ]),
    ).toEqual([])
  })
})

// ── enumerateOsInterfaces ────────────────────────────────────────────

describe('enumerateOsInterfaces', () => {
  it('marks the preferred interface with the flag set', () => {
    const fixtures = {
      lo0: [
        {
          family: 'IPv4',
          address: '127.0.0.1',
          netmask: '255.0.0.0',
          mac: '00:00:00:00:00:00',
          internal: true,
          cidr: '127.0.0.1/8',
        },
      ],
      en0: [
        {
          family: 'IPv4',
          address: '192.168.10.10',
          netmask: '255.255.255.0',
          mac: 'aa:bb:cc:dd:ee:ff',
          internal: false,
          cidr: '192.168.10.10/24',
        },
      ],
      docker0: [
        {
          family: 'IPv4',
          address: '172.17.0.1',
          netmask: '255.255.0.0',
          mac: '02:42:00:00:00:01',
          internal: false,
          cidr: '172.17.0.1/16',
        },
      ],
    }
    const out = enumerateOsInterfaces(fixtures)
    const preferred = out.filter((i) => i.preferred)
    expect(preferred).toHaveLength(1)
    expect(preferred[0]?.name).toBe('en0')
  })

  it('emits human-readable plausibleReason for non-plausible entries', () => {
    expect(
      explainNonPlausible({
        kind: 'docker',
        family: 'IPv4',
        address: '172.17.0.1',
        internal: false,
      }),
    ).toContain('Docker bridge')
    expect(
      explainNonPlausible({ kind: 'vpn', family: 'IPv4', address: '10.8.0.2', internal: false }),
    ).toContain('VPN tunnel')
    expect(
      explainNonPlausible({ kind: 'lan', family: 'IPv6', address: 'fe80::1', internal: false }),
    ).toContain('link-local')
    expect(
      explainNonPlausible({ kind: 'lan', family: 'IPv6', address: 'ff02::1', internal: false }),
    ).toContain('multicast')
    expect(
      explainNonPlausible({ kind: 'lan', family: 'IPv4', address: '169.254.1.2', internal: false }),
    ).toContain('IPv4 link-local')
    expect(
      explainNonPlausible({
        kind: 'loopback',
        family: 'IPv4',
        address: '127.0.0.1',
        internal: true,
      }),
    ).toContain('Internal')
  })

  it('marks plausibility per interface', () => {
    const fixtures = {
      lo0: [
        {
          family: 'IPv4',
          address: '127.0.0.1',
          netmask: '255.0.0.0',
          mac: '00:00:00:00:00:00',
          internal: true,
          cidr: '127.0.0.1/8',
        },
      ],
      en0: [
        {
          family: 'IPv4',
          address: '192.168.10.10',
          netmask: '255.255.255.0',
          mac: 'aa:bb:cc:dd:ee:ff',
          internal: false,
          cidr: '192.168.10.10/24',
        },
        {
          family: 'IPv6',
          address: 'fe80::1',
          netmask: 'ffff:ffff:ffff:ffff::',
          mac: 'aa:bb:cc:dd:ee:ff',
          internal: false,
          cidr: 'fe80::1/64',
        },
        {
          family: 'IPv6',
          address: '2a02:908:3614:bfa0::5',
          netmask: 'ffff:ffff:ffff:ffff::',
          mac: 'aa:bb:cc:dd:ee:ff',
          internal: false,
          cidr: '2a02:908:3614:bfa0::5/64',
        },
      ],
      docker0: [
        {
          family: 'IPv4',
          address: '172.17.0.1',
          netmask: '255.255.0.0',
          mac: '02:42:00:00:00:01',
          internal: false,
          cidr: '172.17.0.1/16',
        },
      ],
    }
    const out = enumerateOsInterfaces(fixtures)
    const lookup = (addr: string): LocalInterface | undefined => out.find((i) => i.address === addr)

    // LAN IPv4 = plausible, empty reason.
    expect(lookup('192.168.10.10')?.plausible).toBe(true)
    expect(lookup('192.168.10.10')?.plausibleReason).toBe('')
    // LAN IPv6 GUA = plausible.
    expect(lookup('2a02:908:3614:bfa0::5')?.plausible).toBe(true)
    expect(lookup('2a02:908:3614:bfa0::5')?.plausibleReason).toBe('')
    // LAN IPv6 link-local = NOT plausible, has reason.
    expect(lookup('fe80::1')?.plausible).toBe(false)
    expect(lookup('fe80::1')?.plausibleReason).toContain('link-local')
    // Docker = NOT plausible (different kind even though IPv4 RFC1918).
    expect(lookup('172.17.0.1')?.plausible).toBe(false)
    expect(lookup('172.17.0.1')?.plausibleReason).toContain('Docker')
    // Loopback = NOT plausible, marked as internal.
    expect(lookup('127.0.0.1')?.plausible).toBe(false)
    expect(lookup('127.0.0.1')?.plausibleReason).toContain('Internal')
  })

  it('skips entries with no addresses array', () => {
    const out = enumerateOsInterfaces({ ghost: undefined })
    expect(out).toEqual([])
  })

  it('marks non-permanent IPv6 as not plausible when Linux flags are known', () => {
    const flags = parseProcIfInet6(
      [
        '2a0209083614bfa00000000000000002 1d2 40 00 82     eth0',
        '2a0209083614bfa010ffe00039805ecf 1d2 40 00 00     eth0',
        'fe8000000000000010ffe00039805ecf 1d2 40 20 80     eth0',
      ].join('\n'),
    )
    const out = enumerateOsInterfaces(
      {
        eth0: [
          {
            family: 'IPv6',
            address: '2a02:908:3614:bfa0::2',
            netmask: 'ffff:ffff:ffff:ffff::',
            mac: 'aa:bb:cc:dd:ee:ff',
            internal: false,
            cidr: '2a02:908:3614:bfa0::2/64',
          },
          {
            family: 'IPv6',
            address: '2a02:908:3614:bfa0:10ff:e000:3980:5ecf',
            netmask: 'ffff:ffff:ffff:ffff::',
            mac: 'aa:bb:cc:dd:ee:ff',
            internal: false,
            cidr: '2a02:908:3614:bfa0:10ff:e000:3980:5ecf/64',
          },
        ],
      },
      flags,
    )
    expect(out.find((i) => i.address === '2a02:908:3614:bfa0::2')?.plausible).toBe(true)
    const privacy = out.find((i) => i.address.endsWith('3980:5ecf'))
    expect(privacy?.plausible).toBe(false)
    expect(privacy?.plausibleReason).toMatch(/privacy|temporary/i)
  })
})

describe('ipv6Prefix64Key', () => {
  it('groups a stable GUA and a privacy GUA on the same LAN prefix', () => {
    expect(ipv6Prefix64Key('2a02:908:3614:bfa0::2')).toBe(
      ipv6Prefix64Key('2a02:908:3614:bfa0:10ff:e000:3480:5ecf'),
    )
  })

  it('distinguishes different /64s', () => {
    expect(ipv6Prefix64Key('fd00::1')).not.toBe(ipv6Prefix64Key('fd00:0:0:1::1'))
  })
})

describe('shouldAdvertiseIpv6', () => {
  it('keeps plausible IPv6 when flags are unknown', () => {
    expect(shouldAdvertiseIpv6('2a02:908:3614:bfa0::2', undefined)).toBe(true)
  })

  it('keeps PERMANENT GUA and DHCPv6 NODAD, drops flags=0 privacy temps', () => {
    expect(shouldAdvertiseIpv6('2a02:908:3614:bfa0::2', 0x82)).toBe(true)
    expect(shouldAdvertiseIpv6('2a02:908:3614:bfa0::5', 0x02)).toBe(true)
    expect(shouldAdvertiseIpv6('2a02:908:3614:bfa0:10ff:e000:3980:5ecf', 0x00)).toBe(false)
  })

  it('drops TEMPORARY, DEPRECATED, and TENTATIVE addresses', () => {
    expect(shouldAdvertiseIpv6('2a02:908:3614:bfa0::2', 0x01)).toBe(false)
    expect(shouldAdvertiseIpv6('2a02:908:3614:bfa0::2', 0x20)).toBe(false)
    expect(shouldAdvertiseIpv6('2a02:908:3614:bfa0::2', 0x40)).toBe(false)
  })
})

describe('reconcileAllowlist', () => {
  const v4 = iface({ name: 'eth0', address: '192.168.10.9', kind: 'lan' })
  const stable = iface({
    name: 'eth0',
    address: '2a02:908:3614:bfa0::2',
    family: 'IPv6',
    kind: 'lan',
    netmask: 'ffff:ffff:ffff:ffff::',
  })
  const docker = iface({ name: 'docker0', address: '172.17.0.1', kind: 'docker' })

  it('replaces a stale IPv6 with the current auto-seed set', () => {
    const next = reconcileAllowlist(
      ['192.168.10.9', '2a02:908:3614:bfa0:10ff:e000:3480:5ecf'],
      [v4, stable],
    )
    expect(next).toEqual(['192.168.10.9', '2a02:908:3614:bfa0::2'])
  })

  it('keeps still-live operator extras such as docker', () => {
    const next = reconcileAllowlist(['192.168.10.9', '172.17.0.1'], [v4, stable, docker])
    expect(next).toContain('172.17.0.1')
    expect(next).toContain('2a02:908:3614:bfa0::2')
  })

  it('drops extras that are no longer on any interface', () => {
    const next = reconcileAllowlist(['192.168.10.9', '172.17.0.1'], [v4, stable])
    expect(next).not.toContain('172.17.0.1')
  })

  it('does not keep a still-live privacy IPv6 that auto-seed skipped', () => {
    const privacy = iface({
      name: 'eth0',
      address: '2a02:908:3614:bfa0:10ff:e000:3980:5ecf',
      family: 'IPv6',
      kind: 'lan',
      netmask: 'ffff:ffff:ffff:ffff::',
      plausible: false,
    })
    const next = reconcileAllowlist(
      ['192.168.10.9', '2a02:908:3614:bfa0:10ff:e000:3980:5ecf'],
      [v4, stable, privacy],
    )
    expect(next).toEqual(['192.168.10.9', '2a02:908:3614:bfa0::2'])
  })

  it('leaves an empty allowlist empty (operator unrestricted)', () => {
    expect(reconcileAllowlist([], [v4, stable])).toEqual([])
  })

  it('refreshes on a one-hour interval from startup', () => {
    expect(ALLOWLIST_RECONCILE_INTERVAL_MS).toBe(60 * 60 * 1000)
  })
})

// ── selectAppConnectionEndpoints (API / viewer race set) ────────────────────

describe('selectAppConnectionEndpoints', () => {
  const lanV4 = iface({ name: 'eth0', address: '192.168.10.9', kind: 'lan' })
  const ipv6 = iface({
    name: 'eth0',
    address: 'fd00::1',
    family: 'IPv6',
    kind: 'lan',
    netmask: 'ffff:ffff::',
  })

  const palette = buildEndpoints([lanV4, ipv6], 4480, true, false, 'camstack.example.top', 'http', {
    host: 'hub.tail.ts.net',
    port: 4443,
  })

  it('AUTO keeps LAN IPv4 + the public tunnel, never IPv6 / mesh / loopback', () => {
    const selected = selectAppConnectionEndpoints(palette, AUTOMATIC_HUB_ADDRESS_FLAGS)
    expect(selected.map((e) => e.kind)).toEqual(['lan-ipv4', 'public'])
    expect(selected.map((e) => e.interfaceKind)).toEqual(['lan', 'public'])
    expect(selected.every((e) => e.kind !== 'lan-ipv6')).toBe(true)
    expect(selected.every((e) => e.interfaceKind !== 'vpn')).toBe(true)
    expect(selected.every((e) => e.kind !== 'loopback')).toBe(true)
  })

  it('an explicit list keeps only those URLs, in palette order', () => {
    const pub = palette.find((e) => e.interfaceKind === 'public' && e.kind === 'public')
    const mesh = palette.find((e) => e.interfaceKind === 'vpn')
    expect(pub && mesh).toBeTruthy()
    const selected = selectAppConnectionEndpoints(palette, {
      ...AUTOMATIC_HUB_ADDRESS_FLAGS,
      appConnections: [mesh!.baseUrl, pub!.baseUrl],
    })
    expect(selected.map((e) => e.baseUrl)).toEqual([pub!.baseUrl, mesh!.baseUrl])
  })

  it('an explicit list that matches nothing falls back to AUTO', () => {
    const selected = selectAppConnectionEndpoints(palette, {
      ...AUTOMATIC_HUB_ADDRESS_FLAGS,
      appConnections: ['http://10.0.0.9:4480'],
    })
    expect(selected.map((e) => e.kind)).toEqual(['lan-ipv4', 'public'])
  })
})

// ── app link entry (D709) ────────────────────────────────────────────

describe('appLinkEndpoint', () => {
  it('is the central domain, kind app-link, ranked ahead of the hub addresses', () => {
    const entry = appLinkEndpoint()
    expect(entry.baseUrl).toBe('https://camstack.zentik.app')
    expect(entry.kind).toBe('app-link')
    expect(entry.priority).toBeLessThan(0)
  })
  it('its hub= comes from the same palette: tunnel first, then mesh', () => {
    const lanV4 = iface({ name: 'eth0', address: '192.168.10.9' })
    const withTunnel = buildEndpoints([lanV4], 4443, false, false, 'cam.example.top', 'https', {
      host: 'hub.tail1234.ts.net',
      port: 4443,
    })
    expect(pickAppLinkHub(withTunnel)).toBe('https://cam.example.top')
    const meshOnly = buildEndpoints([lanV4], 4443, false, false, '', 'https', {
      host: 'hub.tail1234.ts.net',
      port: 4443,
    })
    expect(pickAppLinkHub(meshOnly)).toBe('https://hub.tail1234.ts.net:4443')
    expect(pickAppLinkHub(buildEndpoints([lanV4], 4443, false, false, '', 'https'))).toBeNull()
  })
})
