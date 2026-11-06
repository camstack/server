import { describe, expect, it } from 'vitest'
import { keyedFieldFit, keyedFieldOffers } from '../../keyed/keyed-fit'
import { defaultScalarTransform } from '../../scalar/scalar-form'
import {
  groupSourceValues,
  judgeNumberUnit,
  judgeSourceCompatibility,
  keyedTargetUnit,
  type SourceDestination,
  type SourceWireableField,
} from '../source-selector-model'

const LEVEL: SourceDestination = {
  cap: 'consumables',
  targetId: 'items',
  fieldPath: 'level',
  title: 'Level',
}

function numeric(cap: string, path: string, unit: string | null): SourceWireableField {
  return { cap, path, kind: 'number', unit, currentText: '12' }
}

describe('a number reaching a percent item level', () => {
  it('reads the target unit from the reading quantity', () => {
    expect(keyedTargetUnit('consumables', 'level')).toBe('%')
  })

  it('fits a percent reading as is', () => {
    expect(judgeSourceCompatibility(LEVEL, numeric('battery', 'level', '%'))).toEqual({
      kind: 'direct',
    })
  })

  it('does not offer a value of unknown unit (a control value with no unit)', () => {
    expect(judgeSourceCompatibility(LEVEL, numeric('control', 'value', null)).kind).toBe(
      'incompatible',
    )
  })

  it('does not offer a unit CamStack does not know', () => {
    expect(judgeSourceCompatibility(LEVEL, numeric('control', 'value', 'stints')).kind).toBe(
      'incompatible',
    )
  })

  it('offers hours or minutes as convertible, never as is', () => {
    for (const unit of ['h', 'min']) {
      expect(judgeSourceCompatibility(LEVEL, numeric('brush', 'timeLeft', unit))).toEqual({
        kind: 'conversion',
        name: 'scale',
      })
    }
    const { groups } = groupSourceValues(
      [numeric('control', 'value', 'min'), numeric('battery', 'level', '%')],
      LEVEL,
      'en',
    )
    const rows = groups.flatMap((g) => g.rows)
    expect(rows.map((r) => `${r.cap}.${r.path}:${r.compatibility.kind}`)).toEqual([
      'battery.level:direct',
      'control.value:conversion',
    ])
  })

  it('does not offer a temperature for a percentage', () => {
    expect(judgeSourceCompatibility(LEVEL, numeric('temp', 'value', '°C')).kind).toBe(
      'incompatible',
    )
    const verdict = keyedFieldFit('consumables', 'items', 'level', {
      cap: 'temp',
      path: 'value',
      kind: 'number',
      unit: '°C',
      enumValues: [],
    })
    expect(verdict.ok).toBe(false)
  })

  it('requires the operator to enter the scale for another dimension', () => {
    const offers = [
      { cap: 'brush', path: 'timeLeft', kind: 'number' as const, unit: 'h', enumValues: [] },
    ]
    const verdict = keyedFieldFit('consumables', 'items', 'level', offers[0]!)
    if (!verdict.ok || verdict.mode !== 'scalar') throw new Error('expected a scalar fit')
    expect(verdict.fit.transforms).toEqual(['linear'])
    const draft = defaultScalarTransform(verdict.fit)
    expect(draft.kind).toBe('linear')
    if (draft.kind === 'linear') expect(Number.isNaN(draft.scale)).toBe(true)
  })
})

describe('the unit of an offered field comes from the catalog, not only the slice', () => {
  it('gives battery.level its stored unit when the snapshot slice carries none', () => {
    const [offer] = keyedFieldOffers(
      { caps: [{ cap: 'battery', fields: [{ path: 'level', kind: 'number' }] }] },
      { battery: { level: 64 } },
    )
    expect(offer?.unit).toBe('%')
    expect(
      judgeSourceCompatibility(LEVEL, numeric('battery', 'level', offer?.unit ?? null)),
    ).toEqual({ kind: 'direct' })
  })
})

describe('a number of the same dimension but another unit', () => {
  it('is convertible, and the default transform carries the computed factor', () => {
    expect(judgeNumberUnit('°C', numeric('t', 'v', '°F'))).toEqual({
      kind: 'conversion',
      name: 'scale',
    })
    expect(judgeNumberUnit('°C', numeric('t', 'v', '°C'))).toBeNull()
    const draft = defaultScalarTransform({
      ok: true,
      valueKind: 'number',
      sourceUnit: null,
      transforms: ['linear'],
      declared: [],
      conversion: { from: 'min', to: 's' },
    })
    expect(draft).toMatchObject({ kind: 'linear', scale: 60, offset: 0 })
  })
})
