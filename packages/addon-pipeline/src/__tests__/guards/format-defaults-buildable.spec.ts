import type { StepDefinition } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { getStepDefinition } from '../../detection-pipeline/registry/step-definitions.js'
import {
  evaluateFormatDefaultsGuard,
  findUnbuildableFormatDefaults,
} from './format-defaults-buildable.guard.js'

describe('format defaults are buildable (D657)', () => {
  it('the checked-out catalog passes', () => {
    expect(evaluateFormatDefaultsGuard()).toEqual([])
  })

  it('refuses the shape that shipped: a tflite default naming a model with no tflite build', () => {
    // It shipped as face-detection tflite → yunet-2023mar, before YuNet had its
    // Coral build (D710); the face embedder still has none.
    const embed = getStepDefinition('face-embedding')
    const bad: StepDefinition = {
      ...embed,
      defaultModelIdByFormat: { tflite: 'auraface-r100' },
    }
    expect(findUnbuildableFormatDefaults([bad])).toEqual([
      {
        stepId: 'face-embedding',
        format: 'tflite',
        modelId: 'auraface-r100',
        problem: 'no-build-for-format',
      },
    ])
  })

  it('refuses an entry naming a model the step does not list', () => {
    const face = getStepDefinition('face-detection')
    const bad: StepDefinition = {
      ...face,
      defaultModelIdByFormat: { onnx: 'no-such-model' },
    }
    expect(findUnbuildableFormatDefaults([bad])).toEqual([
      {
        stepId: 'face-detection',
        format: 'onnx',
        modelId: 'no-such-model',
        problem: 'not-in-catalog',
      },
    ])
  })

  it('accepts an entry whose model ships the build (the Coral SSD for object-detection)', () => {
    const od = getStepDefinition('object-detection')
    expect(od.defaultModelIdByFormat?.['tflite']).toBeDefined()
    expect(findUnbuildableFormatDefaults([od])).toEqual([])
  })
})
