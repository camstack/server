import { describe, expect, it } from 'vitest'
import {
  installedIsNewerDevBuild,
  INSTALLED_NEWER_NOTE,
  partitionAddonUpdates,
} from '../mcp/addon-update-partition.js'

describe('partitionAddonUpdates', () => {
  it('does not offer 1.2.681 over a 1.2.942 dev build and says the install is newer', () => {
    const r = partitionAddonUpdates([
      {
        name: '@camstack/addon-pipeline',
        currentVersion: '1.2.942-dev.1795359713',
        latestVersion: '1.2.681',
      },
      { name: '@camstack/addon-x', currentVersion: '1.2.6', latestVersion: '1.2.7' },
    ])
    expect(r.offer.map((u) => u.name)).toEqual(['@camstack/addon-x'])
    expect(r.installedNewer).toEqual([
      {
        name: '@camstack/addon-pipeline',
        installed: '1.2.942-dev.1795359713',
        registry: '1.2.681',
        note: INSTALLED_NEWER_NOTE,
      },
    ])
  })

  it('keeps a newer registry, a lower release line and unparseable versions as offered', () => {
    expect(installedIsNewerDevBuild('1.2.942-dev.1', '1.2.943')).toBe(false)
    expect(installedIsNewerDevBuild('1.2.7', '1.2.6')).toBe(false)
    expect(installedIsNewerDevBuild('weird', '1.2.6')).toBe(false)
  })
})
