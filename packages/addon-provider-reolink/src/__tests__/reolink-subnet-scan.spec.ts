import { describe, expect, it } from 'vitest'
import {
  REOLINK_DISCOVERY_MODES,
  scanReolinkSubnets,
  subnetsFromParams,
} from '../reolink-subnet-scan.js'

describe('Reolink subnet scan', () => {
  it('is a custom mode with a reason', () => {
    expect(REOLINK_DISCOVERY_MODES).toHaveLength(1)
    expect(REOLINK_DISCOVERY_MODES[0]).toMatchObject({ kind: 'custom' })
  })

  it('reads the subnets the orchestrator passes and ignores junk', () => {
    expect(subnetsFromParams({ subnets: ['192.0.2.0/24', 5, ''] })).toEqual(['192.0.2.0/24'])
    expect(subnetsFromParams(undefined)).toEqual([])
    expect(subnetsFromParams({ subnets: 'x' })).toEqual([])
  })

  it('scans every covered subnet and merges by host', async () => {
    const asked: (string | undefined)[] = []
    const out = await scanReolinkSubnets({
      subnets: ['192.0.2.0/24', '198.51.100.0/24'],
      scan: async (cidr) => {
        asked.push(cidr)
        return cidr === '192.0.2.0/24'
          ? [{ host: '192.0.2.5' }, { host: '192.0.2.6' }]
          : [{ host: '198.51.100.9' }, { host: '192.0.2.5' }]
      },
    })
    expect(asked).toEqual(['192.0.2.0/24', '198.51.100.0/24'])
    expect(out.map((d) => d.host)).toEqual(['192.0.2.5', '192.0.2.6', '198.51.100.9'])
  })

  it('scans once with no CIDR when none is given, and survives a failing subnet', async () => {
    const asked: (string | undefined)[] = []
    await scanReolinkSubnets({ subnets: [], scan: async (c) => (asked.push(c), []) })
    expect(asked).toEqual([undefined])
    const errors: unknown[] = []
    const out = await scanReolinkSubnets({
      subnets: ['192.0.2.0/24', '198.51.100.0/24'],
      scan: async (cidr) => {
        if (cidr === '192.0.2.0/24') throw new Error('boom')
        return [{ host: '198.51.100.9' }]
      },
      onError: (_c, e) => errors.push(e),
    })
    expect(out).toHaveLength(1)
    expect(errors).toHaveLength(1)
  })
})
