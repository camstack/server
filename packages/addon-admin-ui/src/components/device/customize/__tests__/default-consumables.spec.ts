import { describe, expect, it } from 'vitest'
import {
  consumableFieldKey,
  defaultConsumables,
  humanizeConsumableKey,
} from '../default-consumables'
import type { WireableCatalog } from '../source-picker-model'

const LEVEL = { kind: 'enum', enumValues: ['ok', 'low', 'empty'] } as const

const CATALOG: WireableCatalog = {
  caps: [
    {
      cap: 'dishwasher',
      fields: [
        { path: 'remainingSeconds', kind: 'number' },
        { path: 'saltLevel', ...LEVEL },
        { path: 'rinseAidLevel', ...LEVEL },
        { path: 'operationState', kind: 'enum', enumValues: ['Ready', 'Run'] },
      ],
    },
    // A wrapper cap the device does NOT serve itself, with a same-shaped field.
    { cap: 'some-wrapper', fields: [{ path: 'tonerLevel', ...LEVEL }] },
    {
      cap: 'consumables',
      fields: [{ path: 'level', kind: 'number', item: true }],
    },
  ],
}

const known = <T>(value: T) => ({ kind: 'known' as const, value })

describe('defaultConsumables', () => {
  it('takes every level-enum field of the device OWN caps, and nothing else', () => {
    const result = defaultConsumables(known(new Set(['dishwasher'])), known(CATALOG), null)
    expect(result).toEqual(
      known([
        { kind: 'field', key: 'salt', cap: 'dishwasher', path: 'saltLevel' },
        {
          kind: 'field',
          key: 'rinseAid',
          cap: 'dishwasher',
          path: 'rinseAidLevel',
        },
      ]),
    )
  })

  it('adds the items of a native consumables cap after the fields', () => {
    const item = {
      key: 'filter',
      label: 'Filter',
      level: 40,
      status: null,
      lastResetAt: null,
      resettable: true,
    }
    const result = defaultConsumables(known(new Set(['consumables'])), known(CATALOG), {
      kind: 'value',
      value: [item],
    })
    expect(result).toEqual(known([{ kind: 'item', key: 'filter', item }]))
  })

  it('claims nothing before the bindings and the fields answered (D315)', () => {
    expect(defaultConsumables({ kind: 'pending' }, known(CATALOG), null)).toEqual({
      kind: 'pending',
    })
    expect(
      defaultConsumables(known(new Set(['dishwasher'])), { kind: 'unknown', reason: 'x' }, null),
    ).toEqual({ kind: 'unknown', reason: 'x' })
  })

  it('an unreadable or malformed item list is unknown, never an empty list', () => {
    const native = known(new Set(['consumables']))
    expect(
      defaultConsumables(native, known(CATALOG), {
        kind: 'unknown',
        reason: 'timeout',
      }),
    ).toEqual({ kind: 'unknown', reason: 'timeout' })
    expect(
      defaultConsumables(native, known(CATALOG), {
        kind: 'value',
        value: [{ key: 1 }],
      }).kind,
    ).toBe('unknown')
    expect(defaultConsumables(native, known(CATALOG), { kind: 'pending' })).toEqual({
      kind: 'pending',
    })
  })
})

describe('consumable field names', () => {
  it('drop the Level suffix and read as words', () => {
    expect(consumableFieldKey('saltLevel')).toBe('salt')
    expect(consumableFieldKey('tanks.rinseAidLevel')).toBe('rinseAid')
    expect(consumableFieldKey('Level')).toBe('Level')
    expect(humanizeConsumableKey('rinseAid')).toBe('Rinse aid')
  })
})
