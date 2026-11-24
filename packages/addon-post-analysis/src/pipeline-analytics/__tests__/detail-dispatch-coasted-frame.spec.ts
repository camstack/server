/**
 * A coasted frame is not a frame the subject was seen in (D397).
 *
 * ## The measurement
 *
 * On the live hub, one hour of `native crop miss` at `servedTier=miss`: 486
 * lines, of which **383 (78.8%) carry
 * `workerReason="frame N released and no retained tile for this frame"`** and
 * only **10 (2.1%)** carry `"…no retained subject or scene tile contains the
 * requested rectangle"`. So the dominant population is not "the tile was still
 * encoding" and not "the tile did not cover the box" — it is frames for which
 * NO tile was ever cut.
 *
 * A tile is cut per surviving detection of a `FrameResult`
 * (`tile-cut-plan.ts`), and the scene tile rides the same call on
 * detection-bearing frames only (`scene-tile.ts`: "A frame that detected
 * NOTHING gets nothing, scene tile included"). So a frame with zero detections
 * has no retained rung at all — and the only consumer that can name such a
 * frame is one that asks about a track the frame did NOT observe.
 *
 * `matchedThisFrame` is exactly that fact, and the invariant is already
 * documented on `TrackedDetection`: a `false` entry is media-INELIGIBLE,
 * because cropping a coasted box yields the empty scene. Three sibling media
 * paths in `pipeline-analytics/index.ts` honour it (`buildSnapshotTargets`,
 * `collectFirstFrameRetries`, the raster-fallback retention loop). The detail
 * dispatch did not: it overwrote a track's frame association with the current
 * handle and a frozen bbox on every coasted frame.
 *
 * That is two bugs in one. The miss is the visible half; the invisible half is
 * worse — when such an ask HITS (because some other subject in that frame did
 * get a tile) the enrichment is cut from the wrong instant and lands in the
 * same vector index, erroring nowhere.
 *
 * The fix is not a longer retention window. 71% of asks arrive within two
 * seconds and 38% within half a second, so a longer window buys almost
 * nothing; the cause is removed instead.
 */
import type {
  DetailStepAnnounce,
  FrameHandle,
  IScopedLogger,
  RunDetailSubtreeInput,
  RunDetailSubtreeResult,
} from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TrackDetailDispatcher, type TrackDetailFrame } from '../detail-dispatcher.js'

const DEVICE_ID = 7
const NODE_ID = 'hub'
const TRACK = 't1'

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
    cadence: { trigger: 'improve' },
  },
]

function handle(seq: number): FrameHandle {
  return { nodeId: NODE_ID, slot: 0, seq, width: 640, height: 480 } as unknown as FrameHandle
}

function frame(
  seq: number,
  confidence: number,
  timestamp: number,
  matchedThisFrame?: boolean,
): TrackDetailFrame {
  return {
    frameHandle: handle(seq),
    nodeId: NODE_ID,
    bbox: { x: seq * 10, y: 10, w: 40, h: 80 },
    frameWidth: 640,
    frameHeight: 480,
    className: 'person',
    confidence,
    timestamp,
    ...(matchedThisFrame !== undefined ? { matchedThisFrame } : {}),
  }
}

async function flush(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r))
  await new Promise<void>((r) => setImmediate(r))
}

interface Harness {
  readonly dispatcher: TrackDetailDispatcher
  readonly calls: RunDetailSubtreeInput[]
}

function harness(): Harness {
  const calls: RunDetailSubtreeInput[] = []
  const dispatcher = new TrackDetailDispatcher({
    runDetailSubtree: async (
      input: RunDetailSubtreeInput,
    ): Promise<RunDetailSubtreeResult | null> => {
      calls.push(input)
      return { details: [] }
    },
    routeResults: async () => {},
    logger: silentLogger(),
  })
  return { dispatcher, calls }
}

describe('TrackDetailDispatcher — a coasted frame never becomes a track frame association', () => {
  let dispatcher: TrackDetailDispatcher | null = null
  afterEach(() => {
    dispatcher?.dispose()
    dispatcher = null
  })

  it('keeps the last MATCHED frame when the next frame coasted', async () => {
    const h = harness()
    dispatcher = h.dispatcher
    // Birth on frame 1 — always a match.
    h.dispatcher.onTrackStarted(
      DEVICE_ID,
      TRACK,
      'person',
      FACE_ANNOUNCE,
      frame(1, 0.6, 1000),
      1000,
    )
    await flush()
    h.calls.length = 0

    // Frame 2: the subject was NOT observed — the tracker coasted the box.
    h.dispatcher.onFrame(DEVICE_ID, TRACK, FACE_ANNOUNCE, frame(2, 0.9, 2000, false), 2000)
    // Frame 3: observed again, at a higher confidence than the birth.
    h.dispatcher.onFrame(DEVICE_ID, TRACK, FACE_ANNOUNCE, frame(3, 0.8, 3000, true), 3000)
    await flush()

    // The improve dispatch fired on frame 3, and it asks about frame 3 — never
    // about frame 2, whose handle names a frame this subject was not in.
    const seqs = h.calls.map((c) => c.frameHandle?.seq)
    expect(seqs).not.toContain(2)
    expect(seqs).toContain(3)
  })

  it('does not let a coasted frame raise the candidate peak, so it cannot fire an improve dispatch', async () => {
    const h = harness()
    dispatcher = h.dispatcher
    h.dispatcher.onTrackStarted(
      DEVICE_ID,
      TRACK,
      'person',
      FACE_ANNOUNCE,
      frame(1, 0.5, 1000),
      1000,
    )
    await flush()
    h.calls.length = 0

    // A coasted frame carries the tracker's own confidence, which can be
    // anything. It is not an observation and must not schedule work.
    h.dispatcher.onFrame(DEVICE_ID, TRACK, FACE_ANNOUNCE, frame(2, 0.99, 2000, false), 2000)
    await flush()
    expect(h.calls).toHaveLength(0)
  })

  it('still dispatches on a real observation after a coasted one', async () => {
    const h = harness()
    dispatcher = h.dispatcher
    h.dispatcher.onTrackStarted(
      DEVICE_ID,
      TRACK,
      'person',
      FACE_ANNOUNCE,
      frame(1, 0.5, 1000),
      1000,
    )
    await flush()
    h.calls.length = 0

    h.dispatcher.onFrame(DEVICE_ID, TRACK, FACE_ANNOUNCE, frame(2, 0.99, 2000, false), 2000)
    h.dispatcher.onFrame(DEVICE_ID, TRACK, FACE_ANNOUNCE, frame(3, 0.7, 3000, true), 3000)
    await flush()
    expect(h.calls.length).toBeGreaterThan(0)
    expect(h.calls[0]?.frameHandle?.seq).toBe(3)
  })

  it('treats an ABSENT matchedThisFrame as matched — an older producer must not be silenced', async () => {
    const h = harness()
    dispatcher = h.dispatcher
    h.dispatcher.onTrackStarted(
      DEVICE_ID,
      TRACK,
      'person',
      FACE_ANNOUNCE,
      frame(1, 0.5, 1000),
      1000,
    )
    await flush()
    h.calls.length = 0

    h.dispatcher.onFrame(DEVICE_ID, TRACK, FACE_ANNOUNCE, frame(2, 0.9, 2000), 2000)
    await flush()
    expect(h.calls[0]?.frameHandle?.seq).toBe(2)
  })

  it('does NOT adopt an unknown track from a coasted frame — a coasted box is not a birth', async () => {
    const h = harness()
    dispatcher = h.dispatcher
    h.dispatcher.onFrame(DEVICE_ID, TRACK, FACE_ANNOUNCE, frame(1, 0.9, 1000, false), 1000)
    await flush()
    expect(h.calls).toHaveLength(0)

    // …and a real observation afterwards still adopts it.
    h.dispatcher.onFrame(DEVICE_ID, TRACK, FACE_ANNOUNCE, frame(2, 0.9, 2000, true), 2000)
    await flush()
    expect(h.calls.length).toBeGreaterThan(0)
  })

  it('counts every coasted frame it ignored, per device — a branch that drops work is never silent', () => {
    const h = harness()
    dispatcher = h.dispatcher
    h.dispatcher.onTrackStarted(
      DEVICE_ID,
      TRACK,
      'person',
      FACE_ANNOUNCE,
      frame(1, 0.5, 1000),
      1000,
    )
    h.dispatcher.onFrame(DEVICE_ID, TRACK, FACE_ANNOUNCE, frame(2, 0.9, 2000, false), 2000)
    h.dispatcher.onFrame(DEVICE_ID, TRACK, FACE_ANNOUNCE, frame(3, 0.9, 3000, false), 3000)
    h.dispatcher.onFrame(DEVICE_ID, TRACK, FACE_ANNOUNCE, frame(4, 0.9, 4000, true), 4000)
    expect(h.dispatcher.coastedFramesIgnored(DEVICE_ID)).toBe(2)
  })

  it('reports zero for a device that has never coasted, and for one it has never seen', () => {
    const h = harness()
    dispatcher = h.dispatcher
    h.dispatcher.onTrackStarted(
      DEVICE_ID,
      TRACK,
      'person',
      FACE_ANNOUNCE,
      frame(1, 0.5, 1000),
      1000,
    )
    expect(h.dispatcher.coastedFramesIgnored(DEVICE_ID)).toBe(0)
    expect(h.dispatcher.coastedFramesIgnored(999)).toBe(0)
  })
})

describe('TrackDetailDispatcher — the invariant survives a dispose', () => {
  it('forgets its counters when disposed', () => {
    const h = harness()
    h.dispatcher.onTrackStarted(
      DEVICE_ID,
      TRACK,
      'person',
      FACE_ANNOUNCE,
      frame(1, 0.5, 1000),
      1000,
    )
    h.dispatcher.onFrame(DEVICE_ID, TRACK, FACE_ANNOUNCE, frame(2, 0.9, 2000, false), 2000)
    expect(h.dispatcher.coastedFramesIgnored(DEVICE_ID)).toBe(1)
    h.dispatcher.dispose()
    expect(h.dispatcher.coastedFramesIgnored(DEVICE_ID)).toBe(0)
  })
})

// Guards against the fake supplying what production forgot: the harness must
// see the dispatcher actually call `runDetailSubtree`, or every assertion above
// about "no call" is vacuously true.
describe('harness sanity', () => {
  it('dispatches at all on a plain matched track', async () => {
    const h = harness()
    const spy = vi.fn()
    h.dispatcher.onTrackStarted(
      DEVICE_ID,
      TRACK,
      'person',
      FACE_ANNOUNCE,
      frame(1, 0.5, 1000),
      1000,
    )
    await flush()
    expect(h.calls.length).toBeGreaterThan(0)
    expect(spy).not.toHaveBeenCalled()
    h.dispatcher.dispose()
  })
})
