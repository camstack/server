/**
 * The booted addon re-judges a birth with the SESSION'S detector (D925) — the
 * root the frame was stamped with, on its device pool, pinned to its node —
 * and never with a node default. End to end through the event bus, the gate
 * and the `pipelineExecutor.runPipeline` call it really makes.
 */
import type {
  FrameHandle,
  FrameResult,
  IEventBus,
  ObjectDetection,
  PipelineInferenceResultPayload,
} from '@camstack/types'
import { createEvent, EventCategory } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { CONFIRMATION_CROP_MAX_WIDTH } from '../index.js'
import { type Booted, bootAnalytics } from './boot-analytics.js'
import {
  type FakeNativeCropRequest,
  type FakePipelineExecutor,
  type FakeRedetectAnswer,
  isFullFrameRequest,
} from './test-helpers.js'

const DEVICE_ID = 1439
const NODE = 'agent-b'
const HANDLE: FrameHandle = {
  shmId: 'ring-1439',
  slot: 0,
  seq: 2,
  width: 640,
  height: 480,
  format: 'rgb',
  pts: 1,
  byteLength: 640 * 480 * 3,
  nodeId: NODE,
  slotCount: 8,
}
const CORAL_ROOT = {
  rootStepId: 'object-detection',
  rootModelId: 'yolov9s-320-edgetpu',
  rootDeviceKey: 'edgetpu:usb',
} as const
const CROP_JPEG_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')

const PERSON: ObjectDetection = {
  id: 'p0',
  kind: 'first-level',
  macroClass: 'person',
  score: 0.5,
  labels: [],
  bbox: { x: 300, y: 200, width: 60, height: 160 },
}

function buildFrame(
  timestamp: number,
  detections: readonly ObjectDetection[],
  root: Partial<typeof CORAL_ROOT>,
): FrameResult {
  return {
    kind: 'frame',
    ...root,
    frameId: `f-${timestamp}`,
    deviceId: DEVICE_ID,
    timestamp,
    width: 640,
    height: 480,
    detections,
  }
}

function emitInference(bus: IEventBus, frame: FrameResult): void {
  const payload: PipelineInferenceResultPayload = {
    deviceId: DEVICE_ID,
    frame,
    nodeId: NODE,
    frameHandle: HANDLE,
  }
  bus.emit(
    createEvent(
      EventCategory.PipelineInferenceResult,
      { type: 'addon', id: 'pipeline-runner' },
      payload,
    ),
  )
}

async function flush(stepMs: number): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, stepMs))
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

function isConfirmationCropRequest(request: FakeNativeCropRequest): boolean {
  return !isFullFrameRequest(request) && request.maxWidth === CONFIRMATION_CROP_MAX_WIDTH
}

interface ExecutorCall {
  readonly input: unknown
  readonly opts: unknown
}

/** A Coral pool that holds the person at 0.45 — under the person floor (0.65), over the 0.4 bar. */
function coralExecutor(calls: ExecutorCall[]): FakePipelineExecutor {
  return {
    runPipeline: {
      mutate: async (input: unknown, opts?: unknown): Promise<FakeRedetectAnswer> => {
        calls.push({ input, opts })
        return {
          width: 320,
          height: 320,
          detections: [],
          discarded: [{ macroClass: 'person', score: 0.45, reason: 'below-threshold' }],
          rootModelId: CORAL_ROOT.rootModelId,
          rootDeviceKey: CORAL_ROOT.rootDeviceKey,
        }
      },
    },
  }
}

async function boot(calls: ExecutorCall[]): Promise<Booted> {
  return bootAnalytics(
    DEVICE_ID,
    async (request) => {
      if (!isConfirmationCropRequest(request)) return null
      return { jpeg: CROP_JPEG_BASE64, width: 320, height: 320, tier: 'native' as const }
    },
    { pipelineExecutor: coralExecutor(calls) },
  )
}

describe('the booted gate re-judges with the session detector (D925)', () => {
  let booted: Booted | undefined

  afterEach(async () => {
    await flush(1)
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it('asks the Coral model on the Coral pool on the frame node, and confirms at 0.45 over the 0.4 bar', async () => {
    const calls: ExecutorCall[] = []
    booted = await boot(calls)
    for (let i = 0; i < 6; i += 1) {
      emitInference(
        booted.bus.bus,
        buildFrame(1_000 + i * 100, [{ ...PERSON, id: `p${i}` }], CORAL_ROOT),
      )
      await flush(5)
    }
    expect(calls.length, 'the gate re-detected').toBeGreaterThan(0)
    expect(calls[0]!.input).toMatchObject({
      steps: [{ addonId: 'object-detection', modelId: 'yolov9s-320-edgetpu', enabled: true }],
      deviceKey: 'edgetpu:usb',
      deviceId: DEVICE_ID,
      plane: 'frame',
    })
    expect(JSON.stringify(calls[0]!.opts)).toContain(NODE)
    const confirmed = booted.logs.find(
      (line) => line.message === 'confirmation gate: birth confirmed',
    )
    expect(confirmed?.extras).toMatchObject({
      tags: { deviceId: DEVICE_ID },
      meta: {
        reason: 'confirmed',
        bestScore: 0.45,
        modelId: 'yolov9s-320-edgetpu',
        deviceKey: 'edgetpu:usb',
        node: NODE,
        attempts: 0,
        cropSource: 'native',
      },
    })
  }, 30_000)

  it('a frame that names no session detector asks no detector — the birth is deferred', async () => {
    const calls: ExecutorCall[] = []
    booted = await boot(calls)
    for (let i = 0; i < 6; i += 1) {
      emitInference(booted.bus.bus, buildFrame(1_000 + i * 100, [{ ...PERSON, id: `p${i}` }], {}))
      await flush(5)
    }
    expect(calls, 'no node default is ever asked').toEqual([])
    const undecided = booted.logs.find(
      (line) => line.message === 'confirmation gate: birth undecided',
    )
    expect(undecided?.extras).toMatchObject({
      tags: { deviceId: DEVICE_ID },
      meta: { reason: 'session-device-unavailable' },
    })
  }, 30_000)
})
