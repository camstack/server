import { describe, it, expect } from 'vitest'
import { PipelineStepInputSchema } from '../capabilities/pipeline-executor.cap.js'

describe('optional model/engine wire contract', () => {
  it('PipelineStepInput accepts a step with no modelId', () => {
    const parsed = PipelineStepInputSchema.parse({ addonId: 'object-detection', enabled: true })
    expect(parsed.addonId).toBe('object-detection')
    expect(parsed.modelId).toBeUndefined()
  })

  it('PipelineStepInput still accepts an explicit modelId', () => {
    const parsed = PipelineStepInputSchema.parse({
      addonId: 'object-detection',
      modelId: 'yolov9t',
      enabled: true,
    })
    expect(parsed.modelId).toBe('yolov9t')
  })
})
