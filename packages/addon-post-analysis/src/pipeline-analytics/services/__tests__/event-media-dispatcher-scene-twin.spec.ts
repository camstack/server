/**
 * The CLEAN twin of every boxed timeline tile (D654).
 *
 * A notification rule asking for "Full frame" must receive the scene WITHOUT
 * the detection box. The only densely-written whole-scene kinds are the boxed
 * tiles (`firstFrame` / `snapshot` / `lastFrame`), so the dispatcher encodes a
 * `sceneFrame` from the SAME decoded surface in the same write — one extra
 * encode, no second fetch — and the notification ladder asks for it before the
 * annotated tile (`rule-engine.ts#framePreference`).
 *
 * The assertion that matters is byte-level: the twin IS the clean encode of the
 * surface the tile was drawn on. A twin that carried the tile's bytes (or any
 * box) would pass a "was something written" check and still ship a rectangle.
 */
import type { DecodedFrame, FrameHandle, IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { drawBoxedFrame } from '../../../shared/frame/box-drawer.js'
import { MEDIA_QUALITY } from '../../../shared/frame/media-quality.js'
import { type MediaPutInput, SINGLE_INSTANCE_KINDS } from '../../store/media-store.js'
import type {
  EventMediaDispatcherDeps,
  EventMediaWriter,
  TrackSnapshotTarget,
} from '../event-media-dispatcher.js'
import { EventMediaDispatcher } from '../event-media-dispatcher.js'

const FW = 64
const FH = 48
const NATIVE_W = 960
const NATIVE_H = 540

function nonUniformRgb(width: number, height: number): Buffer {
  const b = Buffer.allocUnsafe(width * height * 3)
  for (let i = 0; i < b.length; i++) b[i] = (i * 37) & 0xff
  return b
}

function frame(width: number, height: number): DecodedFrame {
  return { data: nonUniformRgb(width, height), width, height, format: 'rgb', timestamp: 0 }
}

const HANDLE: FrameHandle = {
  shmId: 'camstack.frames.cam-1.0',
  slot: 3,
  seq: 42,
  width: FW,
  height: FH,
  format: 'rgb',
  pts: 100,
  byteLength: FW * FH * 3,
  nodeId: 'node-a',
  slotCount: 16,
}

function logger(): IScopedLogger & { readonly warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn()
  return {
    error: vi.fn(),
    warn,
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
}

/** Every store call, in order — `put` and `putReplacing` alike. */
interface StoreOp {
  readonly op: 'put' | 'putReplacing'
  readonly input: MediaPutInput
}

interface Harness {
  readonly deps: EventMediaDispatcherDeps
  readonly puts: MediaPutInput[]
  readonly ops: StoreOp[]
  readonly log: ReturnType<typeof logger>
  readonly nativeFetch: ReturnType<typeof vi.fn>
}

function harness(
  opts: { native?: DecodedFrame | null; failKind?: MediaPutInput['kind'] } = {},
): Harness {
  const puts: MediaPutInput[] = []
  const ops: StoreOp[] = []
  let nextId = 1
  const log = logger()
  // A TYPED fake of exactly the operations the dispatcher performs: a method
  // it starts calling (a delete, a read) does not type-check here, which is
  // how the one-write-per-roll contract stays visible.
  const mediaStore: EventMediaWriter = {
    put: async (p) => {
      if (p.kind === opts.failKind) throw new Error('disk full')
      puts.push(p)
      ops.push({ op: 'put', input: p })
      return nextId++
    },
    putReplacing: async (p) => {
      puts.push(p)
      ops.push({ op: 'putReplacing', input: p })
      return nextId++
    },
  }
  const native = opts.native === undefined ? frame(NATIVE_W, NATIVE_H) : opts.native
  const nativeFetch = vi.fn(async (): Promise<DecodedFrame | null> => native)
  const deps: EventMediaDispatcherDeps = {
    getRemoteFrame: async () => frame(FW, FH),
    getNativeCropJpeg: async () => null,
    getNativeFullFrameRgb: nativeFetch,
    getParkedSubjectSlab: async () => null,
    mediaStore,
    logger: log,
  }
  return { deps, puts, ops, log, nativeFetch }
}

const BBOX = { x: 5, y: 5, w: 10, h: 10 }

function roll(
  trackId: string,
  timestamp: number,
  over: Partial<TrackSnapshotTarget> = {},
): TrackSnapshotTarget {
  return {
    trackId,
    timestamp,
    bbox: BBOX,
    appendSnapshot: false,
    rollingLastFrame: true,
    bestThumbnail: false,
    keyFrame: 'skip',
    ...over,
  }
}

/** The clean encode of the native surface — what the twin must BE. */
async function cleanNative(): Promise<Buffer> {
  const n = frame(NATIVE_W, NATIVE_H)
  return drawBoxedFrame(n.data, n.width, n.height, [], { quality: MEDIA_QUALITY })
}

describe('EventMediaDispatcher — the clean scene twin (D654)', () => {
  it('writes a clean sceneFrame beside the boxed firstFrame, same instant, same surface', async () => {
    const h = harness()
    const res = await new EventMediaDispatcher(h.deps).captureForFrame({
      deviceId: 101,
      frameHandle: HANDLE,
      events: [],
      trackFrames: [{ trackId: 't1', timestamp: 2000, bbox: BBOX, label: 'person' }],
      cropPadding: 0,
    })
    const tile = h.puts.find((p) => p.kind === 'firstFrame')
    const twin = h.puts.find((p) => p.kind === 'sceneFrame')
    expect(tile).toBeDefined()
    expect(twin).toMatchObject({
      ownerKind: 'track',
      ownerId: 't1',
      timestamp: 2000,
      deviceId: 101,
    })
    // The twin is the UNANNOTATED encode of the surface the tile was drawn on…
    expect(twin!.data.equals(await cleanNative())).toBe(true)
    // …and the tile is not (it carries the box).
    expect(tile!.data.equals(twin!.data)).toBe(false)
    // One native fetch serves both renderings.
    expect(h.nativeFetch).toHaveBeenCalledTimes(1)
    expect(res.firstFrameTrackIds).toEqual(['t1'])
  })

  it('on a native miss the twin is the clean ≤640 detection frame (never upscaled)', async () => {
    const h = harness({ native: null })
    await new EventMediaDispatcher(h.deps).captureForFrame({
      deviceId: 101,
      frameHandle: HANDLE,
      events: [],
      trackFrames: [{ trackId: 't1', timestamp: 2000, bbox: BBOX }],
      cropPadding: 0,
    })
    const twin = h.puts.find((p) => p.kind === 'sceneFrame')
    const det = frame(FW, FH)
    const clean = await drawBoxedFrame(det.data, FW, FH, [], {
      quality: MEDIA_QUALITY,
      maxWidth: 960,
    })
    expect(twin!.data.equals(clean)).toBe(true)
  })

  it('appends a twin beside every appended snapshot', async () => {
    const h = harness()
    await new EventMediaDispatcher(h.deps).captureForFrame({
      deviceId: 101,
      frameHandle: HANDLE,
      events: [],
      trackFrames: [],
      snapshots: [roll('t1', 5000, { appendSnapshot: true, rollingLastFrame: false })],
      cropPadding: 0,
    })
    const twin = h.puts.find((p) => p.kind === 'sceneFrame')
    expect(twin).toMatchObject({ ownerId: 't1', timestamp: 5000 })
    expect(twin!.data.equals(await cleanNative())).toBe(true)
  })

  it('writes the birth twin BEFORE its boxed tile — no instant has a tile without its twin', async () => {
    // The doorstep still-poll reads between writes: a tile stored first is a
    // window in which "Full frame" can only find the box.
    const h = harness()
    await new EventMediaDispatcher(h.deps).captureForFrame({
      deviceId: 101,
      frameHandle: HANDLE,
      events: [],
      trackFrames: [{ trackId: 't1', timestamp: 2000, bbox: BBOX }],
      cropPadding: 0,
    })
    expect(h.ops.map((o) => o.input.kind)).toEqual(['sceneFrame', 'firstFrame'])
  })

  it('writes the snapshot twin BEFORE its appended boxed snapshot', async () => {
    const h = harness()
    await new EventMediaDispatcher(h.deps).captureForFrame({
      deviceId: 101,
      frameHandle: HANDLE,
      events: [],
      trackFrames: [],
      snapshots: [roll('t1', 5000, { appendSnapshot: true, rollingLastFrame: false })],
      cropPadding: 0,
    })
    expect(h.ops.map((o) => o.input.kind)).toEqual(['sceneFrame', 'snapshot'])
  })

  it('the rolling lastFrame has a SINGLE-INSTANCE clean twin, written before the tile', async () => {
    const h = harness()
    await new EventMediaDispatcher(h.deps).captureForFrame({
      deviceId: 101,
      frameHandle: HANDLE,
      events: [],
      trackFrames: [],
      snapshots: [roll('t1', 3000)],
      cropPadding: 0,
    })
    expect(h.ops.map((o) => o.input.kind)).toEqual(['lastSceneFrame', 'lastFrame'])
    const twin = h.puts.find((p) => p.kind === 'lastSceneFrame')
    expect(twin).toMatchObject({ ownerId: 't1', timestamp: 3000 })
    expect(twin!.data.equals(await cleanNative())).toBe(true)
    // Single-instance in the store: one deterministic row and blob per track.
    expect(SINGLE_INSTANCE_KINDS.has('lastSceneFrame')).toBe(true)
  })

  it('a roll issues EXACTLY ONE store write for its twin — no read, no delete', async () => {
    // A roll fires every 2 s per live track; every extra op lands on the
    // synchronous sqlite-settings thread (D447). The typed fake exposes only
    // `put` / `putReplacing`, so a delete or read would not even compile.
    const h = harness()
    const d = new EventMediaDispatcher(h.deps)
    for (const ts of [3000, 5000, 7000]) {
      await d.captureForFrame({
        deviceId: 101,
        frameHandle: HANDLE,
        events: [],
        trackFrames: [],
        snapshots: [roll('t1', ts)],
        cropPadding: 0,
      })
    }
    const twinWrites = h.ops.filter((o) => o.input.kind === 'lastSceneFrame')
    expect(twinWrites.map((o) => [o.op, o.input.timestamp])).toEqual([
      ['put', 3000],
      ['put', 5000],
      ['put', 7000],
    ])
    expect(h.ops).toHaveLength(6) // three twins + three tiles, nothing else
  })

  it('a failed twin write does not cost the tile, and is said per camera', async () => {
    const h = harness({ failKind: 'sceneFrame' })
    const res = await new EventMediaDispatcher(h.deps).captureForFrame({
      deviceId: 101,
      frameHandle: HANDLE,
      events: [],
      trackFrames: [{ trackId: 't1', timestamp: 2000, bbox: BBOX }],
      cropPadding: 0,
    })
    expect(res.firstFrameTrackIds).toEqual(['t1'])
    const line = h.log.warn.mock.calls.find((c) => String(c[0]).includes('scene twin'))
    expect(line).toBeDefined()
    expect(line![1]).toMatchObject({ tags: { deviceId: 101 } })
  })
})
