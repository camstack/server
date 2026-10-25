/**
 * The recorder (spec §3.3). Pinned:
 *  - a camera with the switch off opens nothing — the unarmed cost is one
 *    lookup, and a sink opened for a camera nobody asked about is a disk write
 *    nobody asked for;
 *  - a switched-on camera writes a header (lighting, processor inputs, scene,
 *    stationary entries rebased) and its frames with time RELATIVE to the
 *    segment's origin;
 *  - 10 minutes of frame time rotate the segment (`segment-end`) and the
 *    closed segment triggers the shelf sweep;
 *  - a processor rebuild, a scene change, a dropout skip and a `dropTrack`
 *    each become their record;
 *  - switching off ends the segment `switched-off`;
 *  - a sink that cannot open is reported `failing`, tagged, and not retried
 *    for a minute;
 *  - (amended 2026-09-29 for D683 R3) an identity verdict is written at ITS
 *    frame's time, at call time, after the frames that went by meanwhile, with
 *    `trk` = that frame's live id; one whose segment has closed is logged,
 *    never written at a wrong time.
 *
 * Disarms:
 *  - remove the `!cam.armed` early return in `onFrame` — the first test must fail;
 *  - (amended for D683 R3) stamp an identity with `seg.lastT` instead of
 *    `verdict.timestamp − origin`: "writes an identity verdict at its own
 *    frame's time" fails;
 *  - (amended for D683 R3) queue identities and write them in `flushControl`
 *    on the next frame: the same test fails (the records come after the next
 *    frame, stamped with its time);
 *  - (amended for D683 R3) drop the `timestamp < seg.originMs` check: "a
 *    verdict whose segment has closed is logged" fails (a negative `t` lands in
 *    the new segment).
 *  - (Task 10) remove the try/catch in `onFrame`: "a dependency that throws
 *    never reaches the frame path" fails (the throw escapes into the caller,
 *    which in production is `processFrame`);
 *  - (Task 10) in `openSegment`, install `cam.segment` BEFORE
 *    `stationaryEntries` is read: the same test fails at the retry (the
 *    half-installed segment swallows every later frame, no file ever opens);
 *  - (Task 10 fix round, M1) in `entryFailed`, do not close the open
 *    segment: "a throw inside an open segment ends it recorder-error" fails
 *    (the segment stays open and frames resume in it after a silent hole);
 *  - (D683 Task 14 fix round 1, H2) in `recordDrop`, write `reason: 'dropped'`
 *    instead of the input's: "records the drop's OWN reason" fails;
 *  - (Task 10 fix round, L2) in `stopAll`, drop the deadline race: "stopAll
 *    gives up on a hung sink at its deadline" times out;
 *  - (Task 10, carried from the Task 9 review) in `finishSegment`, drop the
 *    `outcome !== 'closed'` early return: "a segment whose sink cannot finish
 *    is logged and never swept" fails (the sweep is called for a segment that
 *    never closed).
 *  - (Task 12 fix round, H1) omit `session` from the header: "every segment
 *    carries the recorder session" fails;
 *  - (Task 12 fix round, H1) in `rotateCovering`, drop the `originMs > atMs`
 *    check: "a promotion of a window before the open segment leaves it open"
 *    fails;
 *  - (Task 12 fix round, L5) in `closeSegment`, return without awaiting a
 *    segment still opening: "rotateNow waits for a segment that is still
 *    opening" fails.
 *  - (D683 Task 12) stamp a fusion with `seg.lastT` instead of
 *    `fusion.t − origin`: "writes an L2 fusion at its own frame's time" fails;
 *  - (D683 Task 12) drop the `t < seg.originMs` check in `recordFusion`: "a
 *    fusion whose segment has closed is logged" fails;
 *  - (D681 follow-up) empty `flushOpenSegments`: "flushes every open segment
 *    without rotating" fails.
 */
import type { FrameResult } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeLogRecorder } from '../../../__tests__/test-helpers.js'
import type { FrameObservation } from '../../../pipeline/frame-observation.js'
import type { StationaryEntry } from '../../../pipeline/stationary/stationary-types.js'
import type { TrackFusion } from '../../../pipeline/tracker-v2/index.js'
import { sampleInputs, sampleScene } from '../../__tests__/tape-fixtures.js'
import { decodeTapeText, type Tape } from '../../tape-codec.js'
import { hubFacePseudonymizer } from '../frame-record.js'
import type { TapeSink } from '../segment-writer.js'
import { OPEN_RETRY_MS, SEGMENT_MS, TapeRecorder } from '../tape-recorder.js'
import type { TapeRecorderDeps } from '../tape-recorder-types.js'

const T0 = 1_750_000_000_000

function frameAt(ts: number): FrameResult {
  return {
    kind: 'frame',
    frameId: `f-${String(ts)}`,
    deviceId: 101,
    timestamp: ts,
    width: 1280,
    height: 720,
    detections: [
      {
        id: `d-${String(ts)}`,
        kind: 'first-level',
        macroClass: 'person',
        score: 0.9,
        labels: [],
        bbox: { x: 1, y: 2, width: 3, height: 4 },
      },
    ],
  }
}

const OBS: FrameObservation = { gate: { strong: [], weak: [], confirmed: [], woken: [] }, live: [] }

/** A frame whose tracker bound `trk-7` to its person (amended for D683 R3). */
function obsBound(ts: number): FrameObservation {
  return {
    ...OBS,
    live: [{ trackId: 'trk-7', detectionId: `d-${String(ts)}`, matched: true, state: 'moving' }],
  }
}

const FACES = hubFacePseudonymizer(Buffer.alloc(32, 1))

/** An L2 fusion committed at frame time `t` (D683 Task 12). */
const FUSION = (t: number): TrackFusion => ({
  survivorId: 'trk-1',
  absorbedId: 'trk-2',
  members: ['trk-2', 'trk-3'],
  t,
  cost: 0.4,
  gapMs: 2_000,
})

const STATIONARY: readonly StationaryEntry[] = [
  {
    id: 'e1',
    deviceId: 101,
    className: 'vehicle',
    bbox: { x: 10, y: 20, w: 30, h: 40 },
    frameWidth: 1280,
    frameHeight: 720,
    firstSeenAt: T0 - 90_000,
    becameStationaryAt: T0 - 60_000,
    lastConfirmedAt: T0 - 1_000,
  },
]

interface Harness {
  readonly recorder: TapeRecorder
  readonly files: Map<string, string[]>
  readonly closed: number[]
  readonly flushed: string[]
  readonly entries: ReturnType<typeof makeLogRecorder>['entries']
  failOpen: boolean
  failFinish: boolean
  failEntries: boolean
  failFaces: boolean
  hangFinish: boolean
  /** While set, `openSink` waits on it — a sink that is slow to open. */
  openGate: Promise<void> | null
  now: number
}

const SESSION = '0123456789abcdef'

function harness(): Harness {
  const files = new Map<string, string[]>()
  const closed: number[] = []
  const flushed: string[] = []
  const { logger, entries } = makeLogRecorder()
  let id = 0
  const h: Harness = {
    recorder: new TapeRecorder({
      segmentFile: (deviceId, originMs) => `${String(deviceId)}/${String(originMs)}`,
      openSink: async (file): Promise<TapeSink> => {
        if (h.openGate !== null) await h.openGate
        if (h.failOpen) throw new Error('EACCES')
        const lines: string[] = []
        files.set(file, lines)
        return {
          write: (l) => lines.push(l) > 0,
          onceDrain: () => {},
          flush: async () => {
            h.flushed.push(file)
          },
          finish: async () => {
            if (h.hangFinish) await new Promise<never>(() => {})
            if (h.failFinish) throw new Error('EIO')
          },
        }
      },
      lighting: async () => 'ir',
      stationaryEntries: () => {
        if (h.failEntries) throw new Error('registry torn down')
        return STATIONARY
      },
      faces: {
        pseudonym: (label) => {
          if (h.failFaces) throw new Error('hmac unavailable')
          return FACES.pseudonym(label)
        },
      },
      logger,
      mintTapeId: () => {
        id += 1
        return `seg-000${String(id)}`
      },
      onSegmentClosed: (deviceId) => closed.push(deviceId),
      session: SESSION,
      now: () => h.now,
    } satisfies TapeRecorderDeps),
    files,
    closed,
    flushed,
    entries,
    failOpen: false,
    failFinish: false,
    failEntries: false,
    failFaces: false,
    hangFinish: false,
    openGate: null,
    now: T0,
  }
  return h
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function tapeOf(h: Harness, originMs: number): Tape {
  return decodeTapeText((h.files.get(`101/${String(originMs)}`) ?? []).join(''))
}

function feed(h: Harness, ts: number): void {
  h.recorder.onFrame({
    deviceId: 101,
    plane: 'pipeline',
    frame: frameAt(ts),
    injectedIds: new Set(),
    observation: OBS,
    scene: sampleScene(),
  })
}

describe('TapeRecorder', () => {
  it('opens nothing for a camera whose switch is off', async () => {
    const h = harness()
    h.recorder.noteProcessor(101, 'pipeline', sampleInputs())
    feed(h, T0)
    await settle()
    expect(h.files.size).toBe(0)
    expect(h.recorder.status(101).state).toBe('off')
  })

  it('writes a header and relative-time frames for a switched-on camera', async () => {
    const h = harness()
    h.recorder.setArmed(101, true)
    h.recorder.noteProcessor(101, 'pipeline', sampleInputs())
    feed(h, T0)
    feed(h, T0 + 140)
    await settle()
    await h.recorder.rotateNow(101)
    const tape = tapeOf(h, T0)
    expect(tape.header).toMatchObject({
      deviceId: 101,
      lighting: 'ir',
      planes: { pipeline: sampleInputs() },
    })
    expect(tape.header.stationaryEntries).toEqual([
      { id: 'e1', cls: 'vehicle', b: [10, 20, 30, 40], since: -60_000 },
    ])
    expect(tape.body.map((r) => r.kind)).toEqual(['processor', 'frame', 'frame'])
    expect(tape.body.filter((r) => r.kind === 'frame').map((r) => ('t' in r ? r.t : -1))).toEqual([
      0, 140,
    ])
    expect(JSON.stringify(tape)).not.toContain(String(T0))
  })

  it('every segment carries the recorder session (Task 12 fix round, H1)', async () => {
    const h = harness()
    h.recorder.setArmed(101, true)
    feed(h, T0)
    feed(h, T0 + SEGMENT_MS)
    await settle()
    await h.recorder.rotateNow(101)
    expect(tapeOf(h, T0).header.session).toBe(SESSION)
    expect(tapeOf(h, T0 + SEGMENT_MS).header.session).toBe(SESSION)
  })

  it('a promotion of a window before the open segment leaves it open (Task 12 fix round, H1)', async () => {
    const h = harness()
    h.recorder.setArmed(101, true)
    feed(h, T0)
    await settle()
    expect(await h.recorder.rotateCovering(101, T0 - 1)).toBe(false)
    expect(h.recorder.status(101).segmentOriginMs).toBe(T0)
    expect(h.closed).toEqual([])
    expect(await h.recorder.rotateCovering(101, T0)).toBe(true)
    expect(h.recorder.status(101).segmentOriginMs).toBeUndefined()
    expect(tapeOf(h, T0).end?.reason).toBe('segment-end')
  })

  it('flushes every open segment without rotating (D681 follow-up)', async () => {
    const h = harness()
    h.recorder.setArmed(101, true)
    feed(h, T0)
    await settle()
    expect(h.recorder.status(101).segmentOriginMs).toBe(T0)
    await h.recorder.flushOpenSegments()
    expect(h.flushed).toEqual([`101/${String(T0)}`])
    expect(h.closed).toEqual([])
    expect(h.recorder.status(101).segmentOriginMs).toBe(T0)
  })

  it('rotateNow waits for a segment that is still opening (Task 12 fix round, L5)', async () => {
    const h = harness()
    let release = (): void => {}
    h.openGate = new Promise<void>((resolve) => {
      release = resolve
    })
    h.recorder.setArmed(101, true)
    feed(h, T0)
    let done = false
    const rotation = h.recorder.rotateNow(101).then(() => {
      done = true
    })
    await settle()
    expect(done).toBe(false)
    release()
    await rotation
    expect(tapeOf(h, T0).end?.reason).toBe('segment-end')
    expect(h.closed).toEqual([101])
  })

  it('rotates after 10 minutes of frame time and sweeps after closing', async () => {
    const h = harness()
    h.recorder.setArmed(101, true)
    feed(h, T0)
    feed(h, T0 + SEGMENT_MS)
    await settle()
    await settle()
    expect(tapeOf(h, T0).end?.reason).toBe('segment-end')
    expect(h.files.has(`101/${String(T0 + SEGMENT_MS)}`)).toBe(true)
    expect(h.closed).toEqual([101])
  })

  it('records a rebuild, a scene change, a skip and a drop', async () => {
    const h = harness()
    h.recorder.setArmed(101, true)
    feed(h, T0)
    h.recorder.noteProcessor(101, 'pipeline', sampleInputs())
    h.recorder.noteProcessor(101, 'pipeline', sampleInputs())
    h.recorder.onFrame({
      deviceId: 101,
      plane: 'pipeline',
      frame: frameAt(T0 + 140),
      injectedIds: new Set(),
      observation: OBS,
      scene: { ...sampleScene(), zoneMembershipMinOverlap: 0.2 },
    })
    h.recorder.onSkip({ deviceId: 101, plane: 'pipeline', frame: frameAt(T0 + 280) })
    h.recorder.onDrop({
      deviceId: 101,
      plane: 'pipeline',
      trackId: 'trk-9',
      atMs: T0 + 280,
      reason: 'dropped',
    })
    await settle()
    await h.recorder.rotateNow(101)
    const kinds = tapeOf(h, T0).body.map((r) => r.kind)
    expect(kinds).toEqual(['frame', 'processor', 'scene', 'frame', 'skip', 'drop'])
    const rebuilt = tapeOf(h, T0).body.find((r) => r.kind === 'processor')
    expect(rebuilt).toMatchObject({ reason: 'rebuilt', t: 140 })
  })

  it("records the drop's OWN reason — a moved subject's promotion is 'stationary' (D683 Task 14)", async () => {
    const h = harness()
    h.recorder.setArmed(101, true)
    feed(h, T0)
    h.recorder.onDrop({
      deviceId: 101,
      plane: 'pipeline',
      trackId: 'walked-in',
      atMs: T0,
      reason: 'stationary',
    })
    h.recorder.onDrop({
      deviceId: 101,
      plane: 'pipeline',
      trackId: 'always-there',
      atMs: T0,
      reason: 'dropped',
    })
    await settle()
    await h.recorder.rotateNow(101)
    const drops = tapeOf(h, T0).body.flatMap((r) =>
      r.kind === 'drop' ? [{ trk: r.trk, reason: r.reason }] : [],
    )
    expect(drops).toEqual([
      { trk: 'walked-in', reason: 'stationary' },
      { trk: 'always-there', reason: 'dropped' },
    ])
  })

  it('ends the segment switched-off when the switch goes off', async () => {
    const h = harness()
    h.recorder.setArmed(101, true)
    feed(h, T0)
    await settle()
    h.recorder.setArmed(101, false)
    await settle()
    expect(tapeOf(h, T0).end?.reason).toBe('switched-off')
    expect(h.recorder.status(101).state).toBe('off')
  })

  it("writes an identity verdict at its own frame's time, after the frames that went by (amended 2026-09-29 for D683 R3)", async () => {
    const h = harness()
    const faces = hubFacePseudonymizer(Buffer.alloc(32, 1))
    h.recorder.setArmed(101, true)
    for (const ts of [T0, T0 + 140, T0 + 280, T0 + 420]) {
      h.recorder.onFrame({
        deviceId: 101,
        plane: 'pipeline',
        frame: frameAt(ts),
        injectedIds: new Set(),
        observation: obsBound(ts),
        scene: sampleScene(),
      })
    }
    // The recognizer's second pass observes the verdict for frame T0+140 only
    // now, three frames later; then it takes it back on T0+280.
    h.recorder.onIdentity({
      deviceId: 101,
      trackId: 'trk-7',
      timestamp: T0 + 140,
      identityId: 'id-alice',
    })
    h.recorder.onIdentity({
      deviceId: 101,
      trackId: 'trk-7',
      timestamp: T0 + 280,
      identityId: null,
    })
    h.recorder.onFrame({
      deviceId: 101,
      plane: 'pipeline',
      frame: frameAt(T0 + 560),
      injectedIds: new Set(),
      observation: obsBound(T0 + 560),
      scene: sampleScene(),
    })
    await settle()
    await h.recorder.rotateNow(101)
    const body = tapeOf(h, T0).body
    expect(body.map((r) => r.kind)).toEqual([
      'frame',
      'frame',
      'frame',
      'frame',
      'identity',
      'identity',
      'frame',
    ])
    const ids = body.filter((r) => r.kind === 'identity')
    expect(ids).toEqual([
      { kind: 'identity', t: 140, trk: 'trk-7', fid: faces.pseudonym('id-alice') },
      { kind: 'identity', t: 280, trk: 'trk-7', fid: null },
    ])
    const onItsFrame = body.find((r) => r.kind === 'frame' && r.t === 140)
    expect(onItsFrame?.kind === 'frame' ? onItsFrame.live.map((l) => l.trk) : []).toEqual(['trk-7'])
  })

  it('a verdict whose segment has closed is logged, never written at a wrong time (amended 2026-09-29 for D683 R3)', async () => {
    const h = harness()
    h.recorder.setArmed(101, true)
    feed(h, T0)
    feed(h, T0 + SEGMENT_MS)
    await settle()
    await settle()
    h.recorder.onIdentity({
      deviceId: 101,
      trackId: 'trk-7',
      timestamp: T0 + 100,
      identityId: 'id-alice',
    })
    await h.recorder.rotateNow(101)
    expect(tapeOf(h, T0 + SEGMENT_MS).body.some((r) => r.kind === 'identity')).toBe(false)
    const line = h.entries.find((e) => e.message === 'tracking tape identity not recorded')
    expect(line?.extras?.tags).toEqual({ deviceId: 101 })
    expect(line?.extras?.meta).toMatchObject({ trackId: 'trk-7', reason: 'segment-closed' })
  })

  it('an unarmed camera records no identity', async () => {
    const h = harness()
    h.recorder.onIdentity({
      deviceId: 101,
      trackId: 'trk-7',
      timestamp: T0,
      identityId: 'id-alice',
    })
    await settle()
    expect(h.files.size).toBe(0)
    expect(h.entries.some((e) => e.message === 'tracking tape identity not recorded')).toBe(false)
  })

  it("writes an L2 fusion at its own frame's time, at call time (D683 Task 12)", async () => {
    const h = harness()
    h.recorder.setArmed(101, true)
    feed(h, T0)
    feed(h, T0 + 140)
    feed(h, T0 + 280)
    // Committed at T0+140, handed over only now (the sweep path has no frame
    // record): stamped at its own time, landed in call order.
    h.recorder.onFusion({ deviceId: 101, plane: 'pipeline', fusion: FUSION(T0 + 140) })
    feed(h, T0 + 420)
    await settle()
    await h.recorder.rotateNow(101)
    const body = tapeOf(h, T0).body
    expect(body.map((r) => r.kind)).toEqual(['frame', 'frame', 'frame', 'fusion', 'frame'])
    expect(body.find((r) => r.kind === 'fusion')).toEqual({
      kind: 'fusion',
      t: 140,
      plane: 'pipeline',
      survivor: 'trk-1',
      absorbed: 'trk-2',
      members: ['trk-2', 'trk-3'],
    })
  })

  it('a fusion whose segment has closed is logged, never written at a wrong time (D683 Task 12)', async () => {
    const h = harness()
    h.recorder.setArmed(101, true)
    feed(h, T0)
    feed(h, T0 + SEGMENT_MS)
    await settle()
    await settle()
    h.recorder.onFusion({ deviceId: 101, plane: 'pipeline', fusion: FUSION(T0 + 100) })
    await h.recorder.rotateNow(101)
    expect(tapeOf(h, T0 + SEGMENT_MS).body.some((r) => r.kind === 'fusion')).toBe(false)
    const line = h.entries.find((e) => e.message === 'tracking tape fusion not recorded')
    expect(line?.extras?.tags).toEqual({ deviceId: 101 })
    expect(line?.extras?.meta).toMatchObject({ survivorId: 'trk-1', reason: 'segment-closed' })
  })

  it('an unarmed camera records no fusion (D683 Task 12)', async () => {
    const h = harness()
    h.recorder.onFusion({ deviceId: 101, plane: 'pipeline', fusion: FUSION(T0) })
    await settle()
    expect(h.files.size).toBe(0)
    expect(h.entries.some((e) => e.message === 'tracking tape fusion not recorded')).toBe(false)
  })

  it('a dependency that throws never reaches the frame path, is reported failing, and retries', async () => {
    const h = harness()
    h.recorder.setArmed(101, true)
    h.failEntries = true
    expect(() => feed(h, T0)).not.toThrow()
    await settle()
    expect(h.files.size).toBe(0)
    expect(h.recorder.status(101)).toMatchObject({ state: 'failing', reason: 'registry torn down' })
    const line = h.entries.find((e) => e.message === 'tracking tape record failed')
    expect(line?.extras?.tags).toEqual({ deviceId: 101 })
    expect(line?.extras?.meta).toMatchObject({ record: 'frame', error: 'registry torn down' })
    // Backed off like a sink that cannot open: one line a minute, not one a frame.
    feed(h, T0 + 140)
    expect(h.entries.filter((e) => e.message === 'tracking tape record failed')).toHaveLength(1)
    h.failEntries = false
    h.now = T0 + OPEN_RETRY_MS
    feed(h, T0 + OPEN_RETRY_MS)
    await settle()
    expect(h.files.size).toBe(1)
    expect(h.recorder.status(101).state).toBe('recording')
  })

  it('a throw inside an open segment ends it recorder-error; the next opens fresh after the backoff', async () => {
    const h = harness()
    h.recorder.setArmed(101, true)
    feed(h, T0)
    await settle()
    h.failFaces = true
    expect(() =>
      h.recorder.onIdentity({ deviceId: 101, trackId: 'trk-7', timestamp: T0, identityId: 'id-a' }),
    ).not.toThrow()
    h.failFaces = false
    await settle()
    // The loss falls BETWEEN segments: the open one is ended with a reason a
    // promotion reads as a `restart` gap, never resumed after a silent hole.
    expect(tapeOf(h, T0).end?.reason).toBe('recorder-error')
    expect(h.recorder.status(101)).toMatchObject({ state: 'failing', gapsSinceArmed: 1 })
    const line = h.entries.find((e) => e.message === 'tracking tape record failed')
    expect(line?.extras?.tags).toEqual({ deviceId: 101 })
    expect(line?.extras?.meta).toMatchObject({ record: 'identity', segmentEnded: true })
    feed(h, T0 + 140)
    await settle()
    expect(h.files.size).toBe(1)
    h.now = T0 + OPEN_RETRY_MS
    feed(h, T0 + OPEN_RETRY_MS)
    await settle()
    await h.recorder.rotateNow(101)
    const next = tapeOf(h, T0 + OPEN_RETRY_MS)
    expect(next.header.deviceId).toBe(101)
    expect(next.body.filter((r) => r.kind === 'frame')).toHaveLength(1)
  })

  it('stopAll gives up on a hung sink at its deadline, and says so', async () => {
    const h = harness()
    h.recorder.setArmed(101, true)
    feed(h, T0)
    await settle()
    h.hangFinish = true
    await expect(h.recorder.stopAll(20)).resolves.toBe('timed-out')
    const line = h.entries.find((e) => e.message === 'tracking tapes did not stop in time')
    expect(line?.extras?.meta).toMatchObject({ deadlineMs: 20 })
  })

  it('a segment whose sink cannot finish is logged and never swept', async () => {
    const h = harness()
    h.recorder.setArmed(101, true)
    feed(h, T0)
    await settle()
    h.failFinish = true
    await h.recorder.rotateNow(101)
    expect(h.closed).toEqual([])
    const line = h.entries.find((e) => e.message === 'tracking tape segment could not close')
    expect(line?.extras?.tags).toEqual({ deviceId: 101 })
    expect(line?.extras?.meta).toMatchObject({ originMs: T0, reason: 'segment-end' })
    expect(h.entries.some((e) => e.message === 'tracking tape segment closed')).toBe(false)
  })

  it('reports a sink that cannot open as failing, tagged, and waits before retrying', async () => {
    const h = harness()
    h.failOpen = true
    h.recorder.setArmed(101, true)
    feed(h, T0)
    await settle()
    expect(h.recorder.status(101)).toMatchObject({ state: 'failing', reason: 'EACCES' })
    const line = h.entries.find((e) => e.message === 'tracking tape segment could not open')
    expect(line?.extras?.tags).toEqual({ deviceId: 101 })
    h.failOpen = false
    feed(h, T0 + 140)
    await settle()
    expect(h.files.size).toBe(0)
    h.now = T0 + OPEN_RETRY_MS
    feed(h, T0 + OPEN_RETRY_MS)
    await settle()
    expect(h.files.size).toBe(1)
  })
})
