import type { HubIdentity } from '@apocaliss92/noderademacher'
import { describe, expect, it } from 'vitest'
import {
  browseRademacherHubs,
  hubFromIdentity,
  proposeRademacherHubs,
  RADEMACHER_SETUP_INTEGRATION_KEY,
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

  it('browses through the library probe and drops duplicate hosts', async () => {
    const found = await browseRademacherHubs(async () => [IDENTITY, IDENTITY, SECOND])
    expect(found.map((f) => f.host)).toEqual(['192.168.10.50', '192.168.10.51'])
  })

  it('does not propose a hub whose host or id an integration already stores', async () => {
    const found = await browseRademacherHubs(async () => [IDENTITY, SECOND])
    expect(proposeRademacherHubs(found, [])).toHaveLength(2)
    expect(proposeRademacherHubs(found, [' 192.168.10.50 '])).toHaveLength(1)
    expect(proposeRademacherHubs(found, ['AABBCCDDEEFF']).map((f) => f.host)).toEqual([
      '192.168.10.51',
    ])
    expect(proposeRademacherHubs(found, ['192.168.10.50', '192.168.10.51'])).toHaveLength(0)
  })

  it('shapes one candidate per hub that opens the integration form pre-filled', async () => {
    const found = await browseRademacherHubs(async () => [IDENTITY, SECOND])
    const candidates = rademacherDiscoveryCandidates(found)
    expect(candidates[0]).toEqual({
      stableId: 'rademacher:aabbccddeeff',
      suggestedName: 'Casa',
      prefilledConfig: { host: '192.168.10.50', [RADEMACHER_SETUP_INTEGRATION_KEY]: true },
    })
    // The base path the hub answered on rides along, so the form needs no guess.
    expect(candidates[1]?.prefilledConfig).toEqual({
      host: '192.168.10.51',
      basePath: '/hp',
      setupIntegration: true,
    })
  })

  it('says what the scan found', () => {
    expect(rademacherDiscoverySummary(0, 0)).toBe('No hub found on the network.')
    expect(rademacherDiscoverySummary(1, 0)).toBe('Hub already added.')
    expect(rademacherDiscoverySummary(1, 1)).toBe('Found 1 hub.')
    expect(rademacherDiscoverySummary(3, 2)).toBe('Found 2 hubs.')
  })
})
