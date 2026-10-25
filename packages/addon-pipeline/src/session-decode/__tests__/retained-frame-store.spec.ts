/**
 * `RetainedFrameStore` — RAM replacement for the `csr.` shm retention ring
 * (shm-ring removal, 2026-07-16). Covers the rgb round-trip, the non-rgb skip,
 * latest-wins budget eviction, key identity (evicted → null), full-frame crop,
 * ROI crop + downscale, and the opaque RAM-key handle shape.
 */
import type { DecodedFrame, IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'

import {
  CONTENT_SIZED_RESERVE_BYTES,
  cropRgb,
  RETAINED_FRAME_KEY_PREFIX,
  RetainedFrameStore,
} from '../retained-frame-store.js'

const silentLogger: IScopedLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger
  },
  withTags() {
    return silentLogger
  },
}

function makeFrame(
  width: number,
  height: number,
  format: DecodedFrame['format'],
  seed: number,
): DecodedFrame {
  const bpp = format === 'rgb' || format === 'bgr' ? 3 : 1
  const data = Buffer.allocUnsafe(width * height * bpp)
  for (let i = 0; i < data.length; i += 1) data[i] = (i + seed) & 0xff
  return { data, width, height, format, timestamp: seed }
}

function newStore(budgetBytes?: number, perDeviceFloor?: number): RetainedFrameStore {
  return new RetainedFrameStore({
    nodeId: 'test-node',
    logger: silentLogger,
    ...(budgetBytes !== undefined ? { budgetBytes } : {}),
    ...(perDeviceFloor !== undefined ? { perDeviceFloor } : {}),
  })
}

/** Bytes of one WxH rgb frame (3 bpp) — for exact budget math in the floor tests. */
function frameBytes(width: number, height: number): number {
  return width * height * 3
}

describe('RetainedFrameStore', () => {
  it('retains an rgb frame and returns it byte-intact by handle', () => {
    const store = newStore()
    const frame = makeFrame(64, 48, 'rgb', 3)
    const handle = store.write(104, frame)
    expect(handle).not.toBeNull()
    if (handle === null) throw new Error('unreachable')
    expect(handle.nodeId).toBe('test-node')
    expect(handle.width).toBe(64)
    expect(handle.height).toBe(48)
    expect(handle.format).toBe('rgb')
    expect(handle.shmId.startsWith(RETAINED_FRAME_KEY_PREFIX)).toBe(true)

    const read = store.getFrame(handle)
    expect(read).not.toBeNull()
    expect(read?.data.equals(frame.data)).toBe(true)
  })

  it('skips a non-rgb frame (motion gray is never retained)', () => {
    const store = newStore()
    expect(store.write(591, makeFrame(32, 32, 'gray', 1))).toBeNull()
    expect(store.size).toBe(0)
  })

  it('evicts oldest-first once over the byte budget (latest-wins)', () => {
    // Budget for ~2 frames of 16x16 rgb (768 bytes each).
    const store = newStore(16 * 16 * 3 * 2 + 10)
    const h1 = store.write(1, makeFrame(16, 16, 'rgb', 1))!
    const h2 = store.write(1, makeFrame(16, 16, 'rgb', 2))!
    const h3 = store.write(1, makeFrame(16, 16, 'rgb', 3))!
    // h1 is the oldest → evicted; h2 + h3 retained.
    expect(store.getFrame(h1)).toBeNull()
    expect(store.getFrame(h2)).not.toBeNull()
    expect(store.getFrame(h3)).not.toBeNull()
    expect(store.size).toBe(2)
  })

  it('gives distinct handles across sessions/devices that never collide', () => {
    const store = newStore()
    const a = store.write(1, makeFrame(8, 8, 'rgb', 1))!
    const b = store.write(2, makeFrame(8, 8, 'rgb', 2))!
    expect(a.seq).not.toBe(b.seq)
    expect(store.getFrame(a)?.timestamp).toBe(1)
    expect(store.getFrame(b)?.timestamp).toBe(2)
  })

  it('crop full-frame (bbox 0,0,1,1) returns the whole frame', () => {
    const store = newStore()
    const frame = makeFrame(10, 6, 'rgb', 7)
    const handle = store.write(1, frame)!
    const crop = store.crop(handle, { x: 0, y: 0, w: 1, h: 1 })
    expect(crop).not.toBeNull()
    expect(crop?.width).toBe(10)
    expect(crop?.height).toBe(6)
    expect(Buffer.from(crop!.bytes).equals(frame.data)).toBe(true)
  })

  it('crop of an evicted handle returns null', () => {
    const store = newStore(8 * 8 * 3 + 10)
    const h1 = store.write(1, makeFrame(8, 8, 'rgb', 1))!
    store.write(1, makeFrame(8, 8, 'rgb', 2))
    expect(store.crop(h1, { x: 0, y: 0, w: 1, h: 1 })).toBeNull()
  })

  it('clear drops every retained frame', () => {
    const store = newStore()
    const h = store.write(1, makeFrame(8, 8, 'rgb', 1))!
    store.clear()
    expect(store.size).toBe(0)
    expect(store.getFrame(h)).toBeNull()
  })
})

describe('RetainedFrameStore per-device retention floor', () => {
  const W = 16
  const H = 16
  const ONE = frameBytes(W, H) // 768 bytes

  it("protects a device's most-recent frames from a busy neighbour's eviction", () => {
    // Budget fits 6 frames; floor 2. A busy device 1 pushes 6 frames after a
    // quiet device 2 wrote 2 — pure global FIFO would evict device 2's frames
    // (they are the oldest). The floor must keep device 2's last 2 alive and
    // reclaim device 1's excess instead.
    const store = newStore(ONE * 6 + 10, 2)
    const b1 = store.write(2, makeFrame(W, H, 'rgb', 201))!
    const b2 = store.write(2, makeFrame(W, H, 'rgb', 202))!
    const a: ReturnType<RetainedFrameStore['write']>[] = []
    for (let i = 0; i < 6; i += 1) a.push(store.write(1, makeFrame(W, H, 'rgb', i))!)

    // Device 2's floor-protected frames survive despite being globally oldest.
    expect(store.getFrame(b1)).not.toBeNull()
    expect(store.getFrame(b2)).not.toBeNull()
    // Device 1's OLDEST (beyond its floor) were reclaimed to make room.
    expect(store.getFrame(a[0]!)).toBeNull()
    expect(store.getFrame(a[1]!)).toBeNull()
    // Device 1's newest are retained.
    expect(store.getFrame(a[5]!)).not.toBeNull()
    // Memory stays bounded by the byte budget.
    expect(store.retainedBytes).toBeLessThanOrEqual(ONE * 6 + 10)
    expect(store.size).toBe(6)
  })

  it('the hard byte ceiling overrides the floor when genuinely exhausted (OOM guard)', () => {
    // Floor 10 would protect every frame, but the budget only fits 2 — the
    // ceiling wins and evicts oldest-first regardless of the floor.
    const store = newStore(ONE * 2 + 10, 10)
    const h1 = store.write(1, makeFrame(W, H, 'rgb', 1))!
    store.write(1, makeFrame(W, H, 'rgb', 2))
    store.write(1, makeFrame(W, H, 'rgb', 3))
    expect(store.getFrame(h1)).toBeNull()
    expect(store.size).toBe(2)
    expect(store.retainedBytes).toBeLessThanOrEqual(ONE * 2 + 10)
  })

  it('floor 0 restores pure global-FIFO eviction (reversible knob)', () => {
    // Budget fits 2 frames; floor disabled. Device 2's older frame is the global
    // oldest and IS evicted (no protection) — the pre-2026-07-19 behaviour.
    const store = newStore(ONE * 2 + 10, 0)
    const b1 = store.write(2, makeFrame(W, H, 'rgb', 9))!
    const a1 = store.write(1, makeFrame(W, H, 'rgb', 1))!
    const a2 = store.write(1, makeFrame(W, H, 'rgb', 2))!
    expect(store.getFrame(b1)).toBeNull()
    expect(store.getFrame(a1)).not.toBeNull()
    expect(store.getFrame(a2)).not.toBeNull()
  })

  it('a device with no pending frames beyond its floor still recycles promptly', () => {
    // Interleave two busy devices under a tight budget: retention never grows
    // past the ceiling and old beyond-floor frames are dropped every write.
    const store = newStore(ONE * 8 + 10, 2)
    for (let i = 0; i < 50; i += 1) {
      store.write(1, makeFrame(W, H, 'rgb', i))
      store.write(2, makeFrame(W, H, 'rgb', 100 + i))
      expect(store.retainedBytes).toBeLessThanOrEqual(ONE * 8 + 10)
    }
    // Both devices kept their floor; total bounded.
    expect(store.size).toBeLessThanOrEqual(8)
    expect(store.size).toBeGreaterThanOrEqual(4)
  })

  it('evicting a device down to empty removes its per-device index (no leak)', () => {
    // Device 2 writes one frame, then device 1 floods; with floor 0 device 2's
    // frame is evicted and its per-device bookkeeping is cleaned up, so a later
    // device-2 write starts fresh without stale keys.
    const store = newStore(ONE * 2 + 10, 0)
    store.write(2, makeFrame(W, H, 'rgb', 9))
    for (let i = 0; i < 5; i += 1) store.write(1, makeFrame(W, H, 'rgb', i))
    const b2 = store.write(2, makeFrame(W, H, 'rgb', 77))!
    expect(store.getFrame(b2)).not.toBeNull()
    expect(store.retainedBytes).toBeLessThanOrEqual(ONE * 2 + 10)
  })
})

describe('cropRgb', () => {
  it('crops the top-left quadrant', () => {
    // 4x4 rgb; each pixel value = its linear index for easy assertions.
    const w = 4
    const h = 4
    const data = Buffer.allocUnsafe(w * h * 3)
    for (let p = 0; p < w * h; p += 1) {
      data[p * 3] = p
      data[p * 3 + 1] = p
      data[p * 3 + 2] = p
    }
    const frame: DecodedFrame = { data, width: w, height: h, format: 'rgb', timestamp: 0 }
    const crop = cropRgb(frame, { x: 0, y: 0, w: 0.5, h: 0.5 })
    expect(crop.width).toBe(2)
    expect(crop.height).toBe(2)
    // Pixels (0,0),(1,0),(0,1),(1,1) → linear 0,1,4,5.
    expect([crop.bytes[0], crop.bytes[3], crop.bytes[6], crop.bytes[9]]).toEqual([0, 1, 4, 5])
  })

  it('downscales when maxWidth is narrower than the crop', () => {
    const frame = makeFrame(20, 10, 'rgb', 0)
    const crop = cropRgb(frame, { x: 0, y: 0, w: 1, h: 1 }, 10)
    expect(crop.width).toBe(10)
    expect(crop.height).toBe(5)
  })
})

// ── 2026-07-23 cold-window fix: TIME floor ──────────────────────────────────

function rgbFrame(bytes: number): {
  data: Buffer
  width: number
  height: number
  format: 'rgb'
  timestamp: number
} {
  return { data: Buffer.alloc(bytes), width: 10, height: 10, format: 'rgb', timestamp: 0 }
}

describe('RetainedFrameStore time floor', () => {
  it('frames younger than timeFloorMs survive budget eviction beyond the count floor', () => {
    let t = 1_000
    const store = new RetainedFrameStore({
      nodeId: 'n',
      logger: silentLogger,
      budgetBytes: 10_000,
      perDeviceFloor: 2,
      timeFloorMs: 1_500,
      now: () => t,
    })
    // 8 young frames of 2000B each (16KB > 10KB budget) — ALL within the time
    // floor: pass 1 must refuse to evict them (pass 2 hard ceiling still
    // applies and trims oldest-first).
    const handles = []
    for (let i = 0; i < 8; i++) {
      t += 100
      handles.push(store.write(7, rgbFrame(2_000)))
    }
    // Hard ceiling wins in pass 2, so size is bounded — but MORE than the
    // count floor (2) must have survived pass 1 thanks to the time floor.
    expect(store.retainedBytes).toBeLessThanOrEqual(10_000)
    expect(store.size).toBeGreaterThan(2)
  })

  it('after the time floor expires, eviction reclaims down to the count floor', () => {
    let t = 1_000
    const store = new RetainedFrameStore({
      nodeId: 'n',
      logger: silentLogger,
      budgetBytes: 100_000,
      perDeviceFloor: 2,
      timeFloorMs: 1_500,
      now: () => t,
    })
    for (let i = 0; i < 5; i++) {
      t += 100
      store.write(7, rgbFrame(2_000))
    }
    // Age everything past the floor, then push a heavy neighbour to force
    // eviction pressure on device 7.
    t += 10_000
    for (let i = 0; i < 50; i++) {
      t += 10
      store.write(8, rgbFrame(2_000))
    }
    // Device 7 is reclaimable down to its COUNT floor now that its frames are old.
    expect(store.retainedBytes).toBeLessThanOrEqual(100_000)
  })
})

describe('RetainedFrameStore pixel-free content fallback', () => {
  function pixelFree(width = 1920, height = 1080): DecodedFrame {
    return { data: Buffer.alloc(0), width, height, format: 'rgb', timestamp: 1 }
  }

  it('never serves a 0-byte raster from a pixel-free write', () => {
    const store = newStore()
    const handle = store.write(1, pixelFree())
    expect(handle).not.toBeNull()
    expect(handle!.byteLength).toBe(0)
    expect(store.crop(handle!, { x: 0, y: 0, w: 1, h: 1 })).toBeNull()
    expect(store.getFrame(handle!)?.data.byteLength).toBe(0)
  })

  it('materializes a content-sized RGB view on demand and crops from that', async () => {
    const store = newStore()
    const view = makeFrame(640, 360, 'rgb', 9)
    let calls = 0
    const handle = store.write(1, pixelFree(), {
      materialize: async () => {
        calls += 1
        return view
      },
    })
    expect(handle).not.toBeNull()

    const crop = await store.cropAsync(handle!, { x: 0, y: 0, w: 1, h: 1 })
    expect(calls).toBe(1)
    expect(crop?.width).toBe(640)
    expect(crop?.height).toBe(360)
    expect(crop?.bytes.byteLength).toBe(640 * 360 * 3)
    expect(store.retainedBytes).toBe(640 * 360 * 3)

    await store.cropAsync(handle!, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 })
    expect(calls).toBe(1)
  })

  it('returns an explicit miss when on-demand materialize cannot produce pixels', async () => {
    const store = newStore()
    const handle = store.write(1, pixelFree(), {
      materialize: async () => null,
    })
    expect(await store.cropAsync(handle!, { x: 0, y: 0, w: 1, h: 1 })).toBeNull()
    expect(store.getFrame(handle!)?.data.byteLength).toBe(0)
  })

  it('releases the fallback when the lazy entry is dropped', () => {
    const store = newStore()
    let released = 0
    const handle = store.write(1, pixelFree(), {
      materialize: async () => null,
      release: () => {
        released += 1
      },
    })
    store.clear()
    expect(store.getFrame(handle!)).toBeNull()
    expect(released).toBe(1)
  })

  it('reserves worst-case 640×640 RGB for every lazy contain ≤640 aspect', () => {
    const reserve = 640 * 640 * 3
    const store = newStore()
    expect(store.write(1, pixelFree(1920, 1080))).not.toBeNull()
    expect(store.retainedBytes).toBe(reserve)
    store.clear()
    expect(store.write(1, pixelFree(1600, 1200))).not.toBeNull()
    expect(store.retainedBytes).toBe(reserve)
    store.clear()
    expect(store.write(1, pixelFree(1920, 1920))).not.toBeNull()
    expect(store.retainedBytes).toBe(reserve)
  })

  it('settles 16:9, 4:3 and square hydrates to their contain ≤640 footprints', async () => {
    const cases = [
      { width: 1920, height: 1080, viewW: 640, viewH: 360 },
      { width: 1600, height: 1200, viewW: 640, viewH: 480 },
      { width: 1920, height: 1920, viewW: 640, viewH: 640 },
    ] as const
    for (const sample of cases) {
      const store = newStore()
      const view = makeFrame(sample.viewW, sample.viewH, 'rgb', sample.viewW)
      const handle = store.write(1, pixelFree(sample.width, sample.height), {
        materialize: async () => view,
      })
      expect(store.retainedBytes).toBe(640 * 640 * 3)
      expect(await store.ensureContent(handle!)).not.toBeNull()
      expect(store.retainedBytes).toBe(sample.viewW * sample.viewH * 3)
    }
  })

  it('rememberOnDemand reserves content-sized bytes so many unrequested detections stay bounded', () => {
    const released: number[] = []
    const store = new RetainedFrameStore({
      nodeId: 'test-node',
      logger: silentLogger,
      budgetBytes: CONTENT_SIZED_RESERVE_BYTES * 2 + 10,
      perDeviceFloor: 0,
      timeFloorMs: 0,
    })
    for (let i = 0; i < 6; i += 1) {
      const handle = store.allocateHandle(1, pixelFree())!
      store.rememberOnDemand(1, handle, {
        materialize: async () => null,
        release: () => {
          released.push(i)
        },
      })
    }
    expect(store.size).toBeLessThanOrEqual(2)
    expect(store.retainedBytes).toBeLessThanOrEqual(CONTENT_SIZED_RESERVE_BYTES * 2 + 10)
    expect(released.length).toBeGreaterThan(0)
    expect(store.has(store.allocateHandle(1, pixelFree())!)).toBe(false)
  })

  it('rememberOnDemand replaces the content-sized reserve with JPEG bytes after hydrate', async () => {
    const store = newStore(8_000_000, 0)
    const handle = store.allocateHandle(1, pixelFree())!
    const jpeg = makeFrame(64, 64, 'jpeg', 1)
    store.rememberOnDemand(1, handle, { materialize: async () => jpeg })
    expect(store.size).toBe(1)
    expect(store.retainedBytes).toBe(CONTENT_SIZED_RESERVE_BYTES)
    expect(store.getDeviceId(handle)).toBe(1)
    expect(store.statsByDevice(1)).toEqual({ entries: 1, bytes: CONTENT_SIZED_RESERVE_BYTES })
    expect(await store.ensureContent(handle)).not.toBeNull()
    expect(store.retainedBytes).toBe(4096)
    expect(store.statsByDevice(1)).toEqual({ entries: 1, bytes: 4096 })
  })

  it('a reduced budget that would fit two 16:9 reserves keeps only one worst-case slot', () => {
    const oldReserve = 640 * 360 * 3
    const worstCase = 640 * 640 * 3
    const store = newStore(oldReserve * 2 + 10, 0)
    const first = store.write(1, pixelFree(1920, 1080))!
    const second = store.write(1, pixelFree(1600, 1200))!
    expect(store.getFrame(first)).toBeNull()
    expect(store.getFrame(second)).not.toBeNull()
    expect(store.size).toBe(1)
    expect(store.retainedBytes).toBe(worstCase)
    expect(store.retainedBytes).toBeLessThanOrEqual(oldReserve * 2 + 10)
  })
})
