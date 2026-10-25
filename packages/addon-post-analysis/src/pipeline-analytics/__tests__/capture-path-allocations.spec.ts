/**
 * Allocation ledger of the per-track capture paths, before vs after (D867).
 *
 * `pipeline-analytics` RSS sat at 540-880 MB with ~48 MB/s of freshly faulted
 * pages and 1-2 full GCs a second, driven by external-memory pressure from
 * media Buffer churn. This spec runs each path N times on fixtures and counts
 * the bytes it MATERIALISES in this process — sharp outputs handed back to JS,
 * Buffer copies, base64 strings and their decodes, Float32Array wrappers —
 * for the removed code (replicated inline, exactly as it was) and for the
 * current code. It prints the table and asserts the current path allocates less.
 *
 * Counted, not sampled: `process.memoryUsage().arrayBuffers` deltas are decided
 * by when V8 happens to collect, which is the very thing under study.
 */
import sharp from 'sharp'
import type { FrameHandle, IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { drawBoxedFrame, drawBoxedJpeg } from '../../shared/frame/box-drawer.js'
import { decodeJpegToRgb } from '../../shared/frame/encode-crop.js'
import { rankIdentities, type GallerySample } from '../pipeline/face-matcher.js'
import { createKeyFrameCrop } from '../pipeline/keyframe-crop.js'
import { EventMediaDispatcher } from '../services/event-media-dispatcher.js'

const ROUNDS = 8

interface Ledger {
  sharpOutBytes: number
  copyBytes: number
  base64Bytes: number
  float32Bytes: number
}

const ledger: Ledger = { sharpOutBytes: 0, copyBytes: 0, base64Bytes: 0, float32Bytes: 0 }

function reset(): void {
  ledger.sharpOutBytes = 0
  ledger.copyBytes = 0
  ledger.base64Bytes = 0
  ledger.float32Bytes = 0
}

function total(): number {
  return ledger.sharpOutBytes + ledger.copyBytes + ledger.base64Bytes + ledger.float32Bytes
}

function resultBytes(r: unknown): number {
  if (Buffer.isBuffer(r)) return r.length
  if (typeof r === 'object' && r !== null && 'data' in r && Buffer.isBuffer(r.data)) {
    return r.data.length
  }
  return 0
}

/** Install the counters; returns the restore function. */
function install(): () => void {
  const sharpProto = Object.getPrototypeOf(
    sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } }),
  )
  const origToBuffer = Reflect.get(sharpProto, 'toBuffer')
  Reflect.set(sharpProto, 'toBuffer', function (this: unknown, ...args: unknown[]) {
    const p: Promise<unknown> = Reflect.apply(origToBuffer, this, args)
    return p.then((r: unknown) => {
      ledger.sharpOutBytes += resultBytes(r)
      return r
    })
  })

  const origFrom = Buffer.from
  Reflect.set(Buffer, 'from', (...args: unknown[]) => {
    const out = Reflect.apply(origFrom, Buffer, args)
    const a0 = args[0]
    if (typeof a0 === 'string' && args[1] === 'base64') ledger.base64Bytes += out.length
    else if (a0 instanceof Uint8Array) ledger.copyBytes += out.length
    return out
  })

  const origToString = Buffer.prototype.toString
  Reflect.set(Buffer.prototype, 'toString', function (this: Buffer, ...args: unknown[]) {
    const out: unknown = Reflect.apply(origToString, this, args)
    if (args[0] === 'base64' && typeof out === 'string') ledger.base64Bytes += out.length
    return out
  })

  const OrigF32 = globalThis.Float32Array
  Reflect.set(
    globalThis,
    'Float32Array',
    new Proxy(OrigF32, {
      construct(target, args: unknown[]): object {
        const a0 = args[0]
        if (typeof a0 === 'number') ledger.float32Bytes += a0 * 4
        else if (typeof a0 === 'object' && a0 !== null && 'length' in a0) {
          if (typeof a0.length === 'number' && !(a0 instanceof ArrayBuffer)) {
            ledger.float32Bytes += a0.length * 4
          }
        }
        return Reflect.construct(target, args)
      },
    }),
  )

  return (): void => {
    Reflect.set(sharpProto, 'toBuffer', origToBuffer)
    Reflect.set(Buffer, 'from', origFrom)
    Reflect.set(Buffer.prototype, 'toString', origToString)
    Reflect.set(globalThis, 'Float32Array', OrigF32)
  }
}

function sceneRgb(width: number, height: number): Buffer {
  const b = Buffer.allocUnsafe(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3
      b[i] = Math.round((x / width) * 200) ^ (y & 7)
      b[i + 1] = Math.round((y / height) * 200)
      b[i + 2] = (x * 7 + y * 13) & 0xff
    }
  }
  return b
}

async function jpegOf(width: number, height: number): Promise<Buffer> {
  return sharp(sceneRgb(width, height), { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 90 })
    .toBuffer()
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

interface Row {
  readonly scenario: string
  readonly before: number
  readonly after: number
}
const rows: Row[] = []

function mb(n: number): string {
  return (n / 1048576).toFixed(2)
}

describe('capture-path allocations, before vs after (D867)', () => {
  let restore: () => void
  beforeEach(() => {
    restore = install()
    reset()
  })
  afterEach(() => {
    restore()
  })

  it('boxed timeline tile: decode+draw in JS vs ONE libvips pipeline', async () => {
    const jpeg = await jpegOf(960, 540)
    const box = { x: 100, y: 80, w: 200, h: 160, label: 'person' }
    reset()
    for (let i = 0; i < ROUNDS; i++) {
      const rgb = await decodeJpegToRgb(jpeg)
      await Promise.all([
        drawBoxedFrame(rgb.bytes, rgb.width, rgb.height, [box], { quality: 80 }),
        drawBoxedFrame(rgb.bytes, rgb.width, rgb.height, [], { quality: 80 }),
      ])
    }
    const before = total()
    reset()
    for (let i = 0; i < ROUNDS; i++) {
      await Promise.all([
        drawBoxedJpeg(jpeg, 960, 540, [box], { quality: 80 }),
        drawBoxedJpeg(jpeg, 960, 540, [], { quality: 80 }),
      ])
    }
    const after = total()
    rows.push({ scenario: 'boxed tile 960x540 (tile + clean twin)', before, after })
    expect(after).toBeLessThan(before * 0.5)
  })

  it('keyframe crop: base64 + RGB copy vs bytes, no copy', async () => {
    const jpeg = await jpegOf(1920, 1080)
    const crop = async (_b: Buffer, w: number, h: number): Promise<Buffer> =>
      Buffer.alloc(Math.min(w * h, 1000))
    reset()
    for (let i = 0; i < ROUNDS; i++) {
      // The removed shape: MediaStore base64 string -> sharp decodes the string
      // back to bytes -> RGB -> a defensive copy of the RGB surface.
      const base64 = jpeg.toString('base64')
      const rgb = await decodeJpegToRgb(base64)
      await crop(Buffer.from(rgb.bytes), rgb.width, rgb.height)
    }
    const before = total()
    reset()
    const fn = createKeyFrameCrop({
      getMedia: async () => ({ bytes: jpeg, timestamp: 1000 }),
      decodeJpegToRgb: (b) => decodeJpegToRgb(b),
      cropRegionToJpeg: async (b, w, h) => crop(b, w, h),
      maxSkewMs: 5000,
      minSubjectIou: 0.5,
      maxSubjectSampleGapMs: 1000,
      logger: logger(),
    })
    for (let i = 0; i < ROUNDS; i++) {
      await fn({
        deviceId: 1,
        mediaId: 1,
        bbox: { x: 192, y: 108, w: 384, h: 216 },
        frameWidth: 1920,
        frameHeight: 1080,
        padding: 0,
        timestamp: 1000,
      })
    }
    const after = total()
    rows.push({ scenario: 'keyframe crop 1920x1080', before, after })
    expect(after).toBeLessThan(before * 0.7)
  })

  it('pinned detection frame: a private copy vs the fetched buffer', async () => {
    const handle: FrameHandle = {
      shmId: 's',
      slot: 0,
      seq: 1,
      width: 640,
      height: 360,
      format: 'rgb',
      pts: 0,
      byteLength: 640 * 360 * 3,
      nodeId: 'n',
      slotCount: 4,
    }
    const fetched = {
      data: sceneRgb(640, 360),
      width: 640,
      height: 360,
      format: 'rgb' as const,
      timestamp: 0,
    }
    reset()
    for (let i = 0; i < ROUNDS; i++) {
      const copy = { ...fetched, data: Buffer.from(fetched.data) }
      expect(copy.data.length).toBe(fetched.data.length)
    }
    const before = total()
    reset()
    const dispatcher = new EventMediaDispatcher({
      getRemoteFrame: async () => fetched,
      getNativeCropJpeg: async () => null,
      getNativeFullFrameRgb: async () => null,
      getParkedSubjectSlab: async () => null,
      mediaStore: { put: async () => 1, putReplacing: async () => 1 },
      logger: logger(),
    })
    for (let i = 0; i < ROUNDS; i++) await dispatcher.resolvePinnedFrame(1, handle)
    const after = total()
    rows.push({ scenario: 'pinned 640x360 frame', before, after })
    expect(after).toBe(0)
    expect(before).toBeGreaterThan(0)
  })

  it('face probe against a 3200-sample gallery: per-sample wrapper vs held Float32Array', () => {
    const DIM = 512
    const SAMPLES = 3200
    const numbers: GallerySample[] = []
    const floats: GallerySample[] = []
    for (let i = 0; i < SAMPLES; i++) {
      const v = Array.from({ length: DIM }, (_, k) => Math.fround(Math.sin(i * 31 + k)))
      numbers.push({ identityId: `id-${i % 80}`, embedding: v, modelId: 'm' })
      floats.push({ identityId: `id-${i % 80}`, embedding: new Float32Array(v), modelId: 'm' })
    }
    const probe = {
      embedding: Array.from({ length: DIM }, (_, k) => Math.fround(Math.cos(k))),
      modelId: 'm',
    }
    reset()
    for (let i = 0; i < ROUNDS; i++) rankIdentities(probe, numbers, 1)
    const before = total()
    reset()
    for (let i = 0; i < ROUNDS; i++) rankIdentities(probe, floats, 1)
    const after = total()
    rows.push({ scenario: `face probe x${SAMPLES} samples`, before, after })
    // The probe itself is wrapped once per call: ROUNDS x DIM x 4 bytes.
    expect(after).toBe(ROUNDS * DIM * 4)
    expect(before).toBeGreaterThan(after * 100)
  })

  it('prints the ledger', () => {
    const lines = rows.map(
      (r) =>
        `  ${r.scenario.padEnd(42)} before ${mb(r.before).padStart(9)} MB   after ${mb(r.after).padStart(9)} MB   (${ROUNDS} rounds)`,
    )
    process.stdout.write(`\n[D867 allocation ledger]\n${lines.join('\n')}\n`)
    expect(rows.length).toBe(4)
  })
})
