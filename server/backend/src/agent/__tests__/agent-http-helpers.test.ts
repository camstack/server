import { describe, expect, it } from 'vitest'
import { mapDiscoveredNodes, pickIpv4, resolveHubEndpoint } from '../agent-http.js'

describe('pickIpv4', () => {
  it('returns the first non-internal IPv4', () => {
    expect(pickIpv4(['127.0.0.1', 'fe80::1', '192.168.10.9'])).toBe('192.168.10.9')
  })

  it('skips loopback and IPv6', () => {
    expect(pickIpv4(['::1', '127.0.0.1'])).toBeNull()
  })

  it('handles undefined / empty', () => {
    expect(pickIpv4(undefined)).toBeNull()
    expect(pickIpv4([])).toBeNull()
  })
})

describe('resolveHubEndpoint', () => {
  it('prefers the hub node IPv4', () => {
    const nodes = [
      { id: 'hub', hostname: 'unraid', ipList: ['127.0.0.1', '192.168.10.9'] },
      { id: 'agent-1', hostname: 'mac', ipList: ['192.168.10.20'] },
    ]
    expect(resolveHubEndpoint(nodes)).toBe('192.168.10.9')
  })

  it('falls back to hostname when no IPv4', () => {
    expect(resolveHubEndpoint([{ id: 'hub', hostname: 'unraid', ipList: ['::1'] }])).toBe('unraid')
  })

  it('returns null when no hub node is present', () => {
    expect(resolveHubEndpoint([{ id: 'agent-1', hostname: 'mac' }])).toBeNull()
  })
})

describe('mapDiscoveredNodes', () => {
  const nodes = [
    { id: 'hub', hostname: 'unraid', ipList: ['192.168.10.9'] },
    { id: 'agent-1', hostname: 'mac-mini' },
    { id: 'self', hostname: 'me' },
  ]

  it('excludes self and flags the hub with a human displayName', () => {
    const result = mapDiscoveredNodes(nodes, 'self')
    expect(result).toEqual([
      { id: 'hub', hostname: 'unraid', displayName: 'unraid', isHub: true },
      { id: 'agent-1', hostname: 'mac-mini', displayName: 'mac-mini', isHub: false },
    ])
  })

  it('uses IPv4 when hostname is absent or equals the opaque id', () => {
    expect(
      mapDiscoveredNodes([{ id: 'hub', hostname: 'hub', ipList: ['192.168.10.9'] }], 'self'),
    ).toEqual([
      {
        id: 'hub',
        hostname: 'hub',
        displayName: '192.168.10.9',
        isHub: true,
      },
    ])
  })

  it('does not name a hub after its container id when an address is known', () => {
    const [hub] = mapDiscoveredNodes(
      [{ id: 'hub', hostname: 'a4afbe756e45', ipList: ['192.168.10.9'] }],
      'self',
    )
    expect(hub?.displayName).toBe('192.168.10.9')
    expect(hub?.hostname).toBe('a4afbe756e45')
  })

  it('falls back to the node id when hostname and IPv4 are absent', () => {
    expect(mapDiscoveredNodes([{ id: 'hub' }], 'self')).toEqual([
      { id: 'hub', hostname: 'hub', displayName: 'hub', isHub: true },
    ])
  })
})
