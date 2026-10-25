/**
 * The snapshot rollback, END TO END through the booted addon.
 *
 * `snapshot-rollback.spec.ts` proves the TrackStore gives an interval back. It
 * proves nothing about whether the frame loop ever ASKS it to — and that is the
 * shape of this defect and of the last two like it in this file's neighbourhood
 * (a correct key-frame decision function nobody consulted; a media-kind ladder
 * where four rungs advanced their bookkeeping from the ids that persisted and
 * the fifth did not). So this boots the real addon, makes every capture fail the
 * way production fails, and reads the addon's own log.
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
import { SNAPSHOT_MAX_ROLLBACKS } from '../pipeline/snapshot-retry.js'
import type { FakeEventBus } from './test-helpers.js'

const DEVICE_ID = 102
const OWNER_NODE = 'agent-a'
/** The addon's own default; a snapshot becomes due this long after the seed. */
const SNAPSHOT_INTERVAL_MS = 5_000

const HANDLE: FrameHandle = {
  shmId: 'ring-102',
  slot: 0,
  seq: 2,
  width: 640,
  height: 480,
  format: 'rgb',
  pts: 1,
  byteLength: 640 * 480 * 3,
  nodeId: OWNER_NODE,
  slotCount: 8,
}

/** A subject that MOVES, so the periodic gate's movement test is satisfied. */
function detection(x: number): ObjectDetection {
  return {
    id: 'd1',
    kind: 'first-level',
    macroClass: 'person',
    score: 0.9,
    labels: [],
    bbox: { x, y: 160, width: 120, height: 160 },
  }
}

function buildFrame(timestamp: number, x: number): FrameResult {
  return {
    kind: 'frame',
    frameId: `f-${timestamp}`,
    deviceId: DEVICE_ID,
    timestamp,
    width: 640,
    height: 480,
    detections: [detection(x)],
  }
}

function emitInference(bus: IEventBus, timestamp: number, x: number): void {
  const payload: PipelineInferenceResultPayload = {
    deviceId: DEVICE_ID,
    frame: buildFrame(timestamp, x),
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

/**
 * Drive the camera long enough for several snapshot intervals to elapse, with
 * the subject walking across the frame so the movement gate keeps passing.
 *
 * A bridging frame lands half-way through every step: tracker v2 ends a track
 * whose coast budget (`maxMissedMs`, 4 s) ran out, and a step longer than that
 * would make every frame a new, never-confirmed piece (D683). The bridge is
 * not due a snapshot of its own, so each step still re-decides one.
 */
async function driveFrames(bus: FakeEventBus, count: number, stepMs: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    emitInference(bus.bus, 1_000 + i * stepMs, 100 + i * 25)
    await flush()
    emitInference(bus.bus, 1_000 + i * stepMs + stepMs / 2, 112 + i * 25)
    await flush()
  }
}

function snapshotDropLines(booted: Booted): { intervalReturned: boolean }[] {
  return booted.logs
    .filter((l) => l.level === 'warn' && l.message === 'snapshot capture did not land')
    .map((l) => {
      const extras = l.extras as { meta?: { intervalReturned?: boolean } }
      return { intervalReturned: extras.meta?.intervalReturned === true }
    })
}

describe('snapshot rollback, end to end', () => {
  let booted: Booted | undefined

  afterEach(async () => {
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it('returns the interval when the capture batch loses the frame — and SAYS it did', async () => {
    // Every fetch misses: the cold-lease / recycled-handle shape that aborts the
    // whole capture batch. `storedSnapshots` comes back empty.
    booted = await bootAnalytics(DEVICE_ID, async () => null, {
      // The periodic filmstrip snapshot is DEBUG media as of the
      // `debugMediaEnabled` flip; this whole file is about that snapshot's
      // rollback, so the camera has to be in debug.
      deviceSettings: { debugMediaEnabled: true },
    })
    await driveFrames(booted.bus, 12, SNAPSHOT_INTERVAL_MS + 1_000)

    const drops = snapshotDropLines(booted)
    // The branch used to be silent — 197 snapshots per 3 h were found by counting
    // rows, not by reading logs.
    expect(drops.length).toBeGreaterThan(0)
    // …and at least one of them gave the interval back rather than spending it.
    expect(drops.some((d) => d.intervalReturned)).toBe(true)
  })

  it('carries the deviceId tag — a media gap is always asked per camera', async () => {
    booted = await bootAnalytics(DEVICE_ID, async () => null, {
      // The periodic filmstrip snapshot is DEBUG media as of the
      // `debugMediaEnabled` flip; this whole file is about that snapshot's
      // rollback, so the camera has to be in debug.
      deviceSettings: { debugMediaEnabled: true },
    })
    await driveFrames(booted.bus, 12, SNAPSHOT_INTERVAL_MS + 1_000)

    const line = booted.logs.find(
      (l) => l.level === 'warn' && l.message === 'snapshot capture did not land',
    )
    expect(line).toBeDefined()
    expect(line!.extras).toMatchObject({ tags: { deviceId: DEVICE_ID } })
  })

  it('concedes the slot after a bounded run — a dead camera never retries per frame', async () => {
    booted = await bootAnalytics(DEVICE_ID, async () => null, {
      // The periodic filmstrip snapshot is DEBUG media as of the
      // `debugMediaEnabled` flip; this whole file is about that snapshot's
      // rollback, so the camera has to be in debug.
      deviceSettings: { debugMediaEnabled: true },
    })
    // Frames one interval apart: every one of them re-decides a snapshot, so an
    // unbounded rollback would return the interval on all of them.
    await driveFrames(booted.bus, 24, SNAPSHOT_INTERVAL_MS + 200)

    const returned = snapshotDropLines(booted).filter((d) => d.intervalReturned).length
    expect(returned).toBeGreaterThan(0)
    expect(returned).toBeLessThanOrEqual(SNAPSHOT_MAX_ROLLBACKS)
  })
})
