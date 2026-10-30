import type { HubIdentity } from '@apocaliss92/noderademacher'
import { DeviceType, type DiscoveryHit } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  hubsFromHits,
  hubFromIdentity,
  proposeRademacherHubs,
  RADEMACHER_DISCOVERY_MODES,
  rademacherDiscoveryCandidates,
  rademacherDiscoverySummary,
} from '../rademacher-hub-discovery.js'
import { IDENTITY } from './fake-hub.js'

const SECOND: HubIdentity = {
  host: '192.168.10.51',
  model: 'Start2Smart',
  name: '',
  basePath: '/hp',
  passwordProtected: false,
}

function hit(host: string, status: number): DiscoveryHit {
  return { modeIndex: 0, host, port: 80, http: { status, headers: {}, bodyText: '' } }
}

const PROBE = async (host: string): Promise<HubIdentity | null> =>
  [IDENTITY, SECOND].find((identity) => identity.host === host) ?? null

describe('Rademacher LAN discovery', () => {
  it('projects a probe result: MAC as identity, model as the name of an unnamed hub', () => {
    expect(hubFromIdentity(IDENTITY)).toEqual({
      host: '192.168.10.50',
      name: 'Casa',
      id: 'aabbccddeeff',
      model: 'HomePilot',
      basePath: '',
    })
    expect(hubFromIdentity(SECOND)).toEqual({
      host: '192.168.10.51',
      name: 'Start2Smart',
      id: '192-168-10-51',
      model: 'Start2Smart',
      basePath: '/hp',
    })
  })

  it('declares the library probe request, on both api base paths', () => {
    expect(RADEMACHER_DISCOVERY_MODES).toEqual([
      expect.objectContaining({
        kind: 'http-probe',
        port: 80,
        method: 'POST',
        path: '/authentication/password_salt',
        acceptStatus: [200, 500],
      }),
      expect.objectContaining({ path: '/hp/authentication/password_salt', method: 'POST' }),
    ])
  })

  it('classifies http-probe hits through the identity check, once per host', async () => {
    const found = await hubsFromHits(
      [hit('192.168.10.50', 200), hit('192.168.10.50', 200), hit('192.168.10.51', 500)],
      PROBE,
    )
    expect(found.map((f) => f.host)).toEqual(['192.168.10.50', '192.168.10.51'])
  })

  it('rejects a hit that is not a salt answer, or whose host fails the identity check', async () => {
    expect(
      await hubsFromHits(
        [hit('192.168.10.60', 404), { modeIndex: 0, host: '192.168.10.61', port: 80 }],
        PROBE,
      ),
    ).toEqual([])
    expect(await hubsFromHits([hit('192.168.10.99', 200)], PROBE)).toEqual([])
  })

  it('does not propose a hub whose host or id an integration already stores', async () => {
    const found = await hubsFromHits([hit('192.168.10.50', 200), hit('192.168.10.51', 500)], PROBE)
    expect(proposeRademacherHubs(found, [])).toHaveLength(2)
    expect(proposeRademacherHubs(found, [' 192.168.10.50 '])).toHaveLength(1)
    expect(proposeRademacherHubs(found, ['AABBCCDDEEFF']).map((f) => f.host)).toEqual([
      '192.168.10.51',
    ])
    expect(proposeRademacherHubs(found, ['192.168.10.50', '192.168.10.51'])).toHaveLength(0)
  })

  it('shapes one candidate per hub that opens the integration form pre-filled', async () => {
    const found = await hubsFromHits([hit('192.168.10.50', 200), hit('192.168.10.51', 500)], PROBE)
    const candidates = rademacherDiscoveryCandidates(found)
    expect(candidates[0]).toEqual({
      stableId: 'rademacher:aabbccddeeff',
      type: DeviceType.Gateway,
      suggestedName: 'Casa',
      prefilledConfig: { host: '192.168.10.50' },
      setupIntegration: true,
    })
    // The base path the hub answered on rides along, so the form needs no guess.
    expect(candidates[1]?.prefilledConfig).toEqual({ host: '192.168.10.51', basePath: '/hp' })
  })

  it('says what the scan found', () => {
    expect(rademacherDiscoverySummary(0, 0)).toBe('No hub found on the network.')
    expect(rademacherDiscoverySummary(1, 0)).toBe('Hub already added.')
    expect(rademacherDiscoverySummary(1, 1)).toBe('Found 1 hub.')
    expect(rademacherDiscoverySummary(3, 2)).toBe('Found 2 hubs.')
  })
})
