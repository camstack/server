/**
 * The capture half: a debug crop is stored WITH its attribution, is bounded per
 * track, costs an unmarked track nothing, and every path that stores nothing
 * says why.
 */
import type { FrameHandle } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type DebugCropCaptureDeps,
  type DebugCropCaptureInput,
  createDebugCropCapture,
} from '../debug-crop-capture.js'
import { DEBUG_CROPS_PER_TRACK_MAX } from '../debug-crop-plan.js'

const FW = 1920
const FH = 1080
/** The fetched frame is capped, so it is NOT the detection frame's dims — the
 *  whole point of the scaling this suite pins. */
const FETCH_W = 960
const FETCH_H = 540

const HANDLE = { nodeId: 'hub' } as unknown as FrameHandle

interface Line {
  readonly msg: string
  readonly meta: Record<string, unknown>
  readonly tags: Record<string, unknown>
}

interface Harness {
  readonly deps: DebugCropCaptureDeps
  readonly lines: Line[]
  readonly put: ReturnType<typeof vi.fn>
  readonly marked: Set<string>
}

function makeDeps(over: Partial<DebugCropCaptureDeps> = {}): Harness {
  const lines: Line[] = []
  const marked = new Set<string>(['aaa111'])
  const record =
    (level: string) =>
    (message: string, ctx?: { meta?: Record<string, unknown>; tags?: Record<string, unknown> }) => {
      lines.push({ msg: `${level}:${message}`, meta: ctx?.meta ?? {}, tags: ctx?.tags ?? {} })
    }
  const put = vi.fn(async () => 42)
  const deps: DebugCropCaptureDeps = {
    isDebugMarked: (trackId) => marked.has(trackId),
    fetchFrameRgb: vi.fn(async () => ({
      bytes: Buffer.alloc(3),
      width: FETCH_W,
      height: FETCH_H,
    })),
    extractCropRaw: vi.fn(async (_d, _w, _h, box) => ({
      data: Buffer.alloc(3),
      width: Math.max(1, Math.round(box.w * FETCH_W)),
      height: Math.max(1, Math.round(box.h * FETCH_H)),
    })),
    drawBoxedFrame: vi.fn(async () => Buffer.from('jpeg')),
    putDebugCrop: put,
    logger: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    } as unknown as DebugCropCaptureDeps['logger'],
    ...over,
  }
  return { deps, lines, put, marked }
}

function input(over: Partial<DebugCropCaptureInput> = {}): DebugCropCaptureInput {
  return {
    deviceId: 101,
    trackId: 'aaa111',
    decision: 'best-shot',
    subject: { x: 900, y: 500, w: 40, h: 40 },
    rival: { x: 1000, y: 560, w: 120, h: 180 },
    frameHandle: HANDLE,
    frameWidth: FW,
    frameHeight: FH,
    timestamp: 1_700_000_000_000,
    evidence: { areaRatio: 13.5, centroidDist: 118.4, accepted: true },
    ...over,
  }
}

describe('createDebugCropCapture', () => {
  let ctx: Harness
  beforeEach(() => {
    ctx = makeDeps()
  })

  it('costs an UNMARKED track nothing — no fetch, no store, no line', async () => {
    const capture = createDebugCropCapture(ctx.deps)
    expect(await capture(input({ trackId: 'not-marked' }))).toBeNull()
    expect(ctx.deps.fetchFrameRgb).not.toHaveBeenCalled()
    expect(ctx.put).not.toHaveBeenCalled()
    // A designed no-op is NOT dropped work: silence here is correct, and a line
    // per frame per camera is exactly what this gate exists to avoid.
    expect(ctx.lines).toHaveLength(0)
  })

  it('stores ONE crop, carrying the decision and its numbers on the line', async () => {
    const capture = createDebugCropCapture(ctx.deps)
    expect(await capture(input())).toBe(42)
    expect(ctx.put).toHaveBeenCalledTimes(1)
    const stored = ctx.put.mock.calls[0]?.[0] as Record<string, unknown>
    expect(stored['trackId']).toBe('aaa111')
    expect(stored['deviceId']).toBe(101)
    const line = ctx.lines.find((l) => l.msg === 'info:debug crop stored')
    expect(line).toBeDefined()
    expect(line?.tags['deviceId']).toBe(101)
    expect(line?.meta['decision']).toBe('best-shot')
    expect(line?.meta['areaRatio']).toBe(13.5)
    expect(line?.meta['cropRect']).toBeTypeOf('string')
  })

  it('SCALES the drawn boxes into the fetched frame — which is not the detection frame', async () => {
    const capture = createDebugCropCapture(ctx.deps)
    await capture(input())
    const draw = ctx.deps.drawBoxedFrame as unknown as ReturnType<typeof vi.fn>
    const call = draw.mock.calls[0]
    const cutWidth = call?.[1] as number
    const boxes = call?.[3] as ReadonlyArray<{ x: number; w: number; label?: string }>
    expect(boxes).toHaveLength(2)
    expect(boxes[0]?.label).toContain('best-shot')
    expect(boxes[1]?.label).toBe('rival')
    // The detection-space subject is 40 px wide; the fetched frame is half the
    // detection frame's width, so the drawn box must be 20. Drawing it at 40
    // would put the box beside the subject, not on it.
    expect(boxes[0]?.w).toBeCloseTo(20, 3)
    expect(boxes[0]?.x).toBeGreaterThanOrEqual(0)
    expect(boxes[0]?.x).toBeLessThan(cutWidth)
  })

  it('logs a REFUSAL when the frame cannot be fetched, and stores nothing', async () => {
    const h = makeDeps({ fetchFrameRgb: vi.fn(async () => null) })
    const capture = createDebugCropCapture(h.deps)
    expect(await capture(input())).toBeNull()
    expect(h.put).not.toHaveBeenCalled()
    const line = h.lines.find((l) => l.meta['reason'] === 'frame-unavailable')
    expect(line).toBeDefined()
    expect(line?.tags['deviceId']).toBe(101)
    expect(line?.meta['decision']).toBe('best-shot')
  })

  it('logs a REFUSAL when the plan says no, and stores nothing', async () => {
    const capture = createDebugCropCapture(ctx.deps)
    expect(await capture(input({ subject: { x: 0, y: 0, w: 0, h: 0 } }))).toBeNull()
    expect(ctx.put).not.toHaveBeenCalled()
    const line = ctx.lines.find((l) => l.meta['reason'] === 'degenerate-subject')
    expect(line).toBeDefined()
    expect(line?.tags['deviceId']).toBe(101)
  })

  it('bounds the crops one track may own, and says so once', async () => {
    const capture = createDebugCropCapture(ctx.deps)
    for (let i = 0; i < DEBUG_CROPS_PER_TRACK_MAX; i += 1) {
      expect(await capture(input({ timestamp: 1_000 + i }))).toBe(42)
    }
    expect(await capture(input({ timestamp: 9_999 }))).toBeNull()
    expect(ctx.put).toHaveBeenCalledTimes(DEBUG_CROPS_PER_TRACK_MAX)
    expect(ctx.lines.filter((l) => l.meta['reason'] === 'per-track-cap')).toHaveLength(1)
    await capture(input({ timestamp: 10_000 }))
    expect(ctx.lines.filter((l) => l.meta['reason'] === 'per-track-cap')).toHaveLength(1)
  })

  it('does not fetch a frame it has already decided not to use', async () => {
    const capture = createDebugCropCapture(ctx.deps)
    for (let i = 0; i < DEBUG_CROPS_PER_TRACK_MAX; i += 1) await capture(input({ timestamp: i }))
    const before = (ctx.deps.fetchFrameRgb as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    await capture(input({ timestamp: 9_999 }))
    expect((ctx.deps.fetchFrameRgb as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      before,
    )
  })

  it('counts per TRACK, not globally', async () => {
    ctx.marked.add('bbb222')
    const capture = createDebugCropCapture(ctx.deps)
    for (let i = 0; i < DEBUG_CROPS_PER_TRACK_MAX; i += 1) await capture(input({ timestamp: i }))
    expect(await capture(input({ trackId: 'bbb222' }))).toBe(42)
  })

  it('a failed store is reported with the attribution, never swallowed', async () => {
    const h = makeDeps({
      putDebugCrop: vi.fn(async () => {
        throw new Error('disk full')
      }),
    })
    const capture = createDebugCropCapture(h.deps)
    expect(await capture(input())).toBeNull()
    const line = h.lines.find((l) => l.msg.startsWith('warn:'))
    expect(line).toBeDefined()
    expect(line?.tags['deviceId']).toBe(101)
    expect(line?.meta['decision']).toBe('best-shot')
    expect(String(line?.meta['error'])).toContain('disk full')
  })

  it('a render failure is named, not confused with a missing frame', async () => {
    const h = makeDeps({
      extractCropRaw: vi.fn(async () => {
        throw new Error('memory area too small')
      }),
    })
    const capture = createDebugCropCapture(h.deps)
    expect(await capture(input())).toBeNull()
    const line = h.lines.find((l) => l.meta['reason'] === 'render-failed')
    expect(line).toBeDefined()
    expect(line?.tags['deviceId']).toBe(101)
  })
})
