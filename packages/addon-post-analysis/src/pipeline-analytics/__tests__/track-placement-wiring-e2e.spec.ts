/**
 * The REAL addon, fed by the bus: a track's opened / closed placement comes
 * from the inference payload's `nodeId` and the frame's `rootDeviceKey` /
 * `rootModelId`, and the detail read (`getTrack`) returns both.
 *
 * The store spec (`track-store-placement.spec.ts`) proves the store keeps what
 * it is given; this one proves production GIVES it — the payload's node is the
 * one value only `handleInferenceResult` holds, and a store spec cannot see a
 * caller that forgot to pass it.
 *
 * Disarm: pass `''` instead of `data.nodeId` to `processFrame` — both
 * assertions fail (no placement at all).
 */
import { afterEach, describe, expect, it } from 'vitest'
import type {
  FrameHandle,
  FrameResult,
  IEventBus,
  ObjectDetection,
  PipelineInferenceResultPayload,
} from '@camstack/types'
import { EventCategory, createEvent } from '@camstack/types'
import { bootAnalytics, type Booted } from './boot-analytics.js'

const DEVICE_ID = 959

interface Placed {
  readonly nodeId: string
  readonly deviceKey: string
  readonly modelId: string
}

const HUB_NPU: Placed = { nodeId: 'hub', deviceKey: 'openvino:npu', modelId: 'yolo26n' }
const AGENT_CORAL: Placed = {
  nodeId: 'agent-b',
  deviceKey: 'edgetpu:pci',
  modelId: 'yolov8n-tflite',
}

function person(x: number): ObjectDetection {
  return {
    id: 'p',
    kind: 'first-level',
    macroClass: 'person',
    score: 0.9,
    labels: [],
    bbox: { x, y: 100, width: 60, height: 150 },
  }
}

function emit(bus: IEventBus, timestamp: number, x: number, on: Placed): void {
  const handle: FrameHandle = {
    shmId: `ring-${String(DEVICE_ID)}`,
    slot: 0,
    seq: 2,
    width: 640,
    height: 480,
    format: 'rgb',
    pts: 1,
    byteLength: 640 * 480 * 3,
    nodeId: on.nodeId,
    slotCount: 8,
  }
  const frame: FrameResult = {
    kind: 'frame',
    frameId: `f-${String(timestamp)}`,
    deviceId: DEVICE_ID,
    timestamp,
    width: 640,
    height: 480,
    detections: [person(x)],
    rootModelId: on.modelId,
    rootDeviceKey: on.deviceKey,
  }
  const payload: PipelineInferenceResultPayload = {
    deviceId: DEVICE_ID,
    frame,
    nodeId: on.nodeId,
    frameHandle: handle,
  }
  bus.emit(
    createEvent(
      EventCategory.PipelineInferenceResult,
      { type: 'addon', id: 'pipeline-runner' },
      payload,
    ),
  )
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise<void>((r) => setTimeout(r, 1))
    await new Promise<void>((r) => setImmediate(r))
  }
}

function startedTrackId(booted: Booted): string | undefined {
  for (const line of booted.logs) {
    if (line.message !== 'track started') continue
    const meta: unknown =
      typeof line.extras === 'object' && line.extras !== null
        ? Reflect.get(line.extras, 'meta')
        : null
    const id: unknown =
      typeof meta === 'object' && meta !== null ? Reflect.get(meta, 'trackId') : null
    if (typeof id === 'string') return id
  }
  return undefined
}

describe('track placement — from the inference payload to the detail read', () => {
  let booted: Booted | undefined

  afterEach(async () => {
    await flush()
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it('a track born on the hub NPU and last seen on the agent Coral reports both', async () => {
    booted = await bootAnalytics(DEVICE_ID, async () => null)
    let t = 1_000
    for (let i = 0; i < 10; i += 1) {
      emit(booted.bus.bus, t, 100 + i * 5, i < 5 ? HUB_NPU : AGENT_CORAL)
      await flush()
      t += 130
    }
    const trackId = startedTrackId(booted)
    if (trackId === undefined) throw new Error('the track never started')

    const track = await booted.addon.getTrack({ deviceId: DEVICE_ID, trackId })
    expect(track?.openedPlacement).toEqual(HUB_NPU)
    expect(track?.closedPlacement).toEqual(AGENT_CORAL)
  })
})
