// @vitest-environment jsdom
/**
 * `PipelineStep` (the benchmark's step card) corrects a model id its catalog no
 * longer lists to the step default, so a stale template never runs nothing.
 */
import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import type { PipelineAddonSchema } from '@camstack/types'
import { PipelineStep, type PipelineStepDisplayConfig } from '../pipeline-step'

const SCHEMA: PipelineAddonSchema = {
  id: 'object-detection',
  name: 'Object Detection',
  slot: 'detector',
  inputClasses: [],
  outputClasses: ['object'],
  childSlots: [],
  models: [
    { id: 'model-a', name: 'Model A', formats: {} },
    { id: 'model-b', name: 'Model B', formats: {} },
  ],
  defaultModelId: 'model-a',
  defaultConfidence: 0.5,
}

function step(modelId: string): PipelineStepDisplayConfig {
  return {
    addonId: 'object-detection',
    addonName: 'Object Detection',
    slot: 'detector',
    inputClasses: [],
    outputClasses: ['object'],
    enabled: true,
    modelId,
    children: [],
  }
}

describe('PipelineStep — stale model', () => {
  it('auto-corrects an unknown modelId to the step default', async () => {
    const onChange = vi.fn()
    render(
      <PipelineStep
        step={step('stale-model')}
        schema={SCHEMA}
        allSchemas={new Map()}
        onChange={onChange}
      />,
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'model-a' }))
  })

  it('leaves a listed model alone', async () => {
    const onChange = vi.fn()
    render(
      <PipelineStep
        step={step('model-b')}
        schema={SCHEMA}
        allSchemas={new Map()}
        onChange={onChange}
      />,
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(onChange).not.toHaveBeenCalled()
  })
})
