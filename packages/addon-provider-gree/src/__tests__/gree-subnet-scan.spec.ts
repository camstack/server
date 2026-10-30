import type { DiscoveredDevice } from '@apocaliss92/nodegree'
import { describe, expect, it } from 'vitest'
import { cidrToBroadcast, GREE_DISCOVERY_MODES, scanGreeSubnets } from '../gree-subnet-scan.js'

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
})
