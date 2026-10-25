/**
 * Step-tree device jump (phase 1) — orchestrator-side pure helpers: the
 * save-time `jumpDeviceKey` validator and the attach-payload roster builder.
 */
import { describe, expect, it } from 'vitest'
import {
  buildInferenceDeviceRoster,
  validateJumpTargets,
  type StoredInferenceDevice,
} from '../inference-device-model.js'

describe('validateJumpTargets', () => {
  const enabled = new Set(['edgetpu:usb', 'openvino:npu', 'coreml:ane'])

  it('accepts a jumpDeviceKey pointing at an enabled, available same-node device', () => {
    const map: Record<string, StoredInferenceDevice> = {
      'edgetpu:usb': {
        enabled: true,
        steps: { 'face-detection': { jumpDeviceKey: 'openvino:npu' } },
      },
      'openvino:npu': { enabled: true },
    }
    expect(validateJumpTargets(map, enabled)).toBeNull()
  })

  it('rejects a jumpDeviceKey pointing at a device absent from the node', () => {
    const map: Record<string, StoredInferenceDevice> = {
      'edgetpu:usb': {
        enabled: true,
        steps: { 'face-detection': { jumpDeviceKey: 'openvino:missing' } },
      },
    }
    expect(validateJumpTargets(map, enabled)).toMatch(/not an enabled, available device/)
  })

  it('rejects a jumpDeviceKey pointing at a disabled device', () => {
    const map: Record<string, StoredInferenceDevice> = {
      'edgetpu:usb': { enabled: true, steps: { 'face-detection': { jumpDeviceKey: 'cpu' } } },
    }
    // `cpu` is not in the enabled∧available set.
    expect(validateJumpTargets(map, enabled)).toMatch(/not an enabled, available device/)
  })

  it('rejects a self-pointing jumpDeviceKey', () => {
    const map: Record<string, StoredInferenceDevice> = {
      'openvino:npu': {
        enabled: true,
        steps: { 'face-detection': { jumpDeviceKey: 'openvino:npu' } },
      },
    }
    expect(validateJumpTargets(map, enabled)).toMatch(/its own device/)
  })

  it('is a no-op when no step declares a jumpDeviceKey', () => {
    const map: Record<string, StoredInferenceDevice> = {
      'openvino:npu': { enabled: true, steps: { 'face-detection': { modelId: 'scrfd-2.5g' } } },
    }
    expect(validateJumpTargets(map, enabled)).toBeNull()
  })
})

describe('buildInferenceDeviceRoster', () => {
  it('maps eligible weights + caps into a sorted roster', () => {
    const roster = buildInferenceDeviceRoster(
      { 'openvino:npu': 3, 'edgetpu:usb': 1 },
      { 'openvino:npu': 2 },
    )
    expect(roster).toEqual([
      { deviceKey: 'edgetpu:usb', weight: 1, maxSessions: null },
      { deviceKey: 'openvino:npu', weight: 3, maxSessions: 2 },
    ])
  })

  it('normalizes a non-positive weight to 1', () => {
    const roster = buildInferenceDeviceRoster({ cpu: 0 }, {})
    expect(roster).toEqual([{ deviceKey: 'cpu', weight: 1, maxSessions: null }])
  })
})
