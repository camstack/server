/**
 * D683 §6.4 (review C2/M2): `index.ts` wires `TrackerSweep.canClose` into the
 * `TrackCloser` it builds (`canClose: (t) => this.trackerSweep.canClose(t,
 * Date.now())`) — the ONE production gate, asked in the processor's own frame
 * clock. `track-close-gate.spec.ts` pins the STORE-level behaviour given a
 * gate shaped like this; this spec is the only one that pins the ACTUAL WIRE
 * in `index.ts`, through the booted addon — the brief's own unit test says
 * its wiring disarm is "not unit-visible" from inside the store, which is
 * exactly the gap this file closes.
 *
 * Disarms (each alone, restored — in `index.ts`'s `TrackCloser` construction):
 *  - drop the `canClose` field entirely: "the closer consults the tracker's
 *    canClose gate before closing a row" fails (the spy is never called AND
 *    the row closes on the first sweep regardless of the spy's answer);
 *  - replace it with `canClose: () => true`: the same test fails the same way
 *    (the spy is never consulted, so gating it `false` has no effect).
 *
 * Review L1/L2: no casts (an `instanceof TrackStore` guard, and a thrown
 * narrow on `trackId` instead of `as`); the spy assertion checks the EXACT
 * args (`{ deviceId, trackId }`, the real wall clock) rather than merely
 * "called".
 */
import type {
  FrameHandle,
  FrameResult,
  IEventBus,
  ObjectDetection,
  PipelineInferenceResultPayload,
} from '@camstack/types'
import { createEvent, EventCategory } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type PipelineAnalyticsAddon from '../index.js'
import { TrackerSweep } from '../pipeline/tracker-sweep.js'
import { TrackStore } from '../store/track-store.js'
import { type Booted, bootAnalytics } from './boot-analytics.js'

const DEVICE_ID = 921
const HANDLE: FrameHandle = {
  shmId: 'ring-921',
  slot: 0,
  seq: 2,
  width: 640,
  height: 480,
  format: 'rgb',
  pts: 1,
  byteLength: 640 * 480 * 3,
  nodeId: 'hub',
  slotCount: 8,
}

function person(id: string, x: number): ObjectDetection {
  return {
    id,
    kind: 'first-level',
    macroClass: 'person',
    score: 0.9,
    labels: [],
    bbox: { x, y: 100, width: 60, height: 150 },
  }
}

function emit(bus: IEventBus, timestamp: number, detections: readonly ObjectDetection[]): void {
  const frame: FrameResult = {
    kind: 'frame',
    frameId: `f-${timestamp}`,
    deviceId: DEVICE_ID,
    timestamp,
    width: 640,
    height: 480,
    detections,
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

function trackStartedIds(booted: Booted): string[] {
  const out: string[] = []
  for (const line of booted.logs) {
    if (line.message !== 'track started') continue
    const meta: unknown =
      typeof line.extras === 'object' && line.extras !== null
        ? Reflect.get(line.extras, 'meta')
        : null
    const id: unknown =
      typeof meta === 'object' && meta !== null ? Reflect.get(meta, 'trackId') : null
    if (typeof id === 'string') out.push(id)
  }
  return out
}

async function sweepExpiredTracks(addon: PipelineAnalyticsAddon): Promise<void> {
  const sweep: unknown = Reflect.get(addon, 'sweepExpiredTracks')
  if (typeof sweep !== 'function') throw new Error('no sweepExpiredTracks')
  await sweep.call(addon)
}

describe("index.ts wires the tracker's canClose into the track closer (D683 Task 16)", () => {
  let booted: Booted | undefined

  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    await flush()
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it('the closer consults the tracker sweep before closing a row past its TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000)
    booted = await bootAnalytics(DEVICE_ID, async () => null)
    // Enough sightings for the confirmation gate to settle the birth — a
    // shorter run leaves it deferred and nothing named "track started" ever
    // logs (the gate has no crop source in this harness).
    for (let i = 0; i < 10; i += 1) {
      vi.setSystemTime(1_000 + i * 130)
      emit(booted.bus.bus, 1_000 + i * 130, [person('a', 100 + i * 5)])
      await flush()
    }
    const [trackId] = trackStartedIds(booted)
    if (trackId === undefined) throw new Error('a track was never born')

    const sweeper: unknown = Reflect.get(booted.addon, 'trackerSweep')
    if (!(sweeper instanceof TrackerSweep)) throw new Error('trackerSweep not built')
    const canClose = vi.spyOn(sweeper, 'canClose').mockReturnValue(false)

    // Well past the store's own TTL (30 s default) so `expireStale` reaches
    // its `canClose` check on every candidate — any wiring gap shows here.
    vi.setSystemTime(45_000)
    await sweepExpiredTracks(booted.addon)
    // Not just "called" (review L2): the SAME clock the closer was wired
    // with (`Date.now()`, not a frame timestamp `frameNow` would still have
    // to convert) and the row actually held.
    expect(canClose, 'the gate was actually asked, with the real wall clock').toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: DEVICE_ID, trackId }),
      45_000,
    )

    const trackStore: unknown = Reflect.get(booted.addon, 'trackStore')
    if (!(trackStore instanceof TrackStore)) throw new Error('trackStore not built')
    expect(
      trackStore.getActiveByTrack(trackId),
      'the gate said no — the row must still be open',
    ).not.toBeNull()

    canClose.mockReturnValue(true)
    await sweepExpiredTracks(booted.addon)
    expect(trackStore.getActiveByTrack(trackId), 'the gate said yes — the row closes').toBeNull()
  })
})
