import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import {
  WIDE_THUMBNAIL_ASPECT_H,
  WIDE_THUMBNAIL_ASPECT_W,
  wideCentralSquareLayout,
} from '../../shared/frame/wide-central-square-crop.js'
import type { DecodedFrame, FrameHandle, IScopedLogger } from '@camstack/types'
import {
  EventMediaDispatcher,
  type EventMediaDispatcherDeps,
  type TrackFrameTarget,
  type TrackSnapshotTarget,
} from '../services/event-media-dispatcher.js'

const noopLogger: IScopedLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
  withTags: () => noopLogger,
} as unknown as IScopedLogger

const handle: FrameHandle = {
  shmId: 'shm-1',
  seq: 1,
  width: 64,
  height: 36,
  nodeId: 'hub',
} as unknown as FrameHandle

/** A non-uniform RGB frame (a horizontal gradient) so the dispatcher's
 *  blank-frame guard passes and a real crop is produced. */
function gradientFrame(width: number, height: number): DecodedFrame {
  const data = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3
      data[i] = (x * 7) % 256
      data[i + 1] = (y * 11) % 256
      data[i + 2] = (x * y) % 256
    }
  }
  return { data, width, height, format: 'rgb', timestamp: 0 }
}

interface Put {
  ownerKind: string
  ownerId: string
  kind: string
}

function makeDeps(over: Partial<EventMediaDispatcherDeps> = {}): {
  deps: EventMediaDispatcherDeps
  puts: Put[]
} {
  const puts: Put[] = []
  const mediaStore = {
    put: async (p: Put) => {
      puts.push({ ownerKind: p.ownerKind, ownerId: p.ownerId, kind: p.kind })
      return `${p.ownerKind}:${p.ownerId}:${p.kind}`
    },
    putReplacing: async (p: Put) => {
      puts.push({ ownerKind: p.ownerKind, ownerId: p.ownerId, kind: p.kind })
      return `${p.ownerKind}:${p.ownerId}:${p.kind}`
    },
  }
  const deps: EventMediaDispatcherDeps = {
    getRemoteFrame: async () => gradientFrame(handle.width, handle.height),
    // Native miss → no native subject crop, no native full frame. Forces the
    // zero-native-media path where the raster fallback matters.
    getNativeCropJpeg: async () => null,
    getNativeFullFrameRgb: async () => null,
    // No parcel either (D422): the best shot cannot be written from anything.
    getParkedSubjectSlab: async () => null,
    mediaStore: mediaStore as unknown as EventMediaDispatcherDeps['mediaStore'],
    logger: noopLogger,
    ...over,
  }
  return { deps, puts }
}

const snapTarget = (over: Partial<TrackSnapshotTarget> = {}): TrackSnapshotTarget => ({
  trackId: 't1',
  timestamp: 1000,
  bbox: { x: 16, y: 9, w: 16, h: 12 },
  appendSnapshot: false,
  rollingLastFrame: false,
  bestThumbnail: true,
  keyFrame: 'skip',
  ...over,
})

const frameTarget = (over: Partial<TrackFrameTarget> = {}): TrackFrameTarget => ({
  trackId: 't1',
  timestamp: 1000,
  bbox: { x: 16, y: 9, w: 16, h: 12 },
  ...over,
})

describe('EventMediaDispatcher raster fallback — geometry', () => {
  /**
   * The last-resort raster preview and the REAL best-shot thumbnail must frame
   * the subject identically. They did not: the thumbnail used
   * `wideCentralSquareLayout` (16:9 canvas, central square = long side x1.2),
   * the fallback used `squareSafeCropRegionNormalized` (a square) — so the same
   * track looked like two different subjects depending on which path had
   * produced its preview, and every consumer sized for 16:9 letterboxed or cut
   * the square one.
   *
   * The geometry is now the SAME FUNCTION, not a second copy of the rule.
   */
  it('frames the subject on the same 16:9 window the thumbnail uses', async () => {
    const { deps } = makeDeps()
    const d = new EventMediaDispatcher(deps)
    const res = await d.captureForFrame({
      deviceId: 1,
      frameHandle: handle,
      events: [],
      trackFrames: [frameTarget()],
      snapshots: [],
      cropPadding: 0,
      rasterFallbackWantedTrackIds: new Set(['t1']),
    })
    const jpeg = res.rasterFallbacks[0]!.jpeg
    const meta = await sharp(jpeg).metadata()
    // The window the REAL thumbnail would have asked the native surface for.
    const layout = wideCentralSquareLayout(frameTarget().bbox, {
      W: handle.width,
      H: handle.height,
    })
    const expectedW = Math.round(layout.fetch.w * handle.width)
    const expectedH = Math.round(layout.fetch.h * handle.height)
    expect({ w: meta.width, h: meta.height }).toEqual({ w: expectedW, h: expectedH })
    // ...and the aspect a 16:9 consumer expects, as a consequence.
    expect((meta.width ?? 0) / (meta.height ?? 1)).toBeCloseTo(
      WIDE_THUMBNAIL_ASPECT_W / WIDE_THUMBNAIL_ASPECT_H,
      1,
    )
  })
})

describe('EventMediaDispatcher raster fallback', () => {
  it('retains a raster subject crop for a WANTED track when native media misses', async () => {
    const { deps } = makeDeps()
    const d = new EventMediaDispatcher(deps)
    const res = await d.captureForFrame({
      deviceId: 1,
      frameHandle: handle,
      events: [],
      trackFrames: [frameTarget()],
      snapshots: [],
      cropPadding: 0,
      rasterFallbackWantedTrackIds: new Set(['t1']),
    })
    expect(res.rasterFallbacks).toHaveLength(1)
    expect(res.rasterFallbacks[0]!.trackId).toBe('t1')
    expect(res.rasterFallbacks[0]!.timestamp).toBe(1000)
    expect(res.rasterFallbacks[0]!.jpeg.length).toBeGreaterThan(0)
    // It is NOT persisted here — the fallback is committed only at close-time.
  })

  it('produces NO raster fallback for a track that is not wanted', async () => {
    const { deps } = makeDeps()
    const d = new EventMediaDispatcher(deps)
    const res = await d.captureForFrame({
      deviceId: 1,
      frameHandle: handle,
      events: [],
      trackFrames: [frameTarget()],
      snapshots: [],
      cropPadding: 0,
      rasterFallbackWantedTrackIds: new Set(),
    })
    expect(res.rasterFallbacks).toHaveLength(0)
  })

  it('produces NO raster fallback when the wanted set is omitted (back-compat)', async () => {
    const { deps } = makeDeps()
    const d = new EventMediaDispatcher(deps)
    const res = await d.captureForFrame({
      deviceId: 1,
      frameHandle: handle,
      events: [],
      trackFrames: [frameTarget()],
      snapshots: [snapTarget()],
      cropPadding: 0,
    })
    expect(res.rasterFallbacks).toHaveLength(0)
  })

  it('emits at most ONE raster fallback per track across its targets in a frame', async () => {
    const { deps } = makeDeps()
    const d = new EventMediaDispatcher(deps)
    const res = await d.captureForFrame({
      deviceId: 1,
      frameHandle: handle,
      events: [],
      trackFrames: [frameTarget({ trackId: 't1' })],
      snapshots: [snapTarget({ trackId: 't1' })],
      cropPadding: 0,
      rasterFallbackWantedTrackIds: new Set(['t1']),
    })
    expect(res.rasterFallbacks).toHaveLength(1)
  })

  it('captures a raster fallback from a snapshot-only target too', async () => {
    const { deps } = makeDeps()
    const d = new EventMediaDispatcher(deps)
    const res = await d.captureForFrame({
      deviceId: 1,
      frameHandle: handle,
      events: [],
      trackFrames: [],
      snapshots: [snapTarget({ trackId: 't2', timestamp: 2000 })],
      cropPadding: 0,
      rasterFallbackWantedTrackIds: new Set(['t2']),
    })
    expect(res.rasterFallbacks.map((r) => r.trackId)).toEqual(['t2'])
  })

  // FIX B: a confirmed track can be observed WITHOUT any firstFrame/snapshot
  // target this frame (e.g. a resurrected track, or one whose firstFrame already
  // dropped). Its bbox arrives via `rasterFallbackCandidates` so it STILL gets a
  // last-resort raster crop — otherwise it renders a blank reel tile at close.
  it('captures a raster fallback from an extra candidate with NO firstFrame/snapshot target', async () => {
    const { deps } = makeDeps()
    const d = new EventMediaDispatcher(deps)
    const res = await d.captureForFrame({
      deviceId: 1,
      frameHandle: handle,
      events: [],
      trackFrames: [],
      snapshots: [],
      cropPadding: 0,
      rasterFallbackWantedTrackIds: new Set(['t9']),
      rasterFallbackCandidates: [
        { trackId: 't9', timestamp: 3000, bbox: { x: 16, y: 9, w: 16, h: 12 } },
      ],
    })
    expect(res.rasterFallbacks.map((r) => r.trackId)).toEqual(['t9'])
    expect(res.rasterFallbacks[0]!.timestamp).toBe(3000)
    expect(res.rasterFallbacks[0]!.jpeg.length).toBeGreaterThan(0)
  })

  it('does NOT emit an extra-candidate raster fallback for an id absent from the wanted set', async () => {
    const { deps } = makeDeps()
    const d = new EventMediaDispatcher(deps)
    const res = await d.captureForFrame({
      deviceId: 1,
      frameHandle: handle,
      events: [],
      trackFrames: [],
      snapshots: [],
      cropPadding: 0,
      rasterFallbackWantedTrackIds: new Set(),
      rasterFallbackCandidates: [
        { trackId: 't9', timestamp: 3000, bbox: { x: 16, y: 9, w: 16, h: 12 } },
      ],
    })
    expect(res.rasterFallbacks).toHaveLength(0)
  })

  it('prefers a target-derived bbox over an extra candidate for the same track (first wins)', async () => {
    const { deps } = makeDeps()
    const d = new EventMediaDispatcher(deps)
    const res = await d.captureForFrame({
      deviceId: 1,
      frameHandle: handle,
      events: [],
      trackFrames: [frameTarget({ trackId: 't1', timestamp: 1000 })],
      snapshots: [],
      cropPadding: 0,
      rasterFallbackWantedTrackIds: new Set(['t1']),
      // Same track also supplied as an extra candidate with a different ts — the
      // target-derived candidate precedes it, so exactly one fallback is emitted
      // stamped with the TARGET timestamp.
      rasterFallbackCandidates: [
        { trackId: 't1', timestamp: 9999, bbox: { x: 0, y: 0, w: 8, h: 8 } },
      ],
    })
    expect(res.rasterFallbacks).toHaveLength(1)
    expect(res.rasterFallbacks[0]!.timestamp).toBe(1000)
  })
})
