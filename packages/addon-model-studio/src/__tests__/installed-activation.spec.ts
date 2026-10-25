/**
 * Pure helpers for Installed → Activate / Settings on inference devices.
 * Active uses the Pipeline matrix effective chain (not pin-only).
 */
import { describe, expect, it } from 'vitest'
import type { NodeInferenceDevice } from '@camstack/types'
import {
  acceleratorsRunningModel,
  applyStepSettingsOnDevice,
  clusterModelPatch,
  clusterPinsModel,
  patchStepModelOnDevices,
  type StepCatalogForActive,
} from '../ui/installed-activation.js'

function device(
  partial: Partial<NodeInferenceDevice> & Pick<NodeInferenceDevice, 'key'>,
): NodeInferenceDevice {
  return {
    backend: 'openvino',
    device: 'gpu',
    format: 'openvino',
    available: true,
    enabled: true,
    weight: 1,
    maxSessions: null,
    defaultModelId: 'yolo26n',
    steps: {},
    exclusion: null,
    ...partial,
  }
}

const OD_CATALOG: StepCatalogForActive = {
  id: 'object-detection',
  slot: 'detector',
  defaultModelId: 'yolo26n',
  models: [
    {
      id: 'yolo26n',
      formats: { onnx: { sizeMB: 6 }, openvino: { sizeMB: 6 } },
    },
    {
      id: 'yolov9m-320-int8',
      formats: { openvino: { sizeMB: 12 } },
    },
    {
      id: 'ssdlite-mobiledet-coco-edgetpu',
      formats: { tflite: { sizeMB: 4 } },
    },
  ],
}

/** Every format current on disk — the cases below are about the effective chain. */
const ALL_CURRENT: ReadonlySet<string> = new Set(['onnx', 'openvino', 'tflite', 'coreml'])

describe('acceleratorsRunningModel — effective chain (matrix parity)', () => {
  it('never names a DISABLED device, or one whose file is not on disk (live hub CPU/Coral)', () => {
    const devices = [
      device({
        key: 'cpu',
        backend: 'cpu',
        device: 'cpu',
        format: 'onnx',
        enabled: false,
        defaultModelId: 'yolo26n',
      }),
      device({
        key: 'edgetpu:usb',
        backend: 'edgetpu',
        device: 'usb',
        format: 'tflite',
        enabled: true,
        defaultModelId: 'ssdlite-mobiledet-coco-edgetpu',
      }),
      device({ key: 'openvino:gpu', format: 'openvino', defaultModelId: 'yolo26n' }),
    ]
    // yolo26n is the format default of CPU (disabled) and of the GPU; only the
    // GPU, with its openvino file current on disk, configures it.
    expect(
      acceleratorsRunningModel(
        devices,
        'object-detection',
        'yolo26n',
        OD_CATALOG,
        new Set(['onnx', 'openvino']),
      ).map((a) => a.deviceKey),
    ).toEqual(['openvino:gpu'])
    // The Coral is enabled but its tflite copy is not current: not configured.
    expect(
      acceleratorsRunningModel(
        devices,
        'object-detection',
        'ssdlite-mobiledet-coco-edgetpu',
        OD_CATALOG,
        new Set<string>(),
      ),
    ).toEqual([])
  })

  it('marks the device defaultModelId active when steps are empty (live hub GPU/NPU)', () => {
    const devices = [
      device({
        key: 'openvino:gpu',
        format: 'openvino',
        defaultModelId: 'yolov9m-320-int8',
        steps: {},
      }),
      device({
        key: 'openvino:npu',
        device: 'npu',
        format: 'openvino',
        defaultModelId: 'yolov9m-320-int8',
        steps: {},
      }),
    ]
    expect(
      acceleratorsRunningModel(
        devices,
        'object-detection',
        'yolov9m-320-int8',
        OD_CATALOG,
        ALL_CURRENT,
      ),
    ).toEqual([
      { deviceKey: 'openvino:gpu', label: 'iGPU', format: 'openvino' },
      { deviceKey: 'openvino:npu', label: 'NPU', format: 'openvino' },
    ])
    // Catalog default is NOT active when the device elected a different OD model
    expect(
      acceleratorsRunningModel(devices, 'object-detection', 'yolo26n', OD_CATALOG, ALL_CURRENT),
    ).toEqual([])
  })

  it('honours an explicit steps pin over the device default', () => {
    const devices = [
      device({
        key: 'edgetpu:usb',
        backend: 'edgetpu',
        device: 'usb',
        format: 'tflite',
        defaultModelId: 'ssd-mobilenet-v2-coco-edgetpu',
        steps: { 'object-detection': { modelId: 'ssdlite-mobiledet-coco-edgetpu' } },
      }),
    ]
    expect(
      acceleratorsRunningModel(
        devices,
        'object-detection',
        'ssdlite-mobiledet-coco-edgetpu',
        OD_CATALOG,
        ALL_CURRENT,
      ),
    ).toEqual([{ deviceKey: 'edgetpu:usb', label: 'Coral', format: 'tflite' }])
  })

  it('returns nothing without a catalog (cannot resolve effective)', () => {
    expect(
      acceleratorsRunningModel(
        [device({ key: 'openvino:gpu', steps: { 'object-detection': { modelId: 'yolo26n' } } })],
        'object-detection',
        'yolo26n',
        null,
        ALL_CURRENT,
      ),
    ).toEqual([])
  })

  it('clusterPinsModel is true only for cluster-scoped steps with a matching row', () => {
    expect(
      clusterPinsModel('face-embedding', 'auraface-r100', { 'face-embedding': 'auraface-r100' }),
    ).toBe(true)
    expect(
      clusterPinsModel('object-detection', 'yolo26n', { 'face-embedding': 'auraface-r100' }),
    ).toBe(false)
    expect(clusterPinsModel('face-embedding', 'auraface-r100', null)).toBe(false)
  })

  it('clusterModelPatch keys the store the orchestrator reads', () => {
    expect(clusterModelPatch('face-embedding', 'auraface-r100')).toEqual({
      'clusterModel:face-embedding': 'auraface-r100',
    })
  })
})

describe('patchStepModelOnDevices', () => {
  it('pins modelId on targets, force-enables them, keeps every other key', () => {
    const devices = [
      device({ key: 'openvino:gpu', enabled: false }),
      device({
        key: 'cpu',
        backend: 'cpu',
        device: 'cpu',
        format: 'onnx',
        enabled: false,
        steps: { 'object-detection': { modelId: 'keep-me' } },
      }),
    ]
    const out = patchStepModelOnDevices(devices, 'object-detection', 'yolo26n', ['openvino:gpu'])
    expect(out['openvino:gpu']).toMatchObject({
      enabled: true,
      weight: 1,
      steps: { 'object-detection': { modelId: 'yolo26n' } },
    })
    expect(out['cpu']).toMatchObject({
      enabled: false,
      steps: { 'object-detection': { modelId: 'keep-me' } },
    })
  })
})

describe('applyStepSettingsOnDevice', () => {
  it('writes settings under the selected device and MOVEs them off the others', () => {
    const devices = [
      device({
        key: 'openvino:gpu',
        steps: {
          'object-detection': { modelId: 'yolo26n', settings: { conf: 0.4 } },
        },
      }),
      device({
        key: 'openvino:npu',
        device: 'npu',
        steps: {
          'object-detection': { modelId: 'yolo26s', settings: { conf: 0.9 } },
        },
      }),
    ]
    const out = applyStepSettingsOnDevice(
      devices,
      'object-detection',
      'yolo26n',
      { conf: 0.55 },
      'openvino:gpu',
    )
    expect(out['openvino:gpu']?.steps?.['object-detection']).toEqual({
      modelId: 'yolo26n',
      settings: { conf: 0.55 },
    })
    expect(out['openvino:npu']?.steps?.['object-detection']).toEqual({
      modelId: 'yolo26s',
    })
  })
})
