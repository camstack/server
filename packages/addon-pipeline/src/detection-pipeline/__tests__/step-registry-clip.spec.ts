import { describe, it, expect } from 'vitest'
import { ALL_PIPELINE_STEPS, getStepDefinition } from '../registry/step-definitions.js'

describe('pipeline step registry — clip-embedding', () => {
  it('exposes clip-embedding with siglip2-b16-224 default', () => {
    const ids = ALL_PIPELINE_STEPS.map((s) => s.definition.id)
    expect(ids).toContain('clip-embedding')
    const def = getStepDefinition('clip-embedding')
    expect(def.postprocessor).toBe('clip')
    expect(def.defaultModelId).toBe('siglip2-b16-224')
    expect(def.slot).toBe('classifier')
    // ON by default — object embeddings power text→object semantic search.
    expect(def.enabledByDefault).toBe(true)
    expect(def.group).toBe('CLIP')
  })

  it('offers SigLIP2 alone — MobileCLIP S0/S1/S2 left the catalog (D649)', () => {
    const def = getStepDefinition('clip-embedding')
    expect(def.models.map((m) => m.id)).toEqual(['siglip2-b16-224'])
    expect(def.defaultModelId).toBe('siglip2-b16-224')
  })
})
