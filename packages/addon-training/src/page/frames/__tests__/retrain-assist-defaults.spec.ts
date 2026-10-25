/**
 * The assist detector resolution — the page must ask the pipeline with the
 * model, threshold and node that camera REALLY uses, and must say so when it
 * cannot know them.
 *
 * Every case here is a shape measured on the live hub on 2026-09-16: camera 101
 * detects on `MacMiniAgent.localdomain` / `coreml:all`, whose elected detector
 * is `yolov9m-320` — not the `yolo26n` this page used to hard-code, which is
 * the CATALOG default and matches no enabled accelerator on that node.
 */
import type { CameraStatus, NodeInferenceDevice, PipelineSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  type AssistDetectorInput,
  type NodeInferenceDeviceSnapshot,
  resolveAssistDetector,
} from '../lib/retrain-assist-defaults'

const DETECTION: CameraStatus['detection'] = {
  nodeId: 'mac-mini',
  engine: { backend: 'coreml', device: 'all' },
  phase: 'active',
  configuredFps: 10,
  actualFps: 7.6,
  queueDepth: 0,
  avgInferenceMs: 38,
  provisioning: { state: 'ready' },
}

function status(patch?: Partial<CameraStatus>): CameraStatus {
  return {
    deviceId: 101,
    assignment: {
      detectionNodeId: 'mac-mini',
      decoderNodeId: 'mac-mini',
      audioNodeId: 'hub',
      sourceNodeId: 'hub',
      pinned: { detection: false, decoder: false, audio: false },
      reasons: {},
    },
    source: { streams: [] },
    broker: null,
    decoder: null,
    motion: null,
    detection: DETECTION,
    audio: null,
    recording: null,
    switchedOff: [],
    degraded: [],
    fetchedAt: 0,
    ...patch,
  }
}

const CORE_ML: NodeInferenceDevice = {
  key: 'coreml:all',
  backend: 'coreml',
  device: 'all',
  format: 'coreml',
  available: true,
  enabled: true,
  weight: 1,
  maxSessions: null,
  defaultModelId: 'yolov9m-320',
  exclusion: null,
}

function devices(patch?: Partial<NodeInferenceDeviceSnapshot>): NodeInferenceDeviceSnapshot {
  return { nodeId: 'mac-mini', reachable: true, devices: [CORE_ML], ...patch }
}

const SCHEMA: PipelineSchema = {
  availableEngines: [],
  selectedEngine: { runtime: 'python', backend: 'coreml', format: 'coreml' },
  slots: [
    {
      id: 'detector',
      label: 'Detector',
      priority: 0,
      parentSlot: null,
      addons: [
        {
          id: 'object-detection',
          name: 'Object Detection',
          slot: 'detector',
          inputClasses: [],
          outputClasses: ['person'],
          childSlots: [],
          models: [
            {
              id: 'yolov9m-320',
              name: 'YOLOv9m',
              formats: { coreml: { downloaded: true, sizeMB: 40 } },
            },
            { id: 'yolo26n', name: 'YOLO26n', formats: { onnx: { downloaded: true, sizeMB: 6 } } },
          ],
          defaultModelId: 'yolo26n',
          defaultConfidence: 0.5,
        },
      ],
    },
  ],
}

function input(patch?: Partial<AssistDetectorInput>): AssistDetectorInput {
  return {
    status: status(),
    nodeDevices: devices(),
    schema: SCHEMA,
    ...patch,
  }
}

describe('resolveAssistDetector', () => {
  it('answers with the node, model and threshold the camera really runs', () => {
    expect(resolveAssistDetector(input())).toEqual({
      kind: 'resolved',
      nodeId: 'mac-mini',
      modelId: 'yolov9m-320',
      minScore: 0.5,
    })
  })

  it("uses the RUNNING model's floor when the node reports one (D662)", () => {
    const schema: PipelineSchema = {
      ...SCHEMA,
      slots: SCHEMA.slots.map((slot) => ({
        ...slot,
        addons: slot.addons.map((addon) => ({
          ...addon,
          models: addon.models.map((m) =>
            m.id === 'yolov9m-320' ? { ...m, defaultConfidence: 0.35 } : m,
          ),
        })),
      })),
    }
    expect(resolveAssistDetector(input({ schema }))).toMatchObject({
      kind: 'resolved',
      modelId: 'yolov9m-320',
      minScore: 0.35,
    })
  })

  it('prefers the per-(node,device) base over the device election', () => {
    const based: NodeInferenceDevice = {
      ...CORE_ML,
      steps: { 'object-detection': { modelId: 'yolov9s-320' } },
    }
    const result = resolveAssistDetector(input({ nodeDevices: devices({ devices: [based] }) }))
    expect(result).toMatchObject({ kind: 'resolved', modelId: 'yolov9s-320' })
  })

  it('is pending — never a guess — while any of the three reads is unanswered', () => {
    for (const patch of [
      { status: undefined },
      { nodeDevices: undefined },
      { schema: undefined },
    ] satisfies readonly Partial<AssistDetectorInput>[]) {
      expect(resolveAssistDetector(input(patch))).toEqual({ kind: 'unknown', gap: 'pending' })
    }
  })

  it('a detection stage that could not be READ is not a camera without a detector', () => {
    const unread = status({
      detection: null,
      degraded: [{ stage: 'detection', reason: 'timeout', elapsedMs: 1200 }],
    })
    expect(resolveAssistDetector(input({ status: unread }))).toEqual({
      kind: 'unknown',
      gap: 'placement-unreadable',
    })
  })

  it('names a camera that runs no detector apart from one it could not read', () => {
    expect(resolveAssistDetector(input({ status: status({ detection: null }) }))).toEqual({
      kind: 'unknown',
      gap: 'detection-off',
    })
  })

  it('an unreachable node answers nothing about its devices', () => {
    const result = resolveAssistDetector(
      input({ nodeDevices: devices({ reachable: false, devices: [] }) }),
    )
    expect(result).toEqual({ kind: 'unknown', gap: 'node-unreachable' })
  })

  it('names the accelerator it could not find rather than substituting another', () => {
    const other: NodeInferenceDevice = { ...CORE_ML, key: 'cpu', backend: 'cpu', device: 'cpu' }
    expect(resolveAssistDetector(input({ nodeDevices: devices({ devices: [other] }) }))).toEqual({
      kind: 'unknown',
      gap: 'device-unknown',
    })
  })

  it('refuses when the node catalog carries no object-detection step', () => {
    const empty: PipelineSchema = { ...SCHEMA, slots: [] }
    expect(resolveAssistDetector(input({ schema: empty }))).toEqual({
      kind: 'unknown',
      gap: 'step-unknown',
    })
  })
})
