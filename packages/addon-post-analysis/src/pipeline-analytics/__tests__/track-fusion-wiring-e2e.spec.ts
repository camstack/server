/**
 * D683 Task 18: the fusion service's WIRING, through the booted addon. The
 * service's own order is pinned in `track-fusion-service.spec.ts`; this proves
 * `index.ts` hands it every collaborator — the residents (and through them the
 * parked-frame client), the track store, the lifecycle, the live state, the
 * closer's pre-persist sweep-up, the tracker on a refusal — and that a real L2
 * fusion leaves ONE track behind on both the sweep and the frame path.
 *
 * Disarms (each alone, restored):
 *  - `applyTrackFusions`: drop the `this.trackFusion.fuse(...)` call:
 *    "a silent camera's fusion leaves one track" fails (no `track fused`);
 *  - `emitFusedEnd`: emit nothing: "…one track" fails on the lifecycle `end`;
 *  - `trackStore.adopt` → `false`: "…one track" fails (the absorbed row stays);
 *  - residents `onAdopt` → no `parkedFrames.adopt` (T17 M4): "…one track"
 *    fails on the survivor's parcel read;
 *  - the closer's `beforePersist`: drop it: "the survivor's close sweeps up…"
 *    fails;
 *  - residents `onLateAbsorbedWork`: log nothing (T17 M4): "the survivor's
 *    close sweeps up…" fails on its last assertion;
 *  - `onRefused`: drop `processor.dropTrack`: "a fusion naming a deleted
 *    survivor is refused…" fails; drop the tape `onDrop`: same test fails;
 *  - `liveState.forget`: drop the `lastActiveTrackIds` delete: "a frame-path
 *    fusion…" fails (a spurious `track lost` for the absorbed id);
 *  - `bestShotHolder` → always the survivor: "the survivor's close sweeps
 *    up…" fails (the sweep ranks by the holder the residents name);
 *  - `onShutdown`: drop `await this.settleTrackFusions()`: "addon stop awaits
 *    the queued fusion re-points…" fails;
 *  - the frame path: drop the `applyTrackFusions` call: "a frame-path
 *    fusion…" fails;
 *  - (fix round 1 M1, review DB1) `applyTrackFusions` as a sequential
 *    `for … await` instead of `map` + `allSettled`: "two fusions of ONE
 *    frame…" fails.
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
import { FrameState } from '../frame/frame-state.js'
import type PipelineAnalyticsAddon from '../index.js'
import type { FrameProcessor } from '../pipeline/frame-processor.js'
import { TrackFusionService } from '../pipeline/track-fusion-service.js'
import { TrackResidentState } from '../pipeline/track-resident-state.js'
import { TrackerSweep } from '../pipeline/tracker-sweep.js'
import type { TrackFusion } from '../pipeline/tracker-v2/index.js'
import { TrackStore } from '../store/track-store.js'
import { type Booted, bootAnalytics, type LogLine } from './boot-analytics.js'
import { sighting } from './track-store-test-helpers.js'

const DEVICE_ID = 101
const HANDLE: FrameHandle = {
  shmId: 'ring-101',
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

function person(id: string, x: number, score = 0.9): ObjectDetection {
  return {
    id,
    kind: 'first-level',
    macroClass: 'person',
    score,
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

function metaOf(line: LogLine): Record<string, unknown> {
  const meta: unknown =
    typeof line.extras === 'object' && line.extras !== null
      ? Reflect.get(line.extras, 'meta')
      : null
  return typeof meta === 'object' && meta !== null ? { ...meta } : {}
}

function trackStartedIds(booted: Booted): string[] {
  return booted.logs
    .filter((l) => l.message === 'track started')
    .map((l) => metaOf(l)['trackId'])
    .filter((id): id is string => typeof id === 'string')
}

function linesNamed(booted: Booted, message: string): LogLine[] {
  return booted.logs.filter((l) => l.message === message)
}

function processorOf(addon: PipelineAnalyticsAddon): FrameProcessor {
  const frameState = Reflect.get(addon, 'frameState')
  const processors = frameState instanceof FrameState ? frameState.processors : undefined
  if (!(processors instanceof Map)) throw new Error('no processors map')
  const p: FrameProcessor | undefined = processors.get(`${DEVICE_ID}:pipeline`)
  if (p === undefined) throw new Error('no processor for the camera')
  return p
}

function trackStoreOf(addon: PipelineAnalyticsAddon): TrackStore {
  const store: unknown = Reflect.get(addon, 'trackStore')
  if (!(store instanceof TrackStore)) throw new Error('no track store')
  return store
}

function residentsOf(addon: PipelineAnalyticsAddon): TrackResidentState {
  const residents: unknown = Reflect.get(addon, 'residents')
  if (!(residents instanceof TrackResidentState)) throw new Error('no residents')
  return residents
}

async function runTrackerSweep(addon: PipelineAnalyticsAddon, wallNow: number): Promise<void> {
  const sweeper: unknown = Reflect.get(addon, 'trackerSweep')
  if (!(sweeper instanceof TrackerSweep)) throw new Error('no tracker sweep')
  await sweeper.run(wallNow)
}

async function sweepExpiredTracks(addon: PipelineAnalyticsAddon): Promise<void> {
  const sweep: unknown = Reflect.get(addon, 'sweepExpiredTracks')
  if (typeof sweep !== 'function') throw new Error('no sweepExpiredTracks')
  await sweep.call(addon)
}

async function fetchParkedParcel(addon: PipelineAnalyticsAddon, trackId: string): Promise<unknown> {
  // The parcel fetch lives on the addon's media capture (`media/frame-media-capture.ts`).
  const capture: unknown = Reflect.get(addon, 'mediaCapture')
  if (typeof capture !== 'object' || capture === null) throw new Error('no mediaCapture')
  const fetch: unknown = Reflect.get(capture, 'fetchParkedParcel')
  if (typeof fetch !== 'function') throw new Error('no fetchParkedParcel')
  const out: unknown = await fetch.call(capture, trackId, 'keyFrame')
  return out
}

/** The lifecycle `end` events the addon emitted, as `{ trackId, fusedIntoTrackId }`. */
interface EndSeen {
  readonly trackId: unknown
  readonly fusedIntoTrackId: unknown
}

function lifecycleEnds(booted: Booted): EndSeen[] {
  const out: EndSeen[] = []
  for (const e of booted.bus.captured) {
    if (e.category !== EventCategory.PipelineAnalyticsTrackLifecycle) continue
    const data: unknown = e.data
    if (typeof data !== 'object' || data === null) continue
    if (Reflect.get(data, 'phase') !== 'end') continue
    out.push({
      trackId: Reflect.get(data, 'trackId'),
      fusedIntoTrackId: Reflect.get(data, 'fusedIntoTrackId'),
    })
  }
  return out
}

/**
 * A walks 5 frames; 1.9 s later a second piece appears beside it and stands
 * 1.2 s; then the camera goes silent — L2's commit comes from the silence
 * sweep. A's parks are REFUSED, so the only parcel the subject owns is the
 * absorbed piece's: a survivor that reads one at all reads it through the
 * adoption.
 */
async function bootSilentScene(): Promise<{ booted: Booted; first: string; second: string }> {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_000)
  const booted = await bootAnalytics(DEVICE_ID, async () => null, {
    parking: {
      park: async (req) =>
        req.timestamp < 3_000
          ? { kind: 'refused', reason: 'handle-gone', handleAgeMs: 0 }
          : { kind: 'parked' },
    },
  })
  for (let i = 0; i < 5; i += 1) {
    vi.setSystemTime(1_000 + i * 130)
    emit(booted.bus.bus, 1_000 + i * 130, [person('a', 100 + i * 5)])
    await flush()
  }
  for (let t = 3_420; t <= 4_590; t += 130) {
    vi.setSystemTime(t)
    emit(booted.bus.bus, t, [person('b', 230, 0.97)])
    await flush()
  }
  const [first, second] = trackStartedIds(booted)
  if (first === undefined || second === undefined) throw new Error('both pieces were born')
  return { booted, first, second }
}

/** Run ONLY the tracker's silence sweep (no closer) until L2 commits. */
async function sweepUntilFused(booted: Booted): Promise<number> {
  for (let w = 6_000; w <= 31_000; w += 5_000) {
    vi.setSystemTime(w)
    await runTrackerSweep(booted.addon, w)
    await flush()
    if (linesNamed(booted, 'track fused').length > 0) return w
  }
  throw new Error('L2 never fused the two pieces')
}

describe('the fusion service in the booted addon (D683 Task 18)', () => {
  let booted: Booted | undefined

  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    await flush()
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it("a silent camera's fusion leaves one track: one INFO line, the absorbed `end`, one row, one parcel", async () => {
    const scene = await bootSilentScene()
    booted = scene.booted
    const { first, second } = scene
    await sweepUntilFused(booted)

    const [fused] = linesNamed(booted, 'track fused')
    expect(fused?.level).toBe('info')
    expect(fused?.extras).toMatchObject({
      tags: { deviceId: DEVICE_ID },
      meta: { survivorId: first, absorbedId: second, absorbedHadRow: true, rowMerged: true },
    })
    // The absorbed piece ENDS, saying where the subject went.
    expect(lifecycleEnds(booted)).toContainEqual({ trackId: second, fusedIntoTrackId: first })
    // One row: the absorbed one folded into the survivor.
    const store = trackStoreOf(booted.addon)
    expect(store.rowState(first)).toBe('active')
    expect(store.rowState(second)).toBe('none')
    // T17 M4: the survivor's parcel read reaches the absorbed piece's parcel.
    booted.parcelReads.length = 0
    const parcel = await fetchParkedParcel(booted.addon, first)
    expect(booted.parcelReads).toContainEqual({
      deviceId: DEVICE_ID,
      trackId: second,
      kind: 'keyFrame',
    })
    expect(parcel).not.toBeNull()
  })

  it('addon stop awaits the queued fusion re-points before the stores go, and says when it gives up', async () => {
    const scene = await bootSilentScene()
    booted = scene.booted
    await sweepUntilFused(booted)
    const service: unknown = Reflect.get(booted.addon, '_trackFusion')
    if (!(service instanceof TrackFusionService)) throw new Error('no fusion service built')
    // A re-point that never settles: the bounded wait gives up and says so.
    const settled = vi.spyOn(service, 'settledAll').mockReturnValue(new Promise<void>(() => {}))
    const addon = booted.addon
    booted = undefined
    await addon.shutdown()
    expect(settled).toHaveBeenCalledTimes(1)
    expect(
      scene.booted.logs.some(
        (l) =>
          l.level === 'warn' &&
          l.message === 'track fusion re-points still queued at shutdown — left unsettled',
      ),
    ).toBe(true)
  })

  it("the survivor's close sweeps up the absorbed id, closes it to late writers, and late resident work under it is said", async () => {
    const scene = await bootSilentScene()
    booted = scene.booted
    const { first, second } = scene
    const fusedAt = await sweepUntilFused(booted)
    const residents = residentsOf(booted.addon)
    // The sweep-up asks the residents which shot is current NOW.
    const holder = vi.spyOn(residents, 'currentBestShotHolder')
    const store = trackStoreOf(booted.addon)
    for (
      let w = fusedAt;
      w <= fusedAt + 120_000 && store.rowState(first) !== 'closed';
      w += 5_000
    ) {
      vi.setSystemTime(w)
      await sweepExpiredTracks(booted.addon)
      await flush()
    }
    expect(store.rowState(first)).toBe('closed')
    const swept = linesNamed(booted, 'track fusion swept up')
    expect(swept.map((l) => l.extras)).toContainEqual(
      expect.objectContaining({
        tags: { deviceId: DEVICE_ID },
        meta: expect.objectContaining({ survivorId: first, members: [second] }),
      }),
    )
    expect(holder).toHaveBeenCalledWith(first)
    // From the survivor's close on, a write under the absorbed id is refused.
    expect(store.rowClosedAt(second)).toBeDefined()
    // T17 M4: late resident work under the absorbed id is refused AND said.
    residents.markKeyFrameLanded(DEVICE_ID, second)
    const late = linesNamed(booted, 'track resident: late work after close refused')
    expect(late.map((l) => l.extras)).toContainEqual(
      expect.objectContaining({
        tags: { deviceId: DEVICE_ID },
        meta: expect.objectContaining({ trackId: second, survivorId: first }),
      }),
    )
  })

  it('a fusion naming a deleted survivor is refused, and the tracker drops the chain (review 2 M6, T16 S2)', async () => {
    const scene = await bootSilentScene()
    booted = scene.booted
    const { first } = scene
    // The operator deletes the survivor before L2 commits.
    await booted.addon.deleteTracks({ deviceId: DEVICE_ID, trackIds: [first] })
    expect(trackStoreOf(booted.addon).rowState(first)).toBe('closed')
    const dropped = vi.spyOn(processorOf(booted.addon), 'dropTrack')
    const drops: unknown[] = []
    Reflect.set(booted.addon, 'tapeRecorder', {
      onFusion: () => undefined,
      onDrop: (input: unknown) => drops.push(input),
      isArmed: () => false,
    })
    let refused: LogLine | undefined
    for (let w = 6_000; w <= 31_000 && refused === undefined; w += 5_000) {
      vi.setSystemTime(w)
      await runTrackerSweep(booted.addon, w)
      await flush()
      refused = booted.logs.find((l) => l.message.startsWith('track fusion refused'))
    }
    Reflect.set(booted.addon, 'tapeRecorder', null)
    expect(refused?.level).toBe('warn')
    expect(refused?.extras).toMatchObject({
      tags: { deviceId: DEVICE_ID },
      meta: { reason: 'survivor-closed', survivorId: first },
    })
    expect(dropped).toHaveBeenCalledWith(first, 'dropped')
    expect(drops).toContainEqual(
      expect.objectContaining({ deviceId: DEVICE_ID, trackId: first, reason: 'dropped' }),
    )
    expect(linesNamed(booted, 'track fused')).toHaveLength(0)
  })

  it('two fusions of ONE frame have both merged their rows when `applyTrackFusions` returns (review M1)', async () => {
    booted = await bootAnalytics(DEVICE_ID, async () => null)
    const store = trackStoreOf(booted.addon)
    for (const [id, t, x] of [
      ['A', 1_000, 100],
      ['B', 7_000, 130],
      ['C', 8_000, 160],
      ['P', 1_000, 300],
      ['Q', 7_000, 330],
      ['R', 8_000, 360],
    ] as const) {
      store.upsert(sighting(id, t, x, { deviceId: DEVICE_ID }))
    }
    const fusion = (survivorId: string, absorbedId: string): TrackFusion => ({
      survivorId,
      absorbedId,
      members: [absorbedId],
      t: 9_000,
      cost: 0.3,
      gapMs: 1_000,
    })
    const apply: unknown = Reflect.get(booted.addon, 'applyTrackFusions')
    if (typeof apply !== 'function') throw new Error('no applyTrackFusions')
    // A shared survivor (A←B, A←C) and a chain (Q←R, then P←Q), as L2 can
    // commit them on one frame. NOT awaited: the frame path does not await it,
    // and its upsert runs right after this call returns.
    const pending: unknown = apply.call(booted.addon, DEVICE_ID, `${DEVICE_ID}:pipeline`, [
      fusion('A', 'B'),
      fusion('A', 'C'),
      fusion('Q', 'R'),
      fusion('P', 'Q'),
    ])
    expect(['B', 'C', 'Q', 'R'].map((id) => store.rowState(id))).toEqual([
      'none',
      'none',
      'none',
      'none',
    ])
    expect(store.membersOf('A')).toEqual(['B', 'C'])
    expect(store.membersOf('P')).toEqual(['Q', 'R'])
    await pending
    await flush()
  })

  it('a frame-path fusion merges before the frame lands, with no spurious `track lost` for the absorbed id', async () => {
    booted = await bootAnalytics(DEVICE_ID, async () => null)
    // A walks, 8 s of silence, then B beside A's last box — the commit lands
    // on a FRAME (A.lastSeen + 10 s) while B keeps being seen.
    for (const t of [1_000, 1_100, 1_200, 1_300]) {
      emit(booted.bus.bus, t, [person('d1', 100)])
      await flush()
    }
    for (let t = 9_300; t <= 14_500; t += 100) {
      emit(booted.bus.bus, t, [person('d2', 160)])
      await flush()
    }
    // A's birth was deferred (no crop) but its row exists; B is the piece
    // whose birth ran. L2 commits B into A on a frame.
    const [fused] = linesNamed(booted, 'track fused')
    expect(fused?.extras).toMatchObject({
      tags: { deviceId: DEVICE_ID },
      meta: { absorbedHadRow: true, survivorHadRow: true, rowMerged: true },
    })
    const first = fused === undefined ? undefined : metaOf(fused)['survivorId']
    const second = fused === undefined ? undefined : metaOf(fused)['absorbedId']
    if (typeof first !== 'string' || typeof second !== 'string') throw new Error('no fusion')
    expect(trackStartedIds(booted)).toContain(second)
    const lost = linesNamed(booted, 'track lost').filter((l) => metaOf(l)['trackId'] === second)
    expect(lost).toHaveLength(0)
    // The survivor's row holds the absorbed piece's sightings from BEFORE the
    // commit — the row merge, not just the frames after it.
    const row = trackStoreOf(booted.addon).getActiveByTrack(first)
    expect(row?.positions.some((p) => p.timestamp >= 9_300 && p.timestamp < 10_000)).toBe(true)
    expect(trackStoreOf(booted.addon).rowState(second)).toBe('none')
  })
})
