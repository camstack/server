import { describe, it, expect } from 'vitest'
import { resolvePipeline } from '../pipeline-resolver'
import { applyDeviceProvisioning } from '../apply-device-provisioning'
import type {
  CameraPipelineSettings,
  DeviceStepConfig,
  PipelineSchema,
  PipelineEngineChoice,
} from '@camstack/types'

const ENGINE: PipelineEngineChoice = { runtime: 'python', backend: 'coreml', format: 'coreml' }

const CATALOG: PipelineSchema = {
  availableEngines: [],
  selectedEngine: ENGINE,
  slots: [
    {
      id: 'detector',
      label: 'Detector',
      priority: 0,
      parentSlot: null,
      addons: [
        {
          id: 'object-detection',
          name: 'Object detection',
          slot: 'detector',
          inputClasses: [],
          outputClasses: ['person', 'vehicle', 'animal'],
          childSlots: ['classifier'],
          models: [
            { id: 'yolo-m', name: 'YOLO M', formats: { coreml: { downloaded: true, sizeMB: 50 } } },
            { id: 'yolo-s', name: 'YOLO S', formats: { coreml: { downloaded: true, sizeMB: 20 } } },
          ],
          defaultModelId: 'yolo-m',
          defaultConfidence: 0.25,
          configSchema: [],
        },
      ],
    },
  ],
}

// The per-(node,device) BASE for the chosen accelerator.
const BASE: Record<string, DeviceStepConfig> = {
  'object-detection': { modelId: 'yolo-m', settings: { confidence: 0.25 } },
}

describe('per-(node,device) provisioning — resolve (structure) + provision', () => {
  it('resolver attaches NO model; provisioning applies base then override', () => {
    const camera: CameraPipelineSettings = {}
    const { steps } = resolvePipeline(camera, 'coreml', CATALOG)
    expect(steps[0]?.addonId).toBe('object-detection')
    expect(steps[0]?.modelId).toBeUndefined()

    const provisioned = applyDeviceProvisioning(steps, BASE, {})
    expect(provisioned[0]?.modelId).toBe('yolo-m')
  })

  it('the accelerator alone picks the model; a camera layer adds settings only (D927)', () => {
    const { steps } = resolvePipeline({}, 'coreml', CATALOG)
    const provisioned = applyDeviceProvisioning(steps, BASE, {
      'object-detection': { settings: { enabledClasses: ['person'] } },
    })
    expect(provisioned[0]?.modelId).toBe('yolo-m')
    expect(provisioned[0]?.settings).toEqual({ confidence: 0.25, enabledClasses: ['person'] })
  })

  it('per-camera stepToggles is the SOLE disable path (overrides carry no enablement)', () => {
    const gatedOff: CameraPipelineSettings = { stepToggles: { 'object-detection': false } }
    const { steps } = resolvePipeline(gatedOff, 'coreml', CATALOG)
    expect(steps.length).toBe(0)
  })
})
