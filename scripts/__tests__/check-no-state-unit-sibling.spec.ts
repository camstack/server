import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { readingMeta } from '../../packages/types/src/units/quantity.js'
import { judgeStateUnits, type StateUnitCap } from '../lib/state-unit-sibling.ts'

function cap(runtimeState: z.ZodType, history: StateUnitCap['history'] = 'none'): StateUnitCap {
  return {
    capName: 'temperature-sensor',
    scope: 'device',
    deviceNative: true,
    runtimeState,
    history,
  }
}

describe('judgeStateUnits', () => {
  it('fails a unit sibling next to a reading', () => {
    const schema = z.object({
      celsius: z.number().meta(readingMeta('temperature')),
      unit: z.string().optional(),
      lastFetchedAt: z.number(),
    })
    const rules = judgeStateUnits(cap(schema), new Set()).map((v) => v.rule)
    expect(rules).toContain('unit-sibling')
  })

  it('fails a numeric reading with no quantity', () => {
    const schema = z.object({
      value: z.number(),
      lastFetchedAt: z.number(),
    })
    const rules = judgeStateUnits({ ...cap(schema), capName: 'numeric-sensor' }, new Set()).map(
      (v) => v.rule,
    )
    expect(rules).toEqual(['missing-quantity'])
  })

  it('accepts a declared quantity and a matching history unit', () => {
    const schema = z.object({
      celsius: z
        .number()
        .nullable()
        .meta(readingMeta('temperature', { precision: 1 })),
      lastFetchedAt: z.number(),
    })
    expect(
      judgeStateUnits(
        cap(schema, { fields: { celsius: { kind: 'gauge', unit: '°C' } } }),
        new Set(),
      ),
    ).toEqual([])
  })

  it('fails history.unitFrom and a history unit that is not the base', () => {
    const schema = z.object({
      temperature: z.number().meta(readingMeta('temperature')),
      temperatureUnit: z.string(),
    })
    const rules = judgeStateUnits(
      cap(schema, {
        fields: { temperature: { kind: 'gauge', unitFrom: 'temperatureUnit' } },
      }),
      new Set(),
    ).map((v) => v.rule)
    expect(rules).toContain('unit-sibling')
    expect(rules).toContain('unit-from')
  })

  it('lets quantity: none through, and ignores a clock', () => {
    const schema = z.object({
      score: z.number().meta(readingMeta('none')),
      lastFetchedAt: z.number(),
    })
    expect(judgeStateUnits(cap(schema), new Set())).toEqual([])
  })

  it('does not judge a system cap', () => {
    const schema = z.object({ unit: z.string(), value: z.number() })
    expect(
      judgeStateUnits({ ...cap(schema), scope: 'system', deviceNative: false }, new Set()),
    ).toEqual([])
  })
})
