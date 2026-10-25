/**
 * Keyed-array compiler: one feature owns the array. Each item assigns one
 * declared field. Native rows are not part of the feature.
 */
import { describe, expect, it } from 'vitest'
import type { CompositionFieldsFeature, CompositionItemEntry } from '../../composition.js'
import { literal, fromRead } from '../field-source.js'
import {
  compileKeyedArrayOverride,
  mergeKeyedArrayItem,
  withoutKeyedArrayItem,
  type KeyedArrayItemCompile,
} from '../keyed-array-compile.js'
import { decodeKeyedArrayOverride, readKeyedArrayItems } from '../keyed-array-decode.js'
import { projectKeyedArrayAssignment } from '../keyed-array-status.js'

const DEVICE = { addonId: 'provider-homeassistant', stableId: 'feeder' }
const METER = { addonId: 'provider-homeassistant', stableId: 'meter' }

function levelItem(key: string, label: string): KeyedArrayItemCompile {
  return {
    draft: {
      kind: 'keyedArray',
      cap: 'consumables',
      targetId: 'items',
      key,
      label,
      fieldPath: 'level',
      source: { ...METER, cap: 'numeric-sensor', fieldPath: 'value' },
      transform: { kind: 'identity' },
    },
    sourceValueKind: 'number',
    sourceUnit: null,
    literals: [
      { path: 'kind', value: 'wear' },
      { path: 'form', value: 'part' },
    ],
  }
}

function compile(items: readonly KeyedArrayItemCompile[]) {
  return compileKeyedArrayOverride({
    cap: 'consumables',
    targetId: 'items',
    device: DEVICE,
    apply: 'add',
    items,
  })
}

describe('keyed-array compiler', () => {
  it('writes one level item and reads it back', () => {
    const compiled = compile([levelItem('food', 'Food')])
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(compiled.value.fields).toEqual({
      lastChangedAt: literal('now'),
      lastFetchedAt: literal('now'),
    })
    expect(compiled.value.items?.['food']).toEqual({
      label: 'Food',
      fields: {
        level: fromRead(METER, 'numeric-sensor', 'value'),
        kind: literal('"wear"'),
        form: literal('"part"'),
      },
    })
    const decoded = decodeKeyedArrayOverride({
      feature: compiled.value,
      device: DEVICE,
      cap: 'consumables',
      targetId: 'items',
    })
    expect(decoded?.items.map((item) => item.compile?.draft.key)).toEqual(['food'])
  })

  it('requires the remaining unit literal and refuses a string source', () => {
    const missing = compile([
      {
        ...levelItem('filter', 'Filter'),
        draft: { ...levelItem('filter', 'Filter').draft, fieldPath: 'remaining.value' },
        literals: [],
      },
    ])
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.reason).toBe('literal')
    const days = compile([
      {
        ...levelItem('filter', 'Filter'),
        draft: { ...levelItem('filter', 'Filter').draft, fieldPath: 'remaining.value' },
        literals: [{ path: 'remaining.unit', value: 'days' }],
      },
    ])
    expect(days.ok).toBe(true)
    const stringSource = compile([
      {
        ...levelItem('filter', 'Filter'),
        sourceValueKind: 'string',
      },
    ])
    expect(stringSource.ok).toBe(false)
    if (stringSource.ok) return
    expect(stringSource.reason).toBe('source-kind')
  })

  it('maps an enum and refuses a value the field cannot hold', () => {
    const mapped = compile([
      {
        ...levelItem('pad', 'Mop pad'),
        draft: {
          ...levelItem('pad', 'Mop pad').draft,
          fieldPath: 'status',
          source: { ...METER, cap: 'enum-sensor', fieldPath: 'state' },
          transform: { kind: 'enum-map', mapping: { installed: 'ok', missing: 'replace' } },
        },
        sourceValueKind: 'enum',
        literals: [],
      },
    ])
    expect(mapped.ok).toBe(true)
    if (!mapped.ok) return
    const decoded = decodeKeyedArrayOverride({
      feature: mapped.value,
      device: DEVICE,
      cap: 'consumables',
      targetId: 'items',
    })
    expect(decoded?.items[0]?.compile?.draft.transform).toEqual({
      kind: 'enum-map',
      mapping: { installed: 'ok', missing: 'replace' },
    })
    const refused = compile([
      {
        ...levelItem('pad', 'Mop pad'),
        draft: {
          ...levelItem('pad', 'Mop pad').draft,
          fieldPath: 'status',
          transform: { kind: 'enum-map', mapping: { installed: 'nope' } },
        },
        sourceValueKind: 'enum',
        literals: [],
      },
    ])
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.reason).toBe('enum')
  })

  it('removes one item and leaves the other byte-for-byte', () => {
    const compiled = compile([levelItem('food', 'Food'), levelItem('filter', 'Filter')])
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const food = compiled.value.items?.['food']
    const left = withoutKeyedArrayItem(compiled.value, 'filter')
    expect(left?.items?.['food']).toBe(food)
    expect(Object.keys(left?.items ?? {})).toEqual(['food'])
    expect(withoutKeyedArrayItem(left ?? compiled.value, 'food')).toBeNull()
  })

  it('does not recognise an item with a leaf this card did not declare', () => {
    const compiled = compile([levelItem('food', 'Food')])
    expect(compiled.ok).toBe(true)
    if (!compiled.ok || compiled.value.items?.['food'] === undefined) return
    const food = compiled.value.items['food']
    const extra: CompositionItemEntry = {
      ...food,
      fields: { ...food.fields, status: literal('"ok"') },
    }
    const feature: CompositionFieldsFeature = {
      ...compiled.value,
      items: { food: extra },
    }
    const read = readKeyedArrayItems(feature, 'consumables', 'items')
    expect(read?.canonical).toBe(true)
    expect(read?.items[0]?.recognized).toBe(false)
    const decoded = decodeKeyedArrayOverride({
      feature,
      device: DEVICE,
      cap: 'consumables',
      targetId: 'items',
    })
    expect(decoded).toBeNull()
  })

  it('merges a new item without replacing the stored sibling', () => {
    const first = compile([levelItem('food', 'Food')])
    const second = compile([levelItem('filter', 'Filter')])
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    const food = first.value.items?.['food']
    const merged = mergeKeyedArrayItem(first.value, second.value, 'filter')
    expect(merged?.items?.['food']).toBe(food)
    expect(merged?.fields).toBe(first.value.fields)
    expect(merged?.items?.['filter']?.label).toBe('Filter')
  })

  it('projects native, assigned and an unread customization', () => {
    const compiled = compile([levelItem('food', 'Food'), levelItem('filter', 'Filter')])
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const assigned = projectKeyedArrayAssignment({
      cap: 'consumables',
      targetId: 'items',
      device: DEVICE,
      stored: { kind: 'known', value: compiled.value },
      sourcePresence: 'present',
      sourceUnknownReason: null,
    })
    expect(assigned.text).toBe('2 assigned')
    expect(assigned.status.state).toBe('active')
    const none = projectKeyedArrayAssignment({
      cap: 'consumables',
      targetId: 'items',
      device: DEVICE,
      stored: { kind: 'known', value: null },
      sourcePresence: 'present',
      sourceUnknownReason: null,
    })
    expect(none.text).toBe('Native')
    const pending = projectKeyedArrayAssignment({
      cap: 'consumables',
      targetId: 'items',
      device: DEVICE,
      stored: { kind: 'pending' },
      sourcePresence: 'present',
      sourceUnknownReason: null,
    })
    expect(pending.text).toBe('pending')
    expect(pending.status.state).toBe('unavailable')
  })
})
