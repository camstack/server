import type { DiscoveredDevice } from '@apocaliss92/nodegree'
import { describe, expect, it } from 'vitest'
import {
  cidrToBroadcast,
  GREE_DISCOVERY_MODES,
  GREE_UNICAST_CONCURRENCY,
  planGreeSweep,
  scanGreeSubnets,
} from '../gree-subnet-scan.js'

function ac(mac: string, ip: string): DiscoveredDevice {
  return { ip, port: 7000, mac, name: `AC ${mac}` }
}

describe('Gree subnet scan', () => {
  it('declares a custom mode with its reason', () => {
    expect(GREE_DISCOVERY_MODES).toEqual([
      { kind: 'custom', reason: expect.stringContaining('nodegree') },
    ])
  })

  it('derives the directed broadcast of a CIDR and refuses anything else', () => {
    expect(cidrToBroadcast('192.0.2.0/24')).toBe('192.0.2.255')
    expect(cidrToBroadcast('198.51.100.64/26')).toBe('198.51.100.127')
    expect(cidrToBroadcast('192.0.2.7')).toBeNull()
    expect(cidrToBroadcast('192.0.2.0/33')).toBeNull()
    expect(cidrToBroadcast('nope/24')).toBeNull()
  })

  it('sweeps each covered subnet once and merges the responders by MAC', async () => {
    const asked: string[] = []
    const found = await scanGreeSubnets({
      subnets: ['192.0.2.0/24', '198.51.100.0/24', '192.0.2.0/24'],
      sweep: async (target) => {
        asked.push(target)
        return target === '192.0.2.255'
          ? [ac('AA:01', '192.0.2.10')]
          : [ac('aa:01', '198.51.100.9'), ac('bb:02', '198.51.100.11')]
      },
    })
    expect(asked.sort()).toEqual(['192.0.2.255', '198.51.100.255'])
    expect(found.map((d) => d.mac.toLowerCase()).sort()).toEqual(['aa:01', 'bb:02'])
  })

  it('skips a failing sweep and reports it', async () => {
    const errors: string[] = []
    const found = await scanGreeSubnets({
      subnets: ['192.0.2.0/24', '198.51.100.0/24'],
      sweep: async (target) => {
        if (target === '192.0.2.255') throw new Error('network unreachable')
        return [ac('cc:03', '198.51.100.5')]
      },
      onError: (target) => errors.push(target),
    })
    expect(errors).toEqual(['192.0.2.255'])
    expect(found).toHaveLength(1)
  })

  describe('routed subnets', () => {
    it('plans a broadcast only for an on-link subnet and a unicast per host for a routed one', () => {
      const plan = planGreeSweep({
        subnets: ['192.0.2.0/24', '198.51.100.0/24'],
        localAddresses: ['192.0.2.7'],
      })
      expect(plan.broadcasts).toEqual(['192.0.2.255', '198.51.100.255'])
      expect(plan.unicast).toHaveLength(254)
      expect(plan.unicast[0]).toBe('198.51.100.1')
      expect(plan.unicast[253]).toBe('198.51.100.254')
      expect(plan.unicast.some((ip) => ip.startsWith('192.0.2.'))).toBe(false)
    })

    it('refuses a routed subnet larger than a /24 with a reason, keeping its broadcast', () => {
      const plan = planGreeSweep({
        subnets: ['198.51.100.0/23'],
        localAddresses: ['192.0.2.7'],
      })
      expect(plan.unicast).toEqual([])
      expect(plan.broadcasts).toEqual(['198.51.101.255'])
      expect(plan.refused).toEqual([
        {
          subnet: '198.51.100.0/23',
          reason: expect.stringContaining('larger than a /24'),
        },
      ])
    })

    it('probes a small routed subnet without its network and broadcast addresses and dedupes repeats', () => {
      const plan = planGreeSweep({
        subnets: ['198.51.100.64/30', '198.51.100.64/30', 'junk'],
        localAddresses: [],
      })
      expect(plan.unicast).toEqual(['198.51.100.65', '198.51.100.66'])
      expect(plan.refused).toEqual([{ subnet: 'junk', reason: 'not an IPv4 CIDR' }])
    })

    it('unicasts a routed subnet, bounded, and merges by MAC with the broadcast answers', async () => {
      let inFlight = 0
      let peak = 0
      const asked: string[] = []
      const found = await scanGreeSubnets({
        subnets: ['198.51.100.0/24'],
        localAddresses: ['192.0.2.7'],
        sweep: async (target) => {
          asked.push(target)
          inFlight += 1
          peak = Math.max(peak, inFlight)
          await new Promise((resolve) => setTimeout(resolve, 0))
          inFlight -= 1
          if (target === '198.51.100.255') return [ac('AA:20', '198.51.100.20')]
          return target === '198.51.100.20' ? [ac('aa:20', '198.51.100.20')] : []
        },
      })
      expect(asked).toHaveLength(255)
      expect(peak).toBeLessThanOrEqual(GREE_UNICAST_CONCURRENCY + 1)
      expect(found).toHaveLength(1)
      expect(found[0]?.ip).toBe('198.51.100.20')
    })

    it('does not unicast when the local addresses are not given', async () => {
      const asked: string[] = []
      await scanGreeSubnets({
        subnets: ['198.51.100.0/24'],
        sweep: async (target) => {
          asked.push(target)
          return []
        },
      })
      expect(asked).toEqual(['198.51.100.255'])
    })
  })
})
