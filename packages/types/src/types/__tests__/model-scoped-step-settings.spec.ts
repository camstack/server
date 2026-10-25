import { describe, expect, it } from 'vitest'
import {
  cameraScopedStepSettings,
  isModelScopedStepSettingKey,
  modelScopedStepSettingKeys,
} from '../agent-pipeline-settings.js'

/**
 * D927: a model is chosen by the accelerator that runs it. A camera layer may
 * carry camera-semantic settings only — never a model, a model binding or a
 * confidence floor (every `bindsToModel` field is a `minConfidence*`).
 */
describe('model-scoped step setting keys (D927)', () => {
  it('names a model id, a model binding and every confidence floor', () => {
    expect(isModelScopedStepSettingKey('modelId')).toBe(true)
    expect(isModelScopedStepSettingKey('minConfidencePersonModelId')).toBe(true)
    expect(isModelScopedStepSettingKey('minConfidence')).toBe(true)
    expect(isModelScopedStepSettingKey('minConfidenceVehicle')).toBe(true)
  })

  it('leaves camera-semantic keys alone', () => {
    expect(isModelScopedStepSettingKey('enabledClasses')).toBe(false)
    expect(isModelScopedStepSettingKey('nmsIouThreshold')).toBe(false)
    expect(isModelScopedStepSettingKey('maxDetections')).toBe(false)
  })

  it('lists the offending keys sorted and strips them from a bag', () => {
    const bag = {
      enabledClasses: ['person'],
      minConfidencePerson: 0.7,
      minConfidencePersonModelId: 'yolov9m-320-int8',
    }
    expect(modelScopedStepSettingKeys(bag)).toEqual([
      'minConfidencePerson',
      'minConfidencePersonModelId',
    ])
    expect(cameraScopedStepSettings(bag)).toEqual({ enabledClasses: ['person'] })
  })
})
