import type { NodeInferenceDevice } from '@camstack/types'
import { acceleratorLabel } from '@camstack/ui-library'
import { describe, expect, it } from 'vitest'
import { acceleratorLabel as autoTuneAcceleratorLabel } from '../../auto-tune/auto-tune-view-model'
import { acceleratorFace } from '../../placement-board/NodeInferenceDevices'

function device(key: string, backend: string, dev: string): NodeInferenceDevice {
  return {
    key,
    backend,
    device: dev,
    format: 'onnx',
    available: true,
    enabled: true,
    weight: 1,
    maxSessions: null,
    defaultModelId: 'yolo',
    exclusion: null,
  } as NodeInferenceDevice
}

const DEVICES = [
  device('cpu', 'cpu', 'cpu'),
  device('openvino:npu', 'openvino', 'npu'),
  device('openvino:gpu', 'openvino', 'gpu'),
  device('edgetpu:usb', 'edgetpu', 'usb'),
  device('coreml:all', 'coreml', 'all'),
  device('cuda:0', 'cuda', '0'),
]

describe('one accelerator label for every screen (ui-library `acceleratorLabel`)', () => {
  it('names each accelerator once', () => {
    expect(DEVICES.map(acceleratorLabel)).toEqual([
      'CPU',
      'Intel NPU',
      'Intel iGPU',
      'Coral Edge TPU',
      'Apple Neural Engine',
      'Cuda 0',
    ])
  })

  it('the placement board names devices with the shared function', () => {
    // The audit found the Mac's CoreML device named "Coreml All" on one screen
    // and "Apple ANE" on another.
    for (const d of DEVICES) expect(acceleratorFace(d).label).toBe(acceleratorLabel(d))
  })

  it('Auto tune names the same hardware the same way', () => {
    expect(autoTuneAcceleratorLabel('apple-ane')).toBe('Apple Neural Engine')
    expect(autoTuneAcceleratorLabel('intel-npu')).toBe('Intel NPU')
    expect(autoTuneAcceleratorLabel('coral')).toBe('Coral Edge TPU')
  })
})
