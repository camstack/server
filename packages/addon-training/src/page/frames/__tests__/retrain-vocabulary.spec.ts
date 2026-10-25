/**
 * The label field suggests what the corpus already uses.
 */
import { describe, expect, it } from 'vitest'
import { buildVocabulary, suggestLabels } from '../lib/retrain-vocabulary.js'

const corpus = [
  { macroClass: 'person' as const, label: 'postman' },
  { macroClass: 'person' as const, label: 'Postman' },
  { macroClass: 'person' as const, label: 'postman' },
  { macroClass: 'person' as const, label: 'neighbour' },
  { macroClass: 'vehicle' as const, label: 'postal van' },
  { macroClass: 'animal' as const, label: 'cat' },
  { macroClass: 'person' as const },
  { macroClass: 'person' as const, label: '  ' },
  { macroClass: 'person' as const, label: 'plant', kind: 'model_error' as const },
]

describe('buildVocabulary', () => {
  const vocabulary = buildVocabulary(corpus)
  it('merges case variants under their most common spelling, most used first', () => {
    expect(vocabulary[0]).toMatchObject({ label: 'postman', count: 3 })
  })
  it('ignores blank labels and model errors', () => {
    const labels = vocabulary.map((v) => v.label)
    expect(labels).not.toContain('plant')
    expect(labels).not.toContain('')
    expect(labels).toHaveLength(4)
  })
})

describe('suggestLabels', () => {
  const vocabulary = buildVocabulary(corpus)
  it('matches by substring and puts labels used with this class first', () => {
    expect(suggestLabels(vocabulary, 'po', 'person')).toEqual(['postman', 'postal van'])
    expect(suggestLabels(vocabulary, 'po', 'vehicle')).toEqual(['postal van', 'postman'])
  })
  it('suggests everything for an empty field, never the exact text, and respects the limit', () => {
    expect(suggestLabels(vocabulary, '', 'person', 2)).toHaveLength(2)
    expect(suggestLabels(vocabulary, 'cat', 'animal')).toEqual([])
  })
})
