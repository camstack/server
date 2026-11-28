/**
 * The step switch matrix (D1065): every cell comes from the attach path's own
 * gate and placement, so the inspector cannot say "on" for a step no camera
 * runs, nor "skip" for a step a sibling device runs.
 */
import { describe, it, expect } from 'vitest'
import type {
  NodeInferenceDevice,
  PipelineAddonSchema,
  PipelineSchema,
  StepSwitchCell,
  StepSwitchMatrix,
} from '@dominevo/types'
import { buildStepSwitchMatrix, type StepSwitchMatrixInput } from '../step-switch-matrix.js'

type Slot = PipelineAddonSchema['slot']

function step(opts: {
  readonly id: string
  readonly slot: Slot
  readonly inputClasses?: readonly string[]
  readonly formats: readonly string[]
  readonly enabledByDefault?: boolean
}): PipelineAddonSchema {
  return {
    id: opts.id,
    name: opts.id,
    slot: opts.slot,
    inputClasses: opts.inputClasses ?? [],
    outputClasses: [],
    childSlots: [],
    models: [
      {
        id: `${opts.id}-model`,
        name: `${opts.id}-model`,
        formats: Object.fromEntries(opts.formats.map((f) => [f, { downloaded: true, sizeMB: 1 }])),
      },
    ],
    defaultModelId: `${opts.id}-model`,
    defaultConfidence: 0.5,
    ...(opts.enabledByDefault !== undefined ? { enabledByDefault: opts.enabledByDefault } : {}),
  }
}

const CATALOG: PipelineSchema = {
  availableEngines: [],
  selectedEngine: { runtime: 'python', backend: 'cpu', format: 'onnx' },
  slots: [
    {
      id: 'detector',
      label: 'Detector',
      priority: 0,
      parentSlot: null,
      addons: [
        step({ id: 'object-detection', slot: 'detector', formats: ['onnx', 'openvino'] }),
        step({
          id: 'segmentation',
          slot: 'detector',
          formats: ['onnx', 'openvino'],
          enabledByDefault: false,
        }),
      ],
    },
    {
      id: 'cropper',
      label: 'Cropper',
      priority: 1,
      parentSlot: 'detector',
      addons: [
        // No openvino build: on the NPU it jumps to the CPU.
        step({
          id: 'face-detection',
          slot: 'cropper',
          inputClasses: ['person'],
          formats: ['onnx'],
        }),
      ],
    },
    {
      id: 'audio-classifier',
      label: 'Audio',
      priority: 4,
      parentSlot: null,
      addons: [step({ id: 'audio-classifier', slot: 'audio-classifier', formats: ['coreml'] })],
    },
  ],
}

function device(key: string, format: NodeInferenceDevice['format']): NodeInferenceDevice {
  return {
    key,
    backend: key.split(':')[0] ?? key,
    device: key.split(':')[1] ?? key,
    format,
    available: true,
    presence: 'present',
    enabled: true,
    weight: 1,
    maxSessions: null,
    defaultModelId: 'object-detection-model',
    exclusion: null,
  }
}

const NPU = 'openvino:npu'
const CPU = 'onnx:cpu'

function input(overrides: Partial<StepSwitchMatrixInput> = {}): StepSwitchMatrixInput {
  return {
    clusterModes: {},
    cameraToggles: [{}, {}],
    nodes: [
      {
        nodeId: 'hub',
        catalog: CATALOG,
        devices: [device(NPU, 'openvino'), device(CPU, 'onnx')],
        settings: undefined,
      },
    ],
    ...overrides,
  }
}

function cell(
  matrix: StepSwitchMatrix,
  stepId: string,
  deviceKey: string,
): StepSwitchCell | undefined {
  return matrix.steps
    .find((s) => s.stepId === stepId)
    ?.nodes[0]?.devices.find((d) => d.deviceKey === deviceKey)?.cell
}

describe('buildStepSwitchMatrix (D1065)', () => {
  it('an opt-in step no camera turned on is opt-in-unused, not on', () => {
    const matrix = buildStepSwitchMatrix(input())
    expect(matrix.steps.find((s) => s.stepId === 'segmentation')?.effectiveMode).toBe('opt-in')
    expect(cell(matrix, 'segmentation', NPU)).toEqual({ kind: 'opt-in-unused' })
  })

  it('an opt-in step a camera turned on is on where it runs', () => {
    const matrix = buildStepSwitchMatrix(input({ cameraToggles: [{ segmentation: true }, {}] }))
    expect(cell(matrix, 'segmentation', NPU)).toEqual({ kind: 'on' })
    expect(matrix.steps.find((s) => s.stepId === 'segmentation')?.camerasEnabling).toBe(1)
  })

  it('audio-classifier is never format-gated', () => {
    const matrix = buildStepSwitchMatrix(input())
    expect(cell(matrix, 'audio-classifier', NPU)).toEqual({ kind: 'on' })
  })

  it('a detail step the elected device cannot run jumps to the sibling that can', () => {
    const matrix = buildStepSwitchMatrix(input())
    expect(cell(matrix, 'face-detection', NPU)).toEqual({ kind: 'jump', toDeviceKey: CPU })
    expect(cell(matrix, 'face-detection', CPU)).toEqual({ kind: 'on' })
  })

  it('the cluster, node and device switches each name their layer', () => {
    const off = buildStepSwitchMatrix(input({ clusterModes: { 'face-detection': 'off' } }))
    expect(cell(off, 'face-detection', CPU)).toEqual({ kind: 'off-cluster' })

    const nodeOff = buildStepSwitchMatrix(
      input({
        nodes: [
          {
            nodeId: 'hub',
            catalog: CATALOG,
            devices: [device(NPU, 'openvino'), device(CPU, 'onnx')],
            settings: { stepEnabled: { 'face-detection': false } },
          },
        ],
      }),
    )
    expect(cell(nodeOff, 'face-detection', CPU)).toEqual({ kind: 'off-node' })

    const cpuOff = { ...device(CPU, 'onnx'), steps: { 'face-detection': { enabled: false } } }
    const deviceOff = buildStepSwitchMatrix(
      input({
        nodes: [
          {
            nodeId: 'hub',
            catalog: CATALOG,
            devices: [device(NPU, 'openvino'), cpuOff],
            settings: {
              inferenceDevices: {
                [CPU]: { enabled: true, steps: { 'face-detection': { enabled: false } } },
              },
            },
          },
        ],
      }),
    )
    expect(cell(deviceOff, 'face-detection', CPU)).toEqual({ kind: 'off-device' })
    // The NPU cannot run it and its only sibling switched it off.
    expect(cell(deviceOff, 'face-detection', NPU)).toEqual({ kind: 'off-device' })
  })

  it('a node that does not answer is unreachable, with no cells', () => {
    const matrix = buildStepSwitchMatrix(
      input({ nodes: [{ nodeId: 'agent', catalog: null, devices: null, settings: undefined }] }),
    )
    expect(matrix.steps).toEqual([])
  })
})
