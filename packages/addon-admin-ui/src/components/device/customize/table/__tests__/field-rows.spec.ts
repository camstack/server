import type { CompositionFieldsCard, CompositionFieldsFeature } from '@camstack/types'
import { compositionSourceKey } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  type FieldRow,
  type SourcePresence,
  fieldGroups,
  fieldRowState,
  itemFieldRows,
} from '../field-rows'

const SRC = { addonId: 'provider-homeassistant', stableId: 'sensor.level' }
const from = {
  kind: 'from',
  sources: [{ source: SRC, cap: 'enum-sensor', fieldPath: 'value' }],
  aggregate: null,
} as const

function card(entries: CompositionFieldsCard['entries']): CompositionFieldsCard {
  return { cardKind: 'fields', cap: 'pet-fountain', enabled: undefined, entries, items: undefined }
}

describe('per-field rows of an off-catalog cap', () => {
  it('lists a required field nobody bound as a to-fill row, one row per field', () => {
    const [group] = fieldGroups([card({ pumpRunning: from })])
    const toFill = group?.rows.filter((row) => row.entry === null) ?? []
    expect(toFill.length).toBeGreaterThan(0)
    expect(group?.rows.map((r) => r.path)).toContain('pumpRunning')
    expect(group?.rows.every((r) => r.item === null)).toBe(true)
  })

  it('moves clocks and constants under Advanced', () => {
    const [group] = fieldGroups([
      card({
        pumpRunning: from,
        lastFetchedAt: { kind: 'companion', companion: 'now' },
        error: { kind: 'formula', expr: 'null', bindings: {} },
      }),
    ])
    expect(group?.advanced.map((r) => r.path).toSorted()).toEqual(['error', 'lastFetchedAt'])
    expect(group?.rows.map((r) => r.path)).not.toContain('lastFetchedAt')
  })
})

describe('the row state', () => {
  const row = (entry: FieldRow['entry']): FieldRow => ({
    key: 'k',
    cap: 'pet-fountain',
    path: 'waterLevel',
    entry,
    advanced: false,
    item: null,
  })
  const key = compositionSourceKey(SRC)
  const presence = (p: SourcePresence | null): ReadonlyMap<string, SourcePresence> | null =>
    p === null ? null : new Map([[key, p]])

  it('is to fill without an entry, whatever the fleet says', () => {
    expect(fieldRowState(row(null), presence('answering')).kind).toBe('toFill')
  })
  it('claims nothing while the fleet is unread', () => {
    expect(fieldRowState(row(from), null).kind).toBe('checking')
  })
  it('tells a listed online source, an offline one and a vanished one apart', () => {
    expect(fieldRowState(row(from), presence('answering')).kind).toBe('bound')
    expect(fieldRowState(row(from), presence('offline')).kind).toBe('notAnswering')
    expect(fieldRowState(row(from), new Map()).kind).toBe('missing')
  })
})

describe('a keyed item as a form', () => {
  it('has one row per bound field and leaves the kind literal out', () => {
    const feature: CompositionFieldsFeature = {
      kind: 'fields',
      cap: 'consumables',
      fields: {},
      items: {
        filter: {
          label: 'Filter',
          fields: {
            'remaining.value': {
              kind: 'from',
              source: SRC,
              cap: 'enum-sensor',
              fieldPath: 'value',
            },
            'remaining.kind': { kind: 'expression', expr: '"duration"', bindings: {} },
          },
        },
      },
    }
    const rows = itemFieldRows(feature)
    expect(rows.map((r) => r.path)).toEqual(['remaining.value'])
    expect(rows[0]?.item).toEqual({ key: 'filter', label: 'Filter' })
  })
})
