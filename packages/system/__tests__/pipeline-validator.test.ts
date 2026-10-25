import { describe, it, expect } from 'vitest'
import type { PipelineConfig, PipelineEngineChoice } from '@camstack/types'
import { PipelineValidator } from '../src/pipeline/pipeline-validator'

/** The engine is irrelevant to routing; any valid choice will do. */
const TEST_ENGINE: PipelineEngineChoice = { runtime: 'python', backend: 'onnx', format: 'onnx' }

function buildStepExists(...ids: string[]): (stepId: string) => boolean {
  const registered = new Set(ids)
  return (stepId: string) => registered.has(stepId)
}

describe('PipelineValidator', () => {
  it('validates a simple single-node pipeline', () => {
    const loader = buildStepExists('mock-detector')
    const validator = new PipelineValidator(loader)

    const config: PipelineConfig = {
      engine: TEST_ENGINE,
      video: [{ step: 'detect', addon: 'mock-detector' }],
    }

    const result = validator.validate(config)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('fails when addon is not registered', () => {
    const loader = buildStepExists()
    const validator = new PipelineValidator(loader)

    const config: PipelineConfig = {
      engine: TEST_ENGINE,
      video: [{ step: 'detect', addon: 'unknown-addon' }],
    }

    const result = validator.validate(config)
    expect(result.valid).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.message).toContain('has no provider')
    expect(result.errors[0]?.step).toBe('detect')
    expect(result.errors[0]?.addon).toBe('unknown-addon')
    expect(result.errors[0]?.severity).toBe('error')
  })

  it('validates nested pipeline nodes recursively', () => {
    const loader = buildStepExists('mock-detector', 'mock-classifier')
    const validator = new PipelineValidator(loader)

    const config: PipelineConfig = {
      engine: TEST_ENGINE,
      video: [
        {
          step: 'detect',
          addon: 'mock-detector',
          children: [{ step: 'classify', addon: 'mock-classifier' }],
        },
      ],
    }

    const result = validator.validate(config)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('catches missing addon in nested children', () => {
    const loader = buildStepExists('mock-detector')
    const validator = new PipelineValidator(loader)

    const config: PipelineConfig = {
      engine: TEST_ENGINE,
      video: [
        {
          step: 'detect',
          addon: 'mock-detector',
          children: [{ step: 'classify', addon: 'missing-classifier' }],
        },
      ],
    }

    const result = validator.validate(config)
    expect(result.valid).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.addon).toBe('missing-classifier')
  })

  it('validates empty video pipeline', () => {
    const loader = buildStepExists()
    const validator = new PipelineValidator(loader)

    const config: PipelineConfig = { engine: TEST_ENGINE, video: [] }
    const result = validator.validate(config)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates audio node when present', () => {
    const loader = buildStepExists('mock-classifier')
    const validator = new PipelineValidator(loader)

    const config: PipelineConfig = {
      engine: TEST_ENGINE,
      video: [],
      audio: { step: 'audio-classify', addon: 'mock-classifier' },
    }

    const result = validator.validate(config)
    expect(result.valid).toBe(true)
  })

  it('fails on missing audio addon', () => {
    const loader = buildStepExists()
    const validator = new PipelineValidator(loader)

    const config: PipelineConfig = {
      engine: TEST_ENGINE,
      video: [],
      audio: { step: 'audio-classify', addon: 'missing-audio-addon' },
    }

    const result = validator.validate(config)
    expect(result.valid).toBe(false)
    expect(result.errors[0]?.addon).toBe('missing-audio-addon')
  })

  it('collects multiple errors across different nodes', () => {
    const loader = buildStepExists()
    const validator = new PipelineValidator(loader)

    const config: PipelineConfig = {
      engine: TEST_ENGINE,
      video: [
        { step: 'step-a', addon: 'missing-a' },
        { step: 'step-b', addon: 'missing-b' },
      ],
    }

    const result = validator.validate(config)
    expect(result.valid).toBe(false)
    expect(result.errors).toHaveLength(2)
  })
})
