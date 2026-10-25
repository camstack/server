/**
 * The crop paths whose destination is a STORED JPEG must not decode.
 *
 * `wantJpeg` is unconditionally `true` (2026-07-23 relay-pressure fix — raw RGB
 * over the UDS relay ballooned hub-main to 2-4 GB), so every `getNativeCrop`
 * reply already arrives as a JPEG the OWNING runner encoded at `quality: 90`.
 * Until this change the crop paths then paid `base64 → Buffer → raw RGB
 * (24.9 MB at 4K) → copy → copy → JPEG` and arrived back at the same picture.
 * `getFullFrameJpegBase64` had refused that from the start, with the reason
 * written on it; the crop paths simply never adopted it.
 *
 * ## What is asserted, and why it cannot pass with the mechanism off
 *
 * The seam is `sharp` itself, mocked here to delegate to the REAL sharp while
 * counting constructions — so "no decode" is a count at the decode boundary,
 * not a spy on an injected helper. That is backed by two assertions a decode
 * could not survive even uncounted:
 *
 *  - BYTE IDENTITY with the runner's reply. A decode plus a re-encode never
 *    reproduces the source bytes, at any quality.
 *  - CHANNEL PRESERVATION. A 1-channel (grayscale) reply comes back 1-channel.
 *    `decodeJpegToRgb` → `encodeRgbCropToJpeg` is a 3-channel round trip by
 *    construction and cannot preserve it.
 *
 * And the two consumers that KEEP their decode are asserted to still decode,
 * positively: the keyFrame surface still arrives as `w*h*3` raw RGB, and the
 * display crop still re-encodes (its bytes differ from the reply's).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { defined } from '../../../__tests__/support/vitest-mock.js'
import type { AddonContext, FrameHandle, IScopedLogger } from '@camstack/types'

/** Construction count at the ONE decode/encode seam this addon has: `sharp`. */
const seam = vi.hoisted(() => ({ sharpCalls: 0 }))

vi.mock('sharp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sharp')>()
  const real = actual.default
  const counted = (
    input?: Parameters<typeof real>[0],
    options?: Parameters<typeof real>[1],
  ): ReturnType<typeof real> => {
    seam.sharpCalls += 1
    return real(input, options)
  }
  return { ...actual, default: counted }
})

import sharp from 'sharp'
import { extractCrop } from '../../../shared/frame/crop-extractor.js'
import { createNativeFrameTransport } from '../native-frame-transport.js'
import type { NativeFrameTransport } from '../native-frame-transport.js'

interface LoggedEntry {
  readonly level: string
  readonly message: string
  readonly extras: unknown
}

function stubLogger(entries: LoggedEntry[]): IScopedLogger {
  const logger: IScopedLogger = {
    debug: (message, extras) => entries.push({ level: 'debug', message, extras }),
    info: (message, extras) => entries.push({ level: 'info', message, extras }),
    warn: (message, extras) => entries.push({ level: 'warn', message, extras }),
    error: (message, extras) => entries.push({ level: 'error', message, extras }),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

const HANDLE: FrameHandle = {
  shmId: 'shm-1',
  slot: 0,
  seq: 2,
  width: 640,
  height: 360,
  format: 'rgb',
  pts: 1,
  byteLength: 640 * 360 * 3,
  nodeId: 'hub',
  slotCount: 4,
}

const CROP_W = 64
const CROP_H = 48
const ROI = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }
const FULL_FRAME_WINDOW = { x: 0, y: 0, w: 1, h: 1 }

/** The runner's own encode quality (`encodeNativeCropResult`). */
const RUNNER_QUALITY = 90
/** A DIFFERENT quality, so a re-encode is visible in the byte length too. */
const LOW_QUALITY = 35

/** Raw rgb24 with a gradient — a flat fill compresses to near-identical bytes
 *  at any quality, which would make the identity assertions vacuous. */
function gradientRaw(width: number, height: number, channels: number): Buffer {
  const buf = Buffer.alloc(width * height * channels)
  for (let i = 0; i < buf.length; i += 1) buf[i] = (i * 7) % 251
  return buf
}

async function encodeColourFixture(quality: number): Promise<Buffer> {
  return sharp(gradientRaw(CROP_W, CROP_H, 3), {
    raw: { width: CROP_W, height: CROP_H, channels: 3 },
  })
    .jpeg({ quality })
    .toBuffer()
}

/** A genuinely 1-channel JPEG. `toColourspace('b-w')` is what makes the encoded
 *  file grayscale — a 1-channel RAW input alone still encodes as 3-channel. */
async function encodeGrayFixture(quality: number): Promise<Buffer> {
  return sharp(gradientRaw(CROP_W, CROP_H, 1), {
    raw: { width: CROP_W, height: CROP_H, channels: 1 },
  })
    .toColourspace('b-w')
    .jpeg({ quality })
    .toBuffer()
}

/** One `getNativeCrop` reply, in either of its two wire shapes. */
interface ReplyStub {
  readonly jpeg?: string
  readonly bytes?: Uint8Array
  readonly width: number
  readonly height: number
  readonly tier?: 'native' | 'ram-fullframe'
}

/**
 * The shape of a `getNativeCrop` request, as the stub reads it. Typed here
 * rather than `unknown` because the boundary below is already a documented
 * cast and a resolver has to tell an ROI request from a full-frame one — the
 * same test `getNativeCrop` itself applies.
 */
interface StubCropRequest {
  readonly bbox: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  readonly maxWidth?: number
}

/** Answer each request individually — needed to make LEG 1 miss and LEG 2 hit. */
type ReplyResolver = (request: StubCropRequest) => ReplyStub | null

interface Harness {
  readonly transport: NativeFrameTransport
  readonly entries: readonly LoggedEntry[]
  readonly requests: readonly StubCropRequest[]
}

/** `getNativeCrop`'s own full-frame test, mirrored so the stub routes like the runner. */
function isFullFrameRequest(request: StubCropRequest): boolean {
  const b = request.bbox
  return b.x <= 0.001 && b.y <= 0.001 && b.w >= 0.999 && b.h >= 0.999
}

function harness(reply: ReplyStub | null): Harness {
  return harnessResolving(() => reply)
}

function harnessResolving(resolve: ReplyResolver): Harness {
  const entries: LoggedEntry[] = []
  const requests: StubCropRequest[] = []
  const query = async (input: StubCropRequest): Promise<ReplyStub | null> => {
    requests.push(input)
    return resolve(input)
  }
  // DOCUMENTED TYPE BOUNDARY (the same one `native-frame-transport-tier.spec.ts`
  // takes): `AddonContext['api']` is the whole generated cap surface, and the
  // transport narrows it structurally to the single method it uses. There is no
  // named type for "just that method" to build a stub against.
  const api = { pipelineRunner: { getNativeCrop: { query } } } as unknown as AddonContext['api']
  const transport = createNativeFrameTransport({
    api,
    ownNodeId: 'hub',
    logger: stubLogger(entries),
  })
  return { transport, entries, requests }
}

/** The three fixtures, encoded once with the REAL sharp before any counting. */
let colourJpeg: Buffer
let lowQualityJpeg: Buffer
let grayJpeg: Buffer

beforeAll(async () => {
  colourJpeg = await encodeColourFixture(RUNNER_QUALITY)
  lowQualityJpeg = await encodeColourFixture(LOW_QUALITY)
  grayJpeg = await encodeGrayFixture(RUNNER_QUALITY)
  // The probe is only meaningful if the fixture really is 1-channel.
  expect((await sharp(grayJpeg).metadata()).channels).toBe(1)
})

beforeEach(() => {
  seam.sharpCalls = 0
})

/** Assertions run through the real sharp; do them AFTER reading the count. */
function takeSeamCount(): number {
  const n = seam.sharpCalls
  seam.sharpCalls = 0
  return n
}

describe('captureCrop / tryNativeCrop — the runner’s JPEG, handed on', () => {
  it('performs NO decode: zero sharp constructions on the whole capture', async () => {
    const h = harness({
      jpeg: colourJpeg.toString('base64'),
      width: CROP_W,
      height: CROP_H,
      tier: 'native',
    })
    const out = await h.transport.captureCrop(HANDLE, { x: 10, y: 10, w: 20, h: 20 }, 640, 360, 0.1)
    const seamCount = takeSeamCount()
    expect(out).not.toBeNull()
    expect(seamCount).toBe(0)
  })

  it('returns the runner’s bytes VERBATIM — a re-encode could not', async () => {
    const h = harness({
      jpeg: lowQualityJpeg.toString('base64'),
      width: CROP_W,
      height: CROP_H,
      tier: 'native',
    })
    const out = await h.transport.captureCrop(HANDLE, { x: 10, y: 10, w: 20, h: 20 }, 640, 360, 0.1)
    takeSeamCount()
    expect(out).not.toBeNull()
    expect(out?.equals(lowQualityJpeg)).toBe(true)
    // A q90 re-encode of this q35 picture is materially bigger; naming the
    // number makes the failure readable rather than "buffers differ".
    expect(out?.byteLength).toBe(lowQualityJpeg.byteLength)
  })

  it('stores a VALID JPEG at the dimensions the runner reported', async () => {
    const h = harness({
      jpeg: colourJpeg.toString('base64'),
      width: CROP_W,
      height: CROP_H,
      tier: 'native',
    })
    const out = await h.transport.captureCrop(HANDLE, { x: 10, y: 10, w: 20, h: 20 }, 640, 360, 0.1)
    takeSeamCount()
    const meta = await sharp(out ?? Buffer.alloc(0)).metadata()
    expect(meta.format).toBe('jpeg')
    expect(meta.width).toBe(CROP_W)
    expect(meta.height).toBe(CROP_H)
  })

  it('preserves a 1-channel payload — a decode→RGB→encode cannot', async () => {
    const h = harness({
      jpeg: grayJpeg.toString('base64'),
      width: CROP_W,
      height: CROP_H,
      tier: 'native',
    })
    const out = await h.transport.captureCrop(HANDLE, { x: 10, y: 10, w: 20, h: 20 }, 640, 360, 0.1)
    takeSeamCount()
    const meta = await sharp(out ?? Buffer.alloc(0)).metadata()
    expect(meta.channels).toBe(1)
  })

  it('VERSION SKEW: a pre-encode runner’s raw RGB is still encoded here', async () => {
    const h = harness({
      bytes: gradientRaw(CROP_W, CROP_H, 3),
      width: CROP_W,
      height: CROP_H,
      tier: 'native',
    })
    const out = await h.transport.captureCrop(HANDLE, { x: 10, y: 10, w: 20, h: 20 }, 640, 360, 0.1)
    const seamCount = takeSeamCount()
    // Exactly one construction: the encode that has to happen because the
    // reply carried no JPEG at all. Nothing decoded it first.
    expect(seamCount).toBe(1)
    const meta = await sharp(out ?? Buffer.alloc(0)).metadata()
    expect(meta.format).toBe('jpeg')
    expect(meta.width).toBe(CROP_W)
  })

  it('still asks the runner to encode (wantJpeg stays true, D9/D18)', async () => {
    const h = harness({
      jpeg: colourJpeg.toString('base64'),
      width: CROP_W,
      height: CROP_H,
      tier: 'native',
    })
    await h.transport.captureCrop(HANDLE, { x: 10, y: 10, w: 20, h: 20 }, 640, 360, 0.1)
    takeSeamCount()
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]).toMatchObject({ encodeJpeg: true })
  })
})

describe('getNativeCropJpeg — the runner’s JPEG, handed on', () => {
  it('performs NO decode and returns the runner’s bytes verbatim', async () => {
    const h = harness({
      jpeg: lowQualityJpeg.toString('base64'),
      width: CROP_W,
      height: CROP_H,
      tier: 'native',
    })
    const out = await h.transport.getNativeCropJpeg(HANDLE, ROI, undefined, 102)
    const seamCount = takeSeamCount()
    expect(seamCount).toBe(0)
    expect(out?.equals(lowQualityJpeg)).toBe(true)
  })

  it('preserves a 1-channel payload', async () => {
    const h = harness({
      jpeg: grayJpeg.toString('base64'),
      width: CROP_W,
      height: CROP_H,
      tier: 'native',
    })
    const out = await h.transport.getNativeCropJpeg(HANDLE, ROI, undefined, 102)
    takeSeamCount()
    const meta = await sharp(out ?? Buffer.alloc(0)).metadata()
    expect(meta.channels).toBe(1)
  })

  it('TIER GATE still refuses a ram-fullframe reply, and says so per camera', async () => {
    const h = harness({
      jpeg: colourJpeg.toString('base64'),
      width: CROP_W,
      height: CROP_H,
      tier: 'ram-fullframe',
    })
    const out = await h.transport.getNativeCropJpeg(HANDLE, FULL_FRAME_WINDOW, undefined, 102)
    takeSeamCount()
    expect(out).toBeNull()
    const line = h.entries.find((e) => e.message.includes('sub-native tier'))
    expect(line?.level).toBe('info')
    expect(line?.extras).toMatchObject({
      tags: { deviceId: 102 },
      meta: { tier: 'ram-fullframe', servedWidth: CROP_W, servedHeight: CROP_H },
    })
  })

  it('TIER GATE still ACCEPTS an absent tier (pre-tier runner, version skew)', async () => {
    const h = harness({ jpeg: colourJpeg.toString('base64'), width: CROP_W, height: CROP_H })
    const out = await h.transport.getNativeCropJpeg(HANDLE, FULL_FRAME_WINDOW, undefined, 102)
    takeSeamCount()
    expect(out).not.toBeNull()
  })
})

describe('bumpCropMetric accounting survives the pass-through', () => {
  it('counts the served crop as a HIT and the refused tier as a FALLBACK', async () => {
    const nowSpy = vi.spyOn(Date, 'now')
    try {
      const served = harness({
        jpeg: colourJpeg.toString('base64'),
        width: CROP_W,
        height: CROP_H,
        tier: 'native',
      })
      // First bump always publishes the window line (`lastCropMetricAt` is 0).
      nowSpy.mockReturnValue(1_000_000)
      await served.transport.getNativeCropJpeg(HANDLE, ROI, undefined, 102)
      const hitLine = served.entries.find((e) => e.message === 'native-crop window')
      expect(hitLine?.extras).toMatchObject({
        meta: { nativeHits: 1, detectionFrameFallbacks: 0 },
      })

      const refused = harness({
        jpeg: colourJpeg.toString('base64'),
        width: CROP_W,
        height: CROP_H,
        tier: 'ram-fullframe',
      })
      nowSpy.mockReturnValue(2_000_000)
      await refused.transport.getNativeCropJpeg(HANDLE, FULL_FRAME_WINDOW, undefined, 102)
      const missLine = refused.entries.find((e) => e.message === 'native-crop window')
      expect(missLine?.extras).toMatchObject({
        meta: { nativeHits: 0, detectionFrameFallbacks: 1 },
      })
    } finally {
      nowSpy.mockRestore()
      takeSeamCount()
    }
  })
})

describe('the two consumers that KEEP the decode still decode', () => {
  it('a full frame (getNativeFullFrameRgb) still arrives as raw RGB pixels', async () => {
    const h = harness({
      jpeg: colourJpeg.toString('base64'),
      width: CROP_W,
      height: CROP_H,
      tier: 'native',
    })
    const frame = await h.transport.getNativeFullFrameRgb(HANDLE, 1920)
    takeSeamCount()
    expect(frame?.format).toBe('rgb')
    // The boxed timeline tile draws ON this surface, so the pixels are still here.
    expect(frame?.data.length).toBe(CROP_W * CROP_H * 3)
  })

  it('captureDisplayCrop LEG 2 (the FALLBACK) still decodes — it cuts a region', async () => {
    // LEG 1 misses (ROI request answered `null`); LEG 2 serves the full frame,
    // which must be decoded so the region can be cut out of it.
    const h = harnessResolving((request) =>
      isFullFrameRequest(request)
        ? {
            jpeg: colourJpeg.toString('base64'),
            width: CROP_W,
            height: CROP_H,
            tier: 'native',
          }
        : null,
    )
    const out = await h.transport.captureDisplayCrop(
      HANDLE,
      { x: 10, y: 10, w: 20, h: 20 },
      640,
      360,
      0.1,
      'track-1',
    )
    const seamCount = takeSeamCount()
    expect(out).not.toBeNull()
    // ONE decode of the full frame + ONE encode of the cut region. This is the
    // leg that genuinely crops, and it is inside the SAME function as the
    // pass-through leg — which is why it is asserted, not assumed.
    expect(seamCount).toBe(2)
    expect(out?.equals(colourJpeg)).toBe(false)
    const meta = await sharp(out ?? Buffer.alloc(0)).metadata()
    expect(meta.format).toBe('jpeg')
    // The cut region, not the whole frame: a 20px box padded on a 640x360
    // frame maps to a fraction of the 64x48 served raster.
    expect(meta.width).toBeLessThan(CROP_W)
  })
})

describe('captureDisplayCrop LEG 1 — the native ROI, handed on (F1b)', () => {
  const displayCrop = (h: Harness): Promise<Buffer | null> =>
    h.transport.captureDisplayCrop(HANDLE, { x: 10, y: 10, w: 20, h: 20 }, 640, 360, 0.1, 'track-1')

  it('performs NO decode: zero sharp constructions on a native-ROI hit', async () => {
    const h = harness({
      jpeg: colourJpeg.toString('base64'),
      width: CROP_W,
      height: CROP_H,
      tier: 'native',
    })
    const out = await displayCrop(h)
    const seamCount = takeSeamCount()
    expect(out).not.toBeNull()
    expect(seamCount).toBe(0)
  })

  it('returns the runner’s bytes VERBATIM — these ARE the gallery tiles', async () => {
    const h = harness({
      jpeg: lowQualityJpeg.toString('base64'),
      width: CROP_W,
      height: CROP_H,
      tier: 'native',
    })
    const out = await displayCrop(h)
    takeSeamCount()
    expect(out?.equals(lowQualityJpeg)).toBe(true)
  })

  it('preserves a 1-channel payload — a decode→RGB→encode cannot', async () => {
    const h = harness({
      jpeg: grayJpeg.toString('base64'),
      width: CROP_W,
      height: CROP_H,
      tier: 'native',
    })
    const out = await displayCrop(h)
    takeSeamCount()
    const meta = await sharp(out ?? Buffer.alloc(0)).metadata()
    expect(meta.channels).toBe(1)
  })

  it('does NOT apply the subject-crop TIER GATE — a display tile may be sub-native', async () => {
    // The gallery's whole point is to show something honest rather than
    // nothing; `getNativeCropJpeg` refuses `ram-fullframe`, this path must not.
    const h = harness({
      jpeg: colourJpeg.toString('base64'),
      width: CROP_W,
      height: CROP_H,
      tier: 'ram-fullframe',
    })
    const out = await displayCrop(h)
    takeSeamCount()
    expect(out?.equals(colourJpeg)).toBe(true)
  })

  it('LEG 1 is tried FIRST — a hit never reaches the full-frame fallback', async () => {
    const h = harness({
      jpeg: colourJpeg.toString('base64'),
      width: CROP_W,
      height: CROP_H,
      tier: 'native',
    })
    await displayCrop(h)
    takeSeamCount()
    expect(h.requests).toHaveLength(1)
    expect(isFullFrameRequest(defined(h.requests[0], 'requests[0]'))).toBe(false)
  })
})

describe('a corrupt reply is a MISS, not a throw', () => {
  // The normalizer runs inside the fetch's catch. It has to: the display crop
  // awaits leg 1 with no try of its own, so a decode that throws would skip
  // leg 2 and lose a tile the retained frame could still have served.
  const corrupt = (): ReplyStub => ({
    jpeg: Buffer.from('not a jpeg at all').toString('base64'),
    width: CROP_W,
    height: CROP_H,
    tier: 'native',
  })

  it('getNativeFullFrameRgb still THROWS — a routing failure is not a miss', async () => {
    // NOT a miss: the full-frame fetch reports a failure as an exception, and
    // only the display fallback below translates it to `null`, at its own
    // call site. Collapsing it to `null` here would hide the difference.
    const h = harness(corrupt())
    await expect(h.transport.getNativeFullFrameRgb(HANDLE, 1920)).rejects.toThrow()
    takeSeamCount()
  })

  it('captureDisplayCrop answers null when LEG 2 cannot decode, rather than rejecting', async () => {
    // Leg 1 misses; leg 2's full frame will not decode. Before the normalizer
    // was moved back inside the catch this rejected, and `createDisplayCrop`
    // awaits its legs with no try of its own — so the caller got an exception
    // where the contract promises `null`.
    const h = harnessResolving((request) => (isFullFrameRequest(request) ? corrupt() : null))
    const out = await h.transport.captureDisplayCrop(
      HANDLE,
      { x: 10, y: 10, w: 20, h: 20 },
      640,
      360,
      0.1,
      'track-1',
    )
    takeSeamCount()
    expect(out).toBeNull()
    // And the drop is NAMED, not silent (CLAUDE.md).
    const line = h.entries.find((e) => e.message.includes('display crop fallback used'))
    expect(line?.extras).toMatchObject({ meta: { reason: 'unavailable' } })
  })

  it('a jpeg-shaped reply is TRUSTED, not re-validated — same contract as getFullFrameJpegBase64', async () => {
    // Stated so it is a decision on the record rather than an oversight: the
    // pass-through legs no longer decode, so they no longer implicitly validate.
    // Re-adding a decode to validate would restore the exact cost F1/F1b remove,
    // and `getFullFrameJpegBase64` has passed the wire JPEG on unvalidated since
    // it was written. The runner encodes with sharp; a corrupt payload here means
    // the transport corrupted it, which is not a case a decode should paper over.
    const h = harness(corrupt())
    const out = await h.transport.getNativeCropJpeg(HANDLE, ROI, undefined, 102)
    const seamCount = takeSeamCount()
    expect(seamCount).toBe(0)
    expect(out?.equals(Buffer.from('not a jpeg at all'))).toBe(true)
  })
})

describe('the decoded surface is handed over, not copied — the precondition', () => {
  /**
   * `cropReplyToRgb` used to `Buffer.from()` the buffer `decodeJpegToRgb` had
   * just allocated, and the display fallback copied it a second time — two full
   * duplicates of a raw RGB surface (6.2 MB each at 1920 wide) per key-frame
   * capture, immediately garbage, which is exactly the fragmenting shape the
   * `native-residue` heap profile is made of.
   *
   * Dropping a copy is safe if and only if NO consumer mutates the buffer. That
   * is not observable from a return value, so it is asserted directly against
   * the REAL consumer: the fallback leg's region cut.
   */
  it('the real consumer only READS the surface', async () => {
    const h = harness({
      jpeg: colourJpeg.toString('base64'),
      width: CROP_W,
      height: CROP_H,
      tier: 'native',
    })
    const frame = await h.transport.getNativeFullFrameRgb(HANDLE, 1920)
    takeSeamCount()
    expect(frame).not.toBeNull()
    const surface = frame?.data ?? Buffer.alloc(0)
    const before = Buffer.from(surface)

    // The display fallback leg's cut.
    const cut = await extractCrop(surface, CROP_W, CROP_H, { x: 0.1, y: 0.1, w: 0.3, h: 0.3 })
    takeSeamCount()

    expect(cut.crop.byteLength).toBeGreaterThan(0)
    // THE ASSERTION: after the read, the surface is byte-for-byte intact.
    expect(surface.equals(before)).toBe(true)
  })
})
