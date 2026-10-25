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
      ids(applyExportFilters(DEVICES, { roles: [], providers: ['provider-homematic'] })),
    ).toEqual([3, 4])
    expect(
      ids(
        applyExportFilters(DEVICES, {
          roles: ['cover-blind', 'outlet'],
          providers: ['provider-homematic'],
        }),
      ),
    ).toEqual([3])
  })

  it('offers only the roles and providers present, sorted', () => {
    expect(roleFilterOptions(DEVICES).map((o) => o.id)).toEqual(['(none)', 'cover-blind', 'outlet'])
    expect(providerFilterOptions(DEVICES).map((o) => o.id)).toEqual([
      'provider-homeassistant',
      'provider-homematic',
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
