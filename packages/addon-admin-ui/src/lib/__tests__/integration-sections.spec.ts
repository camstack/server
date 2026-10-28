import { describe, expect, it } from 'vitest'
import { splitIntegrationSections, systemAddonIdsOf } from '../integration-sections'

const addon = (id: string, packageName: string) => ({ manifest: { id, packageName } })

describe('systemAddonIdsOf', () => {
  it('names the addons shipped in a framework package, never by addon id', () => {
    const ids = systemAddonIdsOf([
      addon('core-blocks', '@camstack/system'),
      addon('camera-grid', '@camstack/system'),
      addon('provider-reolink', '@camstack/addon-provider-reolink'),
    ])
    expect([...ids].sort()).toEqual(['camera-grid', 'core-blocks'])
  })

  it('is empty while the addon list has not answered', () => {
    expect(systemAddonIdsOf(undefined).size).toBe(0)
  })
})

describe('splitIntegrationSections', () => {
  const rows = [
    { id: 'a', addonId: 'provider-reolink' },
    { id: 'b', addonId: 'core-blocks' },
    { id: 'c', addonId: 'provider-onvif' },
    { id: 'd', addonId: 'unknown-addon' },
  ]

  it('puts system-offered integrations in System and the rest in Providers, order kept', () => {
    const { providers, system } = splitIntegrationSections(rows, new Set(['core-blocks']))
    expect(providers.map((r) => r.id)).toEqual(['a', 'c', 'd'])
    expect(system.map((r) => r.id)).toEqual(['b'])
  })

  it('leaves an empty block empty', () => {
    expect(splitIntegrationSections(rows, new Set()).system).toEqual([])
    const onlySystem = splitIntegrationSections([rows[1]], new Set(['core-blocks']))
    expect(onlySystem.providers).toEqual([])
  })
})
