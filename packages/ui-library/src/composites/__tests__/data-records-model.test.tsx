// @vitest-environment jsdom
/**
 * The unified Data record view: facet groups over declared kinds (entry and
 * record), the entry-title join, and the compact `menu` filter group. An
 * unknown row count is never "empty".
 */
import { StorageKindSchema, type EntryKindInfo, type StorageKind } from '@camstack/types'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  buildDataRecordRows,
  DATA_RECORD_FACET_GROUPS,
  dataRecordContents,
  dataRecordSearchText,
} from '../data-records/data-records-model'
import {
  EMPTY_DATA_TABLE_FILTER,
  filterDataTableRows,
  toggleDataTableGroupFacet,
  type DataTableFilterState,
} from '../data-table-filter'
import { DataTableFilterBar } from '../data-table-filter-bar'

function kind(over: Partial<StorageKind> & Pick<StorageKind, 'owner' | 'kind'>): StorageKind {
  return StorageKindSchema.parse({
    database: 'settings',
    class: 'config',
    state: 'declared',
    rows: 1,
    bytesEstimate: 10,
    writeTrigger: 'operator',
    retention: { none: 'test' },
    entry: false,
    declaration: { class: 'config', writeTrigger: 'operator', retention: { none: 'test' } },
    ...over,
  })
}

const KINDS: readonly StorageKind[] = [
  kind({ owner: 'ml', kind: 'llm-profiles', entry: true, rows: 2 }),
  kind({ owner: 'notifiers', kind: 'targets', entry: true, rows: 0 }),
  kind({
    owner: 'recorder',
    kind: 'segments',
    database: 'events',
    class: 'ledger',
    rows: 40,
  }),
  kind({ owner: 'old', kind: 'gone', state: 'orphaned', rows: null }),
]

const ENTRY_KINDS: readonly EntryKindInfo[] = [
  {
    owner: 'ml',
    kind: 'llm-profiles',
    title: 'LLM profiles',
    nameField: 'name',
    fields: {},
    secretPaths: [],
    rows: 2,
  },
]

function pick(state: DataTableFilterState, groups: Record<string, string[]>): DataTableFilterState {
  return Object.entries(groups).reduce(
    (acc, [id, values]) =>
      values.reduce((inner, value) => toggleDataTableGroupFacet(inner, id, value), acc),
    state,
  )
}

function run(groups: Record<string, string[]>, search = ''): string[] {
  const rows = buildDataRecordRows(KINDS, ENTRY_KINDS)
  return filterDataTableRows(
    rows,
    { ...pick(EMPTY_DATA_TABLE_FILTER, groups), search },
    { searchText: dataRecordSearchText, facetGroups: DATA_RECORD_FACET_GROUPS },
  ).map((r) => r.kind.kind)
}

describe('data record rows', () => {
  it('joins the entry title only onto entry kinds, and survives an unanswered catalog', () => {
    const joined = buildDataRecordRows(KINDS, ENTRY_KINDS)
    expect(joined.map((r) => r.entryTitle)).toEqual(['LLM profiles', null, null, null])
    const pending = buildDataRecordRows(KINDS, undefined)
    expect(pending).toHaveLength(KINDS.length)
    expect(pending.every((r) => r.entryTitle === null)).toBe(true)
  })

  it('an unreadable row count is unknown, never empty', () => {
    expect(dataRecordContents(kind({ owner: 'a', kind: 'b', rows: null }))).toBe('unknown')
    expect(dataRecordContents(kind({ owner: 'a', kind: 'b', rows: 0 }))).toBe('empty')
    expect(run({ contents: ['empty'] })).toEqual(['targets'])
  })
})

describe('data record filters', () => {
  it('ORs inside a group and ANDs across groups', () => {
    expect(run({ owner: ['ml', 'recorder'] })).toEqual(['llm-profiles', 'segments'])
    expect(run({ owner: ['ml', 'recorder'], database: ['events'] })).toEqual(['segments'])
  })

  it('filters entry vs record, state and class', () => {
    expect(run({ type: ['entry'] })).toEqual(['llm-profiles', 'targets'])
    expect(run({ type: ['record'], state: ['orphaned'] })).toEqual(['gone'])
    expect(run({ class: ['ledger'] })).toEqual(['segments'])
  })

  it('narrows to several kinds picked together', () => {
    expect(run({ kind: ['ml/llm-profiles', 'old/gone'] })).toEqual(['llm-profiles', 'gone'])
  })

  it('the search also matches the entry title', () => {
    expect(run({}, 'LLM')).toEqual(['llm-profiles'])
  })
})

describe('DataTableFilterBar menu groups', () => {
  it('draws one trigger per group and toggles exactly the changed values', () => {
    const toggled: Array<[string, string]> = []
    render(
      <DataTableFilterBar
        state={EMPTY_DATA_TABLE_FILTER}
        facets={[]}
        groups={[
          {
            id: 'owner',
            label: 'Owner',
            facets: [
              { value: 'ml', count: 1 },
              { value: 'recorder', count: 2 },
            ],
            selected: ['ml'],
            display: 'menu',
          },
        ]}
        labels={{
          searchPlaceholder: 's',
          searchLabel: 's',
          facetsLabel: 'f',
          clearLabel: 'c',
        }}
        onSearch={() => {}}
        onToggleFacet={() => {}}
        onToggleGroupFacet={(id, value) => toggled.push([id, value])}
        onClear={() => {}}
      />,
    )
    const trigger = screen.getByRole('button', { name: /Owner · 1/ })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('option', { name: /recorder/ }))
    expect(toggled).toEqual([['owner', 'recorder']])
  })
})
