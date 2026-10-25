/**
 * A frame handle the runner REFUSED as expired must never be named again.
 *
 * 2026-09-30, the live fleet: `native crop refused — the handle is past the
 * lease age bound` ~7 times per handle (ages 30.0–35.2 s), 954 lines in two
 * hours over seven cameras on all three nodes. The caller was this dispatcher:
 * a coasting track's frame association is frozen (D397), so every periodic
 * tick re-dispatched its steps against the SAME handle, and each dispatch
 * asked twice — rung 1 (`runDetailSubtree({ frameHandle })`) and rung 3
 * (`captureCropBase64`, native-strict against the same handle) — until the
 * scheduler's three-miss give-up abandoned the step.
 *
 * The runner now says so, typed (`runDetailSubtree-refused:handle-expired`,
 * twin of addon-pipeline `detail-park.ts`, D688). On it the dispatcher retires
 * the handle for the track — rung 1 and rung 3 are skipped from then on, the
 * parked frame (D422) still serves — and logs it ONCE, tagged by camera.
 */
import type { DetailStepAnnounce, FrameHandle, IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TrackDetailDispatcher, type TrackDetailFrame } from '../detail-dispatcher.js'
import { makeFaceDetailSubtreeResult } from './support/detail-subtree-result.js'

const DEVICE_ID = 111
const NODE_ID = 'hub'

interface LoggedLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly fields: { tags?: Record<string, unknown>; meta?: Record<string, unknown> } | undefined
}

function recordingLogger(sink: LoggedLine[]): IScopedLogger {
  const at =
    (level: LoggedLine['level']) =>
    (message: string, fields?: LoggedLine['fields']): void => {
      sink.push({ level, message, fields })
    }
  const logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
  }
  return logger as unknown as IScopedLogger
}

function frameHandle(seq: number): FrameHandle {
  return {
    shmId: `ram:${NODE_ID}:${DEVICE_ID}`,
    nodeId: NODE_ID,
    slot: 920,
    seq,
    width: 640,
    height: 480,
  } as unknown as FrameHandle
}

function frame(seq: number): TrackDetailFrame {
  return {
    frameHandle: frameHandle(seq),
    nodeId: NODE_ID,
    bbox: { x: 10, y: 10, w: 40, h: 80 },
    frameWidth: 640,
    frameHeight: 480,
    className: 'person',
    confidence: 0.9,
    timestamp: 0,
    matchedThisFrame: true,
  }
}

/** What the runner's cap method throws for a handle past the lease age bound. */
function handleExpiredError(): Error {
  return new Error(
    `runDetailSubtree-refused:handle-expired — camera ${DEVICE_ID}: the frame handle is past the native lease age bound (age 30934 ms)`,
  )
}

const PERIODIC_FACE: readonly DetailStepAnnounce[] = [
  {
    stepId: 'face-detection',
    inputClasses: ['person'],
    cadence: { trigger: 'periodic', minIntervalMs: 0 },
  },
]

async function flush(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r))
  await new Promise<void>((r) => setImmediate(r))
}

function callsNamingHandle(fn: ReturnType<typeof vi.fn>, seq: number): number {
  return fn.mock.calls.filter((call) => {
    const input: unknown = call[0]
    if (typeof input !== 'object' || input === null) return false
    const handle: unknown = Reflect.get(input, 'frameHandle')
    return typeof handle === 'object' && handle !== null && Reflect.get(handle, 'seq') === seq
  }).length
}

describe('TrackDetailDispatcher — a handle refused as expired is retired, not re-asked', () => {
  let dispatcher: TrackDetailDispatcher | null = null

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(0)
  })

  afterEach(() => {
    dispatcher?.dispose()
    dispatcher = null
    vi.useRealTimers()
  })

  it('names the refused handle ONCE — neither rung 1 nor the native-strict crop rung asks for it again', async () => {
    const runDetailSubtree = vi.fn(async (input: { frameHandle?: FrameHandle }) => {
      if (input.frameHandle !== undefined) throw handleExpiredError()
      return null
    })
    const captureCropBase64 = vi.fn(async () => null)
    const lines: LoggedLine[] = []
    dispatcher = new TrackDetailDispatcher({
      runDetailSubtree,
      routeResults: vi.fn(async () => {}),
      captureParkedFrame: vi.fn(async () => null),
      captureCropBase64,
      logger: recordingLogger(lines),
      tickIntervalMs: 1000,
    })

    dispatcher.onTrackStarted(DEVICE_ID, 't1', 'person', PERIODIC_FACE, frame(2968), 0)
    await flush()
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(1000)
      await flush()
    }

    // Before the fix: 3 rung-1 asks + 3 native-strict crop asks, all for one
    // handle the registry had already refused — the live pattern.
    expect(callsNamingHandle(runDetailSubtree, 2968)).toBe(1)
    expect(captureCropBase64).not.toHaveBeenCalled()

    // Said once, by camera, with the reason.
    const retired = lines.filter((l) => l.message.includes('frame handle refused as expired'))
    expect(retired).toHaveLength(1)
    expect(retired[0]!.fields?.tags).toEqual({ deviceId: DEVICE_ID })
    expect(retired[0]!.fields?.meta?.['reason']).toBe('handle-expired')
    expect(retired[0]!.fields?.meta?.['trackId']).toBe('t1')
  })

  it('falls back to the parked frame on the SAME dispatch that got the refusal', async () => {
    const runDetailSubtree = vi.fn(
      async (input: { frameHandle?: FrameHandle; frameJpeg?: string }) => {
        if (input.frameHandle !== undefined) throw handleExpiredError()
        if (input.frameJpeg !== undefined) {
          return makeFaceDetailSubtreeResult(0.8)
        }
        return null
      },
    )
    const routeResults = vi.fn(async () => {})
    dispatcher = new TrackDetailDispatcher({
      runDetailSubtree,
      routeResults,
      captureParkedFrame: vi.fn(async () => ({
        base64: 'ZnJhbWU=',
        width: 640,
        height: 480,
        bbox: { x: 100, y: 100, w: 50, h: 80 },
        nodeId: NODE_ID,
        timestamp: 1,
      })),
      captureCropBase64: vi.fn(async () => null),
      logger: recordingLogger([]),
      tickIntervalMs: 1000,
    })

    dispatcher.onTrackStarted(DEVICE_ID, 't1', 'person', PERIODIC_FACE, frame(2968), 0)
    await flush()

    expect(routeResults).toHaveBeenCalledTimes(1)
  })

  it('a FRESH observed frame replaces the retired handle — the track is cut from native pixels again', async () => {
    const runDetailSubtree = vi.fn(async (input: { frameHandle?: FrameHandle }) => {
      const seq = input.frameHandle === undefined ? null : Reflect.get(input.frameHandle, 'seq')
      if (seq === 2968) throw handleExpiredError()
      return null
    })
    dispatcher = new TrackDetailDispatcher({
      runDetailSubtree,
      routeResults: vi.fn(async () => {}),
      logger: recordingLogger([]),
      tickIntervalMs: 1000,
    })

    dispatcher.onTrackStarted(DEVICE_ID, 't1', 'person', PERIODIC_FACE, frame(2968), 0)
    await flush()
    dispatcher.onFrame(DEVICE_ID, 't1', PERIODIC_FACE, frame(3001), 500)
    await vi.advanceTimersByTimeAsync(1000)
    await flush()

    expect(callsNamingHandle(runDetailSubtree, 2968)).toBe(1)
    expect(callsNamingHandle(runDetailSubtree, 3001)).toBeGreaterThanOrEqual(1)
  })
})
