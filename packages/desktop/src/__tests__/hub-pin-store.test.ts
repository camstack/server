import { describe, expect, it } from 'vitest'
import {
  activeHub,
  EMPTY_HUB_RECORD,
  healthUrlForOrigin,
  hubIdForOrigin,
  normalizeHubOrigin,
  partitionForHub,
  viewerUrlForOrigin,
  withActiveHubOrigin,
  withClearedPin,
  withPinnedFingerprint,
} from '../role/hub-pin-store'

const FP = 'sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

describe('normalizeHubOrigin', () => {
  it('keeps an explicit scheme, port and drops the path', () => {
    expect(normalizeHubOrigin('https://192.168.10.9:4443/viewer/camstack/')).toBe(
      'https://192.168.10.9:4443',
    )
    expect(normalizeHubOrigin('http://hub.local:4480')).toBe('http://hub.local:4480')
  })

  it('defaults a bare host to https', () => {
    expect(normalizeHubOrigin('camstack.example.top')).toBe('https://camstack.example.top')
  })

  it('rejects anything that is not a usable http(s) address', () => {
    expect(normalizeHubOrigin('')).toBeNull()
    expect(normalizeHubOrigin('   ')).toBeNull()
    expect(normalizeHubOrigin('ftp://hub')).toBeNull()
    expect(normalizeHubOrigin('https://')).toBeNull()
  })
})

describe('hub identity', () => {
  it('derives a partition-safe id from the origin', () => {
    expect(hubIdForOrigin('https://192.168.10.9:4443')).toBe('192-168-10-9-4443')
    expect(partitionForHub(hubIdForOrigin('https://192.168.10.9:4443'))).toBe(
      'persist:hub-192-168-10-9-4443',
    )
  })

  it('gives two different hubs two different partitions', () => {
    expect(hubIdForOrigin('https://192.168.10.9:4443')).not.toBe(
      hubIdForOrigin('https://192.168.10.10:4443'),
    )
  })

  it('builds the viewer and probe URLs off the same origin', () => {
    expect(viewerUrlForOrigin('https://h:4443')).toBe('https://h:4443/viewer/camstack/')
    expect(healthUrlForOrigin('https://h:4443')).toBe('https://h:4443/health')
  })
})

describe('hub record', () => {
  it('adds a hub and makes it active without mutating the input', () => {
    const next = withActiveHubOrigin(EMPTY_HUB_RECORD, 'https://h:4443', 'Home')
    expect(EMPTY_HUB_RECORD.hubs).toHaveLength(0)
    expect(activeHub(next)?.origin).toBe('https://h:4443')
    expect(activeHub(next)?.label).toBe('Home')
    expect(activeHub(next)?.pinnedIssuerFingerprint).toBeNull()
  })

  it('re-selecting a known hub keeps its pin', () => {
    const added = withActiveHubOrigin(EMPTY_HUB_RECORD, 'https://h:4443')
    const pinned = withPinnedFingerprint(added, hubIdForOrigin('https://h:4443'), FP)
    const second = withActiveHubOrigin(
      withActiveHubOrigin(pinned, 'https://other:4443'),
      'https://h:4443',
    )
    expect(second.hubs).toHaveLength(2)
    expect(activeHub(second)?.pinnedIssuerFingerprint).toBe(FP)
  })

  it('clears a pin only when explicitly asked', () => {
    const added = withActiveHubOrigin(EMPTY_HUB_RECORD, 'https://h:4443')
    const id = hubIdForOrigin('https://h:4443')
    const pinned = withPinnedFingerprint(added, id, FP)
    expect(activeHub(withClearedPin(pinned, id))?.pinnedIssuerFingerprint).toBeNull()
    expect(activeHub(pinned)?.pinnedIssuerFingerprint).toBe(FP)
  })

  it('reports no active hub for an empty record', () => {
    expect(activeHub(EMPTY_HUB_RECORD)).toBeNull()
  })
})
