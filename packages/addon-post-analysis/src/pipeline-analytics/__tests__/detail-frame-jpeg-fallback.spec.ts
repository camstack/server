/**
 * The detail dispatcher's SECOND rung: the track's PARKED key frame, which the
 * runner cuts (D422).
 *
 * ## What was broken, twice
 *
 * The dispatcher only ever sent `frameHandle` and, on a miss, `cropJpeg`. Both
 * are served from the decode worker's native lease — `captureCropBase64` is
 * native-STRICT and returns `null` on exactly the miss that sent it there. So
 * the two "independent" fallbacks failed together, and `onFrameMiss` abandoned
 * the step permanently (~3600 drops per 3 h cluster-wide). The `frameJpeg`
 * rung added then fetched the FRESHEST frame by handle — which is the same
 * surface being swept, one hop later: D419's 10 s bound took the fleet's
 * keyFrame presence from 99.5% to 76.6% through exactly this kind of ask.
 *
 * Since D422 the rung reads the track's PARKED key frame by
 * `(deviceId, trackId)`: pixels copied at the best instant, a lookup that
 * cannot miss on age. The runner still cuts the rectangle (D52); the hub only
 * scales the subject's box into the parcel's pixel space.
 *
 * ## What these cases pin
 *
 * The fakes reproduce the PRODUCTION failure shape: the frame-handle call
 * returns `null` and `captureCropBase64` returns `null`. Nothing here can pass
 * because a fake supplied a crop the real capture path cannot produce — the
 * recovery has to come from the parcel or not at all. And a parcel is enriched
 * ONCE per step: the periodic tick on a coasting track must not re-run the
 * same face on the same image every second.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import type {
  DetailStepAnnounce,
  FrameHandle,
  IScopedLogger,
  RunDetailSubtreeInput,
  RunDetailSubtreeResult,
} from '@camstack/types'
import {
  TrackDetailDispatcher,
  type ParkedDetailFrame,
  type TrackDetailFrame,
} from '../detail-dispatcher.js'

const DEVICE_ID = 101
const NODE_ID = 'agent-a'
const FRAME_WIDTH = 640
const FRAME_HEIGHT = 360

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

const CLIP_ANNOUNCE: readonly DetailStepAnnounce[] = [
  {
    stepId: 'clip-embedding',
    inputClasses: ['person'],
    cadence: { trigger: 'once', maxPerTrack: 3 },
  },
]

function frame(): TrackDetailFrame {
  return {
    frameHandle: {
      nodeId: NODE_ID,
      slot: 3,
      seq: 91,
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
    } as unknown as FrameHandle,
    nodeId: NODE_ID,
    bbox: { x: 100, y: 100, w: 50, h: 80 },
    frameWidth: FRAME_WIDTH,
    frameHeight: FRAME_HEIGHT,
    className: 'person',
    confidence: 0.8,
    timestamp: 1000,
  }
}

/** The track's parked key frame, as the client hands it to the dispatcher:
 *  native pixels, the subject box already scaled into THEM, the holding node. */
function parkedFrame(timestamp = 1000): ParkedDetailFrame {
  return {
    base64: 'ZnVsbC1mcmFtZQ==',
    width: 3840,
    height: 2160,
    bbox: { x: 600, y: 600, w: 300, h: 480 },
    nodeId: NODE_ID,
    timestamp,
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise<void>((r) => setImmediate(r))
}

describe('detail dispatcher — parked key-frame rung', () => {
  let dispatcher: TrackDetailDispatcher | null = null
  afterEach(() => {
    dispatcher?.dispose()
    dispatcher = null
  })

  it('re-dispatches with the PARKED full frame (not a pre-cut tile), pinned to the node holding it', async () => {
    const calls: { input: RunDetailSubtreeInput; nodeId: string | undefined }[] = []
    const runDetailSubtree = vi.fn(
      async (
        input: RunDetailSubtreeInput,
        nodeId: string | undefined,
      ): Promise<RunDetailSubtreeResult | null> => {
        calls.push({ input, nodeId })
        if (input.frameJpeg !== undefined) {
          return {
            details: [
              {
                stepId: 'clip-embedding',
                className: 'person',
                score: 0.7,
                bbox: { x: 0, y: 0, w: 1, h: 1 },
              },
            ],
          }
        }
        return null
      },
    )
    const routeResults = vi.fn(async () => {})
    // Production shape: the native-strict crop capture misses too.
    const captureCropBase64 = vi.fn(async () => null)
    const captureParkedFrame = vi.fn(async () => parkedFrame())

    dispatcher = new TrackDetailDispatcher({
      runDetailSubtree,
      routeResults,
      captureCropBase64,
      captureParkedFrame,
      logger: silentLogger(),
    })
    dispatcher.onTrackStarted(DEVICE_ID, 't1', 'person', CLIP_ANNOUNCE, frame(), 1000)
    await flush()

    expect(captureParkedFrame).toHaveBeenCalledWith(DEVICE_ID, 't1')
    expect(calls).toHaveLength(2)
    expect(calls[0]!.input.frameHandle).toBeDefined()
    expect(calls[0]!.input.frameJpeg).toBeUndefined()
    // The recovery rung: the PARKED full frame, and deliberately NOT
    // `cropJpeg` — the runner must derive the rectangle (D52), never receive
    // one already cut. The box is the parcel's own, in the parcel's pixels.
    expect(calls[1]!.input.frameJpeg).toBe('ZnVsbC1mcmFtZQ==')
    expect(calls[1]!.input.cropJpeg).toBeUndefined()
    expect(calls[1]!.input.parent.bbox).toEqual({ x: 600, y: 600, w: 300, h: 480 })
    expect(calls[1]!.nodeId).toBe(NODE_ID)
    // The pre-cut tile is never reached once the parcel produced a result.
    expect(captureCropBase64).not.toHaveBeenCalled()
    expect(routeResults).toHaveBeenCalledTimes(1)
  })

  it('does not read the parcel when the frame handle hits — the cheapest rung stays first', async () => {
    const runDetailSubtree = vi.fn(
      async (): Promise<RunDetailSubtreeResult | null> => ({ details: [] }),
    )
    const captureParkedFrame = vi.fn(async () => parkedFrame())
    dispatcher = new TrackDetailDispatcher({
      runDetailSubtree,
      routeResults: vi.fn(async () => {}),
      captureParkedFrame,
      logger: silentLogger(),
    })
    dispatcher.onTrackStarted(DEVICE_ID, 't1', 'person', CLIP_ANNOUNCE, frame(), 1000)
    await flush()

    expect(runDetailSubtree).toHaveBeenCalledTimes(1)
    expect(captureParkedFrame).not.toHaveBeenCalled()
  })

  it('enriches a parcel ONCE per step — a second dispatch on the same parked instant skips the rung', async () => {
    const calls: RunDetailSubtreeInput[] = []
    const runDetailSubtree = vi.fn(async (input: RunDetailSubtreeInput) => {
      calls.push(input)
      return input.frameJpeg !== undefined ? { details: [] } : null
    })
    const captureParkedFrame = vi.fn(async () => parkedFrame(1000))
    dispatcher = new TrackDetailDispatcher({
      runDetailSubtree,
      routeResults: vi.fn(async () => {}),
      captureParkedFrame,
      logger: silentLogger(),
    })
    const announce: readonly DetailStepAnnounce[] = [
      { stepId: 'clip-embedding', inputClasses: ['person'], cadence: { trigger: 'improve' } },
    ]
    dispatcher.onTrackStarted(DEVICE_ID, 't1', 'person', announce, frame(), 1000)
    await flush()
    // A strictly better detection fires an `improve` dispatch; the handle
    // misses again and the SAME parcel is on offer.
    dispatcher.onFrame(DEVICE_ID, 't1', announce, { ...frame(), confidence: 0.95 }, 2000)
    await flush()

    expect(calls.filter((c) => c.frameJpeg !== undefined)).toHaveLength(1)

    // A NEWER parcel (a later best) is enriched again.
    captureParkedFrame.mockResolvedValue(parkedFrame(1500))
    dispatcher.onFrame(DEVICE_ID, 't1', announce, { ...frame(), confidence: 0.99 }, 3000)
    await flush()
    expect(calls.filter((c) => c.frameJpeg !== undefined)).toHaveLength(2)
  })

  it('still falls through to cropJpeg when there is no parcel', async () => {
    const calls: RunDetailSubtreeInput[] = []
    const runDetailSubtree = vi.fn(async (input: RunDetailSubtreeInput) => {
      calls.push(input)
      return input.cropJpeg !== undefined ? { details: [] } : null
    })
    dispatcher = new TrackDetailDispatcher({
      runDetailSubtree,
      routeResults: vi.fn(async () => {}),
      captureCropBase64: vi.fn(async () => 'dGlsZQ=='),
      captureParkedFrame: vi.fn(async () => null),
      logger: silentLogger(),
    })
    dispatcher.onTrackStarted(DEVICE_ID, 't1', 'person', CLIP_ANNOUNCE, frame(), 1000)
    await flush()

    expect(
      calls.map((c) => (c.frameJpeg ? 'frameJpeg' : c.cropJpeg ? 'cropJpeg' : 'handle')),
    ).toEqual(['handle', 'cropJpeg'])
  })
})
