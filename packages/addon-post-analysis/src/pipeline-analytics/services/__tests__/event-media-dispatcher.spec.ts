/**
 * `EventMediaDispatcher` — produces track + enrichment media FROM the decoded
 * detection-pipeline frame (resolved via the runner's native surface), REPLACING
 * the device-snapshot thumbnailer.
 *
 * Persisted-kind set (2026-07-21 native-media rework):
 *  - Object events write ONLY the enrichment child crops (`faceCrop`/`plateCrop`)
 *    — the retired `crop`/`fullFrame`/`fullFrameBoxed` kinds are NO LONGER
 *    produced (old stored tracks keep reading them; the enum is unchanged).
 *  - The boxed timeline tiles (`firstFrame`/`snapshot`/`lastFrame`) — each with a
 *    clean `sceneFrame` twin from the same surface (D654) — are cut from
 *    the NATIVE full frame downscaled to 960 with ONLY the track's own box burned
 *    in; a native miss falls back to the ≤640 detection frame (honest lower res,
 *    NEVER an upscale) with a `logger.warn`.
 *  - The best-shot subject crop is a 16:9 CENTRAL-SQUARE window (subject in the
 *    middle square, lateral scene context) persisted in TWO variants from ONE
 *    native fetch: `thumbnail` (uncapped native window) and `thumbnailSmall` (the
 *    same window downscaled to a 480 long side / 480×270 for fast reel/list
 *    loading) — native-or-nothing (a miss skips both).
 */
import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import type { DecodedFrame, FrameHandle, IScopedLogger } from '@camstack/types'
import { EventMediaDispatcher } from '../event-media-dispatcher.js'
import type { EventMediaDispatcherDeps, ParkedSubjectSlab } from '../event-media-dispatcher.js'
import type { MediaPutInput } from '../../store/media-store.js'
import { deliveredWideCentralSquareLayout } from '../../../shared/frame/wide-central-square-crop.js'

const FW = 64
const FH = 48

/** Deterministic media ROW id (D482) for a fixture LABEL — not a real rowid,
 *  just a stable, non-zero number a test can assert back against for the
 *  same label. */
function mediaIdFor(label: string): number {
  let hash = 0
  for (const ch of label) hash = (hash * 31 + ch.charCodeAt(0)) % 100_000
  return hash + 1000
}

/** A real solid-colour JPEG of the given size — the runner's native subject crop
 *  is a genuine JPEG (the `thumbnailSmall` derivation runs sharp over it). */
async function makeJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 120, b: 200 } },
  })
    .jpeg({ quality: 88 })
    .toBuffer()
}

/** The native subject-crop bytes the runner returns on a hit — a real >480 JPEG
 *  so the composed 16:9 `thumbnail` window downscales to `thumbnailSmall`. */
const DEFAULT_NATIVE_JPEG = await makeJpeg(1600, 1600)

function makeHandle(overrides: Partial<FrameHandle> = {}): FrameHandle {
  return {
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
    ...overrides,
  }
}

/** A deterministic NON-uniform RGB buffer — every channel spans a wide range so
 *  the dispatcher's blank/uniform-frame guard treats it as a real frame. A solid
 *  fill (the old `Buffer.alloc(..., 0xaa)`) is now skipped as a degenerate crop. */
function nonUniformRgb(width: number, height: number): Buffer {
  const b = Buffer.allocUnsafe(width * height * 3)
  for (let i = 0; i < b.length; i++) b[i] = (i * 37) & 0xff
  return b
}

function makeFrame(overrides: Partial<DecodedFrame> = {}): DecodedFrame {
  return {
    data: nonUniformRgb(FW, FH),
    width: FW,
    height: FH,
    format: 'rgb',
    timestamp: 100,
    ...overrides,
  }
}

/** The native full frame the runner returns for the boxed timeline tiles —
 *  ALREADY downscaled worker-side to ≤ 960 long side. Default 960×540. */
function makeNativeFrame(width = 960, height = 540): DecodedFrame {
  return {
    data: nonUniformRgb(width, height),
    width,
    height,
    format: 'rgb',
    timestamp: 0,
  }
}

function makeLogger(): IScopedLogger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as IScopedLogger
}

function makeDeps(
  frame: DecodedFrame | null,
  getNativeCropJpeg: EventMediaDispatcherDeps['getNativeCropJpeg'] = vi.fn(
    async () => DEFAULT_NATIVE_JPEG,
  ),
  getNativeFullFrameRgb: EventMediaDispatcherDeps['getNativeFullFrameRgb'] = vi.fn(async () =>
    makeNativeFrame(),
  ),
  getRemoteFrame?: EventMediaDispatcherDeps['getRemoteFrame'],
  getParkedSubjectSlab: EventMediaDispatcherDeps['getParkedSubjectSlab'] = vi.fn(async () =>
    parkedSlab({ x: 5, y: 5, w: 10, h: 10 }),
  ),
): {
  deps: EventMediaDispatcherDeps
  puts: MediaPutInput[]
  replaces: MediaPutInput[]
  readRes: DecodedFrame | null
} {
  const puts: MediaPutInput[] = []
  const replaces: MediaPutInput[] = []
  const mediaStore = {
    put: vi.fn(async (p: MediaPutInput) => {
      puts.push(p)
      return mediaIdFor(`key:${p.ownerId}:${p.kind}:${p.timestamp}`)
    }),
    putReplacing: vi.fn(async (p: MediaPutInput) => {
      replaces.push(p)
      return mediaIdFor(`rkey:${p.ownerId}:${p.kind}`)
    }),
  } as unknown as EventMediaDispatcherDeps['mediaStore']
  // Post-shm (2026-07-16): a handle is ALWAYS resolved via `getRemoteFrame`
  // (the runner's full-frame `getNativeCrop`, routed by `handle.nodeId`) — no
  // local shm read. Subject crops come from `getNativeCropJpeg`
  // (native-or-nothing); the boxed timeline tiles from `getNativeFullFrameRgb`.
  const deps: EventMediaDispatcherDeps = {
    getRemoteFrame: getRemoteFrame ?? vi.fn(async () => frame),
    getNativeCropJpeg,
    getNativeFullFrameRgb,
    // The best-shot `thumbnail` reads the track's PARKED slab (D422) — the
    // subject window cut by the runner at the best instant — never a handle.
    getParkedSubjectSlab,
    mediaStore,
    logger: makeLogger(),
  }
  return { deps, puts, replaces, readRes: frame }
}

/** The parked slab a runner would have cut for `bbox` at the best instant:
 *  a JPEG sized to the layout's window at NATIVE_SCALE, with the layout the
 *  hub kept beside it. */
const NATIVE_SCALE = 80
async function parkedSlab(
  bbox: { x: number; y: number; w: number; h: number },
  timestamp = 100,
): Promise<ParkedSubjectSlab> {
  const layout = deliveredWideCentralSquareLayout(bbox, { W: FW, H: FH })
  const slab = await makeJpeg(
    Math.max(1, Math.round(layout.fetch.w * FW * NATIVE_SCALE)),
    Math.max(1, Math.round(layout.fetch.h * FH * NATIVE_SCALE)),
  )
  return { slab, layout, timestamp }
}

describe('EventMediaDispatcher.captureForFrame — retired event kinds', () => {
  it('does NOT write crop / fullFrame / fullFrameBoxed for an object event', async () => {
    const { deps, puts } = makeDeps(makeFrame())
    const d = new EventMediaDispatcher(deps)
    await d.captureForFrame({
      deviceId: 99,
      frameHandle: makeHandle(),
      events: [
        {
          eventId: 'e1',
          timestamp: 1000,
          bbox: { x: 10, y: 8, w: 20, h: 16 },
          className: 'person',
          confidence: 0.9,
        },
      ],
      trackFrames: [],
      cropPadding: 0,
    })
    const kinds = puts.filter((p) => p.ownerId === 'e1').map((p) => p.kind)
    expect(kinds).not.toContain('crop')
    expect(kinds).not.toContain('fullFrame')
    expect(kinds).not.toContain('fullFrameBoxed')
  })

  it('an object event with no childCrops writes NOTHING (no crop/fullFrame)', async () => {
    const { deps, puts } = makeDeps(makeFrame())
    await new EventMediaDispatcher(deps).captureForFrame({
      deviceId: 99,
      frameHandle: makeHandle(),
      events: [
        { eventId: 'e1', timestamp: 1, bbox: { x: 1, y: 1, w: 5, h: 5 }, className: 'person' },
        { eventId: 'e2', timestamp: 2, bbox: { x: 2, y: 2, w: 6, h: 6 }, className: 'car' },
      ],
      trackFrames: [],
      cropPadding: 0,
    })
    // The frame is still resolved once (blank guard) but nothing is stored.
    expect(deps.getRemoteFrame).toHaveBeenCalledTimes(1)
    expect(puts.filter((p) => p.ownerKind === 'object')).toHaveLength(0)
  })

  it('still writes faceCrop / plateCrop child crops (verbatim native), no crop/fullFrame', async () => {
    const NATIVE = Buffer.from('native-child-crop')
    const getNativeCropJpeg = vi.fn(async () => NATIVE)
    const { deps, puts } = makeDeps(makeFrame(), getNativeCropJpeg)
    await new EventMediaDispatcher(deps).captureForFrame({
      deviceId: 99,
      frameHandle: makeHandle(),
      events: [
        {
          eventId: 'e1',
          timestamp: 1000,
          bbox: { x: 5, y: 5, w: 30, h: 30 },
          className: 'person',
          childCrops: [
            { kind: 'faceCrop', bbox: { x: 8, y: 6, w: 12, h: 14 } },
            { kind: 'plateCrop', bbox: { x: 10, y: 20, w: 16, h: 8 } },
          ],
        },
      ],
      trackFrames: [],
      cropPadding: 0,
    })
    const e1 = puts.filter((p) => p.ownerId === 'e1')
    const kinds = e1.map((p) => p.kind).toSorted()
    expect(kinds).toEqual(['faceCrop', 'plateCrop'])
    expect(e1.find((p) => p.kind === 'faceCrop')!.data).toBe(NATIVE)
    expect(e1.find((p) => p.kind === 'plateCrop')!.data).toBe(NATIVE)
  })

  it('DISPLAY child crop falls back to the retained full frame on a native-ROI miss (info log, no upscale)', async () => {
    // faceCrop/plateCrop are DISPLAY media: a native-ROI miss must NOT skip the
    // write — it crops the SAME region out of the retained full frame instead.
    const getNativeCropJpeg = vi.fn(async () => null)
    const getNativeFullFrameRgb = vi.fn(async () => makeNativeFrame())
    const { deps, puts } = makeDeps(makeFrame(), getNativeCropJpeg, getNativeFullFrameRgb)
    await new EventMediaDispatcher(deps).captureForFrame({
      deviceId: 99,
      frameHandle: makeHandle(),
      events: [
        {
          eventId: 'e1',
          timestamp: 1000,
          bbox: { x: 5, y: 5, w: 30, h: 30 },
          className: 'person',
          childCrops: [{ kind: 'faceCrop', bbox: { x: 8, y: 6, w: 12, h: 14 } }],
        },
      ],
      trackFrames: [],
      cropPadding: 0,
    })
    const faceCrop = puts.find((p) => p.ownerId === 'e1' && p.kind === 'faceCrop')
    expect(faceCrop).toBeDefined()
    // The fallback frame was consulted, and the fallback was announced once.
    expect(getNativeFullFrameRgb).toHaveBeenCalled()
    expect(deps.logger.info).toHaveBeenCalled()
  })

  it('DISPLAY child crop last-resort falls back to the ≤640 detection raster when native ROI AND full frame miss', async () => {
    const getNativeCropJpeg = vi.fn(async () => null)
    const getNativeFullFrameRgb = vi.fn(async () => null)
    const { deps, puts } = makeDeps(makeFrame(), getNativeCropJpeg, getNativeFullFrameRgb)
    await new EventMediaDispatcher(deps).captureForFrame({
      deviceId: 99,
      frameHandle: makeHandle(),
      events: [
        {
          eventId: 'e1',
          timestamp: 1000,
          bbox: { x: 5, y: 5, w: 30, h: 30 },
          className: 'person',
          childCrops: [{ kind: 'plateCrop', bbox: { x: 8, y: 6, w: 12, h: 14 } }],
        },
      ],
      trackFrames: [],
      cropPadding: 0,
    })
    // Even with both native surfaces missing, the already-resolved detection
    // raster (`frameData`) yields an honest sub-native crop — never skipped.
    const plateCrop = puts.find((p) => p.ownerId === 'e1' && p.kind === 'plateCrop')
    expect(plateCrop).toBeDefined()
    expect(deps.logger.info).toHaveBeenCalled()
  })

  it('DISPLAY child crop uses the verbatim native ROI when present (no fallback, no fallback log)', async () => {
    const NATIVE = await makeJpeg(200, 200)
    const getNativeCropJpeg = vi.fn(async () => NATIVE)
    const getNativeFullFrameRgb = vi.fn(async () => makeNativeFrame())
    const { deps, puts } = makeDeps(makeFrame(), getNativeCropJpeg, getNativeFullFrameRgb)
    await new EventMediaDispatcher(deps).captureForFrame({
      deviceId: 99,
      frameHandle: makeHandle(),
      events: [
        {
          eventId: 'e1',
          timestamp: 1000,
          bbox: { x: 5, y: 5, w: 30, h: 30 },
          className: 'person',
          childCrops: [{ kind: 'faceCrop', bbox: { x: 8, y: 6, w: 12, h: 14 } }],
        },
      ],
      trackFrames: [],
      cropPadding: 0,
    })
    const faceCrop = puts.find((p) => p.ownerId === 'e1' && p.kind === 'faceCrop')
    expect(faceCrop!.data).toBe(NATIVE)
    // A native hit never touches the full-frame fallback.
    expect(getNativeFullFrameRgb).not.toHaveBeenCalled()
  })
})

describe('EventMediaDispatcher.captureForFrame — boxed timeline tiles (native 960)', () => {
  it('writes a boxed firstFrame per track from the native frame, ≤ 960 wide', async () => {
    const { deps, puts } = makeDeps(makeFrame())
    await new EventMediaDispatcher(deps).captureForFrame({
      deviceId: 99,
      frameHandle: makeHandle(),
      events: [],
      trackFrames: [
        { trackId: 't1', timestamp: 2000, bbox: { x: 5, y: 5, w: 10, h: 10 }, label: 'cat' },
      ],
      cropPadding: 0,
    })
    const t1 = puts.filter((p) => p.ownerKind === 'track' && p.ownerId === 't1')
    // The clean `sceneFrame` twin (written first) plus the boxed tile (D654) —
    // see `event-media-dispatcher-scene-twin.spec.ts`.
    expect(t1.map((p) => p.kind)).toEqual(['sceneFrame', 'firstFrame'])
    const meta = await sharp(t1[0]!.data).metadata()
    expect(meta.width).toBeLessThanOrEqual(960)
    // The native surface (960) — NOT the ≤640 detection frame — was the source.
    expect(deps.getNativeFullFrameRgb).toHaveBeenCalledWith(expect.anything(), 960)
    expect(meta.width).toBe(960)
  })

  it('firstFrame falls back to the ≤640 detection frame + warns on a native miss (no upscale)', async () => {
    const getNativeFullFrameRgb = vi.fn(async () => null)
    const { deps, puts } = makeDeps(makeFrame(), undefined, getNativeFullFrameRgb)
    await new EventMediaDispatcher(deps).captureForFrame({
      deviceId: 99,
      frameHandle: makeHandle(),
      events: [],
      trackFrames: [{ trackId: 't1', timestamp: 2000, bbox: { x: 5, y: 5, w: 10, h: 10 } }],
      cropPadding: 0,
    })
    const t1 = puts.find((p) => p.ownerId === 't1' && p.kind === 'firstFrame')
    expect(t1).toBeDefined()
    const meta = await sharp(t1!.data).metadata()
    // The detection frame is 64 wide → the fallback stays ≤640 (never upscaled to 960).
    expect(meta.width).toBe(FW)
    expect(deps.logger.warn).toHaveBeenCalled()
  })

  it('shares ONE native 960 fetch across multiple track tiles in the same frame (S3)', async () => {
    const getNativeFullFrameRgb = vi.fn(async () => makeNativeFrame())
    const { deps, puts } = makeDeps(makeFrame(), undefined, getNativeFullFrameRgb)
    await new EventMediaDispatcher(deps).captureForFrame({
      deviceId: 99,
      frameHandle: makeHandle(),
      events: [],
      trackFrames: [
        { trackId: 't1', timestamp: 2000, bbox: { x: 5, y: 5, w: 10, h: 10 } },
        { trackId: 't2', timestamp: 2000, bbox: { x: 20, y: 20, w: 10, h: 10 } },
        { trackId: 't3', timestamp: 2000, bbox: { x: 30, y: 30, w: 10, h: 10 } },
      ],
      cropPadding: 0,
    })
    // Three tiles were written…
    expect(puts.filter((p) => p.ownerKind === 'track' && p.kind === 'firstFrame')).toHaveLength(3)
    // …but the identical native full frame was fetched exactly ONCE (memoized).
    expect(getNativeFullFrameRgb).toHaveBeenCalledTimes(1)
  })

  it('warns only ONCE when the native full-frame fetch THROWS (no double warn) (S3)', async () => {
    const getNativeFullFrameRgb = vi.fn(async () => {
      throw new Error('boom')
    })
    const { deps, puts } = makeDeps(makeFrame(), undefined, getNativeFullFrameRgb)
    await new EventMediaDispatcher(deps).captureForFrame({
      deviceId: 99,
      frameHandle: makeHandle(),
      events: [],
      trackFrames: [{ trackId: 't1', timestamp: 2000, bbox: { x: 5, y: 5, w: 10, h: 10 } }],
      cropPadding: 0,
    })
    // The ≤640 fallback tile is still written…
    const t1 = puts.find((p) => p.ownerId === 't1' && p.kind === 'firstFrame')
    expect(t1).toBeDefined()
    // …and the fetch-threw failure logs exactly ONE warn (the miss branch is
    // suppressed for the same failure).
    const warnMock = deps.logger.warn as unknown as ReturnType<typeof vi.fn>
    expect(warnMock).toHaveBeenCalledTimes(1)
    expect(warnMock.mock.calls[0]![0]).toContain('fetch threw')
  })

  it('appends a snapshot, overwrites lastFrame + best thumbnail from ONE encode, returns the stored snapshot', async () => {
    const { deps, puts, replaces } = makeDeps(makeFrame())
    const res = await new EventMediaDispatcher(deps).captureForFrame({
      deviceId: 7,
      frameHandle: makeHandle(),
      events: [],
      trackFrames: [],
      snapshots: [
        {
          trackId: 't1',
          timestamp: 5000,
          bbox: { x: 5, y: 5, w: 10, h: 10 },
          label: 'person',
          appendSnapshot: true,
          rollingLastFrame: true,
          bestThumbnail: true,
          keyFrame: 'skip',
        },
      ],
      cropPadding: 0,
    })
    // Appended snapshot → put(kind: 'snapshot'); returned for TrackStore wiring.
    const snap = puts.find((p) => p.ownerKind === 'track' && p.kind === 'snapshot')
    expect(snap).toBeDefined()
    expect(res.storedSnapshots).toEqual([
      {
        trackId: 't1',
        mediaId: mediaIdFor('key:t1:snapshot:5000'),
        timestamp: 5000,
        bbox: { x: 5, y: 5, w: 10, h: 10 },
      },
    ])
    // Rolling lastFrame + best thumbnail + its 480 companion → putReplacing.
    expect(replaces.map((p) => p.kind).toSorted()).toEqual([
      'lastFrame',
      'thumbnail',
      'thumbnailSmall',
    ])
    // The boxed native frame is encoded ONCE and shared by snapshot + lastFrame
    // (same buffer reference); the THUMBNAIL is a separate NATIVE 16:9
    // central-square window (composed), never the boxed timeline frame.
    const lastFrame = replaces.find((p) => p.kind === 'lastFrame')
    expect(lastFrame!.data).toBe(snap!.data)
    const thumb = replaces.find((p) => p.kind === 'thumbnail')
    expect(thumb!.data).not.toBe(snap!.data)
    // The `thumbnail` is a 16:9 window (subject in the central square).
    const thumbMeta = await sharp(thumb!.data).metadata()
    expect((thumbMeta.width ?? 0) / (thumbMeta.height ?? 1)).toBeCloseTo(16 / 9, 1)
    // `thumbnailSmall` is the SAME 16:9 window downscaled to the 480 long side.
    const small = replaces.find((p) => p.kind === 'thumbnailSmall')
    const smallMeta = await sharp(small!.data).metadata()
    expect(Math.max(smallMeta.width ?? 0, smallMeta.height ?? 0)).toBe(480)
    // The snapshot tile decodes at ≤ 960.
    const snapMeta = await sharp(snap!.data).metadata()
    expect(snapMeta.width).toBeLessThanOrEqual(960)
  })

  it('snapshot/lastFrame fall back to the ≤640 detection frame + warn on a native miss', async () => {
    const getNativeFullFrameRgb = vi.fn(async () => null)
    const { deps, puts } = makeDeps(makeFrame(), undefined, getNativeFullFrameRgb)
    await new EventMediaDispatcher(deps).captureForFrame({
      deviceId: 7,
      frameHandle: makeHandle(),
      events: [],
      trackFrames: [],
      snapshots: [
        {
          trackId: 't1',
          timestamp: 5000,
          bbox: { x: 5, y: 5, w: 10, h: 10 },
          appendSnapshot: true,
          rollingLastFrame: false,
          bestThumbnail: false,
          keyFrame: 'skip',
        },
      ],
      cropPadding: 0,
    })
    const snap = puts.find((p) => p.kind === 'snapshot')
    const meta = await sharp(snap!.data).metadata()
    expect(meta.width).toBe(FW)
    expect(deps.logger.warn).toHaveBeenCalled()
  })

  it('only the requested snapshot kinds are written (best-only, no snapshot/lastFrame)', async () => {
    const { deps, puts, replaces } = makeDeps(makeFrame())
    const res = await new EventMediaDispatcher(deps).captureForFrame({
      deviceId: 7,
      frameHandle: makeHandle(),
      events: [],
      trackFrames: [],
      snapshots: [
        {
          trackId: 't1',
          timestamp: 100,
          bbox: { x: 5, y: 5, w: 10, h: 10 },
          appendSnapshot: false,
          rollingLastFrame: false,
          bestThumbnail: true,
          keyFrame: 'skip',
        },
      ],
      cropPadding: 0,
    })
    expect(puts.filter((p) => p.ownerKind === 'track')).toHaveLength(0)
    expect(res.storedSnapshots).toHaveLength(0)
    expect(replaces.map((p) => p.kind)).toEqual(['thumbnail', 'thumbnailSmall'])
  })
})

describe('EventMediaDispatcher.captureForFrame — firstFrame landed reporting (DEFECT A)', () => {
  it('reports firstFrameTrackIds for a firstFrame that actually persisted', async () => {
    const { deps } = makeDeps(makeFrame())
    const res = await new EventMediaDispatcher(deps).captureForFrame({
      deviceId: 99,
      frameHandle: makeHandle(),
      events: [],
      trackFrames: [{ trackId: 't1', timestamp: 2000, bbox: { x: 5, y: 5, w: 10, h: 10 } }],
      cropPadding: 0,
    })
    expect(res.firstFrameTrackIds).toEqual(['t1'])
  })

  it('a recycled frame reports NO firstFrameTrackIds (caller retries next frame)', async () => {
    const { deps, puts } = makeDeps(null)
    const res = await new EventMediaDispatcher(deps).captureForFrame({
      deviceId: 99,
      frameHandle: makeHandle(),
      events: [],
      trackFrames: [{ trackId: 't1', timestamp: 2000, bbox: { x: 5, y: 5, w: 10, h: 10 } }],
      cropPadding: 0,
    })
    expect(res.firstFrameTrackIds).toEqual([])
    expect(puts).toHaveLength(0)
  })

  it('reports NO firstFrameTrackIds when the mediaStore put THROWS (write dropped)', async () => {
    const { deps } = makeDeps(makeFrame())
    deps.mediaStore.put = vi.fn(async () => {
      throw new Error('disk full')
    })
    const res = await new EventMediaDispatcher(deps).captureForFrame({
      deviceId: 99,
      frameHandle: makeHandle(),
      events: [],
      trackFrames: [{ trackId: 't1', timestamp: 2000, bbox: { x: 5, y: 5, w: 10, h: 10 } }],
      cropPadding: 0,
    })
    expect(res.firstFrameTrackIds).toEqual([])
  })
})

describe('EventMediaDispatcher.captureForFrame — lastFrame landed reporting (DEFECT B)', () => {
  it('reports lastFrameTrackIds only for a rolling lastFrame that actually persisted', async () => {
    const { deps } = makeDeps(makeFrame())
    const res = await new EventMediaDispatcher(deps).captureForFrame({
      deviceId: 7,
      frameHandle: makeHandle(),
      events: [],
      trackFrames: [],
      snapshots: [
        {
          trackId: 't1',
          timestamp: 5000,
          bbox: { x: 5, y: 5, w: 10, h: 10 },
          appendSnapshot: false,
          rollingLastFrame: true,
          bestThumbnail: false,
          keyFrame: 'skip',
        },
      ],
      cropPadding: 0,
    })
    expect(res.lastFrameTrackIds).toEqual(['t1'])
  })

  it('a recycled frame reports NO lastFrameTrackIds (clock stays put, roll retries)', async () => {
    const { deps, replaces } = makeDeps(null)
    const res = await new EventMediaDispatcher(deps).captureForFrame({
      deviceId: 7,
      frameHandle: makeHandle(),
      events: [],
      trackFrames: [],
      snapshots: [
        {
          trackId: 't1',
          timestamp: 5000,
          bbox: { x: 5, y: 5, w: 10, h: 10 },
          appendSnapshot: false,
          rollingLastFrame: true,
          bestThumbnail: false,
          keyFrame: 'skip',
        },
      ],
      cropPadding: 0,
    })
    expect(res.lastFrameTrackIds).toEqual([])
    expect(replaces).toHaveLength(0)
  })

  it('reports NO lastFrameTrackIds when the rolling putReplacing THROWS (write dropped)', async () => {
    const { deps } = makeDeps(makeFrame())
    deps.mediaStore.putReplacing = vi.fn(async () => {
      throw new Error('disk full')
    })
    const res = await new EventMediaDispatcher(deps).captureForFrame({
      deviceId: 7,
      frameHandle: makeHandle(),
      events: [],
      trackFrames: [],
      snapshots: [
        {
          trackId: 't1',
          timestamp: 5000,
          bbox: { x: 5, y: 5, w: 10, h: 10 },
          appendSnapshot: false,
          rollingLastFrame: true,
          bestThumbnail: false,
          keyFrame: 'skip',
        },
      ],
      cropPadding: 0,
    })
    expect(res.lastFrameTrackIds).toEqual([])
  })

  it('a rollingLastFrame not requested is never reported as landed', async () => {
    const { deps } = makeDeps(makeFrame())
    const res = await new EventMediaDispatcher(deps).captureForFrame({
      deviceId: 7,
      frameHandle: makeHandle(),
      events: [],
      trackFrames: [],
      snapshots: [
        {
          trackId: 't1',
          timestamp: 5000,
          bbox: { x: 5, y: 5, w: 10, h: 10 },
          appendSnapshot: true,
          rollingLastFrame: false,
          bestThumbnail: false,
          keyFrame: 'skip',
        },
      ],
      cropPadding: 0,
    })
    expect(res.lastFrameTrackIds).toEqual([])
  })
})

describe('EventMediaDispatcher.captureForFrame — frame guards', () => {
  it('does nothing (no frame read) when there are no events or track frames', async () => {
    const { deps, puts } = makeDeps(makeFrame())
    await new EventMediaDispatcher(deps).captureForFrame({
      deviceId: 99,
      frameHandle: makeHandle(),
      events: [],
      trackFrames: [],
      cropPadding: 0,
    })
    expect(deps.getRemoteFrame).not.toHaveBeenCalled()
    expect(puts).toHaveLength(0)
  })

  it('skips writing media + WARNS when the frame slot was recycled (null)', async () => {
    const { deps, puts } = makeDeps(null)
    await new EventMediaDispatcher(deps).captureForFrame({
      deviceId: 99,
      frameHandle: makeHandle(),
      events: [],
      trackFrames: [{ trackId: 't1', timestamp: 1, bbox: { x: 1, y: 1, w: 5, h: 5 } }],
      cropPadding: 0,
    })
    expect(puts).toHaveLength(0)
    // Never-silent: a whole-batch loss logs at WARN (not debug) with the
    // per-kind lost-target counts.
    const warnMock = deps.logger.warn as unknown as ReturnType<typeof vi.fn>
    expect(warnMock).toHaveBeenCalled()
    expect(warnMock.mock.calls[0]![1].meta).toMatchObject({
      deviceId: 99,
      lostEventTargets: 0,
      lostFirstFrameTargets: 1,
      lostSnapshotTargets: 0,
    })
  })

  it('skips writing media + WARNS when the resolved frame is not RGB', async () => {
    const { deps, puts } = makeDeps(makeFrame({ format: 'yuv420p' as DecodedFrame['format'] }))
    await new EventMediaDispatcher(deps).captureForFrame({
      deviceId: 99,
      frameHandle: makeHandle(),
      events: [],
      trackFrames: [{ trackId: 't1', timestamp: 1, bbox: { x: 1, y: 1, w: 5, h: 5 } }],
      cropPadding: 0,
    })
    expect(puts).toHaveLength(0)
    expect(deps.logger.warn).toHaveBeenCalled()
  })

  it('skips writing media + WARNS when the resolved frame is uniform (blank / hwaccel)', async () => {
    const { deps, puts } = makeDeps(makeFrame({ data: Buffer.alloc(FW * FH * 3, 0xaa) }))
    await new EventMediaDispatcher(deps).captureForFrame({
      deviceId: 99,
      frameHandle: makeHandle(),
      events: [],
      trackFrames: [{ trackId: 't1', timestamp: 1, bbox: { x: 1, y: 1, w: 5, h: 5 } }],
      cropPadding: 0,
    })
    expect(puts).toHaveLength(0)
    expect(deps.logger.warn).toHaveBeenCalled()
  })
})

describe('EventMediaDispatcher.captureForFrame — pinned live-window frame', () => {
  it('a pinnedFrame BYPASSES the by-handle resolve: recycled handle (getRemoteFrame throws), boxed writes still land', async () => {
    // The regression scenario: the batch queued behind keyFrame execs, the ring
    // slot recycled, the by-handle resolve would throw/return null — but the
    // caller pinned the frame in the live window, so every boxed tile lands.
    const throwingRemote = vi.fn(async (): Promise<DecodedFrame | null> => {
      throw new Error('slot recycled')
    })
    const { deps, puts, replaces } = makeDeps(null, undefined, undefined, throwingRemote)
    const res = await new EventMediaDispatcher(deps).captureForFrame({
      deviceId: 99,
      frameHandle: makeHandle(),
      events: [],
      trackFrames: [{ trackId: 't1', timestamp: 2000, bbox: { x: 5, y: 5, w: 10, h: 10 } }],
      snapshots: [
        {
          trackId: 't2',
          timestamp: 2000,
          bbox: { x: 20, y: 20, w: 10, h: 10 },
          appendSnapshot: false,
          rollingLastFrame: true,
          bestThumbnail: false,
          keyFrame: 'skip',
        },
      ],
      cropPadding: 0,
      pinnedFrame: makeFrame(),
    })
    // The ≤640 tier never touched the by-handle resolve.
    expect(throwingRemote).not.toHaveBeenCalled()
    // firstFrame + rolling lastFrame both landed from the pinned data.
    expect(puts.find((p) => p.ownerId === 't1' && p.kind === 'firstFrame')).toBeDefined()
    expect(replaces.find((p) => p.ownerId === 't2' && p.kind === 'lastFrame')).toBeDefined()
    expect(res.firstFrameTrackIds).toEqual(['t1'])
    expect(res.lastFrameTrackIds).toEqual(['t2'])
  })

  it('pinned data feeds the ≤640 boxed fallback when the native full frame ALSO misses', async () => {
    const getNativeFullFrameRgb = vi.fn(async () => null)
    const throwingRemote = vi.fn(async (): Promise<DecodedFrame | null> => {
      throw new Error('slot recycled')
    })
    const { deps, puts } = makeDeps(null, undefined, getNativeFullFrameRgb, throwingRemote)
    await new EventMediaDispatcher(deps).captureForFrame({
      deviceId: 99,
      frameHandle: makeHandle(),
      events: [],
      trackFrames: [{ trackId: 't1', timestamp: 2000, bbox: { x: 5, y: 5, w: 10, h: 10 } }],
      cropPadding: 0,
      pinnedFrame: makeFrame(),
    })
    const t1 = puts.find((p) => p.ownerId === 't1' && p.kind === 'firstFrame')
    expect(t1).toBeDefined()
    // The fallback tile was cut from the pinned ≤640 frame (FW wide — honest, no upscale).
    const meta = await sharp(t1!.data).metadata()
    expect(meta.width).toBe(FW)
  })

  it('no pinnedFrame + failed by-handle resolve → WARN with lost-target counts + empty result', async () => {
    const throwingRemote = vi.fn(async (): Promise<DecodedFrame | null> => {
      throw new Error('slot recycled')
    })
    const { deps, puts } = makeDeps(null, undefined, undefined, throwingRemote)
    const res = await new EventMediaDispatcher(deps).captureForFrame({
      deviceId: 42,
      frameHandle: makeHandle(),
      events: [
        { eventId: 'e1', timestamp: 1, bbox: { x: 1, y: 1, w: 5, h: 5 }, className: 'person' },
      ],
      trackFrames: [{ trackId: 't1', timestamp: 1, bbox: { x: 1, y: 1, w: 5, h: 5 } }],
      cropPadding: 0,
    })
    expect(puts).toHaveLength(0)
    expect(res.firstFrameTrackIds).toEqual([])
    expect(res.thumbnailTrackIds).toEqual([])
    expect(res.lastFrameTrackIds).toEqual([])
    expect(res.storedSnapshots).toEqual([])
    const warnMock = deps.logger.warn as unknown as ReturnType<typeof vi.fn>
    expect(warnMock).toHaveBeenCalled()
    expect(warnMock.mock.calls[0]![0]).toContain('resolveFrame threw')
    expect(warnMock.mock.calls[0]![1].meta).toMatchObject({
      deviceId: 42,
      pinned: false,
      lostEventTargets: 1,
      lostFirstFrameTargets: 1,
      lostSnapshotTargets: 0,
    })
  })
})

describe('EventMediaDispatcher.captureForFrame — best thumbnail (native subject crop)', () => {
  it('#27-A: reports thumbnailTrackIds when a best thumbnail lands', async () => {
    const { deps } = makeDeps(makeFrame())
    const res = await new EventMediaDispatcher(deps).captureForFrame({
      deviceId: 7,
      frameHandle: makeHandle(),
      events: [],
      trackFrames: [],
      snapshots: [
        {
          trackId: 't1',
          timestamp: 100,
          bbox: { x: 5, y: 5, w: 10, h: 10 },
          appendSnapshot: false,
          rollingLastFrame: false,
          bestThumbnail: true,
          keyFrame: 'skip',
        },
      ],
      cropPadding: 0,
    })
    expect(res.thumbnailTrackIds).toEqual(['t1'])
  })

  it('#27-A: a recycled frame reports NO thumbnailTrackIds (caller retries next frame)', async () => {
    const { deps, replaces } = makeDeps(null)
    const res = await new EventMediaDispatcher(deps).captureForFrame({
      deviceId: 7,
      frameHandle: makeHandle(),
      events: [],
      trackFrames: [],
      snapshots: [
        {
          trackId: 't1',
          timestamp: 100,
          bbox: { x: 5, y: 5, w: 10, h: 10 },
          appendSnapshot: false,
          rollingLastFrame: false,
          bestThumbnail: true,
          keyFrame: 'skip',
        },
      ],
      cropPadding: 0,
    })
    expect(res.thumbnailTrackIds).toEqual([])
    expect(replaces).toHaveLength(0)
  })

  it('writes the best thumbnail from the PARKED slab plus a 480 companion — one read by track, no handle', async () => {
    const getNativeCropJpeg = vi.fn(async () => DEFAULT_NATIVE_JPEG)
    const getParkedSubjectSlab = vi.fn(async () => parkedSlab({ x: 5, y: 5, w: 10, h: 10 }, 100))
    const { deps, replaces } = makeDeps(
      makeFrame(),
      getNativeCropJpeg,
      undefined,
      undefined,
      getParkedSubjectSlab,
    )
    await new EventMediaDispatcher(deps).captureForFrame({
      deviceId: 7,
      frameHandle: makeHandle(),
      events: [],
      trackFrames: [],
      snapshots: [
        {
          trackId: 't1',
          // A LATER frame than the parked one: the retry path re-fires while
          // the thumbnail has not landed. The media row must carry the
          // instant the parcel SHOWS, not this frame's.
          timestamp: 250,
          bbox: { x: 5, y: 5, w: 10, h: 10 },
          appendSnapshot: false,
          rollingLastFrame: false,
          bestThumbnail: true,
          keyFrame: 'skip',
        },
      ],
      cropPadding: 0,
    })
    // ONE read, by (deviceId, trackId) — BOTH variants derive from the SAME
    // parked window, never a second read and never a by-handle crop.
    expect(getParkedSubjectSlab).toHaveBeenCalledTimes(1)
    expect(getParkedSubjectSlab).toHaveBeenCalledWith(7, 't1')
    expect(getNativeCropJpeg).not.toHaveBeenCalled()
    // The `thumbnail` is the composed 16:9 window (subject in the central square).
    const thumb = replaces.find((p) => p.kind === 'thumbnail')
    const thumbMeta = await sharp(thumb!.data).metadata()
    expect((thumbMeta.width ?? 0) / (thumbMeta.height ?? 1)).toBeCloseTo(16 / 9, 1)
    expect(thumb?.timestamp).toBe(100)
    // The companion `thumbnailSmall` is that window at the 480 long side (16:9).
    const small = replaces.find((p) => p.kind === 'thumbnailSmall')
    const smallMeta = await sharp(small!.data).metadata()
    expect(Math.max(smallMeta.width ?? 0, smallMeta.height ?? 0)).toBe(480)
    expect((smallMeta.width ?? 0) / (smallMeta.height ?? 1)).toBeCloseTo(16 / 9, 1)
    expect(small?.timestamp).toBe(100)
  })

  it('does NOT write a thumbnail (and logs) when the parcel is missing — and NEVER falls back to a handle', async () => {
    const getNativeCropJpeg = vi.fn(async () => DEFAULT_NATIVE_JPEG)
    const getParkedSubjectSlab = vi.fn(async () => null)
    const { deps, replaces } = makeDeps(
      makeFrame(),
      getNativeCropJpeg,
      undefined,
      undefined,
      getParkedSubjectSlab,
    )
    const onSubjectCropMiss = vi.fn()
    const res = await new EventMediaDispatcher({ ...deps, onSubjectCropMiss }).captureForFrame({
      deviceId: 7,
      frameHandle: makeHandle(),
      events: [],
      trackFrames: [],
      snapshots: [
        {
          trackId: 't1',
          timestamp: 100,
          bbox: { x: 5, y: 5, w: 10, h: 10 },
          appendSnapshot: false,
          rollingLastFrame: false,
          bestThumbnail: true,
          keyFrame: 'skip',
        },
      ],
      cropPadding: 0,
    })
    expect(res.thumbnailTrackIds).toEqual([])
    expect(replaces.some((p) => p.kind === 'thumbnail')).toBe(false)
    expect(deps.logger.warn).toHaveBeenCalled()
    expect(onSubjectCropMiss).toHaveBeenCalledWith(7, 't1', 'parcel-missing')
    // The whole point of D422: a retrieval keyed by the track does not reach
    // back for pixels by handle when the parcel is gone.
    expect(getNativeCropJpeg).not.toHaveBeenCalled()
  })

  it('does NOT degrade the thumbnail to the boxed full frame when the parcel is missing', async () => {
    const { deps, replaces } = makeDeps(
      makeFrame(),
      undefined,
      undefined,
      undefined,
      vi.fn(async () => null),
    )
    await new EventMediaDispatcher(deps).captureForFrame({
      deviceId: 7,
      frameHandle: makeHandle(),
      events: [],
      trackFrames: [],
      snapshots: [
        {
          trackId: 't1',
          timestamp: 100,
          bbox: { x: 5, y: 5, w: 10, h: 10 },
          appendSnapshot: true,
          rollingLastFrame: true,
          bestThumbnail: true,
          keyFrame: 'skip',
        },
      ],
      cropPadding: 0,
    })
    // lastFrame lands (boxed timeline tile), but NO thumbnail is written.
    expect(replaces.some((p) => p.kind === 'lastFrame')).toBe(true)
    expect(replaces.some((p) => p.kind === 'thumbnail')).toBe(false)
  })
})
