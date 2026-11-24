/**
 * #628 — the hub judges a lease handle itself, and one handle is retired for
 * the whole device. Live: handles aged 110 s during a camera outage were still
 * sent, and one refused handle was re-sent by other tracks within 250 ms.
 */
import type { DetailStepAnnounce, FrameHandle, IScopedLogger } from '@camstack/types'
import { NATIVE_CROP_LEASE_MAX_AGE_MS } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { TrackDetailDispatcher, type TrackDetailFrame } from '../detail-dispatcher.js'

const DEVICE_ID = 592
const NODE_ID = 'agent-1'

interface Line {
  readonly message: string
  readonly fields: { tags?: Record<string, unknown>; meta?: Record<string, unknown> } | undefined
}

function loggerInto(sink: Line[]): IScopedLogger {
  const at =
    () =>
    (message: string, fields?: Line['fields']): void => {
      sink.push({ message, fields })
    }
  const logger = { debug: at(), info: at(), warn: at(), error: at(), child: () => logger }
  return logger as unknown as IScopedLogger
}

function handle(seq: number): FrameHandle {
  return {
    shmId: `ram:${NODE_ID}:${DEVICE_ID}`,
    nodeId: NODE_ID,
    slot: 792,
    seq,
    width: 640,
    height: 480,
  } as unknown as FrameHandle
}

function frame(seq: number, timestamp: number): TrackDetailFrame {
  return {
    frameHandle: handle(seq),
    nodeId: NODE_ID,
    bbox: { x: 10, y: 10, w: 40, h: 80 },
    frameWidth: 640,
    frameHeight: 480,
    className: 'person',
    confidence: 0.9,
    timestamp,
    matchedThisFrame: true,
  }
}

const STEPS: readonly DetailStepAnnounce[] = [
  {
    stepId: 'face-detection',
    inputClasses: ['person'],
    cadence: { trigger: 'once' },
  },
]

async function flush(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r))
  await new Promise<void>((r) => setImmediate(r))
}

function handleCalls(fn: ReturnType<typeof vi.fn>): number {
  return fn.mock.calls.filter((c) => {
    const input: unknown = c[0]
    return typeof input === 'object' && input !== null && Reflect.has(input, 'frameHandle')
  }).length
}

describe('TrackDetailDispatcher — handle age and per-handle retirement (#628)', () => {
  it('an expired handle produces no runner call with the handle, one log line, parked frame serves', async () => {
    const NOW = 1_000_000
    const runDetailSubtree = vi.fn(async () => null)
    const captureParkedFrame = vi.fn(async () => null)
    const captureCropBase64 = vi.fn(async () => null)
    const lines: Line[] = []
    const d = new TrackDetailDispatcher({
      runDetailSubtree,
      routeResults: vi.fn(async () => {}),
      captureParkedFrame,
      captureCropBase64,
      logger: loggerInto(lines),
      nowMs: () => NOW,
    })
    const old = frame(83736, NOW - NATIVE_CROP_LEASE_MAX_AGE_MS - 80_000)
    d.onTrackStarted(DEVICE_ID, 'a', 'person', STEPS, old, NOW)
    d.onTrackStarted(DEVICE_ID, 'b', 'person', STEPS, old, NOW)
    await flush()
    d.dispose()

    expect(handleCalls(runDetailSubtree)).toBe(0)
    expect(captureCropBase64).not.toHaveBeenCalled()
    expect(captureParkedFrame).toHaveBeenCalled()
    const skips = lines.filter((l) => l.message.includes('past the lease age bound'))
    expect(skips).toHaveLength(1)
    expect(skips[0]!.fields?.tags).toEqual({ deviceId: DEVICE_ID })
    expect(skips[0]!.fields?.meta?.['handleAgeMs']).toBe(110_000)
  })

  it('a handle at exactly the bound is still sent', async () => {
    const NOW = 1_000_000
    const runDetailSubtree = vi.fn(async () => null)
    const d = new TrackDetailDispatcher({
      runDetailSubtree,
      routeResults: vi.fn(async () => {}),
      logger: loggerInto([]),
      nowMs: () => NOW,
    })
    d.onTrackStarted(
      DEVICE_ID,
      'a',
      'person',
      STEPS,
      frame(1, NOW - NATIVE_CROP_LEASE_MAX_AGE_MS),
      NOW,
    )
    await flush()
    d.dispose()
    expect(handleCalls(runDetailSubtree)).toBe(1)
  })

  it('a handle refused for track A is not sent for track B', async () => {
    const NOW = 1_000_000
    const runDetailSubtree = vi.fn(async (input: { frameHandle?: FrameHandle }) => {
      if (input.frameHandle !== undefined) {
        throw new Error('runDetailSubtree-refused:handle-expired — age 30934 ms')
      }
      return null
    })
    const d = new TrackDetailDispatcher({
      runDetailSubtree,
      routeResults: vi.fn(async () => {}),
      logger: loggerInto([]),
      nowMs: () => NOW,
      maxInFlightPerDevice: 1,
    })
    const fresh = frame(83736, NOW - 1000)
    d.onTrackStarted(DEVICE_ID, 'a', 'person', STEPS, fresh, NOW)
    await flush()
    d.onTrackStarted(DEVICE_ID, 'b', 'person', STEPS, fresh, NOW)
    await flush()
    d.dispose()
    expect(handleCalls(runDetailSubtree)).toBe(1)
  })
})
