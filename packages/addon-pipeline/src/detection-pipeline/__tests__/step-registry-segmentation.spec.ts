import { describe, it, expect } from 'vitest'
import { ALL_PIPELINE_STEPS, getStepDefinition } from '../registry/step-definitions'

describe('pipeline step registry — segmentation', () => {
  const ids = ALL_PIPELINE_STEPS.map((s) => s.definition.id)

  it('exposes the unified "segmentation" step with u2netp default', () => {
    expect(ids).toContain('segmentation')
    const def = getStepDefinition('segmentation')
    expect(def.name).toBe('Segmentation')
    expect(def.defaultModelId).toBe('u2netp')
    expect(def.slot).toBe('refiner')
  })

  it('removes instance-segmentation and the old segmentation-refiner id from the active set', () => {
    expect(ids).not.toContain('instance-segmentation')
    expect(ids).not.toContain('segmentation-refiner')
  })

  it('throws for the dormant id (proves getStepDefinition guards the active set)', () => {
    expect(() => getStepDefinition('instance-segmentation')).toThrow(/Unknown pipeline step/)
  })
})
