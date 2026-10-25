/**
 * A key-frame capture that is RUNNING when the addon shuts down must settle
 * without touching the torn-down context.
 *
 * `onShutdown` clears the capture scheduler's QUEUED requests; a request
 * already executing keeps going, and when its parcel read finally returned it
 * called `redeemPendingPreview` -> `this.ctx`, which throws outside the
 * initialized window. The rejection was `void`-ed, so it surfaced as an
 * unhandled error attributed to whichever spec happened to be running (CI red
 * on main, `device-log-tags.spec.ts`) - and in production as a runner-wide
 * unhandled rejection with no device on it.
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
import { encodeRgbCropToJpeg } from '../../shared/frame/encode-crop.js'
import { bootAnalytics, type Booted } from './boot-analytics.js'
import {
  isFullFrameRequest,
  isKeyFrameRequest,
  type FakeNativeCropReply,
  type FakeNativeCropRequest,
} from './test-helpers.js'

const DEVICE_ID = 4
const SKIP_MESSAGE = 'key-frame capture settled after shutdown'

const HANDLE: FrameHandle = {
  shmId: 'ring-4',
  slot: 0,
  seq: 2,
  width: 640,
  height: 480,
  format: 'rgb',
  pts: 1,
  byteLength: 640 * 480 * 3,
  nodeId: 'alice-laptop',
  slotCount: 8,
}

function detection(): ObjectDetection {
  return {
    id: 'd1',
    kind: 'first-level',
    macroClass: 'person',
    score: 0.9,
    labels: [],
    bbox: { x: 220, y: 160, width: 200, height: 160 },
  }
}

function emitInference(bus: IEventBus, timestamp: number): void {
  const frame: FrameResult = {
    kind: 'frame',
    frameId: `f-${timestamp}`,
    deviceId: DEVICE_ID,
    timestamp,
    width: 640,
    height: 480,
    detections: [detection()],
  }
  const payload: PipelineInferenceResultPayload = {
    deviceId: DEVICE_ID,
    frame,
    nodeId: 'hub',
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

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise<void>((r) => setTimeout(r, 1))
    await new Promise<void>((r) => setImmediate(r))
  }
}

let resolveJpegBase64 = ''
async function resolveOnly(request: FakeNativeCropRequest): Promise<FakeNativeCropReply | null> {
  if (!isFullFrameRequest(request) || isKeyFrameRequest(request)) return null
  if (resolveJpegBase64 === '') {
    const rgb = Buffer.allocUnsafe(64 * 48 * 3)
    for (let i = 0; i < rgb.length; i += 1) rgb[i] = (i * 37) & 0xff
    resolveJpegBase64 = (await encodeRgbCropToJpeg(rgb, 64, 48)).toString('base64')
  }
  return { jpeg: resolveJpegBase64, width: 64, height: 48, tier: 'ram-fullframe' }
}

describe('a key-frame capture running across shutdown', () => {
  let booted: Booted | undefined
  afterEach(async () => {
    await flush()
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it('settles with one skip log and no context access', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)

    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let keyFrameReadStarted = false
    try {
      booted = await bootAnalytics(DEVICE_ID, resolveOnly, {
        parking: {
          parcelRead: async (read) => {
            if (read.kind === 'keyFrame') {
              keyFrameReadStarted = true
              await gate
            }
            return 'held'
          },
        },
      })
      for (let i = 0; i < 12; i += 1) {
        emitInference(booted.bus.bus, 1_000 + i * 1_000)
        await flush()
      }
      // A loaded host can lag the async chain behind the frames: wait for the
      // read itself, bounded, instead of assuming it happened.
      for (let i = 0; i < 200 && !keyFrameReadStarted; i += 1) await flush()
      expect(keyFrameReadStarted, 'the key-frame capture is in flight').toBe(true)

      // Shut down WHILE the capture exec is parked on its parcel read.
      await booted.addon.shutdown()
      release?.()
      // The capture settles asynchronously after the read is released; on a
      // loaded host one flush is not enough for its continuation to log. Wait,
      // bounded, for the skip line — if it never comes the assertion below fails.
      const logs = booted.logs
      const skipped = (): number => logs.filter((l) => l.message.includes(SKIP_MESSAGE)).length
      for (let i = 0; i < 200 && skipped() === 0; i += 1) await flush()
      await flush()

      expect(unhandled).toEqual([])
      expect(booted.logs.filter((l) => l.message.includes(SKIP_MESSAGE))).toHaveLength(1)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
