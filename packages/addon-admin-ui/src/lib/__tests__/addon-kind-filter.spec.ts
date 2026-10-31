import { describe, expect, it } from 'vitest'
import { filterIntegrationAddons, parseAddonKindFilter } from '../addon-kind-filter'

const addons = [{ manifest: { id: 'a' } }, { manifest: { id: 'b' } }]

describe('addon kind filter', () => {
  it('parses only the known kind', () => {
    expect(parseAddonKindFilter('integration')).toBe('integration')
    expect(parseAddonKindFilter('x')).toBeNull()
    expect(parseAddonKindFilter(null)).toBeNull()
  })
  it('keeps integration addons only', () => {
    expect(filterIntegrationAddons(addons, new Set(['b']))).toEqual([addons[1]])
  })
  it('leaves the list whole while the types are unanswered, empties it when answered with none', () => {
    expect(filterIntegrationAddons(addons, null)).toEqual(addons)
    expect(filterIntegrationAddons(addons, new Set())).toEqual([])
  })
})
