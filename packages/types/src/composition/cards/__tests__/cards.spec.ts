/**
 * Composition card decode/encode (D939).
 */
import { describe, expect, it } from 'vitest'
import { CompositionSchema } from '../../composition.js'
import { DOORBELL_101_COMPOSITION, PORCH_COMPOSITION } from '../__fixtures__/stored-compositions.js'
import type { CompositionExpressionSource } from '../../composition.js'
import { classifyFieldSource, fieldEntryToSource } from '../classify-field.js'
import { convertUnitTargets } from '../convert-unit.js'
import { decodeCompositionToCards } from '../decode.js'
import { encodeCardsToComposition } from '../encode.js'
import { setFormulaExpr } from '../edit.js'

function roundTrip(composition: ReturnType<typeof CompositionSchema.parse>): void {
  const { model } = decodeCompositionToCards(composition)
  const encoded = encodeCardsToComposition(model)
  expect(JSON.stringify(encoded)).toBe(JSON.stringify(composition))
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (!isPlainRecord(value)) return value
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value).toSorted()) {
    sorted[key] = sortKeys(value[key])
  }
  return sorted
}

describe('composition cards', () => {
  it('decodes Porch temperature aggregates as from, not formula', () => {
    const { model } = decodeCompositionToCards(PORCH_COMPOSITION)
    const temp = model.cards.find(
      (slot) => slot.card.cardKind === 'fields' && slot.card.cap === 'temperature-sensor',
    )
    expect(temp?.card.cardKind).toBe('fields')
    if (temp?.card.cardKind !== 'fields') return
    expect(temp.card.entries.celsius).toMatchObject({ kind: 'from', aggregate: 'avg-round-1' })
    expect(
      temp.card.entries.celsius?.kind === 'from' ? temp.card.entries.celsius.sources.length : 0,
    ).toBe(2)
    expect(temp.card.entries.lastFetchedAt).toMatchObject({ kind: 'from', aggregate: 'max' })
  })

  it('decodes Porch binary motion as formula and now companion', () => {
    const { model } = decodeCompositionToCards(PORCH_COMPOSITION)
    const binary = model.cards.find(
      (slot) => slot.card.cardKind === 'fields' && slot.card.cap === 'binary',
    )
    if (binary?.card.cardKind !== 'fields') throw new Error('missing binary card')
    expect(binary.card.entries.on?.kind).toBe('formula')
    if (binary.card.entries.on?.kind === 'formula') {
      expect(binary.card.entries.on.expr).toBe(
        'any(d1, d2, within(m1, 300000), within(m2, 300000))',
      )
    }
    expect(binary.card.entries.lastChangedAt).toEqual({ kind: 'companion', companion: 'now' })
    roundTrip(PORCH_COMPOSITION)
  })

  it('decodes doorbell 101 as one pulse card and round-trips', () => {
    const { model } = decodeCompositionToCards(DOORBELL_101_COMPOSITION)
    expect(model.cards).toHaveLength(1)
    expect(model.cards[0]?.card.cardKind).toBe('pulse')
    roundTrip(DOORBELL_101_COMPOSITION)
  })

  it('saves Porch and doorbell 101 untouched, equal to the stored composition', () => {
    for (const stored of [PORCH_COMPOSITION, DOORBELL_101_COMPOSITION]) {
      const saved = encodeCardsToComposition(decodeCompositionToCards(stored).model)
      expect(saved).toStrictEqual(stored)
      expect(JSON.stringify(sortKeys(saved))).toBe(JSON.stringify(sortKeys(stored)))
    }
  })

  it('keeps scalar-refused expressions as formula and encodes edits to that field only', () => {
    const raw = {
      target: {
        kind: 'existing' as const,
        device: { addonId: 'provider-demo', stableId: 'dev-1' },
      },
      features: [
        {
          kind: 'fields' as const,
          cap: 'battery',
          fields: {
            percentage: {
              kind: 'expression' as const,
              expr: 'v > 20',
              bindings: {
                v: {
                  source: { addonId: 'provider-demo', stableId: 'src-1' },
                  cap: 'battery',
                  fieldPath: 'percentage',
                  kind: 'from' as const,
                },
              },
            },
          },
        },
      ],
    }
    const composition = CompositionSchema.parse(raw)
    const { model } = decodeCompositionToCards(composition)
    const card = model.cards[0]
    if (card?.card.cardKind !== 'fields') throw new Error('expected fields card')
    expect(card.card.entries.percentage?.kind).toBe('formula')
    const edited = setFormulaExpr(model, 'battery', 'percentage', 'v > 30')
    const encoded = encodeCardsToComposition(edited)
    const feature = encoded.features[0]
    if (feature === undefined || feature.kind !== 'fields') throw new Error('missing feature')
    expect(feature.fields.percentage).toMatchObject({ kind: 'expression', expr: 'v > 30' })
  })

  it('classifies a self convert expression as convert-unit and writes it back', () => {
    const self = { addonId: 'provider-homeassistant', stableId: 'dev-801' }
    const source: CompositionExpressionSource = {
      kind: 'expression',
      expr: 'convert(v, "°C", "°F")',
      bindings: {
        v: {
          kind: 'from',
          source: self,
          cap: 'temperature-sensor',
          fieldPath: 'celsius',
        },
      },
    }
    const entry = classifyFieldSource(source)
    expect(entry).toMatchObject({
      kind: 'convert-unit',
      from: '°C',
      to: '°F',
      source: { source: self, cap: 'temperature-sensor', fieldPath: 'celsius' },
    })
    expect(fieldEntryToSource(entry, source)).toEqual(source)
  })

  it('keeps a formula over this device native value as a formula', () => {
    const self = { addonId: 'provider-homeassistant', stableId: 'dev-801' }
    const source: CompositionExpressionSource = {
      kind: 'expression',
      expr: 'v * 2',
      bindings: {
        v: {
          kind: 'from',
          source: self,
          cap: 'temperature-sensor',
          fieldPath: 'celsius',
        },
      },
    }
    const entry = classifyFieldSource(source)
    expect(entry.kind).toBe('formula')
    if (entry.kind !== 'formula') return
    expect(entry.bindings.v).toMatchObject({
      kind: 'from',
      source: self,
      fieldPath: 'celsius',
    })
    expect(fieldEntryToSource(entry, undefined)).toEqual(source)
  })

  it('offers every other unit in the field dimension', () => {
    expect(convertUnitTargets('°C')).toEqual(['°F', 'K'])
    expect(convertUnitTargets('%')).toEqual([])
    expect(convertUnitTargets('lx')).toEqual([])
  })
})
