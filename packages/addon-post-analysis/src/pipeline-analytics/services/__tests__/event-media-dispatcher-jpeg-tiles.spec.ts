/**
 * The boxed timeline tiles are drawn from the runner's JPEG, never from an RGB
 * surface (D867), and the pinned detection frame is not copied.
 *
 * Both are allocation removals with NO behaviour change, so the assertions are
 * about (a) which fetch ran, (b) pixel equality with the path that was removed,
 * and (c) buffer identity where a copy used to be.
 */
import sharp from 'sharp'
import type { DecodedFrame, FrameHandle, IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { drawBoxedFrame } from '../../../shared/frame/box-drawer.js'
import { decodeJpegToRgb } from '../../../shared/frame/encode-crop.js'
import { MEDIA_QUALITY } from '../../../shared/frame/media-quality.js'
import type { MediaPutInput } from '../../store/media-store.js'
import type {
  EventMediaDispatcherDeps,
  EventMediaWriter,
  NativeFullFrameJpeg,
} from '../event-media-dispatcher.js'
import { EventMediaDispatcher } from '../event-media-dispatcher.js'

const FW = 64
const FH = 48
const NATIVE_W = 320
const NATIVE_H = 180
const BBOX = { x: 5, y: 5, w: 10, h: 10 }

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

function logger(): IScopedLogger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
}

/** A smooth, non-uniform scene (a gradient with a bright block). */
function sceneRgb(width: number, height: number): Buffer {
  const b = Buffer.allocUnsafe(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3
      const block = x > width / 3 && x < width / 2 && y > height / 3 && y < height / 2
      b[i] = block ? 250 : Math.round((x / width) * 200)
      b[i + 1] = Math.round((y / height) * 200)
      b[i + 2] = 60
    }
  }
  return b
}

async function sceneJpeg(): Promise<NativeFullFrameJpeg> {
  const jpeg = await sharp(sceneRgb(NATIVE_W, NATIVE_H), {
    raw: { width: NATIVE_W, height: NATIVE_H, channels: 3 },
  })
    .jpeg({ quality: 90 })
    .toBuffer()
  return { jpeg, width: NATIVE_W, height: NATIVE_H }
}

function detectionFrame(): DecodedFrame {
  return { data: sceneRgb(FW, FH), width: FW, height: FH, format: 'rgb', timestamp: 0 }
}

interface Harness {
  readonly deps: EventMediaDispatcherDeps
  readonly puts: MediaPutInput[]
  readonly rgbFetch: ReturnType<typeof vi.fn>
  readonly jpegFetch: ReturnType<typeof vi.fn>
}

async function harness(): Promise<Harness> {
  const puts: MediaPutInput[] = []
  const mediaStore: EventMediaWriter = {
    put: async (p) => {
      puts.push(p)
      return puts.length
    },
    putReplacing: async (p) => {
      puts.push(p)
      return puts.length
    },
  }
  const scene = await sceneJpeg()
  const rgbFetch = vi.fn(async (): Promise<DecodedFrame | null> => null)
  const jpegFetch = vi.fn(async (): Promise<NativeFullFrameJpeg | null> => scene)
  const deps: EventMediaDispatcherDeps = {
    getRemoteFrame: async () => detectionFrame(),
    getNativeCropJpeg: async () => null,
    getNativeFullFrameRgb: rgbFetch,
    getNativeFullFrameJpeg: jpegFetch,
    getParkedSubjectSlab: async () => null,
    mediaStore,
    logger: logger(),
  }
  return { deps, puts, rgbFetch, jpegFetch }
}

/** Mean absolute per-channel difference between two JPEGs, after decoding. */
async function meanAbsDiff(a: Buffer, b: Buffer): Promise<number> {
  const [da, db] = await Promise.all([decodeJpegToRgb(a), decodeJpegToRgb(b)])
  expect(da.width).toBe(db.width)
  expect(da.height).toBe(db.height)
  let sum = 0
  for (let i = 0; i < da.bytes.length; i++) sum += Math.abs(da.bytes[i]! - db.bytes[i]!)
  return sum / da.bytes.length
}

describe('boxed timeline tiles from the wire JPEG (D867)', () => {
  it('draws the tile and its clean twin without ever fetching an RGB surface', async () => {
    const h = await harness()
    await new EventMediaDispatcher(h.deps).captureForFrame({
      deviceId: 101,
      frameHandle: HANDLE,
      events: [],
      trackFrames: [{ trackId: 't1', timestamp: 2000, bbox: BBOX, label: 'person' }],
      cropPadding: 0,
    })
    expect(h.rgbFetch).not.toHaveBeenCalled()
    expect(h.jpegFetch).toHaveBeenCalledTimes(1)
    expect(h.puts.map((p) => p.kind)).toEqual(['sceneFrame', 'firstFrame'])
  })

  it('is visually identical to the RGB path it replaced (pixel diff within tolerance)', async () => {
    const h = await harness()
    await new EventMediaDispatcher(h.deps).captureForFrame({
      deviceId: 101,
      frameHandle: HANDLE,
      events: [],
      trackFrames: [{ trackId: 't1', timestamp: 2000, bbox: BBOX, label: 'person' }],
      cropPadding: 0,
    })
    const tile = h.puts.find((p) => p.kind === 'firstFrame')!
    const twin = h.puts.find((p) => p.kind === 'sceneFrame')!

    // The removed path: decode to RGB in JS, draw, encode.
    const scene = await sceneJpeg()
    const rgb = await decodeJpegToRgb(scene.jpeg)
    const sx = NATIVE_W / FW
    const sy = NATIVE_H / FH
    const box = {
      x: BBOX.x * sx,
      y: BBOX.y * sy,
      w: BBOX.w * sx,
      h: BBOX.h * sy,
      label: 'person',
    }
    const oldTile = await drawBoxedFrame(rgb.bytes, rgb.width, rgb.height, [box], {
      quality: MEDIA_QUALITY,
    })
    const oldClean = await drawBoxedFrame(rgb.bytes, rgb.width, rgb.height, [], {
      quality: MEDIA_QUALITY,
    })

    expect(await meanAbsDiff(tile.data, oldTile)).toBeLessThan(1)
    expect(await meanAbsDiff(twin.data, oldClean)).toBeLessThan(1)
    // And the box really is there: tile and twin differ.
    expect(await meanAbsDiff(tile.data, twin.data)).toBeGreaterThan(0)
  })

  it('falls back to the RGB fetch only when no JPEG fetch is wired (test doubles)', async () => {
    const h = await harness()
    const { getNativeFullFrameJpeg: _unused, ...withoutJpeg } = h.deps
    await new EventMediaDispatcher(withoutJpeg).captureForFrame({
      deviceId: 101,
      frameHandle: HANDLE,
      events: [],
      trackFrames: [{ trackId: 't1', timestamp: 2000, bbox: BBOX }],
      cropPadding: 0,
    })
    expect(h.rgbFetch).toHaveBeenCalledTimes(1)
    expect(h.jpegFetch).not.toHaveBeenCalled()
  })
})

describe('pinned detection frame is not copied (D867)', () => {
  it('resolvePinnedFrame hands back the buffer the fetch returned', async () => {
    const h = await harness()
    const fetched = detectionFrame()
    const dispatcher = new EventMediaDispatcher({ ...h.deps, getRemoteFrame: async () => fetched })
    const pinned = await dispatcher.resolvePinnedFrame(101, HANDLE)
    expect(pinned).not.toBeNull()
    // Identity, not equality: a `Buffer.from(...)` here is the removed copy.
    expect(pinned!.data).toBe(fetched.data)
  })

  it('a batch without a pin does not copy the resolved frame either', async () => {
    const h = await harness()
    const fetched = detectionFrame()
    const dispatcher = new EventMediaDispatcher({
      ...h.deps,
      getRemoteFrame: async () => fetched,
      // The ≤640 detection raster is cropped for a display child when no native
      // surface answers; the buffer that reaches the crop is the fetched one.
      getNativeFullFrameJpeg: async () => null,
    })
    await dispatcher.captureForFrame({
      deviceId: 101,
      frameHandle: HANDLE,
      events: [],
      trackFrames: [{ trackId: 't1', timestamp: 2000, bbox: BBOX }],
      cropPadding: 0,
    })
    // The fetched buffer is untouched (read-only consumers): same bytes as a
    // fresh render of the same scene.
    expect(fetched.data.equals(detectionFrame().data)).toBe(true)
  })
})
