import { describe, expect, it } from 'vitest'
import { type PresetSourceField, sourceFor } from '../source-for'

const BATTERY_NUM: PresetSourceField = {
  source: { addonId: 'provider-homeassistant', stableId: 'sensor.freshelement_3_battery' },
  cap: 'numeric-sensor',
  fieldPath: 'value',
  kind: 'number',
}
const DESICCANT_STR: PresetSourceField = {
  source: {
    addonId: 'provider-homeassistant',
    stableId: 'sensor.freshelement_3_desiccant_left_days',
  },
  cap: 'enum-sensor',
  fieldPath: 'value',
  kind: 'string',
}

describe('sourceFor', () => {
  it('reads a same-kind field verbatim, and bridges a string into a number with number(x)', () => {
    expect(sourceFor('number', BATTERY_NUM)).toEqual({
      kind: 'from',
      source: BATTERY_NUM.source,
      cap: 'numeric-sensor',
      fieldPath: 'value',
    })
    expect(sourceFor('number', DESICCANT_STR)).toEqual({
      kind: 'expression',
      expr: 'number(x)',
      bindings: {
        x: { kind: 'from', source: DESICCANT_STR.source, cap: 'enum-sensor', fieldPath: 'value' },
      },
    })
  })
  it('refuses what no builtin bridges', () => {
    expect(sourceFor('boolean', BATTERY_NUM)).toBeNull()
  })
})
