import { describe, expect, it } from 'vitest'
import { stepOptionsFromSchema } from '../ui/model-studio-ui.js'

const schema = {
  slots: [
    {
      id: 'detector',
      addons: [
        { id: 'object-detection', name: 'Object Detection', slot: 'detector' },
        { id: 'package-detection', name: 'Package Detection', slot: 'detector' },
      ],
    },
    {
      id: 'classifier',
      addons: [
        { id: 'animal-classifier', name: 'Animal Classifier', slot: 'classifier' },
        // Duplicate id in a second slot must be deduped.
        { id: 'object-detection', name: 'Object Detection', slot: 'classifier' },
      ],
    },
  ],
}

describe('stepOptionsFromSchema', () => {
  it('flattens slots to (id, name, slot) options, deduped, in schema order', () => {
    const options = stepOptionsFromSchema(schema)
    expect(options.map((o) => o.id)).toEqual([
      'object-detection',
      'package-detection',
      'animal-classifier',
    ])
    expect(options[0]).toEqual({
      id: 'object-detection',
      name: 'Object Detection',
      slot: 'detector',
    })
  })

  it('returns [] for an empty schema', () => {
    expect(stepOptionsFromSchema({ slots: [] })).toEqual([])
  })
})
