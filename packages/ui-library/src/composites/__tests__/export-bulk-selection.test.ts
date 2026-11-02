import { describe, expect, it } from 'vitest'
import {
  NO_EXPORT_FILTERS,
  NO_ROLE_FILTER_ID,
  applyExportFilters,
  deselectShown,
  providerFilterOptions,
  roleFilterOptions,
  selectShown,
} from '../export-bulk-selection'

const DEVICES = [
  { id: 1, addonId: 'provider-homeassistant', role: 'outlet' },
  { id: 2, addonId: 'provider-homeassistant', role: null },
  { id: 3, addonId: 'provider-homematic', role: 'cover-blind' },
  { id: 4, addonId: 'provider-homematic' },
]

const ids = (rows: readonly { readonly id: number }[]): number[] => rows.map((d) => d.id)

describe('export bulk filters', () => {
  it('no filter keeps every row: nothing is hidden by default', () => {
    expect(applyExportFilters(DEVICES, NO_EXPORT_FILTERS)).toHaveLength(4)
  })

  it('filters by role, and a roleless row is the "(none)" role', () => {
    expect(ids(applyExportFilters(DEVICES, { roles: ['outlet'], providers: [] }))).toEqual([1])
    expect(ids(applyExportFilters(DEVICES, { roles: [NO_ROLE_FILTER_ID], providers: [] }))).toEqual(
      [2, 4],
    )
  })

  it('filters by provider, and role and provider combine (AND)', () => {
    expect(
      ids(applyExportFilters(DEVICES, { roles: [], providers: ['addon:provider-homematic'] })),
    ).toEqual([3, 4])
    expect(
      ids(
        applyExportFilters(DEVICES, {
          roles: ['cover-blind', 'outlet'],
          providers: ['addon:provider-homematic'],
        }),
      ),
    ).toEqual([3])
  })

  it('offers only the roles and providers present, sorted by label', () => {
    expect(roleFilterOptions(DEVICES).map((o) => o.id)).toEqual(['(none)', 'cover-blind', 'outlet'])
    expect(providerFilterOptions(DEVICES).map((o) => o.label)).toEqual([
      'provider-homeassistant',
      'provider-homematic',
    ])
  })

  it('labels roles through the caller, and providers by integration NAME', () => {
    const integrations = [
      { id: 'int_0007', addonId: 'provider-homematic', name: 'Homematic CCU' },
      { id: 'int_0003', addonId: 'provider-homeassistant', name: 'Home Assistant' },
    ]
    const labelled = roleFilterOptions(DEVICES, (id) => `L:${id}`)
    expect(labelled.map((o) => o.label)).toEqual(['L:(none)', 'L:cover-blind', 'L:outlet'])
    const options = providerFilterOptions(DEVICES, integrations)
    expect(options).toEqual([
      { id: 'int_0003', label: 'Home Assistant' },
      { id: 'int_0007', label: 'Homematic CCU' },
    ])
    // The filter value is the integration id, so it narrows to its devices.
    expect(
      ids(applyExportFilters(DEVICES, { roles: [], providers: ['int_0007'] }, integrations)),
    ).toEqual([3, 4])
  })

  it('a device created under another integration is filed under THAT one', () => {
    const integrations = [
      { id: 'int_0024', addonId: 'core-blocks', name: 'Blocks' },
      { id: 'int_0001', addonId: 'composer', name: 'Composer' },
    ]
    const composed = [{ id: 1, addonId: 'composer', integrationId: 'int_0024' }]
    expect(providerFilterOptions(composed, integrations)).toEqual([
      { id: 'int_0024', label: 'Blocks' },
    ])
  })
})

describe('export bulk selection', () => {
  it('selects every shown row and keeps the rest of the selection', () => {
    const shown = DEVICES.filter((d) => d.id <= 2)
    expect([...selectShown(new Set(['9']), shown)].toSorted()).toEqual(['1', '2', '9'])
  })

  it('deselects only the shown rows; selections outside the filter stay', () => {
    const shown = DEVICES.filter((d) => d.id <= 2)
    expect([...deselectShown(new Set(['1', '2', '3']), shown)]).toEqual(['3'])
  })

  it('does not mutate its input', () => {
    const current: ReadonlySet<string> = new Set(['1'])
    selectShown(current, DEVICES)
    deselectShown(current, DEVICES)
    expect([...current]).toEqual(['1'])
  })
})
