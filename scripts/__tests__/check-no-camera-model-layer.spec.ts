/**
 * D927 guard — a camera never carries a model or a model-bound threshold.
 * Each case names the ONE rule a fixture trips; the last runs the real cap.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { pipelineOrchestratorCapability } from '../../packages/types/src/capabilities/pipeline-orchestrator.cap.js'
import {
  cameraScopedModelKeys,
  foreignCameraSettingsKeys,
  isModelScopedKey,
  modelPickersNamedIn,
} from '../lib/camera-model-layer.ts'

describe('camera model layer guard (D927)', () => {
  it('names a model id, a binding and a confidence floor', () => {
    expect(isModelScopedKey('modelId')).toBe(true)
    expect(isModelScopedKey('minConfidencePersonModelId')).toBe(true)
    expect(isModelScopedKey('minConfidenceAnimal')).toBe(true)
    expect(isModelScopedKey('enabledClasses')).toBe(false)
  })

  it('flags a camera-scoped input that pins a model per accelerator', () => {
    const input = z.object({
      deviceId: z.number(),
      agentNodeId: z.string(),
      patch: z.object({ modelId: z.string().optional() }).nullable(),
    })
    expect(cameraScopedModelKeys(input)).toEqual(['patch.modelId'])
  })

  it('flags a floor nested in a record of settings', () => {
    const input = z.object({
      deviceId: z.number(),
      steps: z.array(z.object({ settings: z.object({ minConfidencePerson: z.number() }) })),
    })
    expect(cameraScopedModelKeys(input)).toEqual(['steps[].settings.minConfidencePerson'])
  })

  it('leaves a node-scoped input alone (no deviceId)', () => {
    expect(
      cameraScopedModelKeys(z.object({ agentNodeId: z.string(), modelId: z.string() })),
    ).toEqual([])
  })

  it('flags a camera settings blob with a per-accelerator layer', () => {
    const blob = z.object({
      stepToggles: z.record(z.string(), z.boolean()),
      pipelineByAgent: z.unknown(),
    })
    expect(foreignCameraSettingsKeys(blob)).toEqual(['pipelineByAgent'])
  })

  it('flags a camera page that renders a model picker, and nothing else', () => {
    const source = [
      "import { StepModelRow, type PipelineStepDisplayConfig } from '@camstack/ui-library'",
      '<StepModelRow {...row} /> <GroupedModelSelector /> <StepModelRow />',
    ].join('\n')
    expect(modelPickersNamedIn(source)).toEqual(['StepModelRow', 'GroupedModelSelector'])
    expect(modelPickersNamedIn('<EffectiveModelSummary rows={rows} />')).toEqual([])
  })

  it('the real pipeline-orchestrator cap is clean', () => {
    const offenders = Object.entries(pipelineOrchestratorCapability.methods).flatMap(([name, m]) =>
      cameraScopedModelKeys(m.input).map((k) => `${name}:${k}`),
    )
    expect(offenders).toEqual([])
    expect(
      foreignCameraSettingsKeys(pipelineOrchestratorCapability.methods.getCameraSettings.output),
    ).toEqual([])
  })
})
