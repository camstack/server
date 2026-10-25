/**
 * Every buffered face keeps the FULL frame it was detected on (D644).
 *
 * Pinned here:
 *  - nothing happens unless `keepSourceFrames` is on (default OFF);
 *  - a track parks at most once per `FACE_SOURCE_PARK_MIN_INTERVAL_MS`, and a
 *    face that is not parked keeps the frame of the previous park;
 *  - the frame is TAKEN and stored only when the face is buffered, one per
 *    face; a parcel of another instant is refused;
 *  - the track's own keyFrame of the same instant is referenced, not parked;
 *  - a dropped face moves no byte, every close releases the parcel, and the
 *    per-camera stats count parks, reuses, stores and drops.
 */
import type { FrameHandle } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { FaceRecognizer, type FaceStoreInsertInput } from '../face-recognizer.js'
import { FACE_DEFAULTS, FACE_SOURCE_PARK_MIN_INTERVAL_MS } from '../face-settings.js'
import {
  FaceSourceFrameKeeper,
  type FaceSourceFramePort,
  type FaceSourceMediaPut,
  type FaceSourceParcel,
  type FaceSourceParkOrder,
  type HeldFaceGeometry,
  scaleGeometryTo,
  shouldParkSource,
  type TrackKeyFrameParcel,
} from '../face-source-frame.js'
import { FaceSourceStats } from '../face-source-stats.js'
import { mergeSilentLogger } from './test-helpers.js'
import type { TrackedDetectionOut } from '../pipeline/frame-processor.js'

function handle(seq: number): FrameHandle {
  return {
    shmId: 'shm',
    slot: 0,
    seq,
    width: 640,
    height: 360,
    format: 'rgb',
    pts: seq,
    byteLength: 1,
    nodeId: 'hub',
    slotCount: 4,
  }
}

const LANDMARKS = [
  { x: 105, y: 60 },
  { x: 115, y: 60 },
  { x: 110, y: 66 },
  { x: 106, y: 72 },
  { x: 114, y: 72 },
]

const geometry = (timestamp: number): HeldFaceGeometry => ({
  timestamp,
  bbox: { x: 100, y: 50, w: 20, h: 30 },
  landmarks: LANDMARKS,
  frameWidth: 640,
  frameHeight: 360,
})

interface PortFake {
  readonly port: FaceSourceFramePort
  readonly parks: FaceSourceParkOrder[]
  readonly takes: string[]
  readonly released: string[]
  readonly keyFrames: Map<string, TrackKeyFrameParcel>
  parcels: Map<string, FaceSourceParcel>
}

function portFake(): PortFake {
  const f: PortFake = {
    parks: [],
    takes: [],
    released: [],
    keyFrames: new Map(),
    parcels: new Map(),
    port: {
      park: (order) => {
        f.parks.push(order)
        f.parcels.set(order.trackId, {
          jpeg: Buffer.from(`frame@${order.geometry.timestamp}`),
          width: 3840,
          height: 2160,
          timestamp: order.geometry.timestamp,
        })
      },
      take: async (_deviceId, trackId) => {
        f.takes.push(trackId)
        return f.parcels.get(trackId) ?? null
      },
      release: (trackId) => {
        f.released.push(trackId)
      },
      adopt: () => {},
      trackKeyFrame: (trackId) => f.keyFrames.get(trackId),
    },
  }
  return f
}

interface MediaFake {
  readonly puts: FaceSourceMediaPut[]
  readonly trackKeyFrames: Map<string, { mediaId: number; timestamp: number }>
  readonly media: {
    put(i: FaceSourceMediaPut): Promise<number>
    trackKeyFrame(trackId: string): Promise<{ mediaId: number; timestamp: number } | null>
  }
}

function mediaFake(): MediaFake {
  let next = 900
  const m: MediaFake = {
    puts: [],
    trackKeyFrames: new Map(),
    media: {
      put: async (input) => {
        m.puts.push(input)
        return next++
      },
      trackKeyFrame: async (trackId) => m.trackKeyFrames.get(trackId) ?? null,
    },
  }
  return m
}

const logger = { info: vi.fn(), warn: vi.fn() }

describe('FaceSourceFrameKeeper', () => {
  it('scales the detection-frame box and landmarks onto the stored frame', () => {
    const scaled = scaleGeometryTo(geometry(1), 3840, 2160)
    expect(scaled.bbox).toEqual({ x: 600, y: 300, w: 120, h: 180 })
    expect(scaled.landmarks?.[0]).toEqual({ x: 630, y: 360 })
  })

  it('the park interval: first park always, then only once the interval has passed', () => {
    expect(FACE_SOURCE_PARK_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(2_000)
    expect(shouldParkSource(undefined, 100, 2_000)).toBe(true)
    expect(shouldParkSource(100, 2_099, 2_000)).toBe(false)
    expect(shouldParkSource(100, 2_100, 2_000)).toBe(true)
  })

  it('stores ONE frame per face — two faces of one instant store two', async () => {
    const p = portFake()
    const m = mediaFake()
    const keeper = new FaceSourceFrameKeeper({
      port: p.port,
      media: m.media,
      stats: new FaceSourceStats(),
      logger,
    })
    const a = keeper.park({
      deviceId: 101,
      trackId: 'a',
      frameHandle: handle(1),
      geometry: geometry(1000),
    })
    const b = keeper.park({
      deviceId: 101,
      trackId: 'b',
      frameHandle: handle(1),
      geometry: geometry(1000),
    })
    await keeper.persist({ deviceId: 101, trackId: 'a', faceId: 'face-a', source: a })
    await keeper.persist({ deviceId: 101, trackId: 'b', faceId: 'face-b', source: b })
    expect(m.puts.map((x) => x.ownerId)).toEqual(['face-a', 'face-b'])
  })

  it('REFUSES a parcel of another instant, says so with the camera, and counts it', async () => {
    const p = portFake()
    const m = mediaFake()
    const warn = vi.fn()
    const stats = new FaceSourceStats()
    const keeper = new FaceSourceFrameKeeper({
      port: p.port,
      media: m.media,
      stats,
      logger: { info: vi.fn(), warn },
    })
    keeper.park({ deviceId: 101, trackId: 'a', frameHandle: handle(1), geometry: geometry(1000) })
    const stored = await keeper.persist({
      deviceId: 101,
      trackId: 'a',
      faceId: 'face-a',
      source: { geometry: geometry(2000), mode: 'parked' },
    })
    expect(stored).toBeNull()
    expect(m.puts).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(
      'face: buffered WITHOUT its source frame',
      expect.objectContaining({ tags: { deviceId: 101 } }),
    )
    expect(stats.snapshot()[0]?.dropped).toEqual({ 'wrong-instant': 1 })
  })

  it('REUSES the track keyFrame of the same instant: no park, no new blob', async () => {
    const p = portFake()
    const m = mediaFake()
    const stats = new FaceSourceStats()
    p.keyFrames.set('a', { timestamp: 1000, width: 3840, height: 2160 })
    m.trackKeyFrames.set('a', { mediaId: 77, timestamp: 1000 })
    const keeper = new FaceSourceFrameKeeper({ port: p.port, media: m.media, stats, logger })
    const source = keeper.park({
      deviceId: 101,
      trackId: 'a',
      frameHandle: handle(1),
      geometry: geometry(1000),
    })
    expect(source.mode).toBe('track-keyframe')
    expect(p.parks).toHaveLength(0)
    const stored = await keeper.persist({ deviceId: 101, trackId: 'a', faceId: 'face-a', source })
    expect(stored?.mediaId).toBe(77)
    expect(stored?.bbox).toEqual({ x: 600, y: 300, w: 120, h: 180 })
    expect(m.puts).toHaveLength(0)
    expect(stats.snapshot()[0]).toMatchObject({ keyFrameReuses: 1, storedTrackKeyFrame: 1 })
  })

  it('a reused keyFrame that MOVED to another instant is not referenced', async () => {
    const p = portFake()
    const m = mediaFake()
    p.keyFrames.set('a', { timestamp: 1000, width: 3840, height: 2160 })
    m.trackKeyFrames.set('a', { mediaId: 77, timestamp: 5000 })
    const keeper = new FaceSourceFrameKeeper({
      port: p.port,
      media: m.media,
      stats: new FaceSourceStats(),
      logger,
    })
    const source = keeper.park({
      deviceId: 101,
      trackId: 'a',
      frameHandle: handle(1),
      geometry: geometry(1000),
    })
    expect(
      await keeper.persist({ deviceId: 101, trackId: 'a', faceId: 'face-a', source }),
    ).toBeNull()
  })
})

// ── the recognizer ──────────────────────────────────────────────────────────

const SETTINGS = {
  ...FACE_DEFAULTS,
  enabled: true,
  confirmFrames: 2,
  minFacePx: 0,
  recognitionMinFacePx: 0,
  minIdentitySamples: 1,
  keepSourceFrames: true,
}

function candidate(trackId: string, confidence: number): TrackedDetectionOut {
  return {
    trackId,
    className: 'face',
    confidence,
    bbox: { x: 0, y: 0, w: 300, h: 300 },
    faceBbox: { x: 100, y: 50, w: 20, h: 30 },
    faceLandmarks: LANDMARKS,
    zones: [],
    state: 'moving',
    matchedThisFrame: true,
    settling: false,
    confirmed: true,
    embedding: [1, 0, 0],
    embeddingModelId: 'auraface-r100',
    faceAlignedCrop: Buffer.from('aligned').toString('base64'),
  }
}

interface RecHarness {
  readonly rec: FaceRecognizer
  readonly p: PortFake
  readonly m: MediaFake
  readonly stats: FaceSourceStats
  readonly inserted: FaceStoreInsertInput[]
}

function recognizer(): RecHarness {
  const p = portFake()
  const m = mediaFake()
  const stats = new FaceSourceStats()
  const inserted: FaceStoreInsertInput[] = []
  const rec = new FaceRecognizer({
    identityStore: { loadGallery: async () => [], listIdentities: async () => [] },
    faceStore: {
      insert: async (face) => {
        inserted.push(face)
      },
    },
    mediaStore: { put: async () => 501 },
    trackStore: { applyLabelCandidate: async () => null },
    eventStore: { projectTrackLabel: async () => 0 },
    captureCrop: async () => Buffer.from('crop'),
    faceSourceFrames: new FaceSourceFrameKeeper({ port: p.port, media: m.media, stats, logger }),
    logger: mergeSilentLogger({
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      child: () => {
        throw new Error('unused')
      },
    }),
  })
  return { rec, p, m, stats, inserted }
}

async function frame(
  h: RecHarness,
  timestamp: number,
  confidence: number,
  settings = SETTINGS,
  trackId = 't1',
) {
  await h.rec.processFrame({
    deviceId: 101,
    timestamp,
    frameWidth: 640,
    frameHeight: 360,
    tracked: [candidate(trackId, confidence)],
    settings,
    cropPadding: 0,
    frameHandle: handle(timestamp),
  })
}

describe('FaceRecognizer — the source frame of a buffered face (D644)', () => {
  it('OFF by default: no park, no take, no frame on the row', async () => {
    expect(FACE_DEFAULTS.keepSourceFrames).toBe(false)
    const h = recognizer()
    await frame(h, 100, 0.9, { ...SETTINGS, keepSourceFrames: false })
    await h.rec.onTrackEnd(101, 't1')
    expect(h.p.parks).toHaveLength(0)
    expect(h.p.takes).toHaveLength(0)
    expect(h.inserted[0]?.sourceFrameMediaId).toBeUndefined()
  })

  it('parks at most once per interval; the row keeps the LAST PARKED frame', async () => {
    const h = recognizer()
    await frame(h, 100, 0.6)
    await frame(h, 600, 0.8) // a new best inside the interval: NOT parked
    await frame(h, 3_000, 0.9) // interval passed: parked
    await frame(h, 3_500, 0.95) // inside again: not parked
    expect(h.p.parks.map((o) => o.geometry.timestamp)).toEqual([100, 3_000])
    expect(h.m.puts).toHaveLength(0) // nothing stored while the track lives

    await h.rec.onTrackEnd(101, 't1')
    expect(h.m.puts).toHaveLength(1)
    expect(h.m.puts[0]?.timestamp).toBe(3_000)
    const row = h.inserted[0]
    expect(row?.sourceFrameMediaId).toBe(900)
    expect(row?.sourceFrameBbox).toEqual({ x: 600, y: 300, w: 120, h: 180 })
    expect(row?.sourceFrameLandmarks).toHaveLength(5)
    expect(h.p.released).toEqual(['t1'])
    expect(h.stats.snapshot()[0]).toMatchObject({ parks: 2, tracksParked: 1, parksPerTrackMax: 2 })
  })

  it('a face that is DROPPED at close moves no byte, and the parcel is still released', async () => {
    const h = recognizer()
    const noCrop = candidate('t2', 0.9)
    await h.rec.processFrame({
      deviceId: 101,
      timestamp: 100,
      frameWidth: 640,
      frameHeight: 360,
      tracked: [{ ...noCrop, faceAlignedCrop: undefined, faceBbox: undefined }],
      settings: SETTINGS,
      cropPadding: 0,
    })
    await h.rec.onTrackEnd(101, 't2')
    expect(h.inserted).toHaveLength(0)
    expect(h.p.takes).toEqual([])
    expect(h.m.puts).toHaveLength(0)
    expect(h.p.released).toEqual(['t2'])
  })
})
