/**
 * D972 — a number offered for a quantity param agrees with the unit the
 * method's input DECLARES (`paramMeta`). Each case breaks one thing in a
 * known-good fake and expects exactly the complaint that names it.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type {
  CapabilityDefinition,
  CapabilityMethodAccess,
} from '../../packages/types/src/capabilities/capability-definition.ts'
import { method } from '../../packages/types/src/capabilities/capability-definition.ts'
import type {
  LooseCapVocabularyEntry,
  NumberOffer,
} from '../../packages/types/src/device/cap-vocabulary/types.ts'
import { paramMeta } from '../../packages/types/src/units/quantity-input.ts'
import { checkCapVocabulary } from '../lib/cap-vocabulary-check.ts'

const feederDef = {
  name: 'feeder',
  scope: 'device',
  mode: 'singleton',
  methods: {
    feed: method(
      z.object({
        deviceId: z.number(),
        grams: z
          .number()
          .min(4)
          .max(200)
          .meta(paramMeta({ quantity: 'mass', unit: 'g' }))
          .optional(),
        count: z.number().optional(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
  },
} satisfies CapabilityDefinition

const L = { en: 'x', it: 'x' }

function problemsFor(key: string, offer: NumberOffer): readonly string[] {
  const entry: LooseCapVocabularyEntry = {
    scope: 'device',
    noun: L,
    actions: [
      {
        id: 'feeder.feed',
        method: 'feed',
        label: L,
        phrase: { en: 'Feed {device} {x}', it: 'Dai {device} {x}' },
        icon: 'power',
        openArgs: [{ key, label: L, offer }],
      },
    ],
  }
  const defs: readonly CapabilityDefinition[] = [feederDef]
  return checkCapVocabulary({
    defs,
    vocabulary: { feeder: entry },
    accessOf: (): CapabilityMethodAccess => 'create',
    iconKeys: new Set(['power']),
    eventCategories: new Set(),
  }).problems.filter((p) => p.includes(`'${key}'`))
}

describe('number offers and paramMeta', () => {
  it('accepts an offer that repeats the declared quantity and unit', () => {
    expect(
      problemsFor('grams', { kind: 'number', min: 4, max: 200, unit: 'g', quantity: 'mass' }),
    ).toEqual([])
  })

  it('refuses an offer that names another unit than the param declares', () => {
    expect(problemsFor('grams', { kind: 'number', unit: 'kg', quantity: 'mass' })).toEqual([
      "feeder action 'feeder.feed': 'grams' offers unit 'kg' but the input is declared in 'g'",
    ])
  })

  it('refuses an offer that omits the quantity of a quantity param', () => {
    expect(problemsFor('grams', { kind: 'number', unit: 'g' })).toEqual([
      "feeder action 'feeder.feed': 'grams' is a mass param (g) and its offer carries no quantity",
    ])
  })

  it('refuses a quantity on an input that declares none', () => {
    expect(problemsFor('count', { kind: 'number', quantity: 'mass', unit: 'g' })).toEqual([
      "feeder action 'feeder.feed': 'count' offers quantity 'mass' but the input declares none",
    ])
  })
})
