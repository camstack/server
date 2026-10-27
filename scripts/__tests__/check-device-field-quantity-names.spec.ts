import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  judgeFieldNames,
  looksLikeUnit,
  parseAllowances,
  staleAllowances,
  type FieldNameCap,
} from '../lib/quantity-field-names.ts'

const NONE: ReadonlyMap<string, string> = new Map()

function cap(runtimeState: z.ZodType, over: Partial<FieldNameCap> = {}): FieldNameCap {
  return { capName: 'power-meter', scope: 'device', runtimeState, history: undefined, ...over }
}

describe('looksLikeUnit', () => {
  it.each([
    'watts',
    'celsius',
    'kwhTotal',
    'percentage',
    'signalPercent',
    'rssiDbm',
    'pressureHpa',
  ])('refuses %s', (name) => expect(looksLikeUnit(name)).toBe(true))
  it.each([
    'power',
    'temperature',
    'level',
    'signal',
    'energy',
    'timeout',
    'lastChangedAt',
  ])('accepts %s', (name) => expect(looksLikeUnit(name)).toBe(false))
})

describe('judgeFieldNames', () => {
  it('refuses a unit-named status field', () => {
    const found = judgeFieldNames(cap(z.object({ watts: z.number() })), NONE)
    expect(found.map((v) => v.path)).toEqual(['watts'])
  })

  it('accepts a quantity-named field', () => {
    expect(judgeFieldNames(cap(z.object({ power: z.number().nullable() })), NONE)).toEqual([])
  })

  it('walks nested objects and arrays', () => {
    const schema = z.object({ monitors: z.array(z.object({ rssiDbm: z.number() })) })
    expect(judgeFieldNames(cap(schema), NONE).map((v) => v.path)).toEqual(['monitors.rssiDbm'])
  })

  it('judges the history fields too', () => {
    const history = {
      fields: { kwhTotal: { kind: 'counter', unit: 'kWh', deadband: 0, minIntervalMs: 1 } },
    } as const
    const found = judgeFieldNames(cap(z.object({}), { history }), NONE)
    expect(found.map((v) => v.path)).toEqual(['kwhTotal'])
  })

  it('leaves a system-scoped cap alone', () => {
    const system = cap(z.object({ watts: z.number() }), { scope: 'system' })
    expect(judgeFieldNames(system, NONE)).toEqual([])
  })

  it('lets a reasoned allowance through and flags it when it goes stale', () => {
    const c = cap(z.object({ watts: z.number() }))
    const allowed = new Map([['power-meter.watts', 'legacy']])
    expect(judgeFieldNames(c, allowed)).toEqual([])
    expect(staleAllowances([c], allowed)).toEqual([])
    const gone = cap(z.object({ power: z.number() }))
    expect(staleAllowances([gone], allowed)).toEqual(['power-meter.watts'])
  })
})

describe('parseAllowances', () => {
  it('requires a reason', () => {
    const parsed = parseAllowances('# c\npower-meter.watts\npower-meter.amps -- kept\n')
    expect(parsed.errors).toHaveLength(1)
    expect([...parsed.allowed.keys()]).toEqual(['power-meter.amps'])
  })
})
