/**
 * The runner's TYPED `not-attached` refusal must stop the crop-source ladder
 * cold.
 *
 * Before this fix a `runDetailSubtree: camera is not attached` refusal came
 * back as a bare `null`/error and `runOnce` walked the two remaining rungs
 * anyway — a full-frame fetch against a purged retained store (`native
 * full-frame miss`) and a native-strict `captureCrop` doomed by the same
 * missing session. Three cross-node RPCs per dispatch, ~600–900 times an hour
 * fleet-wide, every one of them structurally unable to succeed: the refusal is
 * about the CAMERA's session state, not about this frame, so no pixel rung can
 * recover from it.
 *
 * With the refusal typed (the runner throws an error carrying
 * `runDetailSubtree-refused:not-attached` — see `detail-refusal.ts` and its
 * twin constant in addon-pipeline's `detail-park.ts`), `runOnce` must return
 * immediately and feed the scheduler EXACTLY ONE frame-miss, so the bounded
 * give-up (3 consecutive misses) abandons the step instead of looping.
 */
import type { DetailStepAnnounce, FrameHandle, IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TrackDetailDispatcher, type TrackDetailFrame } from '../detail-dispatcher.js'

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

function frameHandle(): FrameHandle {
  return {
    nodeId: NODE_ID,
    slot: 0,
    seq: 1,
    width: 640,
    height: 480,
  } as unknown as FrameHandle
}

function frame(): TrackDetailFrame {
  return {
    frameHandle: frameHandle(),
    nodeId: NODE_ID,
    bbox: { x: 10, y: 10, w: 40, h: 80 },
    frameWidth: 640,
    frameHeight: 480,
    className: 'person',
    confidence: 0.9,
    timestamp: 0,
  }
}

async function flush(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r))
  await new Promise<void>((r) => setImmediate(r))
}

/** What the runner's cap method throws once the detail park grace has lapsed. */
function notAttachedError(): Error {
  return new Error(
    `runDetailSubtree-refused:not-attached — camera ${DEVICE_ID} is not attached and no detail state is parked`,
  )
}

const ONCE_FACE: readonly DetailStepAnnounce[] = [
  {
    stepId: 'face-detection',
    inputClasses: ['person'],
    cadence: { trigger: 'once', maxPerTrack: 3 },
  },
]

const PERIODIC_FACE: readonly DetailStepAnnounce[] = [
  {
    stepId: 'face-detection',
    inputClasses: ['person'],
    cadence: { trigger: 'periodic', minIntervalMs: 0 },
  },
]

describe('TrackDetailDispatcher — typed not-attached refusal short-circuits the ladder', () => {
  let dispatcher: TrackDetailDispatcher | null = null

  afterEach(() => {
    dispatcher?.dispose()
    dispatcher = null
  })

  it('(4a) on a not-attached refusal, runOnce skips BOTH fallback rungs', async () => {
    const runDetailSubtree = vi.fn(async () => {
      throw notAttachedError()
    })
    const captureParkedFrame = vi.fn(async () => ({
      base64: 'ZnJhbWU=',
      width: 640,
      height: 480,
      bbox: { x: 100, y: 100, w: 50, h: 80 },
      nodeId: 'hub',
      timestamp: 0,
    }))
    const captureCropBase64 = vi.fn(async () => 'Y3JvcA==')
    dispatcher = new TrackDetailDispatcher({
      runDetailSubtree,
      routeResults: vi.fn(async () => {}),
      captureParkedFrame,
      captureCropBase64,
      logger: silentLogger(),
    })

    dispatcher.onTrackStarted(DEVICE_ID, 't1', 'person', ONCE_FACE, frame(), 0)
    await flush()

    expect(runDetailSubtree).toHaveBeenCalledTimes(1)
    // The refusal names the SESSION, not the frame: no pixel rung can recover,
    // so neither doomed follow-up RPC may fire.
    expect(captureParkedFrame).not.toHaveBeenCalled()
    expect(captureCropBase64).not.toHaveBeenCalled()
  })

  describe('with fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
      vi.setSystemTime(0)
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('(4b) each refusal feeds EXACTLY ONE frame-miss — the step is abandoned after 3 dispatches, with zero fallback traffic', async () => {
      const runDetailSubtree = vi.fn(async () => {
        throw notAttachedError()
      })
      const captureParkedFrame = vi.fn(async () => ({
        base64: 'ZnJhbWU=',
        width: 640,
        height: 480,
        bbox: { x: 100, y: 100, w: 50, h: 80 },
        nodeId: 'hub',
        timestamp: 0,
      }))
      const captureCropBase64 = vi.fn(async () => 'Y3JvcA==')
      dispatcher = new TrackDetailDispatcher({
        runDetailSubtree,
        routeResults: vi.fn(async () => {}),
        captureParkedFrame,
        captureCropBase64,
        logger: silentLogger(),
        tickIntervalMs: 1000,
      })

      dispatcher.onTrackStarted(DEVICE_ID, 't1', 'person', PERIODIC_FACE, frame(), 0)
      await flush()

      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(1000)
        await flush()
      }

      // One primary call per dispatch, and abandonment after exactly
      // MAX_CONSECUTIVE_FRAME_MISSES (3) dispatches proves each refusal fed
      // exactly one onFrameMiss (two per refusal would abandon after 2; zero
      // would never converge).
      expect(runDetailSubtree).toHaveBeenCalledTimes(3)
      expect(captureParkedFrame).not.toHaveBeenCalled()
      expect(captureCropBase64).not.toHaveBeenCalled()
    })
  })
})
