import { describe, it, expect } from 'vitest'
import { isModelSubstituted } from '../step-resolution.js'
import { getStepDefinition } from '../registry/step-definitions.js'

describe('model substitution surfacing', () => {
  it('isModelSubstituted is false for null and for a compatible model', () => {
    expect(isModelSubstituted('object-detection', null, 'coreml')).toBe(false)
    const def = getStepDefinition('object-detection')
    const coreml = def.models.find((m) => m.formats['coreml'])
    expect(isModelSubstituted('object-detection', coreml!.id, 'coreml')).toBe(false)
  })

  it('isModelSubstituted is true for an incompatible explicit model', () => {
    const def = getStepDefinition('object-detection')
    const ovOnly = def.models.find((m) => m.formats['openvino'] && !m.formats['coreml'])
    if (!ovOnly) return
    expect(isModelSubstituted('object-detection', ovOnly.id, 'coreml')).toBe(true)
  })
})
