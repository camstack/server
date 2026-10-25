/**
 * Every log line about a camera carries `tags: { deviceId }`.
 *
 * Not a style rule. A miss rate, a media gap or a routing fault is ALWAYS asked
 * per camera ("why is 102 worse than 101?"), and a line that names the camera
 * only in its message text cannot be grouped by one. Two incidents in this repo
 * — a 22% thumbnail gap and a 3-hour media blackout — were diagnosed by
 * hand-correlating timestamps because the lines could not be grouped.
 *
 * The first case boots the addon and reads the real log. The rest are
 * source-shape assertions: the lines they cover fire on transitions an e2e
 * harness cannot reach cheaply (a tracker resurrection), and a missing tag is a
 * textual property of the call site, so a textual check is honest about what it
 * knows. Delete the line's message from the list when the line is deleted.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  FrameHandle,
  FrameResult,
  IEventBus,
  ObjectDetection,
  PipelineInferenceResultPayload,
} from '@camstack/types'
import { EventCategory, createEvent } from '@camstack/types'
import { bootAnalytics, type Booted } from './boot-analytics.js'

const DEVICE_ID = 101
const OWNER_NODE = 'agent-a'

const HANDLE: FrameHandle = {
  shmId: 'ring-101',
  slot: 1,
  seq: 5,
  width: 640,
  height: 480,
  format: 'rgb',
  pts: 1,
  byteLength: 640 * 480 * 3,
  nodeId: OWNER_NODE,
  slotCount: 8,
}

function detection(): ObjectDetection {
  return {
    id: 'd1',
    kind: 'first-level',
    macroClass: 'person',
    score: 0.9,
    labels: [],
    bbox: { x: 220, y: 160, width: 160, height: 160 },
  }
}

function emitInference(bus: IEventBus, timestamp: number, withSubject: boolean): void {
  const frame: FrameResult = {
    kind: 'frame',
    frameId: `f-${timestamp}`,
    deviceId: DEVICE_ID,
    timestamp,
    width: 640,
    height: 480,
    detections: withSubject ? [detection()] : [],
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

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The window of source after a log message, where its `tags` block must sit. */
function callSiteAfter(file: string, message: string): string {
  const source = readFileSync(path.join(SRC_ROOT, file), 'utf8')
  const at = source.indexOf(message)
  expect(at, `${message} — not found in ${file}`).toBeGreaterThan(-1)
  return source.slice(at, at + 400)
}

describe('device-scoped log lines carry tags.deviceId', () => {
  let booted: Booted | undefined
  afterEach(async () => {
    // Drain the fire-and-forget bus handlers before the teardown clears `_ctx`.
    await flush()
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it('the pinned-frame miss is a WARN naming the camera — the first half of the batch-loss pair', async () => {
    booted = await bootAnalytics(DEVICE_ID, async () => null)
    for (let i = 0; i < 4; i += 1) {
      emitInference(booted.bus.bus, 1_000 + i * 500, true)
      await flush()
    }

    const miss = booted.logs.find((l) =>
      l.message.includes('pinned-frame resolve missed (live window)'),
    )
    expect(miss).toBeDefined()
    // Was debug on the throw path and NOTHING at all on the null return, while
    // its pair (`capture batch lost`, carrying `pinned: false`) was a warn.
    expect(miss!.level).toBe('warn')
    expect(miss!.extras).toMatchObject({ tags: { deviceId: DEVICE_ID } })
  })

  it.each([
    ['pipeline-analytics/birth/birth-candidates.ts', "log.info('track resumed'"],
    ['pipeline-analytics/index.ts', "log.info('track lost'"],
    ['pipeline-analytics/pipeline/track-close.ts', "logger.info('track ended'"],
    [
      'pipeline-analytics/services/event-media-dispatcher.ts',
      "logger.warn('best-shot parcel missing",
    ],
    ['pipeline-analytics/pipeline/key-frame-persist.ts', "logger.error('key-frame parcel missing"],
    [
      'pipeline-analytics/runtime/parked-frame-client.ts',
      "logger.warn('track frame park refused by the owning node'",
    ],
  ])('%s — %s', (file, message) => {
    expect(callSiteAfter(file, message)).toContain('deviceId')
  })
})
