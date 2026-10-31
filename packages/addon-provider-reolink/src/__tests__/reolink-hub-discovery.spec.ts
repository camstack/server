/**
 * D985 — a scan offers an NVR / Home Hub as an INTEGRATION to set up, with a stableId the boot
 * migration derives too (so `originStableId` hides the candidate), never as a camera to add.
 */
import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  looksLikeReolinkHub,
  mapReolinkDiscoveryToCandidates,
  reolinkHubStableId,
} from '../reolink-discovery-map.js'

describe('looksLikeReolinkHub', () => {
  it('recognises an NVR and a Home Hub, not a camera', () => {
    expect(looksLikeReolinkHub('RLN8-410')).toBe(true)
    expect(looksLikeReolinkHub('Reolink Home Hub')).toBe(true)
    expect(looksLikeReolinkHub('Reolink NVR')).toBe(true)
    expect(looksLikeReolinkHub('RLC-810A')).toBe(false)
    expect(looksLikeReolinkHub(undefined)).toBe(false)
  })
})

describe('reolinkHubStableId', () => {
  it('prefers the uid, falls back to the host', () => {
    expect(reolinkHubStableId({ uid: 'ABC123', host: '10.0.0.5' })).toBe('reolink-hub-uid-abc123')
    expect(reolinkHubStableId({ host: '10.0.0.5' })).toBe('reolink-hub-host-10-0-0-5')
    expect(reolinkHubStableId({ uid: '  ', host: '10.0.0.5' })).toBe('reolink-hub-host-10-0-0-5')
  })
})

describe('hub candidates', () => {
  const hub = {
    host: '10.0.0.5',
    httpPort: 8000,
    uid: 'UID9',
    model: 'Reolink Home Hub',
    name: 'Hub',
  }
  const cam = { host: '10.0.0.6', model: 'RLC-810A', uid: 'CAM1' }

  it('offers a hub as a setupIntegration candidate with the Baichuan port, not the ONVIF one', () => {
    const [candidate] = mapReolinkDiscoveryToCandidates([hub], {
      username: 'admin',
    })
    expect(candidate?.setupIntegration).toBe(true)
    expect(candidate?.type).toBe(DeviceType.Gateway)
    expect(candidate?.stableId).toBe(reolinkHubStableId({ uid: 'UID9', host: '10.0.0.5' }))
    expect(candidate?.suggestedName).toBe('Hub')
    expect(candidate?.prefilledConfig).toMatchObject({
      host: '10.0.0.5',
      port: 9000,
      uid: 'UID9',
    })
    expect(candidate?.prefilledConfig).not.toHaveProperty('password')
  })

  it('leaves a camera a plain camera candidate', () => {
    const [candidate] = mapReolinkDiscoveryToCandidates([cam], {})
    expect(candidate?.setupIntegration).toBeUndefined()
    expect(candidate?.type).toBe(DeviceType.Camera)
  })

  it('hides a hub an integration already names, by uid or by host', () => {
    expect(mapReolinkDiscoveryToCandidates([hub], {}, [], [{ uid: 'UID9' }])).toHaveLength(0)
    expect(mapReolinkDiscoveryToCandidates([hub], {}, [], [{ host: '10.0.0.5' }])).toHaveLength(0)
    expect(
      mapReolinkDiscoveryToCandidates([hub, cam], {}, [], [{ host: '10.0.0.5' }]),
    ).toHaveLength(1)
  })
})
