import { describe, it, expect } from 'vitest'
import {
  NodeBindingsSchema,
  AgentSettingsMapSchema,
  CameraSettingsMapSchema,
} from '../orchestrator-store-schemas.js'

/**
 * Round-trip guards for the orchestrator's whole-blob durable-state
 * schemas. Each asserts that a representative persisted blob parses
 * back equal (no field dropped), AND that a LEGACY-shaped blob missing
 * newer optional fields still loads. This is the backward-compatibility
 * contract the migration must hold: existing on-disk data must survive
 * the first save after the durable-state cut-over.
 */

describe('NodeBindingsSchema', () => {
  it('round-trips a two-level nodeId → capName → addonId map', () => {
    const blob = {
      hub: { decoder: 'decoder-nodeav', motion: 'motion-wasm' },
      'agent-mac': { decoder: 'decoder-ffmpeg' },
    }
    const parsed = NodeBindingsSchema.parse(blob)
    expect(parsed).toEqual(blob)
  })

  it('accepts an empty map (cold start)', () => {
    expect(NodeBindingsSchema.parse({})).toEqual({})
  })
})

describe('AgentSettingsMapSchema', () => {
  it('agent settings carry device step config (modelId+settings), no addonDefaults', () => {
    const parsed = AgentSettingsMapSchema.parse({
      hub: {
        maxCameras: null,
        inferenceDevices: {
          'openvino:npu': {
            enabled: true,
            steps: { 'object-detection': { modelId: 'yolov9m-320-int8', settings: { conf: 0.3 } } },
          },
        },
      },
    })
    expect(
      parsed.hub?.inferenceDevices?.['openvino:npu']?.steps?.['object-detection']?.modelId,
    ).toBe('yolov9m-320-int8')
    expect('addonDefaults' in parsed.hub!).toBe(false)
  })

  it('tolerates a legacy blob with addonDefaults/models (ignored, not required)', () => {
    // Legacy fields kept schema-optional so an old on-disk blob still loads;
    // migration (Task 6) strips addonDefaults + lifts models → steps.
    const parsed = AgentSettingsMapSchema.parse({
      hub: {
        maxCameras: null,
        addonDefaults: { 'object-detection': { enabled: true, settings: {} } },
        inferenceDevices: {
          'openvino:npu': { enabled: true, models: { 'object-detection': 'yolov9m-320-int8' } },
        },
      },
    })
    expect(parsed.hub).toBeDefined()
    expect(parsed.hub?.maxCameras).toBeNull()
  })
})

describe('CameraSettingsMapSchema', () => {
  it('round-trips a sparse per-camera overlay (stepToggles + camera step settings)', () => {
    const blob = {
      '12': {
        stepToggles: { 'object-detection': true, 'audio-classifier': false },
        stepSettings: { 'object-detection': { enabledClasses: ['person'] } },
      },
    }
    const parsed = CameraSettingsMapSchema.parse(blob)
    expect(parsed).toEqual(blob)
  })

  it('strips the retired per-camera model layers from an old blob (D927)', () => {
    const parsed = CameraSettingsMapSchema.parse({
      '102': {
        stepToggles: { 'face-detection': true },
        stepOverridesByDevice: {
          hub: { 'openvino:npu': { 'object-detection': { modelId: 'yolov9-large-int8' } } },
        },
        pipelineByAgent: { hub: { steps: [], audio: null } },
      },
    })
    expect(parsed['102']).toEqual({ stepToggles: { 'face-detection': true } })
  })

  it('tolerates a legacy camera blob with stepOverridesByAgent (ignored, not required)', () => {
    const parsed = CameraSettingsMapSchema.parse({
      '3': {
        stepToggles: { 'object-detection': true },
        stepOverridesByAgent: {
          'agent-mac': { 'object-detection': { enabled: false, modelId: 'yolo-s' } },
        },
      },
    })
    expect(parsed['3']?.stepToggles?.['object-detection']).toBe(true)
  })

  it('loads a legacy sparse camera entry (only stepToggles)', () => {
    const legacy = {
      '7': { pinnedAgentNodeId: 'agent-mac', stepToggles: { 'object-detection': true } },
    }
    const parsed = CameraSettingsMapSchema.parse(legacy)
    // The retired `pinnedAgentNodeId` (D748) is stripped from an old blob.
    expect(Object.keys(parsed['7'] ?? {})).not.toContain('pinnedAgentNodeId')
    expect(parsed['7']?.stepToggles).toEqual({ 'object-detection': true })
  })

  it('loads a fully-empty camera entry (camera accepted all defaults)', () => {
    const parsed = CameraSettingsMapSchema.parse({ '9': {} })
    expect(parsed['9']).toEqual({})
  })
})
