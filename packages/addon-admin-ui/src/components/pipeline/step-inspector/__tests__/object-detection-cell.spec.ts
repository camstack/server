/**
 * The Object Detection matrix cell, per accelerator class: with no pin it shows
 * EXACTLY the device's elected default (the column header's `detail`), and a pin
 * shows the pin and SAYS it is one (`overridden`, source 'node'). A stored
 * `yolo26n` pin on an iGPU once read as the hardware default because the cell
 * dropped the pin's source.
 */
import type { NodeInferenceDevice, PipelineAddonSchema } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import {
  cellStateFor,
  type InspectorAccelerator,
  nodeAccelerators,
  stepModelOn,
} from '../step-inspector-model'

const FORMATS_OF: Readonly<Record<string, readonly string[]>> = {
  'yolov9s-320': ['onnx'],
  yolo26n: ['onnx', 'openvino', 'coreml', 'tflite'],
  'yolov9m-320-int8': ['openvino'],
  'yolov9m-640': ['coreml'],
  'yolov9t-320': ['onnx'],
  'yolov9s-320-edgetpu': ['tflite'],
}

const build = { sizeMB: 1, downloaded: true }

const catalog: PipelineAddonSchema = {
  id: 'object-detection',
  name: 'Object detection',
  slot: 'detector',
  inputClasses: [],
  outputClasses: [],
  childSlots: [],
  defaultConfidence: 0.5,
  defaultModelId: 'yolov9s-320',
  models: Object.entries(FORMATS_OF).map(([id, formats]) => ({
    id,
    name: id,
    formats: Object.fromEntries(formats.map((f) => [f, build])),
  })),
}

// [deviceKey, backend, device, format, the runner's resolveDefaultDetectionModel result]
const CLASSES = [
  ['cpu', 'onnx', 'cpu', 'onnx', 'yolov9s-320'],
  ['openvino:gpu', 'openvino', 'gpu', 'openvino', 'yolov9m-320-int8'],
  ['openvino:npu', 'openvino', 'npu', 'openvino', 'yolov9m-320-int8'],
  ['openvino:cpu', 'openvino', 'cpu', 'openvino', 'yolov9m-320-int8'],
  ['coreml:all', 'coreml', 'all', 'coreml', 'yolov9m-640'],
  ['onnx:webgpu', 'onnx', 'webgpu', 'onnx', 'yolov9t-320'],
  ['edgetpu:usb', 'edgetpu', 'usb', 'tflite', 'yolov9s-320-edgetpu'],
] as const

function accOf(
  key: string,
  backend: string,
  device: string,
  format: NodeInferenceDevice['format'],
  defaultModelId: string,
  pin?: string,
): InspectorAccelerator {
  const d: NodeInferenceDevice = {
    key,
    backend,
    device,
    format,
    available: true,
    presence: 'present',
    enabled: true,
    weight: 1,
    maxSessions: null,
    exclusion: null,
    defaultModelId,
    ...(pin !== undefined ? { steps: { 'object-detection': { modelId: pin } } } : {}),
  }
  const [acc] = nodeAccelerators('n1', 'hub', [d])
  if (acc === undefined) throw new Error('no accelerator')
  return acc
}

describe('Object Detection cell per accelerator class', () => {
  it.each(CLASSES)('%s: no pin -> the elected default, not marked', (key, b, d, f, runner) => {
    const acc = accOf(key, b, d, f, runner)
    const nodePin = acc.device.steps?.['object-detection']?.modelId
    const model = stepModelOn(catalog, acc, { nodePin })
    expect(model).toEqual({ modelId: acc.device.defaultModelId, source: 'default' })
    expect(cellStateFor({ addon: catalog, acc, gatedOn: true, model })).toEqual({
      kind: 'enabled',
      modelId: runner,
    })
  })

  it.each(CLASSES)('%s: a pin shows the pin and is marked', (key, b, d, f, runner) => {
    const acc = accOf(key, b, d, f, runner, 'yolo26n')
    const nodePin = acc.device.steps?.['object-detection']?.modelId
    const model = stepModelOn(catalog, acc, { nodePin })
    expect(model).toEqual({ modelId: 'yolo26n', source: 'node' })
    expect(cellStateFor({ addon: catalog, acc, gatedOn: true, model })).toMatchObject({
      kind: 'enabled',
      modelId: 'yolo26n',
      overridden: true,
    })
  })
})
