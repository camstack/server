import { describe, expect, it } from 'vitest'
import { applyLoadBalancingShares } from '../load-balancing-shares.js'
import type { AgentSettingsMapBlob } from '../orchestrator-store-schemas.js'

const blob: AgentSettingsMapBlob = {
  hub: {
    maxCameras: 6,
    detectWeight: 20,
    detect: true,
    inferenceDevices: {
      'openvino:npu': {
        enabled: true,
        weight: 50,
        maxSessions: 9,
        steps: { 'object-detection': { modelId: 'm' } },
      },
      'openvino:gpu': { enabled: true, weight: 50 },
      cpu: { enabled: false },
    },
  },
  mac: { maxCameras: null, detectWeight: 70 },
}

describe('applyLoadBalancingShares', () => {
  it('writes node and device shares in one transform and keeps every other field', () => {
    const next = applyLoadBalancingShares(blob, {
      nodes: { hub: 50, mac: 45 },
      devices: { hub: { 'openvino:npu': 60, 'openvino:gpu': 40 } },
      effectiveEnabled: {},
    })
    expect(next.hub).toEqual({
      maxCameras: 6,
      detectWeight: 50,
      detect: true,
      inferenceDevices: {
        'openvino:npu': {
          enabled: true,
          weight: 60,
          maxSessions: 9,
          steps: { 'object-detection': { modelId: 'm' } },
        },
        'openvino:gpu': { enabled: true, weight: 40 },
        cpu: { enabled: false },
      },
    })
    expect(next.mac).toEqual({ maxCameras: null, detectWeight: 45 })
  })

  it('leaves out-of-input nodes and devices untouched', () => {
    const next = applyLoadBalancingShares(blob, {
      nodes: { mac: 10 },
      devices: {},
      effectiveEnabled: {},
    })
    expect(next.hub).toBe(blob.hub)
    expect(next.mac?.detectWeight).toBe(10)
  })

  it('a node with no stored entry gets one, with an unlimited cap', () => {
    const next = applyLoadBalancingShares(blob, {
      nodes: { 'agent-a': 5 },
      devices: {},
      effectiveEnabled: {},
    })
    expect(next['agent-a']).toEqual({ maxCameras: null, detectWeight: 5 })
  })

  it('a device with no stored entry is made explicit with its EFFECTIVE enablement', () => {
    const next = applyLoadBalancingShares(blob, {
      nodes: {},
      devices: { mac: { 'coreml:all': 3 } },
      effectiveEnabled: { mac: { 'coreml:all': true } },
    })
    expect(next.mac?.inferenceDevices).toEqual({ 'coreml:all': { enabled: true, weight: 3 } })
  })

  it('never writes a device whose enablement is unknown', () => {
    const next = applyLoadBalancingShares(blob, {
      nodes: {},
      devices: { mac: { 'ghost:dev': 3 } },
      effectiveEnabled: {},
    })
    expect(next.mac).toBe(blob.mac)
  })
})
