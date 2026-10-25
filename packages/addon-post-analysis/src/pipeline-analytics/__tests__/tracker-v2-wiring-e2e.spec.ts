/**
 * Tracker v2's production WIRING, through the booted addon (D683 Task 11
 * review H1). The processor-level specs call `noteTrackIdentity`,
 * `markSuppressed` and `TrackerSweep.run` by hand; this proves the addon
 * calls them — the recognizer's verdict sink, the confirmation gate's
 * suppression, and `sweepExpiredTracks` — and that a failing sweep never
 * stops the closer (review H3).
 *
 * Disarms (each alone, restored):
 *  - in `index.ts`, drop `this.noteVerdictOnTracker` from the
 *    `onIdentityVerdict` sink list: "a recognizer verdict reaches the camera's
 *    processor" fails;
 *  - in `index.ts`, delete `processor.markSuppressed(id)`: "a suppressed birth
 *    is marked in the tracker" fails;
 *  - in `sweepExpiredTracks`, delete `await this.trackerSweep.run(...)`:
 *    "sweepExpiredTracks ends a silent camera's tracklets" fails;
 *  - in `sweepExpiredTracks`, drop the try/finally (call the sweep, then the
 *    closer): "the closer runs even when the tracker sweep throws" fails;
 *  - (LOW-N1) in `reportTrackerSummary`, drop the sweep-path idle skip: "the
 *    sweep skips an all-zero summary" fails; skip idle summaries on the FRAME
 *    path too: the same test fails on its last line;
 *  - (D683 Task 12) in `applyTrackFusions`, drop the `tapeRecorder.onFusion`
 *    call: "sweepExpiredTracks ends a silent camera's tracklets" fails (the
 *    sweep's fusion never reaches the tape);
 *  - in `wireTrackerObservers`, log every `new` unsampled (review M1): "L2's
 *    `new` decisions are sampled…" fails; drop the `ended` observer (review
 *    M2): "sweepExpiredTracks ends…" fails on its `tracklet ended` line.
 */
import type {
  FrameHandle,
  FrameResult,
  IEventBus,
  ObjectDetection,
  PipelineInferenceResultPayload,
} from '@camstack/types'
import { createEvent, EventCategory } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FrameState } from '../frame/frame-state.js'
import type PipelineAnalyticsAddon from '../index.js'
import type { FrameProcessor } from '../pipeline/frame-processor.js'
import { StationaryObjectRegistry } from '../pipeline/stationary/stationary-registry.js'
import { TrackCloser } from '../pipeline/track-close.js'
import { TrackerSweep } from '../pipeline/tracker-sweep.js'
import { type Booted, bootAnalytics } from './boot-analytics.js'
import {
  FAKE_SESSION_ROOT,
  type FakeRedetectResult,
  isFullFrameRequest,
  makeFakePipelineExecutor,
} from './test-helpers.js'

const DEVICE_ID = 101
const HANDLE: FrameHandle = {
  shmId: 'ring-101',
  slot: 0,
  seq: 2,
  width: 640,
  height: 480,
  format: 'rgb',
  pts: 1,
  byteLength: 640 * 480 * 3,
  nodeId: 'hub',
  slotCount: 8,
}

function person(id: string, x: number): ObjectDetection {
  return {
    id,
    kind: 'first-level',
    macroClass: 'person',
    score: 0.9,
    labels: [],
    bbox: { x, y: 100, width: 60, height: 150 },
  }
}

function emit(bus: IEventBus, timestamp: number, detections: readonly ObjectDetection[]): void {
  const frame: FrameResult = {
    kind: 'frame',
    // The session detector the gate re-judges with (D925).
    ...FAKE_SESSION_ROOT,
    frameId: `f-${timestamp}`,
    deviceId: DEVICE_ID,
    timestamp,
    width: 640,
    height: 480,
    detections,
  }
  const payload: PipelineInferenceResultPayload = {
    deviceId: DEVICE_ID,
    frame,
    nodeId: 'hub',
    frameHandle: HANDLE,
  }
  bus.emit(
    createEvent(
      EventCategory.PipelineInferenceResult,
      { type: 'addon', id: 'pipeline-runner' },
      payload,
    ),
  )
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise<void>((r) => setTimeout(r, 1))
    await new Promise<void>((r) => setImmediate(r))
  }
}

function processorOf(addon: PipelineAnalyticsAddon): FrameProcessor {
  const frameState = Reflect.get(addon, 'frameState')
  const processors = frameState instanceof FrameState ? frameState.processors : undefined
  if (!(processors instanceof Map)) throw new Error('no processors map')
  const p: FrameProcessor | undefined = processors.get(`${DEVICE_ID}:pipeline`)
  if (p === undefined) throw new Error('no processor for the camera')
  return p
}

type VerdictSink = (verdict: {
  deviceId: number
  trackId: string
  timestamp: number
  identityId: string | null
}) => void

function verdictSinkOf(addon: PipelineAnalyticsAddon): VerdictSink {
  const recognizer: unknown = Reflect.get(addon, 'faceRecognizer')
  const deps: unknown =
    typeof recognizer === 'object' && recognizer !== null ? Reflect.get(recognizer, 'deps') : null
  const sink: unknown =
    typeof deps === 'object' && deps !== null ? Reflect.get(deps, 'onIdentityVerdict') : null
  if (typeof sink !== 'function') throw new Error('no onIdentityVerdict wired')
  return (verdict) => {
    sink(verdict)
  }
}

async function sweepExpiredTracks(addon: PipelineAnalyticsAddon): Promise<void> {
  const sweep: unknown = Reflect.get(addon, 'sweepExpiredTracks')
  if (typeof sweep !== 'function') throw new Error('no sweepExpiredTracks')
  await sweep.call(addon)
}

function trackStartedIds(booted: Booted): string[] {
  const out: string[] = []
  for (const line of booted.logs) {
    if (line.message !== 'track started') continue
    const meta: unknown =
      typeof line.extras === 'object' && line.extras !== null
        ? Reflect.get(line.extras, 'meta')
        : null
    const id: unknown =
      typeof meta === 'object' && meta !== null ? Reflect.get(meta, 'trackId') : null
    if (typeof id === 'string') out.push(id)
  }
  return out
}

/** One `meta` field of a recorded log line, read without a cast. */
function metaField(extras: unknown, key: string): unknown {
  if (typeof extras !== 'object' || extras === null) return undefined
  const meta: unknown = Reflect.get(extras, 'meta')
  return typeof meta === 'object' && meta !== null ? Reflect.get(meta, key) : undefined
}

describe('tracker v2 wiring in the addon (review H1)', () => {
  let booted: Booted | undefined

  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    await flush()
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it("a recognizer verdict reaches the camera's processor through the one sink list", async () => {
    booted = await bootAnalytics(DEVICE_ID, async () => null)
    for (let i = 0; i < 4; i += 1) {
      emit(booted.bus.bus, 1_000 + i * 130, [person('p', 100 + i * 5)])
      await flush()
    }
    const p = processorOf(booted.addon)
    const noted = vi.spyOn(p, 'noteTrackIdentity')
    verdictSinkOf(booted.addon)({
      deviceId: DEVICE_ID,
      trackId: 'the-track',
      timestamp: 1_400,
      identityId: 'bob',
    })
    expect(noted).toHaveBeenCalledWith('the-track', 'bob')
  })

  it("sweepExpiredTracks ends a silent camera's tracklets and hands over its fusion", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000)
    booted = await bootAnalytics(DEVICE_ID, async () => null)
    // A walks for 4 frames; after 1.9 s a new piece appears beside it (no
    // overlap) and walks 1.2 s; then the camera goes SILENT.
    for (let i = 0; i < 5; i += 1) {
      vi.setSystemTime(1_000 + i * 130)
      emit(booted.bus.bus, 1_000 + i * 130, [person('a', 100 + i * 5)])
      await flush()
    }
    for (let t = 3_420; t <= 4_590; t += 130) {
      vi.setSystemTime(t)
      emit(booted.bus.bus, t, [person('b', 230)])
      await flush()
    }
    const [first] = trackStartedIds(booted)
    expect(first, 'A was born').toBeDefined()
    const p = processorOf(booted.addon)
    expect(p.isLive(first!)).toBe(true)
    // D683 Task 12: the sweep's fusion has no frame record, so the tape gets
    // it from `applyTrackFusions` — the one place both paths meet.
    const taped: unknown[] = []
    Reflect.set(booted.addon, 'tapeRecorder', { onFusion: (input: unknown) => taped.push(input) })
    // Only the addon's own sweep runs, every 5 s of wall clock.
    for (let w = 6_000; w <= 21_000; w += 5_000) {
      vi.setSystemTime(w)
      await sweepExpiredTracks(booted.addon)
    }
    Reflect.set(booted.addon, 'tapeRecorder', null)
    expect(p.isLive(first!)).toBe(false)
    expect(taped).toContainEqual({
      deviceId: DEVICE_ID,
      plane: 'pipeline',
      fusion: expect.objectContaining({ survivorId: first }),
    })
    // D683 Task 18: the fusion reaches the service — one INFO line per fusion,
    // once its durable re-point has run on the camera's queue.
    await flush()
    const handed = booted.logs.filter((l) => l.level === 'info' && l.message === 'track fused')
    expect(handed.map((l) => l.extras)).toContainEqual(
      expect.objectContaining({
        tags: { deviceId: DEVICE_ID },
        meta: expect.objectContaining({ survivorId: first }),
      }),
    )
    // D438's question, per tracklet at its own end (review M2).
    const ended = booted.logs.filter((l) => l.message === 'tracker: tracklet ended')
    expect(ended.map((l) => l.extras)).toContainEqual(
      expect.objectContaining({
        tags: { deviceId: DEVICE_ID },
        meta: expect.objectContaining({ reason: 'missed', confirmed: true }),
      }),
    )
  })

  it('the sweep skips an all-zero summary; the frame path still logs one (review LOW-N1)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000)
    booted = await bootAnalytics(DEVICE_ID, async () => null)
    // An empty frame builds the processor and starts its summary window.
    emit(booted.bus.bus, 1_000, [])
    await flush()
    vi.setSystemTime(62_000)
    await sweepExpiredTracks(booted.addon)
    const summaries = (): number =>
      booted?.logs.filter((l) => l.message === 'tracker: v2 summary').length ?? 0
    expect(summaries(), 'an idle processor is silent on the sweep').toBe(0)
    // The frame path keeps its line, idle or not.
    vi.setSystemTime(123_000)
    emit(booted.bus.bus, 123_000, [])
    await flush()
    expect(summaries()).toBe(1)
  })

  it('the sweep still logs a summary that counted something (review L4, LOW-N1)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000)
    booted = await bootAnalytics(DEVICE_ID, async () => null)
    for (let i = 0; i < 5; i += 1) {
      vi.setSystemTime(1_000 + i * 130)
      emit(booted.bus.bus, 1_000 + i * 130, [person('a', 100 + i * 5)])
      await flush()
    }
    // Silence: the sweep ends the tracklet, and its summary is due.
    vi.setSystemTime(62_000)
    await sweepExpiredTracks(booted.addon)
    const line = booted.logs.find((l) => l.message === 'tracker: v2 summary')
    expect(line?.extras).toMatchObject({
      tags: { deviceId: DEVICE_ID },
      meta: { tracklets: { confirmed: { missed: 1 } } },
    })
  })

  it("L2's `new` decisions are sampled per camera; a never-confirmed piece is debug (review M1)", async () => {
    booted = await bootAnalytics(DEVICE_ID, async () => null)
    emit(booted.bus.bus, 1_000, [person('p', 100)])
    await flush()
    const observers: unknown = Reflect.get(processorOf(booted.addon), 'trackerObservers')
    const link: unknown =
      typeof observers === 'object' && observers !== null ? Reflect.get(observers, 'link') : null
    if (typeof link !== 'function') throw new Error('no link observer wired')
    for (let i = 0; i < 100; i += 1) {
      link({ t: i, kind: 'new', to: `n${i}`, reason: 'no-candidate' })
      link({ t: i, kind: 'new', to: `u${i}`, reason: 'unconfirmed' })
    }
    const lines = booted.logs.filter((l) => l.message.startsWith('tracker: piece decided new'))
    // First 10, then one in 50 (50, 100): 12 INFO lines for 100 decisions.
    expect(lines.filter((l) => l.level === 'info')).toHaveLength(12)
    expect(lines.filter((l) => l.level === 'debug')).toHaveLength(100)
  })

  it('an out-of-order frame is dropped, counted in the summary and logged with the camera, sampled (follow-up 102, F1)', async () => {
    booted = await bootAnalytics(DEVICE_ID, async () => null)
    for (let i = 0; i < 4; i += 1) {
      emit(booted.bus.bus, 1_000 + i * 130, [person('p', 100 + i * 5)])
      await flush()
    }
    const p = processorOf(booted.addon)
    p.drainTrackerStats()
    // Stamped 400 ms before the last frame (1 390 ms): dropped unassociated.
    emit(booted.bus.bus, 990, [person('p', 102)])
    await flush()
    expect(p.drainTrackerStats().outOfOrderFrames).toBe(1)
    // The processor's clock did not go back with it (fix round 2, LOW-2).
    expect(p.frameNow(Date.now())).toBeGreaterThanOrEqual(1_390)
    const first = booted.logs.filter((l) => l.message.startsWith('tracker: out-of-order frame'))
    expect(first.map((l) => [l.level, l.extras])).toEqual([
      [
        'info',
        {
          tags: { deviceId: DEVICE_ID },
          meta: expect.objectContaining({
            t: 990,
            lastFrameT: 1_390,
            behindMs: 400,
            detections: 1,
            outOfOrderCount: 1,
          }),
        },
      ],
    ])
    const observers: unknown = Reflect.get(p, 'trackerObservers')
    const outOfOrder: unknown =
      typeof observers === 'object' && observers !== null
        ? Reflect.get(observers, 'outOfOrder')
        : null
    if (typeof outOfOrder !== 'function') throw new Error('no out-of-order observer wired')
    for (let i = 0; i < 99; i += 1)
      outOfOrder({ t: i, lastFrameT: i + 100, behindMs: 100, detections: 1 })
    const lines = booted.logs.filter((l) => l.message.startsWith('tracker: out-of-order frame'))
    // 100 out-of-order frames: the first 10, then the 50th and the 100th.
    expect(lines.map((l) => metaField(l.extras, 'outOfOrderCount'))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 50, 100,
    ])
  })

  it('a frame clock that steps back logs a WARN with the camera, counts it, and keeps tracking (F1 fix rounds 2-3)', async () => {
    booted = await bootAnalytics(DEVICE_ID, async () => null)
    for (let i = 0; i < 4; i += 1) {
      emit(booted.bus.bus, 61_000 + i * 130, [person('p', 100 + i * 5)])
      await flush()
    }
    const p = processorOf(booted.addon)
    p.drainTrackerStats()
    // The runner clock is corrected 60 s back; a walker is seen on the new clock.
    for (let i = 0; i < 4; i += 1) {
      emit(booted.bus.bus, 1_390 + i * 130, [person('q', 900 + i * 5)])
      await flush()
    }
    // The first CLOCK_STEP_CONFIRM_FRAMES − 1 frames on the new clock are
    // dropped; the third is the step (fix round 3).
    const stats = p.drainTrackerStats()
    expect([stats.clockSteps, stats.outOfOrderFrames]).toEqual([1, 2])
    const warns = booted.logs.filter((l) =>
      l.message.startsWith('tracker: frame clock stepped back'),
    )
    expect(warns.map((l) => [l.level, l.extras])).toEqual([
      [
        'warn',
        {
          tags: { deviceId: DEVICE_ID },
          meta: expect.objectContaining({
            t: 1_650,
            lastFrameT: 61_390,
            behindMs: 59_740,
            clockStepCount: 1,
          }),
        },
      ],
    ])
    // The processor's clock was rebased with the tracker's.
    expect(p.frameNow(Date.now())).toBeLessThan(61_390)
  })

  it('clock-step WARNs are sampled past the first ten, and a step-closed piece is not "no predecessor" (fix round 3)', async () => {
    booted = await bootAnalytics(DEVICE_ID, async () => null)
    emit(booted.bus.bus, 1_000, [person('p', 100)])
    await flush()
    const observers: unknown = Reflect.get(processorOf(booted.addon), 'trackerObservers')
    const clockStep: unknown =
      typeof observers === 'object' && observers !== null
        ? Reflect.get(observers, 'clockStep')
        : null
    const link: unknown =
      typeof observers === 'object' && observers !== null ? Reflect.get(observers, 'link') : null
    if (typeof clockStep !== 'function' || typeof link !== 'function')
      throw new Error('tracker observers not wired')
    for (let i = 0; i < 60; i += 1)
      clockStep({ t: i, lastFrameT: i + 60_000, behindMs: 60_000, ended: [] })
    const warns = booted.logs.filter((l) =>
      l.message.startsWith('tracker: frame clock stepped back'),
    )
    expect(warns.map((l) => metaField(l.extras, 'clockStepCount'))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 50,
    ])
    link({ t: 1, kind: 'new', to: 'n1', reason: 'clock-step' })
    const closed = booted.logs.filter((l) => l.message.startsWith('tracker: piece decided new'))
    expect(closed.map((l) => [l.level, l.message])).toEqual([
      ['debug', 'tracker: piece decided new — closed by a frame clock step'],
    ])
  })

  it('an out-of-order frame stops before the registry, the store and the events (fix round 3, MEDIUM-2)', async () => {
    booted = await bootAnalytics(DEVICE_ID, async () => null)
    for (let i = 0; i < 4; i += 1) {
      emit(booted.bus.bus, 1_000 + i * 130, [person('p', 100 + i * 5)])
      await flush()
    }
    const noteFrame = vi.spyOn(StationaryObjectRegistry.prototype, 'noteFrame')
    emit(booted.bus.bus, 990, [person('p', 102)])
    await flush()
    expect(noteFrame).not.toHaveBeenCalled()
    emit(booted.bus.bus, 1_520, [person('p', 120)])
    await flush()
    expect(noteFrame).toHaveBeenCalledWith(DEVICE_ID, 1_520)
  })

  it('a piece decided new although a CONFIRMED predecessor was rejected logs unsampled, with the reason (follow-up 102, F5)', async () => {
    booted = await bootAnalytics(DEVICE_ID, async () => null)
    emit(booted.bus.bus, 1_000, [person('p', 100)])
    await flush()
    const observers: unknown = Reflect.get(processorOf(booted.addon), 'trackerObservers')
    const link: unknown =
      typeof observers === 'object' && observers !== null ? Reflect.get(observers, 'link') : null
    if (typeof link !== 'function') throw new Error('no link observer wired')
    for (let i = 0; i < 100; i += 1) {
      link({
        t: i,
        kind: 'new',
        to: `n${i}`,
        reason: 'no-candidate',
        candidates: [
          { from: `a${i}`, to: `n${i}`, gapMs: 400, rejected: 'reach' },
          { from: `u${i}`, to: `n${i}`, gapMs: 300, rejected: 'unconfirmed' },
        ],
      })
    }
    // Only unconfirmed predecessors were rejected: the ordinary sampled line.
    for (let i = 0; i < 100; i += 1) {
      link({
        t: i,
        kind: 'new',
        to: `m${i}`,
        reason: 'no-candidate',
        candidates: [{ from: `u${i}`, to: `m${i}`, gapMs: 300, rejected: 'unconfirmed' }],
      })
    }
    const rejected = booted.logs.filter((l) =>
      l.message.startsWith('tracker: piece decided new — a confirmed predecessor was rejected'),
    )
    expect(rejected).toHaveLength(100)
    expect(rejected[7]?.extras).toEqual({
      tags: { deviceId: DEVICE_ID },
      meta: expect.objectContaining({
        to: 'n7',
        rejectedPredecessors: [{ from: 'a7', rejected: 'reach', gapMs: 400 }],
      }),
    })
    // Only a concurrent (another subject seen at the same time) or a
    // has-successor predecessor: the ordinary sampled line (fix round 1, MEDIUM-1, LOW-4).
    for (let i = 0; i < 100; i += 1) {
      link({
        t: i,
        kind: 'new',
        to: `c${i}`,
        reason: 'no-candidate',
        candidates: [
          {
            from: `x${i}`,
            to: `c${i}`,
            gapMs: 200,
            rejected: i % 2 === 0 ? 'concurrent' : 'has-successor',
          },
        ],
      })
    }
    // The break line carries the rejected predecessors, not the whole candidate list (LOW-2).
    expect(metaField(rejected[7]?.extras, 'candidates')).toBeUndefined()
    const plain = booted.logs.filter(
      (l) => l.message === 'tracker: piece decided new — no predecessor',
    )
    // The 200 plain ones are sampled on their own count: first 10, then 50, 100, 150, 200.
    expect(plain).toHaveLength(14)
  })

  it('the closer runs even when the tracker sweep throws (review H3)', async () => {
    booted = await bootAnalytics(DEVICE_ID, async () => null)
    const closer: unknown = Reflect.get(booted.addon, 'trackCloser')
    const sweeper: unknown = Reflect.get(booted.addon, 'trackerSweep')
    if (!(closer instanceof TrackCloser) || !(sweeper instanceof TrackerSweep)) {
      throw new Error('collaborators not built')
    }
    const closed = vi.spyOn(closer, 'sweep')
    vi.spyOn(sweeper, 'run').mockRejectedValue(new Error('boom'))
    await sweepExpiredTracks(booted.addon)
    expect(closed).toHaveBeenCalledTimes(1)
    expect(
      booted.logs.some((l) => l.level === 'warn' && l.message.startsWith('tracker sweep failed')),
    ).toBe(true)
  })

  it('a suppressed birth is marked in the tracker (review H3 of the plan)', async () => {
    const LOST: FakeRedetectResult = { width: 320, height: 320, detections: [] }
    const { executor } = makeFakePipelineExecutor(() => LOST)
    const crop = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')
    booted = await bootAnalytics(
      DEVICE_ID,
      async (request) =>
        isFullFrameRequest(request)
          ? null
          : { jpeg: crop, width: 320, height: 320, tier: 'native' as const },
      { pipelineExecutor: executor },
    )
    emit(booted.bus.bus, 1_000, [person('p', 300)])
    await flush()
    const marked = vi.spyOn(processorOf(booted.addon), 'markSuppressed')
    for (let i = 1; i < 8; i += 1) {
      emit(booted.bus.bus, 1_000 + i * 130, [person('p', 300 + i * 4)])
      await flush()
    }
    const retracted = booted.logs.filter(
      (l) => l.message === 'birth suppressed — track record retracted',
    )
    expect(retracted.length, 'the gate suppressed the birth').toBeGreaterThan(0)
    expect(marked).toHaveBeenCalled()
  })
})
