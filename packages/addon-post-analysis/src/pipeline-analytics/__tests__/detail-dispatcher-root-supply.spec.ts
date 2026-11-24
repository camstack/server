/**
 * D730 — a step the announce says the root model supplies is never INFERRED:
 *  - a label supply (a classifier) is not dispatched at all, for any track,
 *    logged once per (track, step) with the camera's deviceId;
 *  - a crop supply with served children (a plate → its reader) is dispatched
 *    with the root's box, and waits — retrying per cadence — while the root
 *    drew none in the subject;
 *  - a root face is dispatched with its box, which the runner refines (face
 *    detector in a face-scoped square) before anything is embedded.
 */
import type {
  DetailStepAnnounce,
  FrameHandle,
  IScopedLogger,
  RunDetailSubtreeInput,
  RunDetailSubtreeResult,
} from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  suppliedInParcel,
  TrackDetailDispatcher,
  type TrackDetailFrame,
} from '../detail-dispatcher.js'
import type { RootChildBox } from '../pipeline/frame-processor.js'

const DEVICE_ID = 101

const ANIMAL: readonly DetailStepAnnounce[] = [
  {
    stepId: 'animal-classifier',
    inputClasses: ['animal'],
    cadence: { trigger: 'once', maxPerTrack: 3, stickyOnConfidence: 0.7 },
    filledBy: 'frigate-plus',
    filledAs: 'label',
  },
]

const PLATE: readonly DetailStepAnnounce[] = [
  {
    stepId: 'plate-detection',
    inputClasses: ['vehicle'],
    cadence: { trigger: 'periodic', minIntervalMs: 2_000, maxPerTrack: 8 },
    filledBy: 'frigate-plus',
    filledAs: 'crop',
  },
]

const FACE: readonly DetailStepAnnounce[] = [
  {
    stepId: 'face-detection',
    inputClasses: ['person'],
    cadence: { trigger: 'improve' },
    filledBy: 'frigate-plus',
    filledAs: 'crop',
  },
]

function makeLogger() {
  const info = vi.fn()
  const noop = (): void => {}
  const logger: IScopedLogger = {
    debug: noop,
    info,
    warn: noop,
    error: noop,
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, info }
}

const HANDLE: FrameHandle = {
  shmId: 'seg',
  slot: 0,
  seq: 1,
  width: 640,
  height: 480,
  format: 'rgb',
  pts: 0,
  byteLength: 640 * 480 * 3,
  nodeId: 'hub',
  slotCount: 4,
}

function frame(
  className: string,
  confidence: number,
  rootChildBoxes?: readonly RootChildBox[],
): TrackDetailFrame {
  return {
    frameHandle: HANDLE,
    nodeId: 'hub',
    bbox: { x: 10, y: 10, w: 200, h: 100 },
    frameWidth: 640,
    frameHeight: 480,
    className,
    confidence,
    timestamp: 1000,
    ...(rootChildBoxes !== undefined ? { rootChildBoxes } : {}),
  }
}

async function flush(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r))
  await new Promise<void>((r) => setImmediate(r))
}

describe('TrackDetailDispatcher — root supply (D730)', () => {
  let dispatcher: TrackDetailDispatcher | null = null
  afterEach(() => {
    dispatcher?.dispose()
    dispatcher = null
  })

  function make(info?: ReturnType<typeof makeLogger>) {
    const runDetailSubtree = vi.fn(
      async (_input: RunDetailSubtreeInput): Promise<RunDetailSubtreeResult | null> => ({
        details: [],
      }),
    )
    const log = info ?? makeLogger()
    dispatcher = new TrackDetailDispatcher({
      runDetailSubtree,
      routeResults: vi.fn(async () => {}),
      logger: log.logger,
      tickIntervalMs: 1_000_000,
    })
    return { runDetailSubtree, info: log.info, dispatcher }
  }

  it('a label supply is never dispatched, for any track, logged once per (track, step)', async () => {
    const { runDetailSubtree, info, dispatcher: d } = make()
    const improve = ANIMAL.map((a) => ({
      ...a,
      cadence: { trigger: 'improve' as const, maxPerTrack: 3 },
    }))
    d.onTrackStarted(DEVICE_ID, 't1', 'animal', improve, frame('animal', 0.6), 0)
    d.onFrame(DEVICE_ID, 't1', improve, frame('animal', 0.9), 5_000)
    // A track the root could not name (a bear) is not dispatched either.
    d.onTrackStarted(DEVICE_ID, 't2', 'animal', improve, frame('animal', 0.6), 0)
    await flush()
    expect(runDetailSubtree).not.toHaveBeenCalled()
    const lines = info.mock.calls.filter(
      ([msg]) => msg === 'detail step not dispatched — the root model supplies it',
    )
    expect(lines.map((l) => l[1].meta.trackId)).toEqual(['t1', 't2'])
    expect(lines[0]?.[1]).toMatchObject({
      tags: { deviceId: DEVICE_ID },
      meta: { stepId: 'animal-classifier', filledBy: 'frigate-plus', kind: 'label' },
    })
  })

  it('an announce from an older runner (filledBy, no filledAs) reads as a label supply', async () => {
    const { runDetailSubtree, dispatcher: d } = make()
    const old = ANIMAL.map(({ filledAs: _k, ...rest }) => rest)
    d.onTrackStarted(DEVICE_ID, 't3', 'animal', old, frame('animal', 0.6), 0)
    await flush()
    expect(runDetailSubtree).not.toHaveBeenCalled()
  })

  it('an announce without filledBy dispatches the step as before', async () => {
    const { runDetailSubtree, dispatcher: d } = make()
    const unfilled = ANIMAL.map(({ filledBy: _f, filledAs: _k, ...rest }) => rest)
    d.onTrackStarted(DEVICE_ID, 't4', 'animal', unfilled, frame('animal', 0.6), 0)
    await flush()
    expect(runDetailSubtree).toHaveBeenCalledTimes(1)
  })

  it('a supplied plate goes to the reader with the root box, never to the plate model', async () => {
    const { runDetailSubtree, dispatcher: d } = make()
    const plate: RootChildBox = {
      stepId: 'plate-detection',
      modelId: 'frigate-plus',
      score: 0.71,
      bbox: { x: 90, y: 80, w: 40, h: 12 },
    }
    d.onTrackStarted(DEVICE_ID, 'v1', 'vehicle', PLATE, frame('vehicle', 0.8, [plate]), 0)
    await flush()
    expect(runDetailSubtree).toHaveBeenCalledTimes(1)
    expect(runDetailSubtree.mock.calls[0]?.[0]).toMatchObject({
      steps: ['plate-detection', 'plate-ocr'],
      supplied: {
        stepId: 'plate-detection',
        modelId: 'frigate-plus',
        boxes: [{ bbox: { x: 90, y: 80, w: 40, h: 12 }, score: 0.71 }],
      },
    })
  })

  it('no root plate in the subject yet ⇒ nothing dispatched, one line, retried per cadence', async () => {
    const { runDetailSubtree, info, dispatcher: d } = make()
    d.onTrackStarted(DEVICE_ID, 'v2', 'vehicle', PLATE, frame('vehicle', 0.8), 0)
    await flush()
    expect(runDetailSubtree).not.toHaveBeenCalled()
    expect(
      info.mock.calls.filter(
        ([msg]) => msg === 'detail step waits — the root model drew no box in this subject yet',
      ),
    ).toHaveLength(1)
  })

  it('a root face is dispatched to the face detector and embedder with its box (refinement)', async () => {
    const { runDetailSubtree, dispatcher: d } = make()
    const face: RootChildBox = {
      stepId: 'face-detection',
      modelId: 'frigate-plus',
      score: 0.8,
      bbox: { x: 20, y: 15, w: 20, h: 25 },
    }
    d.onTrackStarted(DEVICE_ID, 'p1', 'person', FACE, frame('person', 0.8, [face]), 0)
    await flush()
    expect(runDetailSubtree).toHaveBeenCalledTimes(1)
    expect(runDetailSubtree.mock.calls[0]?.[0]).toMatchObject({
      steps: ['face-detection', 'face-embedding'],
      supplied: { stepId: 'face-detection', boxes: [{ bbox: face.bbox, score: 0.8 }] },
    })
  })
})

describe('suppliedInParcel', () => {
  it('maps the root box by the same transform that took the subject into the parcel', () => {
    const out = suppliedInParcel(
      {
        stepId: 'plate-detection',
        modelId: 'm',
        boxes: [{ bbox: { x: 30, y: 30, w: 10, h: 4 }, score: 0.5 }],
      },
      { x: 10, y: 10, w: 100, h: 50 },
      { x: 60, y: 60, w: 600, h: 300 },
    )
    expect(out.boxes[0]?.bbox).toEqual({ x: 180, y: 180, w: 60, h: 24 })
  })
})
