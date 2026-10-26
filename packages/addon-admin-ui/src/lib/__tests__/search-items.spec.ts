import { describe, expect, it } from 'vitest'
import { DeviceType, type DeviceInfo } from '@camstack/types'
import { deviceTypeMeta } from '@camstack/ui-library'
import { Camera, GitBranch } from 'lucide-react'
import type { AddonPageInfo } from '../../layouts/AddonPageLoader'
import { filterSearchItems, flattenSearchResults } from '../global-search'
import {
  buildNavSections,
  type BuildNavSectionsParams,
  type NavSection,
  type NavTranslate,
} from '../nav-items'
import {
  buildDeviceSearchItems,
  buildIntegrationSearchItems,
  buildPageSearchItems,
  type IntegrationSearchSource,
  type PageSearchItemLabels,
} from '../search-items'

function device(over: Partial<DeviceInfo> & Pick<DeviceInfo, 'id'>): DeviceInfo {
  return {
    stableId: `stable-${String(over.id)}`,
    addonId: 'provider-reolink',
    type: DeviceType.Camera,
    name: `Device ${String(over.id)}`,
    location: null,
    disabled: false,
    parentDeviceId: null,
    online: true,
    features: [],
    isCamera: true,
    config: {},
    ...over,
  }
}

function integration(
  over: Partial<IntegrationSearchSource> & Pick<IntegrationSearchSource, 'id'>,
): IntegrationSearchSource {
  return {
    addonId: `addon-${over.id}`,
    name: `Integration ${over.id}`,
    enabled: true,
    processState: 'running',
    ...over,
  }
}

const LABELS: PageSearchItemLabels = {
  detection: 'Detection',
  cluster: 'Cluster',
  administration: 'Administration',
  ungrouped: 'Addon Pages',
}

function navTranslate(key: string): string
function navTranslate(key: string, defaultValue: string): string
function navTranslate(key: string, defaultValue?: string): string {
  return typeof defaultValue === 'string' ? defaultValue : key
}

const navT: NavTranslate = navTranslate

const navSectionsParams: BuildNavSectionsParams = {
  isAdmin: true,
  t: navT,
}

describe('buildNavSections — cluster group routes', () => {
  it('labels the cluster section and orders Nodes before Pipeline', () => {
    const sections = buildNavSections(navSectionsParams)
    expect(sections.find((s) => s.key === 'cluster')?.label).toMatch(/Cluster/)
    expect(sections.find((s) => s.key === 'cluster')?.items.map((i) => i.path)).toEqual([
      '/system/nodes',
      '/system/history',
      '/system/pipeline',
      '/system/addons',
      '/system/ai',
    ])
    expect(sections.find((s) => s.key === 'detection')?.items.map((i) => i.path)).not.toContain(
      '/system/pipeline',
    )
  })
})

function addonPage(over: Partial<AddonPageInfo> & Pick<AddonPageInfo, 'id'>): AddonPageInfo {
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

describe('buildDeviceSearchItems', () => {
  it('maps id, name and path, falling back to stableId when name is blank', () => {
    const [item] = buildDeviceSearchItems([device({ id: 1, name: '' })])
    expect(item).toMatchObject({
      key: 'device:1',
      domain: 'device',
      label: 'stable-1',
      path: '/devices/1',
    })
  })

  it('flags a disabled device in the subtitle', () => {
    const [enabled] = buildDeviceSearchItems([device({ id: 1, disabled: false })])
    const [disabled] = buildDeviceSearchItems([device({ id: 2, disabled: true })])
    expect(enabled?.subtitle).toBe('#1 · stable-1 · camera')
    expect(disabled?.subtitle).toBe('#2 · stable-2 · camera · disabled')
  })

  it('shows the numeric id and the stableId in the subtitle — the only place an id match is visible', () => {
    const [item] = buildDeviceSearchItems([
      device({ id: 102, stableId: 'reolink-ABC0099', name: 'Garage' }),
    ])
    // Both ids present, and the numeric one FIRST: the results list
    // truncates the secondary line from the right.
    expect(item?.subtitle).toBe('#102 · reolink-ABC0099 · camera')
    expect(item?.subtitle?.indexOf('#102')).toBe(0)
  })

  it('does not repeat the stableId in the subtitle when it is already the label', () => {
    const [item] = buildDeviceSearchItems([device({ id: 8, name: '', stableId: 'stable-8' })])
    expect(item?.label).toBe('stable-8')
    expect(item?.subtitle).toBe('#8 · camera')
  })

  it('carries the numeric id as an exact-only identifier, in both bare and printed form', () => {
    const [item] = buildDeviceSearchItems([device({ id: 102 })])
    expect(item?.identifiers).toEqual(['102', '#102'])
    // And NOT as a keyword — keywords match on substring, which would make
    // a one-digit query hit a third of the fleet.
    expect(item?.keywords).not.toContain('102')
  })

  it('carries the type icon from the single ui-library DEVICE_TYPE_META source — not a second map', () => {
    const [camera] = buildDeviceSearchItems([device({ id: 1, type: DeviceType.Camera })])
    const [lock] = buildDeviceSearchItems([device({ id: 2, type: DeviceType.Lock })])
    const [siren] = buildDeviceSearchItems([device({ id: 3, type: DeviceType.Siren })])
    // Compared against `deviceTypeMeta` itself (the single source of truth),
    // not a directly-imported lucide component — a bare `lucide-react`
    // import in THIS file can resolve to a different module instance than
    // the copy `@camstack/ui-library` bundles, which would make an
    // `Object.is` check against it flaky for reasons unrelated to the code
    // under test.
    expect(camera?.icon).toBe(deviceTypeMeta(DeviceType.Camera).icon)
    expect(lock?.icon).toBe(deviceTypeMeta(DeviceType.Lock).icon)
    expect(siren?.icon).toBe(deviceTypeMeta(DeviceType.Siren).icon)
    // Different types get different icons — proves the icon tracks the
    // device's OWN type rather than a single hardcoded fallback.
    expect(lock?.icon).not.toBe(siren?.icon)
    expect(camera?.icon).not.toBe(lock?.icon)
  })

  it('folds stableId, addonId and a non-null location into keywords, dropping blanks', () => {
    const [withLocation] = buildDeviceSearchItems([
      device({ id: 1, location: 'Hall', addonId: 'provider-onvif' }),
    ])
    expect(withLocation?.keywords).toEqual(['stable-1', 'provider-onvif', 'Hall'])

    const [withoutLocation] = buildDeviceSearchItems([device({ id: 2, location: null })])
    expect(withoutLocation?.keywords).toEqual(['stable-2', 'provider-reolink'])
  })
})

describe('buildDeviceSearchItems — the integration the device BELONGS to', () => {
  // D659: "Porch (composto)" is SERVED by `composer` and was CREATED by the
  // "Blocks" integration (int_0024, addonId `core-blocks`).
  const BLOCKS = integration({ id: 'int_0024', addonId: 'core-blocks', name: 'Blocks' })
  const porch = device({ id: 4603, addonId: 'composer', integrationId: 'int_0024' })

  it('a composer-served device is found by the name of the integration that created it', () => {
    const items = buildDeviceSearchItems([porch], [BLOCKS])
    expect(items[0]?.keywords).toContain('Blocks')
    const { groups } = filterSearchItems(items, 'blocks')
    expect(flattenSearchResults(groups).map((i) => i.key)).toContain('device:4603')
  })

  it('an UNANSWERED integrations list adds no integration keyword', () => {
    const [item] = buildDeviceSearchItems([porch], null)
    expect(item?.keywords).toEqual(['stable-4603', 'composer'])
  })
})

describe('buildIntegrationSearchItems', () => {
  it('maps id, name and path, falling back to addonId when name is blank', () => {
    const [item] = buildIntegrationSearchItems([
      integration({ id: 'int-1', name: '', addonId: 'provider-onvif' }),
    ])
    expect(item).toMatchObject({
      key: 'integration:int-1',
      domain: 'integration',
      label: 'provider-onvif',
      path: '/integrations/int-1',
    })
  })

  it('flags a disabled integration in the subtitle', () => {
    const [enabled] = buildIntegrationSearchItems([integration({ id: 'a', enabled: true })])
    const [disabled] = buildIntegrationSearchItems([integration({ id: 'b', enabled: false })])
    expect(enabled?.subtitle).toBe('addon-a')
    expect(disabled?.subtitle).toBe('addon-b · disabled')
  })
})

describe('buildPageSearchItems', () => {
  it('maps built-in nav items, using the section label as the subtitle', () => {
    const sections: readonly NavSection[] = [
      {
        key: 'top',
        label: null,
        items: [{ label: 'Devices', icon: Camera, path: '/devices' }],
      },
      {
        key: 'detection',
        label: 'Detection',
        items: [{ label: 'Pipeline', icon: GitBranch, path: '/pipeline' }],
      },
    ]
    const items = buildPageSearchItems(sections, [], LABELS)
    expect(items).toEqual([
      {
        key: 'page:/devices',
        domain: 'page',
        label: 'Devices',
        subtitle: undefined,
        path: '/devices',
        icon: Camera,
      },
      {
        key: 'page:/pipeline',
        domain: 'page',
        label: 'Pipeline',
        subtitle: 'Detection',
        path: '/pipeline',
        icon: GitBranch,
      },
    ])
  })

  it('carries Library nav keywords so old Detection labels still search-hit', () => {
    const sections = buildNavSections(navSectionsParams)
    const items = buildPageSearchItems(sections, [], LABELS)
    const library = items.find((i) => i.path === '/library')
    expect(library?.label).toBe('Library')
    expect(library?.keywords).toEqual(
      expect.arrayContaining(['People', 'Vehicles', 'Events', 'Scenes', 'plates', 'faces']),
    )
  })

  it('maps addon pages docked into a well-known section to the matching built-in label', () => {
    const [item] = buildPageSearchItems(
      [],
      [addonPage({ id: 'benchmark', section: 'cluster' })],
      LABELS,
    )
    expect(item?.subtitle).toBe('Cluster')
  })

  it('maps an addon page in a custom section to its sectionLabel', () => {
    const [item] = buildPageSearchItems(
      [],
      [
        addonPage({
          id: 'auto',
          section: 'automation',
          sectionLabel: 'Automation',
        }),
      ],
      LABELS,
    )
    expect(item?.subtitle).toBe('Automation')
  })

  it('maps a sectionless addon page to the ungrouped label', () => {
    const [item] = buildPageSearchItems([], [addonPage({ id: 'plain' })], LABELS)
    expect(item?.subtitle).toBe('Addon Pages')
  })

  it('keys addon pages by addonId + page id so two addons can reuse the same page id', () => {
    const items = buildPageSearchItems(
      [],
      [
        addonPage({ id: 'settings', addonId: 'addon-a' }),
        addonPage({ id: 'settings', addonId: 'addon-b' }),
      ],
      LABELS,
    )
    expect(items.map((i) => i.key)).toEqual([
      'page:addon:addon-a:settings',
      'page:addon:addon-b:settings',
    ])
  })
})

/**
 * The two pure functions the operator actually experiences, composed:
 * `buildDeviceSearchItems` → `filterSearchItems`. Asserted on the RANKED
 * output, not on which helper ran — the only thing that matters here is
 * which row lands under the cursor when the operator hits Enter.
 *
 * The fleet is fixed and deliberately adversarial: `102` is a device id AND
 * a substring of two other devices' names.
 */
describe('finding a device by id — buildDeviceSearchItems + filterSearchItems', () => {
  const FLEET: readonly DeviceInfo[] = [
    device({ id: 102, name: 'Front door', stableId: 'reolink-D4A00617X' }),
    device({ id: 12, name: 'Garage 102 est', stableId: 'reolink-QQ0012' }),
    device({ id: 13, name: '102 Cortile', stableId: 'reolink-QQ0013' }),
    device({ id: 14, name: 'Hall', stableId: 'onvif-77PLM9021' }),
  ]

  function search(query: string): readonly string[] {
    const { groups } = filterSearchItems(buildDeviceSearchItems(FLEET), query)
    return flattenSearchResults(groups).map((i) => i.label)
  }

  it('puts the device whose ID is 102 first, above every device merely NAMED "102"', () => {
    // "102 Cortile" is a label PREFIX match and "Garage 102 est" a
    // word-boundary match — both of which outrank everything except an
    // exact identifier. Device 102 is called "Front door" and shares not one
    // character with the query.
    expect(search('102')).toEqual(['Front door', '102 Cortile', 'Garage 102 est'])
  })

  it('accepts the `#102` form the result row itself prints', () => {
    expect(search('#102')[0]).toBe('Front door')
  })

  it('finds a device by a SUBSTRING of its stableId — nobody types the whole one', () => {
    expect(search('77PLM')).toEqual(['Hall'])
    expect(search('D4A00617X')).toEqual(['Front door'])
  })

  it('an id is a fact, not a spelling: "108" does not fuzzy-match device 102', () => {
    expect(search('618')).toEqual([])
  })

  it('does not regress name search — a name query still returns exactly what it did', () => {
    expect(search('hall')).toEqual(['Hall'])
    expect(search('garage')).toEqual(['Garage 102 est'])
    // Fuzzy (subsequence) still reaches through a dropped letter.
    expect(search('frntdoor')).toEqual(['Front door'])
  })

  // ── the container ────────────────────────────────────────────────────────
  //
  // The fleet has four devices called "Blocco bambini" and nine called
  // "Temperatura". A result list that shows the name and an opaque stableId is
  // one the operator cannot pick from — and the stableId is the segment that
  // gets truncated away first, so it was carrying the width without carrying
  // the answer.
  describe('buildDeviceSearchItems — the container', () => {
    it('puts the container in the title and does not repeat it under the id', () => {
      const items = buildDeviceSearchItems([
        device({ id: 106, name: 'Baby monitor' }),
        device({ id: 642, name: 'Baby monitor Floodlight', parentDeviceId: 106 }),
      ])
      const child = items.find((i) => i.key === 'device:642')
      expect(child?.label).toBe('Baby monitor · Floodlight')
      expect(child?.subtitle).toBe('#642 · stable-642 · camera')
    })

    it('says nothing for a top-level device', () => {
      const items = buildDeviceSearchItems([device({ id: 106, name: 'Baby monitor' })])
      expect(items[0]?.subtitle).toBe('#106 · stable-106 · camera')
    })

    it('a container outside the listing is named by id, never dropped', () => {
      const items = buildDeviceSearchItems([device({ id: 7, parentDeviceId: 99 })])
      expect(`${items[0]?.label ?? ''} ${items[0]?.subtitle ?? ''}`).toContain('#99')
    })

    it('matches on the container — "baby" finds the floodlight inside it', () => {
      const items = buildDeviceSearchItems([
        device({ id: 106, name: 'Baby monitor' }),
        device({ id: 642, name: 'Floodlight', parentDeviceId: 106 }),
      ])
      expect(items.find((i) => i.key === 'device:642')?.keywords).toContain('Baby monitor')
    })
  })
})
