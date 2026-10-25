/**
 * D683 review N2 (M3's own frame-path half): an operator deleting a track
 * that is still LIVE must not leave the tracker handing back an id with
 * nothing behind it for the rest of the subject's time in view.
 *
 * Before this fix: `TrackStore.upsert` refused to resurrect the id (M3), but
 * nothing told the TRACKER — so every later frame of the same subject kept
 * reaching the frame path under the dead id, which (per H4's "second start"
 * half) ran the confirmation gate again, emitted a second `start` lifecycle
 * event and notification, and wrote fresh object-event rows under an id that
 * owns nothing. Only the MEDIA half of that was refused (D220).
 *
 * After this fix: the frame path asks `rowClosedAt` BEFORE the detection
 * reaches any consumer. On a closed id it drops the detection entirely and
 * tells the tracker to DROP the chain (`dropTrack(id, 'dropped')`, never
 * links) — the subject respawns under a brand-new id on its very next
 * sighting, with an ordinary single `start`.
 *
 * Disarm (restored — `index.ts`'s frame loop): drop the
 * `rowClosedAt(t.trackId) !== undefined` pre-check (and its `dropTrack` call)
 * ahead of `currentTrackIds.add` — the subject never gets a new id, and a
 * second `start` fires under the deleted one.
 *
 * Fix round 3 (review R1): the round-2 pre-check lived INSIDE the upsert
 * loop, so it filtered what reached `TrackStore.upsert`/birth classification
 * but left every OTHER reader of that frame's `result` — object events
 * persisted/published at ~9075, the detail dispatcher, snapshot targets
 * (only D220's media gate separately caught that one), first-frame retries,
 * the raster fallback — reading the unfiltered array. Round 3 filters
 * `result` itself right after `process()`, once, before ANY consumer runs.
 * This file's second test pins the gap round 2 left open: on the DROP frame
 * itself (the very next sighting after the delete, before the respawn has
 * had a chance to confirm under a new id), no object-event row is persisted
 * for the deleted id, and no second `start` lifecycle fires for it.
 *
 * Fix round 4 (review S1, S2):
 *  - S1: the frame path's `dropTrack` is a tracker input no frame carries, so
 *    it is recorded on the tracking tape (`tapeRecorder.onDrop`, reason
 *    `dropped`) after the frame it acted on, exactly as a promotion's is. The
 *    third test arms a real in-memory recorder, asserts the drop record, and
 *    replays the tape through `ProcessorTracker`: the chain ends there too.
 *    Disarm: skip the `onDrop` loop after `recordTapeFrame` — "the frame-path
 *    drop is on the tape" fails (no drop record).
 *  - S2: `riderFolds` are filtered of closed ids in the same rebind, so
 *    `markRiderFolded` never writes `hasRider` on a closed or deleted row.
 *    Disarm: drop the `riderFolds` filter — "a rider fold naming the deleted
 *    id never stamps hasRider" fails.
 */
import type {
  FrameHandle,
  FrameResult,
  IEventBus,
  ObjectDetection,
  PipelineInferenceResultPayload,
} from '@camstack/types'
import { createEvent, EventCategory } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { OBJECT_EVENTS_COLLECTION } from '../store/event-store.js'
import { hubFacePseudonymizer } from '../tracking-bench/recorder/frame-record.js'
import type { TapeSink } from '../tracking-bench/recorder/segment-writer.js'
import { TapeRecorder } from '../tracking-bench/recorder/tape-recorder.js'
import { replayTape } from '../tracking-bench/replay.js'
import { decodeTapeText, type Tape } from '../tracking-bench/tape-codec.js'
import { ProcessorTracker } from '../tracking-bench/trackers/processor-tracker.js'
import { makeSilentLogger } from './test-helpers.js'
import { bootAnalytics, type Booted } from './boot-analytics.js'

const DEVICE_ID = 958
const HANDLE: FrameHandle = {
  shmId: 'ring-958',
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

function person(x: number): ObjectDetection {
  return {
    id: 'p',
    kind: 'first-level',
    macroClass: 'person',
    score: 0.9,
    labels: [],
    bbox: { x, y: 100, width: 60, height: 150 },
  }
}

/** The measured reference cyclist (D34, `rider-fold-record.spec.ts`), halved
 *  to this harness's 640×480 frame and moved along by `dx`: person over bike,
 *  the person folds into the machine before the tracker. */
function cyclist(dx: number): readonly ObjectDetection[] {
  return [
    {
      id: 'p',
      kind: 'first-level',
      macroClass: 'person',
      score: 0.72,
      labels: [],
      bbox: { x: 200 + dx, y: 102, width: 35, height: 82 },
      debug: { originalClass: 'person' },
    },
    {
      id: 'v',
      kind: 'first-level',
      macroClass: 'vehicle',
      score: 0.6,
      labels: [],
      bbox: { x: 195 + dx, y: 135, width: 40, height: 70 },
      debug: { originalClass: 'bicycle' },
    },
  ]
}

function emit(bus: IEventBus, timestamp: number, detections: readonly ObjectDetection[]): void {
  const frame: FrameResult = {
    kind: 'frame',
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

/** Object-event rows persisted for ONE trackId so far (review R1's pin —
 *  a closed id must never gain a new event row, on the drop frame or any
 *  frame after). */
function objectEventRowCountFor(booted: Booted, trackId: string): number {
  const rows = booted.settings.data.get(OBJECT_EVENTS_COLLECTION)
  if (rows === undefined) return 0
  let count = 0
  for (const data of rows.values()) {
    if (Reflect.get(data, 'trackId') === trackId) count += 1
  }
  return count
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

/** A REAL recorder, in memory, with every camera's switch forced on — the
 *  frame path re-arms it from settings on every frame, and the harness's
 *  settings leave the tape off (review S1's pin needs a tape). */
class AlwaysArmedRecorder extends TapeRecorder {
  override setArmed(deviceId: number, _armed: boolean): void {
    super.setArmed(deviceId, true)
  }
}

interface MemoryTape {
  readonly recorder: TapeRecorder
  readonly tapes: () => Tape[]
}

function memoryTape(): MemoryTape {
  const files = new Map<string, string[]>()
  let id = 0
  const recorder = new AlwaysArmedRecorder({
    segmentFile: (deviceId, originMs) => `${String(deviceId)}/${String(originMs)}`,
    openSink: async (file): Promise<TapeSink> => {
      const lines: string[] = []
      files.set(file, lines)
      return {
        write: (l) => lines.push(l) > 0,
        onceDrain: () => {},
        flush: async () => {},
        finish: async () => {},
      }
    },
    lighting: async () => 'day',
    stationaryEntries: () => [],
    faces: hubFacePseudonymizer(Buffer.alloc(32, 1)),
    logger: makeSilentLogger(),
    mintTapeId: () => {
      id += 1
      return `seg-${String(id)}`
    },
    onSegmentClosed: () => {},
    session: '0123456789abcdef',
    now: () => 0,
  })
  return {
    recorder,
    tapes: () => [...files.values()].map((lines) => decodeTapeText(lines.join(''))),
  }
}

describe('operator deletes a LIVE track — the subject respawns, it is not refused forever', () => {
  let booted: Booted | undefined

  afterEach(async () => {
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it('one start under the deleted id, then a NEW id — no phantom second start', async () => {
    booted = await bootAnalytics(DEVICE_ID, async () => null)
    let t = 1_000
    // Enough sightings for the confirmation gate to settle the first birth
    // (no crop source in this harness defers it a few attempts).
    for (let i = 0; i < 10; i += 1) {
      emit(booted.bus.bus, t, [person(100 + i * 5)])
      await flush()
      t += 130
    }
    const startedBeforeDelete = trackStartedIds(booted)
    expect(startedBeforeDelete, 'exactly one birth so far').toHaveLength(1)
    const oldId = startedBeforeDelete[0]
    if (oldId === undefined) throw new Error('the first track never started')

    // The operator deletes it while the subject is STILL in view and moving.
    // It was never persisted yet (TTL has not elapsed) — the cascade still
    // runs and `deletePersisted` still marks the row closed, deleting a key
    // that was never there.
    const result = await booted.addon.deleteTracks({ deviceId: DEVICE_ID, trackIds: [oldId] })
    expect(result.failed).toEqual([])

    // The subject keeps moving. The first post-delete frame still carries the
    // OLD id (the tracker has not re-associated yet) and must be dropped;
    // enough further frames let the respawned subject confirm under its new
    // one.
    for (let i = 0; i < 14; i += 1) {
      emit(booted.bus.bus, t, [person(100 + (10 + i) * 5)])
      await flush()
      t += 130
    }

    const startedAfter = trackStartedIds(booted)
    // The deleted id started exactly once — never a second time.
    expect(startedAfter.filter((id) => id === oldId)).toHaveLength(1)
    // A DIFFERENT id started too — the respawn.
    const newIds = [...new Set(startedAfter)].filter((id) => id !== oldId)
    expect(newIds, 'the subject respawned under a new id').toHaveLength(1)

    // The drop was logged (sampled), tagged with the device.
    const dropped = booted.logs.filter((l) => l.message.includes('row already closed'))
    expect(dropped.length).toBeGreaterThan(0)
    expect(dropped[0]?.extras).toMatchObject({ tags: { deviceId: DEVICE_ID } })
  })

  it('on the DROP FRAME itself, the deleted id gets no event row and no second start (review R1)', async () => {
    booted = await bootAnalytics(DEVICE_ID, async () => null)
    let t = 1_000
    for (let i = 0; i < 10; i += 1) {
      emit(booted.bus.bus, t, [person(100 + i * 5)])
      await flush()
      t += 130
    }
    const startedBeforeDelete = trackStartedIds(booted)
    expect(startedBeforeDelete, 'exactly one birth so far').toHaveLength(1)
    const oldId = startedBeforeDelete[0]
    if (oldId === undefined) throw new Error('the first track never started')

    const eventRowsBeforeDelete = objectEventRowCountFor(booted, oldId)

    const result = await booted.addon.deleteTracks({ deviceId: DEVICE_ID, trackIds: [oldId] })
    expect(result.failed).toEqual([])

    // Exactly ONE frame — the drop frame: the subject is still in view, the
    // tracker has not re-associated yet, so this sighting still carries the
    // OLD (closed) id. Checked BEFORE any further frame gives the respawn a
    // chance to confirm under a new one, so this is unambiguously about what
    // happened to the DELETED id on ITS OWN frame, not a side effect of the
    // new bird's later birth.
    emit(booted.bus.bus, t, [person(100 + 10 * 5)])
    await flush()
    t += 130

    // No new object-event row for the deleted id — round 2 only stopped a
    // fresh BIRTH; round 3's upstream filter keeps every other consumer
    // (object-event persist/publish included) from ever seeing this id on
    // this frame at all.
    expect(
      objectEventRowCountFor(booted, oldId),
      'no new event row for the deleted id on the drop frame',
    ).toBe(eventRowsBeforeDelete)
    // No second `start` (and so no second lifecycle/notification) for the
    // deleted id on this frame either.
    expect(
      trackStartedIds(booted).filter((id) => id === oldId),
      'no second start for the deleted id on the drop frame',
    ).toHaveLength(1)

    // Let the respawn confirm under its own id (unrelated to the pin above —
    // just closing out the scene cleanly).
    for (let i = 0; i < 13; i += 1) {
      emit(booted.bus.bus, t, [person(100 + (11 + i) * 5)])
      await flush()
      t += 130
    }
  })

  it('the frame-path drop is on the tape, and a replay of that tape drops the chain too (review S1)', async () => {
    booted = await bootAnalytics(DEVICE_ID, async () => null)
    const mem = memoryTape()
    // Installed before the first frame, so the processor built on it is
    // noted into the segment header exactly as live does at boot.
    Reflect.set(booted.addon, 'tapeRecorder', mem.recorder)
    let t = 1_000
    for (let i = 0; i < 10; i += 1) {
      emit(booted.bus.bus, t, [person(100 + i * 5)])
      await flush()
      t += 130
    }
    const oldId = trackStartedIds(booted)[0]
    if (oldId === undefined) throw new Error('the first track never started')
    const result = await booted.addon.deleteTracks({ deviceId: DEVICE_ID, trackIds: [oldId] })
    expect(result.failed).toEqual([])
    for (let i = 0; i < 14; i += 1) {
      emit(booted.bus.bus, t, [person(100 + (10 + i) * 5)])
      await flush()
      t += 130
    }

    const tapes = mem.tapes()
    expect(tapes, 'one segment for this short scene').toHaveLength(1)
    const tape = tapes[0]
    if (tape === undefined) throw new Error('no tape')
    // The tape carries the frame path's drop, under the live id, with the
    // reason it closed with live.
    const drops = tape.body.flatMap((r) => (r.kind === 'drop' ? [r] : []))
    expect(drops.map((d) => ({ trk: d.trk, reason: d.reason }))).toEqual([
      { trk: oldId, reason: 'dropped' },
    ])
    const drop = drops[0]
    if (drop === undefined) throw new Error('no drop record')

    // The replay resolves it on its own frame and ends the chain there: the
    // subject's later boxes are bound under a DIFFERENT replay id, exactly as
    // live respawned it.
    const tracker = new ProcessorTracker({ logger: makeSilentLogger() })
    const replay = replayTape(tape, tracker, 'pipeline')
    expect(tracker.unresolvedDropRecords, 'the drop resolved on its frame').toBe(0)
    const boundIdAt = (frameT: number): string | undefined =>
      replay.frames.find((f) => f.t === frameT)?.outputs.find((o) => o.detectionId !== undefined)
        ?.liveId
    const droppedReplayId = boundIdAt(drop.t)
    expect(droppedReplayId, 'the subject was bound on the drop frame').toBeDefined()
    const later = replay.frames
      .filter((f) => f.t > drop.t)
      .flatMap((f) => f.outputs.filter((o) => o.detectionId !== undefined).map((o) => o.liveId))
    expect(later.length, 'the subject keeps being seen after the drop').toBeGreaterThan(0)
    expect(later, 'the replay never binds the dropped chain again').not.toContain(droppedReplayId)
  })

  it('a rider fold naming the deleted id never stamps hasRider on its closed row (review S2)', async () => {
    booted = await bootAnalytics(DEVICE_ID, async () => null)
    let t = 1_000
    for (let i = 0; i < 10; i += 1) {
      emit(booted.bus.bus, t, cyclist(i * 5))
      await flush()
      t += 130
    }
    const foldedInto = (): string[] =>
      booted === undefined
        ? []
        : booted.logs
            .filter((l) => l.message === 'rider folded into its machine')
            .flatMap((l) => {
              const meta: unknown =
                typeof l.extras === 'object' && l.extras !== null
                  ? Reflect.get(l.extras, 'meta')
                  : null
              const id: unknown =
                typeof meta === 'object' && meta !== null ? Reflect.get(meta, 'trackId') : null
              return typeof id === 'string' ? [id] : []
            })
    const vehicleId = foldedInto()[0]
    if (vehicleId === undefined) throw new Error('the cyclist never folded into a vehicle track')

    const trackStore: unknown = Reflect.get(booted.addon, 'trackStore')
    if (typeof trackStore !== 'object' || trackStore === null) throw new Error('no track store')
    const stamped: string[] = []
    const original: unknown = Reflect.get(trackStore, 'markRiderFolded')
    if (typeof original !== 'function') throw new Error('no markRiderFolded')
    Reflect.set(trackStore, 'markRiderFolded', (id: string): Promise<void> => {
      stamped.push(id)
      return Reflect.apply(original, trackStore, [id])
    })

    const result = await booted.addon.deleteTracks({ deviceId: DEVICE_ID, trackIds: [vehicleId] })
    expect(result.failed).toEqual([])
    const foldsBeforeDropFrame = foldedInto().length

    // The drop frame: the tracker still hands the cyclist back under the
    // deleted id, and the fold resolves to it.
    emit(booted.bus.bus, t, cyclist(10 * 5))
    await flush()

    expect(stamped, 'no hasRider write for the deleted id').not.toContain(vehicleId)
    expect(
      foldedInto().slice(foldsBeforeDropFrame),
      'no fold reported into the deleted id',
    ).not.toContain(vehicleId)
  })
})
