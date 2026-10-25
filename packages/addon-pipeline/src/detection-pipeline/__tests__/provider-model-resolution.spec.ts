import { describe, it, expect } from 'vitest'
import { resolveStepsForFormat } from '../step-resolution.js'
import { getDefaultModelForFormat, getStepDefinition } from '../registry/step-definitions.js'

// resolveStepsForFormat is the shared runtime resolution path that both
// provider call sites (resolveStepModels and inputStepsToPipelineSteps) delegate to,
// resolving each step's model via resolveModelForFormat for the node's engine format.
describe('resolveStepsForFormat', () => {
  it('resolves an absent modelId to the format default', () => {
    const out = resolveStepsForFormat(
      [{ addonId: 'object-detection', modelId: undefined, enabled: true }],
      'coreml',
    )
    expect(out[0]!.modelId).toBe(getDefaultModelForFormat('object-detection', 'coreml'))
  })

  it('substitutes an incompatible explicit modelId for the format default', () => {
    const def = getStepDefinition('object-detection')
    const openvinoOnly = def.models.find((m) => m.formats['openvino'] && !m.formats['coreml'])
    if (!openvinoOnly) return
    const out = resolveStepsForFormat(
      [{ addonId: 'object-detection', modelId: openvinoOnly.id, enabled: true }],
      'coreml',
    )
    expect(out[0]!.modelId).toBe(getDefaultModelForFormat('object-detection', 'coreml'))
  })

  it('recurses into children', () => {
    const out = resolveStepsForFormat(
      [
        {
          addonId: 'object-detection',
          modelId: undefined,
          enabled: true,
          children: [{ addonId: 'face-embedding', modelId: undefined, enabled: true }],
        },
      ],
      'coreml',
    )
    expect(out[0]!.children?.[0]!.modelId).toBe(
      getDefaultModelForFormat('face-embedding', 'coreml'),
    )
  })
})
