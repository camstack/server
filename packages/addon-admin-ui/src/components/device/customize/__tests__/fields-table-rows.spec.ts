import type { Composition, CompositionStateRead } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildFieldsTableRows, describeFieldSource } from '../fields-table-rows'

const FEEDER = { addonId: 'provider-homeassistant', stableId: 'ha:device:petkit' }
const BAT = { addonId: 'provider-homeassistant', stableId: 'sensor.freshelement_3_battery' }
const DAYS = {
  addonId: 'provider-homeassistant',
  stableId: 'sensor.freshelement_3_desiccant_left_days',
}
const composition: Composition = {
  target: { kind: 'existing', device: FEEDER },
  features: [
    {
      kind: 'fields',
      cap: 'battery',
      fields: {
        percentage: { kind: 'from', source: BAT, cap: 'numeric-sensor', fieldPath: 'value' },
        charging: { kind: 'expression', expr: '"unknown"', bindings: {} },
      },
    },
    {
      kind: 'fields',
      cap: 'binary',
      fields: {
        on: {
          kind: 'expression',
          expr: '!v',
          bindings: { v: { kind: 'from', source: FEEDER, cap: 'binary', fieldPath: 'on' } },
        },
      },
    },
    {
      kind: 'fields',
      cap: 'consumables',
      fields: {},
      items: {
        desiccant: {
          label: 'Desiccant',
          fields: {
            'remaining.value': {
              kind: 'expression',
              expr: 'number(x)',
              bindings: {
                x: { kind: 'from', source: DAYS, cap: 'enum-sensor', fieldPath: 'value' },
              },
            },
          },
        },
      },
    },
  ],
}
const answered: CompositionStateRead = {
  kind: 'answered',
  state: {
    blockId: 'blk',
    deviceId: 4127,
    status: 'degraded',
    reason: 'binary.on released',
    fields: [
      { cap: 'battery', path: 'percentage', state: 'fresh', value: 87 },
      { cap: 'battery', path: 'charging', state: 'fresh', value: 'unknown' },
      {
        cap: 'binary',
        path: 'on',
        state: 'unavailable',
        value: null,
        reason: 'source unregistered binary',
      },
      {
        cap: 'consumables',
        path: 'remaining.value',
        item: { arrayPath: 'items', key: 'desiccant', label: 'Desiccant' },
        state: 'stale',
        value: 23,
        reason: 'source offline',
      },
    ],
  },
}
const names = new Map([[`${BAT.addonId}/${BAT.stableId}`, 'Fresh Element 3 Battery']])

describe('buildFieldsTableRows', () => {
  const rows = buildFieldsTableRows({
    composition,
    nativeCaps: new Set(['binary']),
    state: answered,
    nativeFields: new Map([['binary', ['on', 'lastChangedAt']]]),
    snapshot: { binary: { on: true, lastChangedAt: 5 } },
    sourceNames: names,
  })
  it('a composed field shows the composer’s report, never the snapshot (D393, D663)', () => {
    const on = rows.find((r) => r.cap === 'binary' && r.field === 'on')
    expect(on).toMatchObject({
      origin: 'composed',
      mode: 'replace',
      value: { kind: 'unavailable', reason: 'source unregistered binary' },
    })
  })
  it('a replaced cap lists its other fields as native, with their value', () => {
    expect(rows.find((r) => r.cap === 'binary' && r.field === 'lastChangedAt')).toMatchObject({
      origin: 'native',
      value: { kind: 'value', value: 5 },
    })
  })
  it('an added cap lists only composed rows; an item leaf keeps its key; stale says why', () => {
    expect(rows.filter((r) => r.cap === 'battery').map((r) => [r.field, r.mode])).toEqual([
      ['percentage', 'add'],
      ['charging', 'add'],
    ])
    expect(rows.find((r) => r.cap === 'consumables')).toMatchObject({
      field: 'items[desiccant].remaining.value',
      value: { kind: 'value', value: 23, staleReason: 'source offline' },
    })
  })
  it('names a from-source by its device', () => {
    expect(
      describeFieldSource(
        { kind: 'from', source: BAT, cap: 'numeric-sensor', fieldPath: 'value' },
        names,
      ),
    ).toBe('Fresh Element 3 Battery · numeric-sensor.value')
  })
  it('an unreachable composer is unknown for every composed field — never a value, even with a readable snapshot', () => {
    const r = buildFieldsTableRows({
      composition,
      nativeCaps: new Set(),
      state: { kind: 'unreachable', error: 'composer restarting' },
      nativeFields: new Map(),
      snapshot: { battery: { percentage: 50, charging: 'no' }, binary: { on: false } },
      sourceNames: names,
    })
    expect(r.every((row) => row.value.kind === 'unknown')).toBe(true)
  })
  it('a disabled feature is off', () => {
    const off: Composition = {
      target: { kind: 'existing', device: FEEDER },
      features: [
        {
          kind: 'fields',
          cap: 'binary',
          enabled: false,
          fields: { on: { kind: 'expression', expr: '!v', bindings: {} } },
        },
      ],
    }
    const r = buildFieldsTableRows({
      composition: off,
      nativeCaps: new Set(['binary']),
      state: answered,
      nativeFields: new Map(),
      snapshot: null,
      sourceNames: names,
    })
    expect(r[0]?.value).toEqual({ kind: 'off' })
  })
})
