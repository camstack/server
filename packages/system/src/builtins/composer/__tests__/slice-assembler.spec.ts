import {
  type CompositionFieldPlan,
  compositionFieldKey,
  CompositionSchema,
  DeviceType,
  type ExpressionValue,
  planComposition,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { type AssemblerEntry, assembleSlice } from '../slice-assembler.js'
import { LOOKUP_CAP } from './fixtures.js'

const DAYS = {
  kind: 'from',
  source: {
    addonId: 'provider-homeassistant',
    stableId: 'ha:b:dev:f-sensor.freshelement_3_desiccant_days_remaining',
  },
  cap: 'numeric-sensor',
  fieldPath: 'value',
} as const

/** A feeder's consumables: the desiccant from three leaves, the filter from one. */
function feederPlans(): readonly CompositionFieldPlan[] {
  const composition = CompositionSchema.parse({
    target: { kind: 'new', type: DeviceType.Generic },
    features: [
      {
        kind: 'fields',
        cap: 'consumables',
        fields: {
          lastChangedAt: { kind: 'expression', expr: 'now', bindings: {} },
          lastFetchedAt: { kind: 'expression', expr: 'now', bindings: {} },
        },
        items: {
          filter: {
            label: 'Filter',
            fields: { status: { kind: 'expression', expr: '"ok"', bindings: {} } },
          },
          desiccant: {
            label: 'Desiccant',
            fields: {
              'remaining.value': DAYS,
              'remaining.kind': { kind: 'expression', expr: '"duration"', bindings: {} },
              status: {
                kind: 'expression',
                expr: 'd <= 0 ? "replace" : "ok"',
                bindings: { d: DAYS },
              },
            },
          },
        },
      },
    ],
  })
  const plan = planComposition(composition, LOOKUP_CAP)
  if (plan.problems.length > 0) throw new Error(plan.problems.map((p) => p.message).join('; '))
  return plan.fields
}

const byKey = new Map(feederPlans().map((p) => [compositionFieldKey(p), p]))

function entry(key: string, value: ExpressionValue): AssemblerEntry {
  const plan = byKey.get(key)
  if (plan === undefined) throw new Error(`no plan for ${key}`)
  return { plan, value }
}

describe('assembleSlice (D663)', () => {
  it('assembles the feeder desiccant item from three leaves on the cap’s own emptyItem', () => {
    expect(
      assembleSlice(
        [
          entry('consumables.lastChangedAt', 1_000),
          entry('consumables.lastFetchedAt', 1_000),
          entry('consumables.items[desiccant].remaining.value', 0),
          entry('consumables.items[desiccant].remaining.kind', 'duration'),
          entry('consumables.items[desiccant].status', 'replace'),
        ],
        LOOKUP_CAP,
      ),
    ).toEqual({
      lastChangedAt: 1_000,
      lastFetchedAt: 1_000,
      items: [
        {
          key: 'desiccant',
          label: 'Desiccant',
          level: null,
          status: 'replace',
          lastResetAt: null,
          resettable: false,
          remaining: { value: 0, kind: 'duration' },
        },
      ],
    })
  })

  it('two items sharing an inner path are two array entries, sorted by key', () => {
    expect(
      assembleSlice(
        [
          entry('consumables.items[filter].status', 'ok'),
          entry('consumables.items[desiccant].status', 'replace'),
        ],
        LOOKUP_CAP,
      ).items,
    ).toEqual([
      {
        key: 'desiccant',
        label: 'Desiccant',
        level: null,
        status: 'replace',
        lastResetAt: null,
        resettable: false,
      },
      {
        key: 'filter',
        label: 'Filter',
        level: null,
        status: 'ok',
        lastResetAt: null,
        resettable: false,
      },
    ])
  })

  it('top-level entries alone are a flat patch — no items key appears', () => {
    expect(assembleSlice([entry('consumables.lastChangedAt', 5)], LOOKUP_CAP)).toEqual({
      lastChangedAt: 5,
    })
  })

  it('an item leaf never overwrites the base: the emptyItem is copied, not mutated', () => {
    const def = LOOKUP_CAP('consumables')
    const before = JSON.stringify(def?.status?.itemArray?.emptyItem)
    assembleSlice([entry('consumables.items[filter].status', 'ok')], LOOKUP_CAP)
    expect(JSON.stringify(def?.status?.itemArray?.emptyItem)).toBe(before)
  })

  it('an item of a cap the lookup does not know as an item array is refused by name', () => {
    const plan = byKey.get('consumables.items[filter].status')
    if (plan === undefined) throw new Error('no plan')
    expect(() => assembleSlice([{ plan, value: 'ok' }], () => null)).toThrow(
      /consumables.*item array/,
    )
  })
})
