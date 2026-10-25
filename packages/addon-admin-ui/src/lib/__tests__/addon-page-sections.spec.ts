import { describe, expect, it } from 'vitest'
import type { AddonPageInfo } from '../../layouts/AddonPageLoader'
import { partitionAddonPages } from '../addon-page-sections'

function page(over: Partial<AddonPageInfo> & Pick<AddonPageInfo, 'id'>): AddonPageInfo {
  return {
    addonId: over.addonId ?? over.id,
    label: over.id,
    icon: 'puzzle',
    path: `/addon/${over.id}`,
    remoteName: `addon_${over.id}_page`,
    bundle: 'remoteEntry.js',
    bundleUrl: `/api/addon-pages/${over.id}/remoteEntry.js`,
    ...over,
  }
}

describe('partitionAddonPages', () => {
  it('docks well-known section ids into their built-in groups', () => {
    const result = partitionAddonPages([
      page({ id: 'benchmark', section: 'detection' }),
      page({ id: 'model-studio', section: 'detection' }),
      page({ id: 'fleet', section: 'cluster' }),
    ])
    expect(result.known.get('detection')?.map((p) => p.id)).toEqual(['benchmark', 'model-studio'])
    expect(result.known.get('cluster')?.map((p) => p.id)).toEqual(['fleet'])
    expect(result.custom).toEqual([])
    expect(result.ungrouped).toEqual([])
  })

  it('creates custom sections (first sectionLabel wins, id fallback) in first-seen order', () => {
    const result = partitionAddonPages([
      page({ id: 'a', section: 'automation', sectionLabel: 'Automation' }),
      page({ id: 'b', section: 'automation', sectionLabel: 'Ignored Later Label' }),
      page({ id: 'c', section: 'tools' }),
    ])
    expect(result.custom.map((s) => ({ id: s.id, label: s.label, n: s.pages.length }))).toEqual([
      { id: 'automation', label: 'Automation', n: 2 },
      { id: 'tools', label: 'tools', n: 1 },
    ])
  })

  it('pages without a section (or blank) land in the legacy ungrouped bucket', () => {
    const result = partitionAddonPages([
      page({ id: 'plain' }),
      page({ id: 'blank', section: '  ' }),
    ])
    expect(result.ungrouped.map((p) => p.id)).toEqual(['plain', 'blank'])
    expect(result.known.size).toBe(0)
  })
})
