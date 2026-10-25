import { describe, expect, it } from 'vitest'
import {
  buildCapabilityLookup,
  CompositionSchema,
  compositionFieldKey,
  planComposition,
} from '../index.js'
import { ALL_CAPABILITY_DEFINITIONS } from '../../generated/capability-router-map.js'
import { DeviceType } from '../../device/device-type.js'

const lookup = buildCapabilityLookup(ALL_CAPABILITY_DEFINITIONS)
const days = {
  kind: 'from',
  source: {
    addonId: 'provider-homeassistant',
    stableId: 'ha:b:dev:f-sensor.freshelement_3_desiccant_days_remaining',
  },
  cap: 'numeric-sensor',
  fieldPath: 'value',
} as const

function consumables(items: unknown) {
  return CompositionSchema.parse({
    target: { kind: 'new', type: DeviceType.Generic },
    features: [
      {
        kind: 'fields',
        cap: 'consumables',
        fields: {
          lastChangedAt: { kind: 'expression', expr: 'now', bindings: {} },
          lastFetchedAt: { kind: 'expression', expr: 'now', bindings: {} },
        },
        items,
      },
    ],
  })
}

describe('item-array fields (D663)', () => {
  it('plans one field per item leaf, nested paths inside the item allowed', () => {
    const plan = planComposition(
      consumables({
        desiccant: {
          label: 'Desiccant',
          fields: {
            'remaining.value': days,
            'remaining.unit': { kind: 'expression', expr: '"days"', bindings: {} },
            status: {
              kind: 'expression',
              expr: 'd <= 0 ? "replace" : "ok"',
              bindings: { d: days },
            },
          },
        },
      }),
      lookup,
    )
    expect(plan.problems).toEqual([])
    const item = plan.fields.filter((f) => f.item !== undefined)
    expect(item.map((f) => f.path).sort()).toEqual(['remaining.unit', 'remaining.value', 'status'])
    expect(item.every((f) => f.item?.key === 'desiccant' && f.item.label === 'Desiccant')).toBe(
      true,
    )
  })

  it('two items sharing an inner path are two fields with two keys (never one record)', () => {
    const plan = planComposition(
      consumables({
        desiccant: {
          label: 'Desiccant',
          fields: { status: { kind: 'expression', expr: '"ok"', bindings: {} } },
        },
        filter: {
          label: 'Filter',
          fields: { status: { kind: 'expression', expr: '"replace"', bindings: {} } },
        },
      }),
      lookup,
    )
    expect(plan.problems).toEqual([])
    const keys = plan.fields
      .filter((f) => f.item !== undefined)
      .map(compositionFieldKey)
      .sort()
    expect(keys).toEqual([
      'consumables.items[desiccant].status',
      'consumables.items[filter].status',
    ])
    expect(new Set(keys).size).toBe(2)
  })

  it('refuses a source for resettable by name', () => {
    const plan = planComposition(
      consumables({
        d: {
          label: 'D',
          fields: { resettable: { kind: 'expression', expr: 'true', bindings: {} } },
        },
      }),
      lookup,
    )
    expect(plan.problems.map((p) => p.code)).toContain('item-field-reserved')
  })

  it('refuses a source for the key field by name — the key comes from the entry', () => {
    const plan = planComposition(
      consumables({
        d: { label: 'D', fields: { key: { kind: 'expression', expr: '"x"', bindings: {} } } },
      }),
      lookup,
    )
    expect(plan.problems.map((p) => p.code)).toContain('item-field-reserved')
  })

  it('refuses a source for the label field by name — the label comes from the entry', () => {
    const plan = planComposition(
      consumables({
        d: { label: 'D', fields: { label: { kind: 'expression', expr: '"x"', bindings: {} } } },
      }),
      lookup,
    )
    expect(plan.problems).toEqual([
      expect.objectContaining({
        code: 'item-field-reserved',
        path: 'features[0].items.d.fields.label',
      }),
    ])
  })

  it('refuses an unknown item field and a non-leaf one (`remaining`) as unknown-field', () => {
    const plan = planComposition(
      consumables({
        d: {
          label: 'D',
          fields: {
            colour: { kind: 'expression', expr: '"red"', bindings: {} },
            remaining: { kind: 'expression', expr: '1', bindings: {} },
          },
        },
      }),
      lookup,
    )
    expect(plan.problems.map((p) => [p.code, p.path]).sort()).toEqual([
      ['unknown-field', 'features[0].items.d.fields.colour'],
      ['unknown-field', 'features[0].items.d.fields.remaining'],
    ])
  })

  it('refuses a source of the wrong kind for an item leaf', () => {
    const plan = planComposition(
      consumables({
        d: { label: 'D', fields: { level: { kind: 'expression', expr: '"full"', bindings: {} } } },
      }),
      lookup,
    )
    expect(plan.problems).toEqual([
      expect.objectContaining({ code: 'kind-mismatch', path: 'features[0].items.d.fields.level' }),
    ])
  })

  it('an item with no fields is complete: nullable leaves are written null, an optional parent is absent', () => {
    const plan = planComposition(consumables({ d: { label: 'D', fields: {} } }), lookup)
    expect(plan.problems).toEqual([])
  })

  it('a required leaf under an optional parent is required once the parent is written', () => {
    const plan = planComposition(
      consumables({ d: { label: 'D', fields: { 'remaining.value': days } } }),
      lookup,
    )
    expect(plan.problems).toEqual([
      expect.objectContaining({
        code: 'missing-field',
        path: 'features[0].items.d.fields.remaining.unit',
      }),
    ])
  })

  it('refuses items on a cap with no itemArray', () => {
    const c = CompositionSchema.parse({
      target: { kind: 'new', type: DeviceType.Sensor },
      features: [
        { kind: 'fields', cap: 'binary', fields: {}, items: { x: { label: 'X', fields: {} } } },
      ],
    })
    expect(planComposition(c, lookup).problems.map((p) => p.code)).toContain('not-item-array')
  })

  it('a cap whose every served method has a composedMethods answer is composable; one without is still has-commands', () => {
    const ok = planComposition(consumables({}), lookup)
    expect(ok.problems.map((p) => p.code)).not.toContain('has-commands')
    const siren = CompositionSchema.parse({
      target: { kind: 'new', type: DeviceType.Switch },
      features: [{ kind: 'fields', cap: 'switch', fields: {} }],
    })
    expect(planComposition(siren, lookup).problems.map((p) => p.code)).toContain('has-commands')
  })
})
