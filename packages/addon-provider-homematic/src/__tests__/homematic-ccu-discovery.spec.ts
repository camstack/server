import { describe, expect, it } from 'vitest'
import {
  browseHomematicCcus,
  HOMEMATIC_SETUP_INTEGRATION_KEY,
  homematicDiscoveryCandidates,
  homematicDiscoverySummary,
  lanHostsToProbe,
  parseAuthEnabledAnswer,
  proposeHomematicCcus,
  type DiscoveryPost,
  type HomematicDiscoveredCcu,
  type LanAddress,
} from '../homematic-ccu-discovery.js'

const ok = (result: unknown) => JSON.stringify({ result, error: null })

describe('parseAuthEnabledAnswer', () => {
  it('reads a boolean result, or its string form', () => {
    expect(parseAuthEnabledAnswer(200, ok(true))).toEqual({ authEnabled: true })
    expect(parseAuthEnabledAnswer(200, ok(false))).toEqual({ authEnabled: false })
    expect(parseAuthEnabledAnswer(200, ok('true'))).toEqual({ authEnabled: true })
    expect(parseAuthEnabledAnswer(200, ok('false'))).toEqual({ authEnabled: false })
  })

  it('treats an "access denied" error as a CCU that asks for a login', () => {
    const text = JSON.stringify({ result: null, error: { code: 401, message: 'access denied' } })
    expect(parseAuthEnabledAnswer(200, text)).toEqual({ authEnabled: true })
  })

  it('is null for anything that is not the CCU JSON-RPC answer', () => {
    expect(parseAuthEnabledAnswer(200, '<html>router</html>')).toBeNull()
    expect(parseAuthEnabledAnswer(404, ok(true))).toBeNull()
    expect(parseAuthEnabledAnswer(200, ok(5))).toBeNull()
    expect(parseAuthEnabledAnswer(200, JSON.stringify({ hello: 'world' }))).toBeNull()
    expect(parseAuthEnabledAnswer(200, 'null')).toBeNull()
    expect(
      parseAuthEnabledAnswer(200, JSON.stringify({ result: null, error: { message: 'other' } })),
    ).toBeNull()
  })
})

const addr = (address: string, over: Partial<LanAddress> = {}): LanAddress => ({
  family: 'IPv4',
  address,
  internal: false,
  ...over,
})

describe('lanHostsToProbe', () => {
  it('walks the /24 of every external IPv4 address, skipping this host', () => {
    const hosts = lanHostsToProbe([addr('192.168.1.20')])
    expect(hosts).toHaveLength(253)
    expect(hosts).toContain('192.168.1.1')
    expect(hosts).toContain('192.168.1.254')
    expect(hosts).not.toContain('192.168.1.20')
    expect(hosts).not.toContain('192.168.1.0')
    expect(hosts).not.toContain('192.168.1.255')
  })

  it('skips loopback, IPv6 and a second address on a /24 already walked', () => {
    const hosts = lanHostsToProbe([
      addr('127.0.0.1', { internal: true }),
      addr('fe80::1', { family: 'IPv6' }),
      addr('192.168.1.20'),
      addr('192.168.1.21'),
      addr('10.0.5.9'),
    ])
    // 253 (first /24, the second address is still probed) + 253 for 10.0.5.0/24, deduplicated.
    expect(new Set(hosts).size).toBe(hosts.length)
    expect(hosts.filter((h) => h.startsWith('192.168.1.'))).toHaveLength(252)
    expect(hosts.filter((h) => h.startsWith('10.0.5.'))).toHaveLength(253)
    expect(hosts.some((h) => h.startsWith('127.'))).toBe(false)
  })
})

describe('browseHomematicCcus', () => {
  const lan = [addr('192.168.1.20')]

  it('finds the CCU among silent hosts and names it after its address', async () => {
    const post: DiscoveryPost = async (url) => {
      if (url.startsWith('http://192.168.1.40/')) return { status: 200, text: ok(false) }
      throw new Error('timeout')
    }
    const found = await browseHomematicCcus({ addresses: () => lan, post })
    expect(found).toEqual([
      {
        host: '192.168.1.40',
        name: 'Homematic CCU (192.168.1.40)',
        id: '192-168-1-40',
        authEnabled: false,
      },
    ])
  })

  it('ignores a host that answers HTTP but is not a CCU', async () => {
    const post: DiscoveryPost = async () => ({ status: 200, text: '<html></html>' })
    expect(await browseHomematicCcus({ addresses: () => lan, post })).toEqual([])
  })

  it('never has more probes in flight than the concurrency bound', async () => {
    let inFlight = 0
    let peak = 0
    const post: DiscoveryPost = async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 0))
      inFlight -= 1
      throw new Error('no answer')
    }
    await browseHomematicCcus({ addresses: () => lan, post, concurrency: 8 })
    expect(peak).toBeLessThanOrEqual(8)
    expect(peak).toBeGreaterThan(1)
  })
})

const CCU: HomematicDiscoveredCcu = {
  host: '192.168.1.40',
  name: 'Homematic CCU (192.168.1.40)',
  id: '192-168-1-40',
  authEnabled: true,
}

describe('proposal and candidate shape', () => {
  it('does not propose a CCU whose host is already on an integration', () => {
    expect(proposeHomematicCcus([CCU], [' 192.168.1.40 '])).toEqual([])
    expect(proposeHomematicCcus([CCU], ['192.168.1.41'])).toEqual([CCU])
  })

  it('opens the integration form with the host pre-filled, never adopting a device', () => {
    const [candidate] = homematicDiscoveryCandidates([CCU])
    expect(candidate).toEqual({
      stableId: 'homematic:192-168-1-40',
      suggestedName: 'Homematic CCU (192.168.1.40)',
      prefilledConfig: { host: '192.168.1.40', [HOMEMATIC_SETUP_INTEGRATION_KEY]: true },
    })
  })

  it('words the summary for none, already-added and found', () => {
    expect(homematicDiscoverySummary(0, 0)).toBe('No CCU found on the network.')
    expect(homematicDiscoverySummary(1, 0)).toBe('CCU already added.')
    expect(homematicDiscoverySummary(1, 1)).toBe('Found 1 CCU.')
    expect(homematicDiscoverySummary(2, 2)).toBe('Found 2 CCUs.')
  })
})
