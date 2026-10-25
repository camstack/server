import { describe, it, expect, vi } from 'vitest'
import type { DiscoveredGateway } from '@apocaliss92/nodewitt'
import {
  cidrToBroadcast,
  parseBroadcastTargets,
  scanEcowittGateways,
} from '../ecowitt-network-scan.js'

function gw(
  over: Partial<DiscoveredGateway> & Pick<DiscoveredGateway, 'ip' | 'mac'>,
): DiscoveredGateway {
  return {
    name: over.name ?? over.mac,
    ...over,
  }
}

// Addresses are RFC 5737 documentation ranges (192.0.2.0/24, 198.51.100.0/24,
// 203.0.113.0/24): publish-safe AND distinct, which every assertion below needs.
describe('cidrToBroadcast', () => {
  it('derives the directed broadcast for a /24', () => {
    expect(cidrToBroadcast('192.0.2.0/24')).toBe('192.0.2.255')
  })
  it('derives the directed broadcast for a /16', () => {
    expect(cidrToBroadcast('198.51.0.0/16')).toBe('198.51.255.255')
  })
  it('derives the directed broadcast for a /25', () => {
    expect(cidrToBroadcast('192.0.2.0/25')).toBe('192.0.2.127')
  })
  it('returns null for a non-CIDR / malformed value', () => {
    expect(cidrToBroadcast('192.0.2.10')).toBeNull()
    expect(cidrToBroadcast('not-a-cidr')).toBeNull()
    expect(cidrToBroadcast('192.0.2.0/40')).toBeNull()
    expect(cidrToBroadcast('999.1.1.0/24')).toBeNull()
  })
})

describe('parseBroadcastTargets', () => {
  it('returns an empty list for blank / whitespace input (local sweep)', () => {
    expect(parseBroadcastTargets('')).toEqual([])
    expect(parseBroadcastTargets('   \n  ')).toEqual([])
  })
  it('splits comma / newline / whitespace separated values', () => {
    expect(parseBroadcastTargets('192.0.2.255, 198.51.100.255\n203.0.113.7')).toEqual([
      '192.0.2.255',
      '198.51.100.255',
      '203.0.113.7',
    ])
  })
  it('converts CIDRs to their directed broadcast address', () => {
    expect(parseBroadcastTargets('198.51.100.0/24')).toEqual(['198.51.100.255'])
  })
  it('de-duplicates and drops empties / invalid tokens', () => {
    expect(parseBroadcastTargets('192.0.2.255, 192.0.2.0/24, , garbage, 198.51.100.255')).toEqual([
      '192.0.2.255',
      '198.51.100.255',
    ])
  })
})

describe('scanEcowittGateways', () => {
  it('does a single local sweep (no broadcastAddr) when there are no targets', async () => {
    const discover = vi.fn(async () => [gw({ ip: '192.0.2.10', mac: 'aa:bb:cc:dd:ee:01' })])
    const found = await scanEcowittGateways({ discover, targets: [], timeoutMs: 3000 })
    expect(discover).toHaveBeenCalledTimes(1)
    expect(discover).toHaveBeenCalledWith({ timeoutMs: 3000 })
    expect(found.map((g) => g.ip)).toEqual(['192.0.2.10'])
  })

  it('sweeps every target subnet and merges the results', async () => {
    const byTarget: Record<string, DiscoveredGateway[]> = {
      '192.0.2.255': [gw({ ip: '192.0.2.20', mac: 'aa:bb:cc:dd:ee:20' })],
      '198.51.100.255': [gw({ ip: '198.51.100.30', mac: 'aa:bb:cc:dd:ee:30' })],
    }
    const discover = vi.fn(async (opts: { broadcastAddr?: string }) =>
      opts.broadcastAddr ? (byTarget[opts.broadcastAddr] ?? []) : [],
    )
    const found = await scanEcowittGateways({
      discover,
      targets: ['192.0.2.255', '198.51.100.255'],
      timeoutMs: 2000,
    })
    expect(discover).toHaveBeenCalledTimes(2)
    expect(discover).toHaveBeenCalledWith({ broadcastAddr: '198.51.100.255', timeoutMs: 2000 })
    expect(found.map((g) => g.ip).sort()).toEqual(['192.0.2.20', '198.51.100.30'])
  })

  it('de-duplicates a gateway that answers on more than one sweep (keyed by mac)', async () => {
    const dup = gw({ ip: '192.0.2.20', mac: 'aa:bb:cc:dd:ee:20' })
    const discover = vi.fn(async () => [dup])
    const found = await scanEcowittGateways({
      discover,
      targets: ['192.0.2.255', '198.51.100.255'],
    })
    expect(found).toHaveLength(1)
    expect(found[0]?.mac).toBe('aa:bb:cc:dd:ee:20')
  })

  it('never throws when one subnet sweep fails — it reports and continues', async () => {
    const onError = vi.fn()
    const discover = vi.fn(async (opts: { broadcastAddr?: string }) => {
      if (opts.broadcastAddr === '198.51.100.255') throw new Error('ENETUNREACH')
      return [gw({ ip: '192.0.2.20', mac: 'aa:bb:cc:dd:ee:20' })]
    })
    const found = await scanEcowittGateways({
      discover,
      targets: ['192.0.2.255', '198.51.100.255'],
      onError,
    })
    expect(found.map((g) => g.ip)).toEqual(['192.0.2.20'])
    expect(onError).toHaveBeenCalledWith('198.51.100.255', expect.any(Error))
  })
})
