/**
 * D850 guard — every `runtimeState` cap declares `history`, and every named
 * field is a number or boolean reachable through fixed objects.
 *
 * Each case builds a fixture cap from a Zod schema and names the ONE rule it
 * must trip; the last case runs the real catalog of caps.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DeviceType } from '../../packages/types/src/device/device-type.js'
import {
  enumValuesOf,
  judgeCapHistory,
  loadHistoryCaps,
  type HistoryCapView,
  type HistoryViolationRule,
} from '../lib/cap-history.ts'

const STATE = z.object({
  celsius: z.number(),
  maybe: z.number().nullable().optional(),
  defaulted: z.number().default(0),
  on: z.boolean(),
  label: z.string(),
  mode: z.enum(['a', 'b']),
  unit: z.string().optional(),
  unitEnum: z.enum(['C', 'F']),
  tank: z.object({ level: z.number().nullable() }).nullable(),
  items: z.array(z.object({ level: z.number() })),
  keyed: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      count: z.number(),
      level: z.number().nullable(),
      status: z.enum(['ok', 'low']).nullable(),
      remaining: z.object({ value: z.number(), unit: z.enum(['days', 'hours']) }).optional(),
    }),
  ),
  byKey: z.record(z.string(), z.object({ level: z.number() })),
  either: z.union([z.number(), z.string()]),
  lastChangedAt: z.number(),
})

function cap(over: Partial<HistoryCapView>): HistoryCapView {
  return {
    capName: 'fixture',
    runtimeState: STATE,
    history: 'none',
    volatileStateFields: ['lastChangedAt'],
    ...over,
  }
}

function rules(view: HistoryCapView): readonly HistoryViolationRule[] {
  return judgeCapHistory(view).map((v) => v.rule)
}

function withField(field: string, spec: object): HistoryCapView {
  return cap({ history: { fields: { [field]: { kind: 'gauge', ...spec } } } })
}

describe('judgeCapHistory', () => {
  it('accepts none, and a clean block', () => {
    expect(rules(cap({ history: 'none' }))).toEqual([])
    expect(rules(withField('celsius', { unit: '°C', deadband: 0.1 }))).toEqual([])
    expect(rules(withField('maybe', {}))).toEqual([])
    expect(rules(withField('defaulted', {}))).toEqual([])
    expect(rules(cap({ history: { fields: { on: { kind: 'boolean' } } } }))).toEqual([])
  })

  it('accepts a path into a fixed (nullable) object', () => {
    expect(rules(withField('tank.level', { unit: '%' }))).toEqual([])
  })

  it('missing block', () => {
    expect(rules(cap({ history: undefined }))).toEqual(['missing-block'])
  })

  it('block without runtimeState', () => {
    expect(rules(cap({ runtimeState: undefined, history: 'none' }))).toEqual([
      'block-without-runtime-state',
    ])
    expect(rules(cap({ runtimeState: undefined, history: undefined }))).toEqual([])
  })

  it('empty fields', () => {
    expect(rules(cap({ history: { fields: {} } }))).toEqual(['empty-fields'])
  })

  it('unknown field', () => {
    expect(rules(withField('nope', {}))).toEqual(['unknown-field'])
  })

  it('non-numeric field (string, enum, union)', () => {
    expect(rules(withField('label', {}))).toEqual(['non-numeric-field'])
    expect(rules(withField('mode', {}))).toEqual(['non-numeric-field'])
    expect(rules(withField('either', {}))).toEqual(['non-numeric-field'])
  })

  it('enum: a z.enum or z.string field, no unit or deadband, values never by hand', () => {
    const e = (field: string, spec: object = {}) =>
      cap({ history: { fields: { [field]: { kind: 'enum', ...spec } } } })
    expect(rules(e('mode'))).toEqual([])
    expect(rules(e('label'))).toEqual([])
    expect(rules(e('label', { skipWhenSet: 'unit' }))).toEqual([])
    expect(rules(e('celsius'))).toEqual(['kind-type-mismatch'])
    expect(rules(e('on'))).toEqual(['kind-type-mismatch'])
    expect(rules(e('mode', { unit: '%' }))).toEqual(['enum-numeric-option'])
    expect(rules(e('mode', { deadband: 1 }))).toEqual(['enum-numeric-option'])
    expect(rules(e('mode', { values: ['a', 'b'] }))).toEqual(['enum-values-by-hand'])
    expect(rules(e('label', { skipWhenSet: 'nope' }))).toEqual(['skip-when-set-invalid'])
  })

  it('the catalog projects a z.enum field’s values, in declaration order', () => {
    expect(enumValuesOf(STATE, 'mode')).toEqual(['a', 'b'])
    expect(enumValuesOf(STATE, 'label')).toBeUndefined()
  })

  it('a path never enters an array or a record', () => {
    expect(rules(withField('items.level', {}))).toEqual(['path-into-collection'])
    expect(rules(withField('byKey.cam1.level', {}))).toEqual(['path-into-collection'])
  })

  it('kind must match the Zod type', () => {
    expect(rules(cap({ history: { fields: { on: { kind: 'gauge' } } } }))).toEqual([
      'kind-type-mismatch',
    ])
    expect(rules(cap({ history: { fields: { celsius: { kind: 'boolean' } } } }))).toEqual([
      'kind-type-mismatch',
    ])
  })

  it('a volatile field is refused', () => {
    expect(rules(withField('lastChangedAt', {}))).toContain('volatile-field')
  })

  it('unit and unitFrom are exclusive; unitFrom must be a sibling string or enum', () => {
    expect(rules(withField('celsius', { unit: '°C', unitFrom: 'unit' }))).toEqual(['unit-conflict'])
    expect(rules(withField('celsius', { unitFrom: 'unit' }))).toEqual([])
    expect(rules(withField('celsius', { unitFrom: 'unitEnum' }))).toEqual([])
    expect(rules(withField('celsius', { unitFrom: 'missing' }))).toEqual(['unit-from-invalid'])
    expect(rules(withField('celsius', { unitFrom: 'on' }))).toEqual(['unit-from-invalid'])
    expect(rules(withField('celsius', { unitFrom: 'items.level' }))).toEqual(['unit-from-invalid'])
  })

  it('unknown unit', () => {
    const spec = JSON.parse('{"kind":"gauge","unit":"furlongs"}')
    expect(rules(cap({ history: { fields: { celsius: spec } } }))).toEqual(['unknown-unit'])
  })

  it('a boolean takes no numeric option', () => {
    expect(rules(cap({ history: { fields: { on: { kind: 'boolean', deadband: 1 } } } }))).toEqual([
      'boolean-numeric-option',
    ])
  })

  it('option values must be sane', () => {
    expect(rules(withField('celsius', { deadband: -1 }))).toEqual(['bad-option-value'])
    expect(rules(withField('celsius', { deadbandPct: 0 }))).toEqual(['bad-option-value'])
    expect(rules(withField('celsius', { deadbandPct: 10, minIntervalMs: 0 }))).toEqual([])
  })

  it('excludeDeviceTypes must be real DeviceTypes', () => {
    const ok = cap({
      history: { fields: { on: { kind: 'boolean', excludeDeviceTypes: [DeviceType.Camera] } } },
    })
    expect(rules(ok)).toEqual([])
    // JSON.parse yields an untyped value — the way a malformed block would reach the guard.
    const spec = JSON.parse('{"kind":"boolean","excludeDeviceTypes":["toaster"]}')
    const bad = cap({ history: { fields: { on: spec } } })
    expect(rules(bad)).toEqual(['unknown-exclude-device-type'])
  })
})

describe('keyed items (D917)', () => {
  function withItems(items: object, fields: object = {}): HistoryCapView {
    return cap({
      history: {
        fields: { ...fields },
        items: { path: 'keyed', key: 'key', label: 'label', fields: {}, ...items },
      },
    })
  }

  it('accepts a keyed array with item-relative fields, unitFrom and enums', () => {
    expect(
      rules(
        withItems({
          fields: {
            level: { kind: 'gauge', unit: '%', deadband: 2 },
            status: { kind: 'enum' },
            'remaining.value': { kind: 'gauge', unitFrom: 'remaining.unit' },
          },
        }),
      ),
    ).toEqual([])
  })

  it('an empty `fields` is fine when items carry the series', () => {
    expect(rules(withItems({ fields: { level: { kind: 'gauge', unit: '%' } } }))).toEqual([])
    expect(rules(withItems({ fields: {} }))).toEqual(['empty-fields'])
  })

  it('the items path must be an array of objects', () => {
    const f = { level: { kind: 'gauge' } }
    expect(rules(withItems({ path: 'celsius', fields: f }))).toEqual(['items-not-keyed-array'])
    expect(rules(withItems({ path: 'nope', fields: f }))).toEqual(['items-not-keyed-array'])
  })

  it('the key and label are string fields of the item', () => {
    const f = { level: { kind: 'gauge' } }
    expect(rules(withItems({ key: 'count', fields: f }))).toEqual(['items-key-invalid'])
    expect(rules(withItems({ key: 'missing', fields: f }))).toEqual(['items-key-invalid'])
    expect(rules(withItems({ label: 'count', fields: f }))).toEqual(['items-key-invalid'])
  })

  it('item fields are judged against the ITEM schema', () => {
    expect(rules(withItems({ fields: { celsius: { kind: 'gauge' } } }))).toEqual(['unknown-field'])
    expect(rules(withItems({ fields: { label: { kind: 'gauge' } } }))).toEqual([
      'non-numeric-field',
    ])
    expect(rules(withItems({ fields: { level: { kind: 'gauge', unitFrom: 'nope' } } }))).toEqual([
      'unit-from-invalid',
    ])
  })

  it('the catalog projects an item z.enum field’s values', () => {
    expect(enumValuesOf(STATE, 'status', 'keyed')).toEqual(['ok', 'low'])
  })
})

describe('the real caps', () => {
  // Loads every *.cap.ts cold; under a loaded full run it has taken longer
  // than the 10 s default.
  it('every cap passes, and there are 74 runtimeState caps', { timeout: 60_000 }, async () => {
    const caps = await loadHistoryCaps()
    expect(caps.filter((c) => c.runtimeState !== undefined)).toHaveLength(74)
    expect(caps.flatMap((c) => judgeCapHistory(c))).toEqual([])
  })
})
