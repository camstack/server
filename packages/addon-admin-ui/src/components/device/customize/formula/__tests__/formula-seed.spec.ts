/**
 * The formula editor opens on what is STORED. A source link used to open as
 * `null`, which read as "values not available" on a Power row whose plug was
 * linked and reporting.
 */
import { describe, expect, it } from 'vitest'
import { seedOf } from '../FormulaFieldDialog'

const PLUG = { addonId: 'provider-homeassistant', stableId: 'ha:plug' }

describe('seedOf', () => {
  it('opens a source link as the formula that reads it', () => {
    expect(seedOf({ kind: 'from', source: PLUG, cap: 'switch', fieldPath: 'on' })).toEqual({
      kind: 'expression',
      expr: 'x',
      bindings: { x: { kind: 'from', source: PLUG, cap: 'switch', fieldPath: 'on' } },
    })
  })

  it('opens a formula as itself', () => {
    const formula = { kind: 'expression' as const, expr: 'x > 20', bindings: {} }
    expect(seedOf(formula)).toBe(formula)
  })

  it('starts empty only for a field no formula can express', () => {
    expect(seedOf({ kind: 'code', code: 'return 1' })).toEqual({
      kind: 'expression',
      expr: 'null',
      bindings: {},
    })
  })
})
