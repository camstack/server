/**
 * D786 — Auto tune never overwrites a custom model. A (node, device) whose root
 * detector is pinned to a custom-registry model comes out of the diff
 * byte-identical: model, thresholds, other steps' pins, all of it. Everything
 * else is tuned as before. (A camera carries no model to keep, D927.)
 */
import { describe, expect, it } from 'vitest'
import { applyNodeAutoTune, type AutoTuneDiffInput } from '../auto-tune/plan-diff.js'
import type { AgentSettingsMapBlob } from '../orchestrator-store-schemas.js'

const CUSTOM = 'custom-yolov9m-640-ft'

const AGENT: AgentSettingsMapBlob = {
  hub: {
    maxCameras: null,
    inferenceDevices: {
      'openvino:npu': {
        enabled: true,
        steps: {
          'object-detection': { modelId: CUSTOM, settings: { minConfidencePerson: 0.45 } },
          'face-detection': { modelId: 'yunet-2023mar' },
        },
      },
      'openvino:gpu': {
        enabled: true,
        steps: { 'object-detection': { settings: { minConfidencePerson: 0.6 } } },
      },
      cpu: {
        enabled: true,
        steps: {
          'object-detection': { modelId: 'yolov9t-320', settings: { minConfidencePerson: 0.7 } },
        },
      },
    },
  },
}

const INPUT: AutoTuneDiffInput = {
  touchedNodes: new Set(['hub']),
  targets: new Map([
    ['hub', [{ deviceKey: 'cpu', modelId: 'yolov9s-320-int8', effectiveEnabled: true }]],
  ]),
  boundKeysByStep: { 'object-detection': ['minConfidencePerson'] },
  keptDevices: new Set(['hub|openvino:npu', 'hub|openvino:gpu']),
  isCustomModel: (id) => id === CUSTOM,
}

describe('Auto tune and custom pins', () => {
  it('leaves a kept device exactly as it was, and tunes the rest', () => {
    const { next, changes } = applyNodeAutoTune(AGENT, INPUT)

    expect(next.hub?.inferenceDevices?.['openvino:npu']).toEqual(
      AGENT.hub?.inferenceDevices?.['openvino:npu'],
    )
    expect(next.hub?.inferenceDevices?.['openvino:gpu']).toEqual(
      AGENT.hub?.inferenceDevices?.['openvino:gpu'],
    )
    expect(changes.map((c) => c.deviceKey)).toEqual(['cpu'])
    expect(next.hub?.inferenceDevices?.cpu?.steps?.['object-detection']?.modelId).toBe(
      'yolov9s-320-int8',
    )
  })
})
