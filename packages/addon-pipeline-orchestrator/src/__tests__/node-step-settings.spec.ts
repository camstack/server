/**
 * The per-(node, device) provisioning base (D927): the node's OWN step
 * settings (`agentSettings[node].stepSettings`) under the device's own entry —
 * never a fold of sibling devices.
 *
 * The fold this replaces read a step's settings off ANY device entry of the
 * node, including a DISABLED one: production parked
 * `animal-classifier.enabledClasses` on the switched-off `cpu` entry of three
 * nodes, and that was the only place the allow-list lived. It worked by
 * accident and could not be seen on the accelerator that ran. Node-wide
 * content now has its own key, and a device's entry is read for that device
 * alone (its model, its jump, its model-bound thresholds).
 */
import { describe, expect, it } from 'vitest'
import { nodeDeviceBase } from '../node-step-settings.js'

const ALLOW = { enabledClasses: ['bird', 'cat', 'dog'] }

describe('nodeDeviceBase', () => {
  it('node-scoped settings reach every device, and the default pool', () => {
    const node = {
      stepSettings: { 'animal-classifier': ALLOW },
      inferenceDevices: { 'openvino:npu': { enabled: true } },
    }
    expect(nodeDeviceBase(node, 'openvino:npu')['animal-classifier']).toEqual({ settings: ALLOW })
    expect(nodeDeviceBase(node, '')['animal-classifier']).toEqual({ settings: ALLOW })
  })

  it('never reads settings off a DISABLED sibling entry (the parked cpu copy)', () => {
    const node = {
      inferenceDevices: {
        cpu: { enabled: false, steps: { 'animal-classifier': { settings: ALLOW } } },
        'openvino:npu': { enabled: true },
      },
    }
    expect(nodeDeviceBase(node, 'openvino:npu')['animal-classifier']).toBeUndefined()
  })

  it("a device's own thresholds apply to it alone and win over the node's keys", () => {
    const node = {
      stepSettings: { 'object-detection': { nmsIouThreshold: 0.5 } },
      inferenceDevices: {
        'openvino:gpu': {
          enabled: true,
          steps: {
            'object-detection': {
              modelId: 'yolov9m-640-int8',
              settings: { minConfidencePerson: 0.7, nmsIouThreshold: 0.6 },
            },
          },
        },
        'openvino:npu': { enabled: true },
      },
    }
    expect(nodeDeviceBase(node, 'openvino:gpu')['object-detection']).toEqual({
      modelId: 'yolov9m-640-int8',
      settings: { nmsIouThreshold: 0.6, minConfidencePerson: 0.7 },
    })
    expect(nodeDeviceBase(node, 'openvino:npu')['object-detection']).toEqual({
      settings: { nmsIouThreshold: 0.5 },
    })
  })

  it('keeps the jump and model of the requested device only', () => {
    const node = {
      inferenceDevices: {
        'edgetpu:usb': {
          enabled: true,
          steps: { 'face-detection': { jumpDeviceKey: 'openvino:gpu' } },
        },
        'openvino:gpu': { enabled: true },
      },
    }
    expect(nodeDeviceBase(node, 'edgetpu:usb')['face-detection']).toEqual({
      jumpDeviceKey: 'openvino:gpu',
    })
    expect(nodeDeviceBase(node, 'openvino:gpu')).toEqual({})
    expect(nodeDeviceBase(undefined, 'cpu')).toEqual({})
  })
})
