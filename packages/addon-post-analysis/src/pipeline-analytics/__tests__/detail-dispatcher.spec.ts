/**
 * `TrackDetailDispatcher` unit spec — focuses on the per-frame adoption path
 * (F6): a track that was already alive when `detailSteps` first appear (a
 * mid-track redeploy / config change) must be adopted as a new track by
 * `onFrame`, not silently starved for its whole life. Also asserts the
 * adoption is idempotent — a subsequent frame does NOT re-create state.
 *
 * The scheduler's cadence policy is unit-tested in `detail-scheduler.spec.ts`;
 * the full addon wiring in `detail-dispatch-integration.spec.ts`. This spec
 * drives the dispatcher directly with injected deps (no broker, no timers).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import type {
  DetailStepAnnounce,
  FrameHandle,
  IScopedLogger,
  RunDetailSubtreeResult,
} from '@camstack/types'
import {
  composeDetailSteps,
  TrackDetailDispatcher,
  type TrackDetailFrame,
} from '../detail-dispatcher.js'
import type { DetailRequest } from '../detail-scheduler.js'

const DEVICE_ID = 7
const NODE_ID = 'hub'

function silentLogger(): IScopedLogger {
  const noop = (): void => {}
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => silentLogger(),
  } as unknown as IScopedLogger
}

const FACE_ANNOUNCE: readonly DetailStepAnnounce[] = [
  {
    stepId: 'face',
    inputClasses: ['person'],
    cadence: { trigger: 'once', maxPerTrack: 3 },
  },
]

function frameHandle(): FrameHandle {
  return { nodeId: NODE_ID, slot: 0, seq: 1, width: 640, height: 480 } as unknown as FrameHandle
}

function frame(confidence: number, timestamp: number): TrackDetailFrame {
  return {
    frameHandle: frameHandle(),
    nodeId: NODE_ID,
    bbox: { x: 10, y: 10, w: 40, h: 80 },
    frameWidth: 640,
    frameHeight: 480,
    className: 'person',
    confidence,
    timestamp,
  }
}

async function flush(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r))
  await new Promise<void>((r) => setImmediate(r))
}

describe('TrackDetailDispatcher — per-frame track adoption (F6)', () => {
  let dispatcher: TrackDetailDispatcher | null = null

  afterEach(() => {
    dispatcher?.dispose()
    dispatcher = null
  })

  it('adopts a track alive before detailSteps appeared, then does not re-create its state', async () => {
    const runDetailSubtree = vi.fn(
      async (): Promise<RunDetailSubtreeResult | null> => ({ details: [] }),
    )
    const routeResults = vi.fn(async () => {})
    dispatcher = new TrackDetailDispatcher({
      runDetailSubtree,
      routeResults,
      logger: silentLogger(),
    })

    // Frames 1 & 2: track is live but NO detail chain announced yet (empty
    // announce) → dispatcher must stay a no-op (no scheduling).
    dispatcher.onFrame(DEVICE_ID, 't1', [], frame(0.9, 1000), 1000)
    dispatcher.onFrame(DEVICE_ID, 't1', [], frame(0.9, 1100), 1100)
    await flush()
    expect(runDetailSubtree).not.toHaveBeenCalled()

    // Frame 3: the chain now appears mid-track → adopt as a new track and fire
    // exactly one new-track request.
    dispatcher.onFrame(DEVICE_ID, 't1', FACE_ANNOUNCE, frame(0.9, 1200), 1200)
    await flush()
    expect(runDetailSubtree).toHaveBeenCalledTimes(1)

    // Frame 4: state already exists → the normal per-frame path runs; adoption
    // must NOT re-create state (which would re-fire a second new-track request).
    dispatcher.onFrame(DEVICE_ID, 't1', FACE_ANNOUNCE, frame(0.95, 1300), 1300)
    await flush()
    expect(runDetailSubtree).toHaveBeenCalledTimes(1)
  })
})

describe('TrackDetailDispatcher — permanent frame-miss give-up (retry loop fix)', () => {
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

  const PERIODIC_FACE: readonly DetailStepAnnounce[] = [
    {
      stepId: 'face-detection',
      inputClasses: ['person'],
      cadence: { trigger: 'periodic', minIntervalMs: 0 },
    },
  ]

  it('stops re-dispatching a step whose frame is permanently gone (no infinite retry loop)', async () => {
    // runDetailSubtree ALWAYS misses — the decoded frame's lease (500ms TTL) is
    // long evicted, so `runOnce` returns null on every attempt and there is no
    // crop fallback. WITHOUT a give-up, the periodic tick re-arms a `retry`
    // forever (the live symptom: the same trackId logged every ~60s for 20+min).
    const runDetailSubtree = vi.fn(async () => null)
    const routeResults = vi.fn(async () => {})
    dispatcher = new TrackDetailDispatcher({
      runDetailSubtree,
      routeResults,
      logger: silentLogger(),
      tickIntervalMs: 1000,
    })

    dispatcher.onTrackStarted(DEVICE_ID, 't1', 'person', PERIODIC_FACE, frame(0.9, 0), 0)
    await flush()

    // Drive 30 periodic ticks — a permanently-missing frame must GIVE UP, not
    // loop: the call count converges instead of growing one-per-tick.
    for (let i = 0; i < 30; i++) {
      await vi.advanceTimersByTimeAsync(1000)
      await flush()
    }

    // new-track + at most a few bounded retries, never ~31.
    expect(runDetailSubtree.mock.calls.length).toBeLessThanOrEqual(4)
  })
})

describe('composeDetailSteps (identity-aware face chain composition)', () => {
  const labeled = (): boolean => true
  const unlabeled = (): boolean => false
  const req = (reason: DetailRequest['reason'], stepId = 'face-detection'): DetailRequest => ({
    trackId: 't1',
    stepId,
    reason,
  })

  it('periodic + labeled track → geometry only (no embedding — skip ArcFace)', () => {
    expect(composeDetailSteps(req('periodic'), labeled)).toEqual(['face-detection'])
  })

  it('periodic + unlabeled track → full detect→embed chain (recognition still needed)', () => {
    expect(composeDetailSteps(req('periodic'), unlabeled)).toEqual([
      'face-detection',
      'face-embedding',
    ])
  })

  it('new-track → full chain even when the track already has a label', () => {
    expect(composeDetailSteps(req('new-track'), labeled)).toEqual([
      'face-detection',
      'face-embedding',
    ])
  })

  it('improve → full chain', () => {
    expect(composeDetailSteps(req('improve'), labeled)).toEqual([
      'face-detection',
      'face-embedding',
    ])
  })

  it('retry → full chain', () => {
    expect(composeDetailSteps(req('retry'), labeled)).toEqual(['face-detection', 'face-embedding'])
  })

  it('plate-detection → always the full detect→OCR chain (symmetric to face)', () => {
    // Without plate-ocr in the array the pipeline prunes the OCR child and the
    // plate is never read — the LPR blocker. Chain is label-independent.
    expect(composeDetailSteps(req('new-track', 'plate-detection'), unlabeled)).toEqual([
      'plate-detection',
      'plate-ocr',
    ])
    expect(composeDetailSteps(req('periodic', 'plate-detection'), labeled)).toEqual([
      'plate-detection',
      'plate-ocr',
    ])
  })

  it('other single-model step → single step id, label state irrelevant', () => {
    expect(composeDetailSteps(req('periodic', 'clip-embedding'), labeled)).toEqual([
      'clip-embedding',
    ])
  })
})

describe('TrackDetailDispatcher — silent enrichment miss (BUG C)', () => {
  let dispatcher: TrackDetailDispatcher | null = null

  afterEach(() => {
    dispatcher?.dispose()
    dispatcher = null
  })

  const PLATE_ANNOUNCE: readonly DetailStepAnnounce[] = [
    { stepId: 'plate-detection', inputClasses: ['vehicle'], cadence: { trigger: 'once' } },
  ]

  function vehicleFrame(): TrackDetailFrame {
    return {
      frameHandle: frameHandle(),
      nodeId: NODE_ID,
      bbox: { x: 10, y: 10, w: 100, h: 100 },
      frameWidth: 640,
      frameHeight: 480,
      className: 'vehicle',
      confidence: 0.9,
      timestamp: 1000,
    }
  }

  it('warns when a plate is detected but the OCR child yields no text label', async () => {
    const warn = vi.fn()
    const logger = { ...silentLogger(), warn, child: () => logger } as unknown as IScopedLogger
    // Root plate detail present (bbox/score) but NO label → OCR produced nothing.
    const runDetailSubtree = vi.fn(
      async (): Promise<RunDetailSubtreeResult | null> => ({
        details: [
          {
            stepId: 'plate-detection',
            className: 'plate',
            score: 0.67,
            bbox: { x: 0, y: 0, w: 20, h: 8 },
          },
        ],
      }),
    )
    const routeResults = vi.fn(async () => {})
    dispatcher = new TrackDetailDispatcher({ runDetailSubtree, routeResults, logger })

    dispatcher.onTrackStarted(DEVICE_ID, 'v1', 'vehicle', PLATE_ANNOUNCE, vehicleFrame(), 1000)
    await flush()

    expect(runDetailSubtree).toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('no enrichment'),
      expect.objectContaining({
        meta: expect.objectContaining({ steps: ['plate-detection', 'plate-ocr'] }),
      }),
    )
  })

  it('does NOT warn when the plate detail carries a text label', async () => {
    const warn = vi.fn()
    const logger = { ...silentLogger(), warn, child: () => logger } as unknown as IScopedLogger
    const runDetailSubtree = vi.fn(
      async (): Promise<RunDetailSubtreeResult | null> => ({
        details: [
          {
            stepId: 'plate-detection',
            className: 'plate',
            score: 0.67,
            bbox: { x: 0, y: 0, w: 20, h: 8 },
            label: 'DWRO309',
          },
        ],
      }),
    )
    const routeResults = vi.fn(async () => {})
    dispatcher = new TrackDetailDispatcher({ runDetailSubtree, routeResults, logger })

    dispatcher.onTrackStarted(DEVICE_ID, 'v2', 'vehicle', PLATE_ANNOUNCE, vehicleFrame(), 1000)
    await flush()

    expect(warn).not.toHaveBeenCalled()
  })
})
