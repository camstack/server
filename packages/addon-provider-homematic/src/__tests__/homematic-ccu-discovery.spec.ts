import { DeviceType, type DiscoveryHit } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  ccusFromHits,
  HOMEMATIC_DISCOVERY_MODES,
  homematicDiscoveryCandidates,
  homematicDiscoverySummary,
  parseAuthEnabledAnswer,
  proposeHomematicCcus,
  type HomematicDiscoveredCcu,
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

const CCU: HomematicDiscoveredCcu = {
  host: '192.168.1.40',
  name: 'Homematic CCU (192.168.1.40)',
  id: '192-168-1-40',
  authEnabled: true,
}

function hit(host: string, status: number, bodyText: string): DiscoveryHit {
  return { modeIndex: 0, host, port: 80, http: { status, headers: {}, bodyText } }
}

describe('declared mode', () => {
  it('asks CCU.getAuthEnabled on the JSON-RPC endpoint', () => {
    const [mode] = HOMEMATIC_DISCOVERY_MODES
    expect(mode).toMatchObject({
      kind: 'http-probe',
      port: 80,
      path: '/api/homematic.cgi',
      method: 'POST',
      contentType: 'application/json',
    })
    expect(mode?.kind === 'http-probe' ? JSON.parse(mode.bodyText ?? '{}') : null).toMatchObject({
      method: 'CCU.getAuthEnabled',
    })
  })
})

describe('ccusFromHits', () => {
  it('keeps the host whose answer is the CCU JSON-RPC one, named after its address', () => {
    expect(ccusFromHits([hit('192.168.1.40', 200, ok(true))])).toEqual([CCU])
  })

  it('rejects a host that answers HTTP but is not a CCU', () => {
    expect(
      ccusFromHits([
        hit('192.168.1.41', 200, '<html>router</html>'),
        hit('192.168.1.42', 404, ok(true)),
        { modeIndex: 0, host: '192.168.1.43', port: 80 },
      ]),
    ).toEqual([])
  })
})

describe('proposal and candidate shape', () => {
  it('does not propose a CCU whose host is already on an integration', () => {
    expect(proposeHomematicCcus([CCU], [' 192.168.1.40 '])).toEqual([])
    expect(proposeHomematicCcus([CCU], ['192.168.1.41'])).toEqual([CCU])
  })

  it('opens the integration form with the host pre-filled, never adopting a device', () => {
    const [candidate] = homematicDiscoveryCandidates([CCU])
    expect(candidate).toEqual({
      stableId: 'homematic:192-168-1-40',
      type: DeviceType.Gateway,
      suggestedName: 'Homematic CCU (192.168.1.40)',
      prefilledConfig: { host: '192.168.1.40' },
      setupIntegration: true,
    })
  })

  it('words the summary for none, already-added and found', () => {
    expect(homematicDiscoverySummary(0, 0)).toBe('No CCU found on the network.')
    expect(homematicDiscoverySummary(1, 0)).toBe('CCU already added.')
    expect(homematicDiscoverySummary(1, 1)).toBe('Found 1 CCU.')
    expect(homematicDiscoverySummary(2, 2)).toBe('Found 2 CCUs.')
  })
})
