/**
 * D745 — Auto tune writes ONLY model choices and model-bound thresholds.
 * The proof is an allow-list over a deep diff of the blobs before and after:
 * every changed path must be a detector/enrichment `modelId` or a bound
 * threshold key (or its binding). Step enablement, device enablement, weights,
 * caps, jumps, unrelated settings and untouched nodes are in the fixture and
 * must come out byte-identical. A camera carries no model (D927), so the
 * agent blob is the only thing Auto tune writes.
 */
import { describe, expect, it } from 'vitest'
import { applyNodeAutoTune, type AutoTuneDiffInput } from '../auto-tune/plan-diff.js'
import type { AgentSettingsMapBlob } from '../orchestrator-store-schemas.js'

const BOUND = {
  'object-detection': ['minConfidencePerson', 'minConfidenceVehicle', 'minConfidenceAnimal'],
  'animal-classifier': ['minConfidence'],
  'package-detection': ['minConfidencePackage'],
}

const AGENT: AgentSettingsMapBlob = {
  hub: {
    maxCameras: null,
    detectWeight: 2,
    inferenceDevices: {
      cpu: {
        enabled: false,
        steps: {
          'animal-classifier': {
            settings: {
              enabledClasses: ['dog', 'cat'],
              minConfidence: 0.7,
              minConfidenceModelId: 'x',
            },
          },
        },
      },
      'edgetpu:usb': { enabled: false, maxSessions: 1 },
      'openvino:gpu': {
        enabled: true,
        weight: 50,
        steps: {
          'object-detection': {
            modelId: 'yolov9m-320-int8',
            settings: { minConfidencePerson: 0.6, fullFrameGuardHardAreaRatio: 0.8 },
          },
          'face-detection': { modelId: 'yunet-2023mar', jumpDeviceKey: 'openvino:npu' },
          'face-embedding': { modelId: 'auraface-r100' },
        },
      },
    },
  },
  'agent-a': {
    maxCameras: 4,
    inferenceDevices: {
      'openvino:gpu': {
        enabled: true,
        steps: { 'object-detection': { modelId: 'yolov9t-320-int8' } },
      },
    },
  },
}

const INPUT: AutoTuneDiffInput = {
  touchedNodes: new Set(['hub']),
  targets: new Map([
    [
      'hub',
      [
        { deviceKey: 'openvino:gpu', modelId: 'yolov9m-640-int8', effectiveEnabled: true },
        { deviceKey: 'openvino:npu', modelId: 'yolov9m-640-int8', effectiveEnabled: true },
      ],
    ],
  ]),
  boundKeysByStep: BOUND,
}

/** Every leaf path whose value differs between `a` and `b`. */
function changedPaths(a: unknown, b: unknown, path = ''): string[] {
  if (Object.is(a, b)) return []
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
  if (!isObj(a) || !isObj(b)) return [path]
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].flatMap((k) => changedPaths(a[k], b[k], `${path}/${k}`))
}

const ALLOWED_AGENT = [
  /^\/hub\/inferenceDevices\/[^/]+\/steps\/[^/]+\/modelId$/,
  /^\/hub\/inferenceDevices\/[^/]+\/steps\/[^/]+\/settings\/minConfidence[A-Za-z]*$/,
  // A device the plan pins for the first time gets an explicit entry.
  /^\/hub\/inferenceDevices\/openvino:npu$/,
  // A step left with neither pin nor settings is pruned.
  /^\/hub\/inferenceDevices\/[^/]+\/steps\/[^/]+$/,
]

describe('Auto tune plan diff — only models and bound thresholds change', () => {
  it('node blob: every changed path is on the allow-list', () => {
    const { next } = applyNodeAutoTune(AGENT, INPUT)
    const paths = changedPaths(AGENT, next)
    expect(paths.length).toBeGreaterThan(0)
    for (const p of paths)
      expect(
        ALLOWED_AGENT.some((re) => re.test(p)),
        p,
      ).toBe(true)
  })

  it('node blob: the detector pin is set, enrichment pins cleared, embedding pin kept, untouched node identical', () => {
    const { next, changes } = applyNodeAutoTune(AGENT, INPUT)
    const gpu = next.hub?.inferenceDevices?.['openvino:gpu']
    expect(gpu?.steps?.['object-detection']).toEqual({
      modelId: 'yolov9m-640-int8',
      settings: { fullFrameGuardHardAreaRatio: 0.8 },
    })
    expect(gpu?.steps?.['face-detection']).toEqual({ jumpDeviceKey: 'openvino:npu' })
    expect(gpu?.steps?.['face-embedding']).toEqual({ modelId: 'auraface-r100' })
    expect(gpu?.weight).toBe(50)
    expect(next.hub?.inferenceDevices?.cpu?.steps?.['animal-classifier']?.settings).toEqual({
      enabledClasses: ['dog', 'cat'],
    })
    expect(next.hub?.inferenceDevices?.['openvino:npu']).toEqual({
      enabled: true,
      steps: { 'object-detection': { modelId: 'yolov9m-640-int8' } },
    })
    expect(next['agent-a']).toBe(AGENT['agent-a'])
    expect(changes.find((c) => c.deviceKey === 'openvino:npu')?.madeExplicit).toBe(true)
  })
})
