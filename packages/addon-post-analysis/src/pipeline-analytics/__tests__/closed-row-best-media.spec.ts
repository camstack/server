/**
 * A CLOSED track row never receives best media, END TO END through the booted
 * addon.
 *
 * Incident 2026-08-21, track `b50e09f7`: a person track whose row had been
 * closed 4.4 minutes earlier had its `thumbnail`, `keyFrame` and `lastFrame`
 * overwritten with photos of a DOG. On a detection-per-session camera the
 * tracker does not run between sessions, so its in-memory track stayed alive
 * with a frozen bbox while the row expired; the animal that walked back in
 * matched that frozen box and inherited the dead track's id. Measured scope:
 * 21 of 7019 tracks in 72 h received best media up to 4.5 min after their last
 * sighting.
 *
 * The association root is closed in the tracker (pre-association purge past the
 * real bound, `sort-tracker.ts`). This is the CAPTURE-side half: whatever the
 * tracker hands back, a row the store has already closed must never be written
 * again. It cannot be unit-tested off the decision alone — the defect is in the
 * frame loop's WIRING, exactly like the two e2e specs next to this one — so
 * this boots the real addon, closes a row under a live tracker, and reads the
 * media rows the addon actually persisted.
 *
 * D683 Task 16 added a SECOND, independent gate ahead of this one:
 * `TrackStore.expireStale` now also asks `TrackerSweep.canClose` (the
 * tracker's own chain-liveness + tail-finality verdict) before closing a row
 * at all — see `track-close-gate.spec.ts` and its wiring e2e. This spec's
 * scenario (the row closes while the tracker still legitimately holds the
 * id) is exactly what that gate exists to prevent going forward, so it is
 * forced open here (`canClose` stubbed `true`) to keep exercising the
 * CAPTURE-side defense this file is actually about, independent of whichever
 * path a row closed through.
 *
 * Fix round 2 (review N2): the frame path now asks `rowClosedAt` ahead of
 * EVERY consumer and drops the tracker's chain for a closed id, so the
 * subject no longer keeps matching under the dead id at all — it respawns
 * under a fresh one. The invariant this file pins is therefore no longer
 * "nothing changes" but "the closed id's OWN rows never change, and nothing
 * NEW ever lands under it" — a new id earning its own media is the fix
 * working, not a regression.
 *
 * Fix round 3 (review R1, "reviewer extra disarm"): round 2's fix filters
 * `result` right after `processor.process()` — before `buildSnapshotTargets`
 * (D220's OWN gate) ever runs on this frame — so the closed id no longer
 * reaches D220's check at all, not merely gets refused by it. The second
 * spec below proves this is a SEPARATE, independent layer: it forces D220's
 * own `closedRowMediaGate` to never refuse (equivalent to the reviewer's
 * disarm of passing `undefined` instead of `rowClosedAt` at the call site)
 * and the SAME invariant still holds, because the closed id was filtered out
 * before D220 ever got asked.
 *
 * Follow-up 102 (round 2 re-review): the baseline is the row AS ITS CLOSE LEFT
 * IT, not the media before the close. Under load a rolling `lastFrame` capture
 * can be dropped for the last live frames, and the close path's own D400
 * promotion then legitimately rewrites `lastFrame` to the newest pre-close
 * snapshot (8000 over 6000) — a close-path write, never a capture-gate one,
 * which failed this spec 1 run in 7 under load on the base. The invariant is
 * pinned two ways: the closed id's rows never change after the close, and none
 * of them ever holds a frame later than the last live one. Disarm (the
 * frame-path closed-id filter off): the D220-disabled test goes RED.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  FrameHandle,
  FrameResult,
  IEventBus,
  ObjectDetection,
  PipelineInferenceResultPayload,
} from '@camstack/types'
import { EventCategory, createEvent } from '@camstack/types'
import { encodeRgbCropToJpeg } from '../../shared/frame/encode-crop.js'
import { ClosedRowMediaGate } from '../pipeline/closed-row-media-gate.js'
import { TrackerSweep } from '../pipeline/tracker-sweep.js'
import { bootAnalytics, type Booted } from './boot-analytics.js'
import { MEDIA_COLLECTION } from '../store/media-store.js'
import type { FakeEventBus, FakeNativeCropReply } from './test-helpers.js'

const DEVICE_ID = 102
const OWNER_NODE = 'agent-a'
/** The addon's own TTL sweep cadence (`TTL_SWEEP_INTERVAL_MS`). */
const TTL_SWEEP_INTERVAL_MS = 5_000
/** The media kinds the incident overwrote — every one a single-instance row. */
const BEST_MEDIA_KINDS = new Set(['thumbnail', 'thumbnailSmall', 'keyFrame', 'lastFrame'])

const HANDLE: FrameHandle = {
  shmId: 'ring-102',
  slot: 0,
  seq: 2,
  width: 640,
  height: 480,
  format: 'rgb',
  pts: 1,
  byteLength: 640 * 480 * 3,
  nodeId: OWNER_NODE,
  slotCount: 8,
}

let nativeJpegBase64 = ''

async function nativeReply(): Promise<FakeNativeCropReply> {
  if (nativeJpegBase64 === '') {
    const rgb = Buffer.allocUnsafe(64 * 48 * 3)
    for (let i = 0; i < rgb.length; i += 1) rgb[i] = (i * 37) & 0xff
    const jpeg = await encodeRgbCropToJpeg(rgb, 64, 48)
    nativeJpegBase64 = (jpeg ?? Buffer.alloc(0)).toString('base64')
  }
  return { jpeg: nativeJpegBase64, width: 64, height: 48, tier: 'native' }
}

/** A subject that MOVES a little — always re-associates, never coasts. */
function detection(x: number): ObjectDetection {
  return {
    id: 'd1',
    kind: 'first-level',
    macroClass: 'person',
    score: 0.9,
    labels: [],
    bbox: { x, y: 160, width: 200, height: 160 },
  }
}

function buildFrame(timestamp: number, x: number): FrameResult {
  return {
    kind: 'frame',
    frameId: `f-${timestamp}`,
    deviceId: DEVICE_ID,
    timestamp,
    width: 640,
    height: 480,
    detections: [detection(x)],
  }
}

function emitInference(bus: IEventBus, timestamp: number, x: number): void {
  const payload: PipelineInferenceResultPayload = {
    deviceId: DEVICE_ID,
    frame: buildFrame(timestamp, x),
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

/** Frame timestamps sit in the far past (epoch ms), which is what makes the
 *  wall-clock TTL sweep treat every track as stale the moment it runs. */
async function driveFrames(
  bus: FakeEventBus,
  from: number,
  count: number,
  stepMs = 1_000,
): Promise<number> {
  let ts = from
  for (let i = 0; i < count; i += 1) {
    ts = from + i * stepMs
    emitInference(bus.bus, ts, 220 + (i % 3) * 4)
    await flush()
  }
  return ts
}

interface MediaRow {
  readonly ownerId: string
  readonly kind: string
  readonly timestamp: number
}

function bestMediaRows(booted: Booted): MediaRow[] {
  const rows = booted.settings.data.get(MEDIA_COLLECTION)
  if (rows === undefined) return []
  const out: MediaRow[] = []
  for (const record of rows.values()) {
    const kind = String(record.kind)
    if (!BEST_MEDIA_KINDS.has(kind)) continue
    out.push({
      ownerId: String(record.ownerId),
      kind,
      timestamp: Number(record.timestamp),
    })
  }
  return out
}

/** `kind → timestamp` of every best-media row currently held for a TRACK. */
function bestMediaByKind(booted: Booted): Map<string, number> {
  const map = new Map<string, number>()
  for (const row of bestMediaRows(booted)) map.set(`${row.ownerId}:${row.kind}`, row.timestamp)
  return map
}

/**
 * Flush until the media rows STOP changing.
 *
 * Every capture is an async encode → put round-trip, so a fixed number of
 * flushes samples an arbitrary moment of the write tail. That cuts both ways: a
 * premature snapshot of the "before" state under-counts, and a premature
 * snapshot of the "after" state would let a late overwrite — the very thing
 * under test — land unseen and the spec pass.
 */
async function settleMedia(
  booted: Booted,
  requiredKinds: ReadonlySet<string> = new Set(),
): Promise<Map<string, number>> {
  let previous = ''
  let stable = 0
  for (let i = 0; i < 80; i += 1) {
    await flush()
    const current = bestMediaByKind(booted)
    const snapshot = JSON.stringify([...current].toSorted())
    stable = snapshot === previous ? stable + 1 : 0
    previous = snapshot
    const kinds = new Set([...current.keys()].map((k) => k.split(':')[1]))
    const complete = [...requiredKinds].every((k) => kinds.has(k))
    if (stable >= 3 && complete) return current
  }
  return bestMediaByKind(booted)
}

/**
 * Why `requiredKinds` exists: "unchanged for three flushes" is a guess about a
 * write tail, and under a loaded suite the encode → put round-trip can go quiet
 * for longer than that and then continue. The BEFORE snapshot then under-counts
 * and the spec fails on its own precondition — which is what happened here,
 * only ever when this file ran alongside the rest of the suite.
 *
 * Waiting for the kinds the precondition already names removes the guess
 * without weakening anything: if a kind genuinely never lands, the loop runs
 * out and the precondition assertion still fails. The AFTER snapshot passes NO
 * required kinds on purpose — it is hunting for a write that must not happen,
 * so it may only ever wait for quiet.
 */

/**
 * Drive frames until the track owns every best-media kind.
 *
 * Flushing harder cannot make a fixed frame count reliable. A rolling capture
 * that is DROPPED under load releases its in-flight key without advancing the
 * clock, and the next FRAME re-rolls it — that is how production recovers. Once
 * the driver has stopped there is no next frame, so the kind never lands however
 * long the spec waits. Keeping frames coming is the same recovery, not a
 * lengthened wait.
 */
async function driveUntilBestMedia(
  booted: Booted,
  from: number,
  kinds: ReadonlySet<string>,
): Promise<{ readonly lastTs: number; readonly media: Map<string, number> }> {
  let ts = from
  for (let batch = 0; batch < 10; batch += 1) {
    ts = await driveFrames(booted.bus, batch === 0 ? ts : ts + 1_000, 4)
    const media = await settleMedia(booted, kinds)
    const have = new Set([...media.keys()].map((k) => k.split(':')[1]))
    if ([...kinds].every((k) => have.has(k))) return { lastTs: ts, media }
  }
  return { lastTs: ts, media: await settleMedia(booted) }
}

/**
 * Drive a track to best media, force its row closed on the TTL sweep alone
 * (the tracker's own `canClose` forced open, same shape as the incident),
 * then keep driving the same subject and settle media again.
 *
 * `disableD220Gate` (review R1's pin): also forces D220's OWN
 * `closedRowMediaGate` to never refuse — equivalent to the reviewer's disarm
 * of passing `undefined` instead of `rowClosedAt` at `buildSnapshotTargets`'
 * call site. With round 3's fix this must change NOTHING: the closed id is
 * filtered out of `result` right after `process()`, before D220 is ever
 * asked, so D220 never even gets a chance to refuse anything on this frame —
 * proving the upstream filter alone is sufficient, independent of D220.
 */
async function runClosedRowThenRespawnScenario(opts: {
  readonly disableD220Gate: boolean
}): Promise<{
  readonly booted: Booted
  readonly lastLiveTs: number
  readonly atClose: Map<string, number>
  readonly afterClose: Map<string, number>
}> {
  // Only the INTERVAL is faked: `flush()` still needs real setTimeout, and
  // the sweep's staleness test still needs the real wall clock.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const booted = await bootAnalytics(DEVICE_ID, async () => nativeReply())

  // A track lives long enough to earn its best media. The old fixed count of
  // 8 sat exactly on the frame where the rolling `lastFrame` first lands, so
  // isolated it passed every time and inside the full suite it failed on its
  // own precondition.
  const { lastTs: lastLiveTs, media: beforeClose } = await driveUntilBestMedia(
    booted,
    1_000,
    BEST_MEDIA_KINDS,
  )
  // Every row the incident overwrote must be there, or the spec is asserting
  // about a track that never had best media to lose.
  expect([...beforeClose.keys()].map((k) => k.split(':')[1]).toSorted()).toEqual([
    'keyFrame',
    'lastFrame',
    'thumbnail',
    'thumbnailSmall',
  ])

  // The TTL sweep closes the row — the tracker is untouched and still holds
  // the id, exactly as it does between sessions on a per-session camera.
  //
  // D683 Task 16 added a SECOND gate ahead of this one: the closer now also
  // asks the tracker's own `TrackerSweep.canClose` (chain-liveness + tail
  // finality, in the processor's frame clock) before closing a row — and in
  // THIS harness, moments after the live frames above, the tracker legitimately
  // still considers the chain live, so that gate alone would hold this row
  // open (which is Task 16's own `track-close-gate.spec.ts` / its wiring e2e).
  // This spec is testing a DIFFERENT, independent layer — the capture-side
  // refusal that must hold regardless of *why* a row closed — so the
  // tracker's own gate is forced open here, reproducing exactly the
  // closes-on-TTL-alone shape the incident exhibited.
  const sweeper: unknown = Reflect.get(booted.addon, 'trackerSweep')
  if (!(sweeper instanceof TrackerSweep)) throw new Error('trackerSweep not built')
  vi.spyOn(sweeper, 'canClose').mockReturnValue(true)

  if (opts.disableD220Gate) {
    const gate: unknown = Reflect.get(booted.addon, 'closedRowMediaGate')
    if (!(gate instanceof ClosedRowMediaGate)) throw new Error('closedRowMediaGate not built')
    vi.spyOn(gate, 'evaluate').mockReturnValue({
      refuse: false,
      log: false,
      closedAgeMs: 0,
      suppressed: 0,
    })
  }

  await vi.advanceTimersByTimeAsync(TTL_SWEEP_INTERVAL_MS)
  await flush()
  // The row as its CLOSE left it (follow-up 102 round 2 re-review): the close
  // path's own D400 promotion may legitimately rewrite `lastFrame` to the
  // newest PRE-close snapshot (a rolling capture dropped under load leaves
  // `lastFrame` behind the last `snapshot`, and the close promotes it). That
  // write never comes through the capture gate and is not what this file is
  // about, so the baseline is taken after it, before any post-close frame.
  const atClose = await settleMedia(booted)

  // D683 review N2/R1: the subject (or, live, the dog that inherited the
  // frozen box) no longer keeps matching under the SAME tracker id — the
  // frame path filters it out of `result` right after `process()`, ahead of
  // every other consumer, and tells the tracker to DROP that chain, so this
  // detection respawns under a BRAND-NEW id instead of being silently
  // refused for the rest of its time in view (H4's "second start" half). The
  // closed id's OWN rows are the invariant this file is actually about: they
  // must never be touched again, whoever the tracker hands back next.
  await driveFrames(booted.bus, lastLiveTs + 1_000, 4)

  const afterClose = await settleMedia(booted)
  return { booted, lastLiveTs, atClose, afterClose }
}

/**
 * The closed row's own best-media rows never move after the close, none of
 * them ever carries a frame later than the last LIVE frame, and any genuinely
 * NEW row belongs to a DIFFERENT id — never the one the row closed under.
 */
function assertClosedRowNeverRewritten(
  lastLiveTs: number,
  atClose: ReadonlyMap<string, number>,
  afterClose: ReadonlyMap<string, number>,
): void {
  for (const [key, timestamp] of atClose) {
    expect(afterClose.get(key), `the closed row's own ${key} survives untouched`).toBe(timestamp)
  }
  const closedId = [...atClose.keys()][0]?.split(':')[0]
  expect(closedId, 'the closed row had an id to compare against').toBeDefined()
  for (const [key, timestamp] of afterClose) {
    if (!key.startsWith(`${closedId}:`)) continue
    expect(timestamp, `${key} holds no post-close frame`).toBeLessThanOrEqual(lastLiveTs)
  }
  for (const key of afterClose.keys()) {
    if (atClose.has(key)) continue
    expect(key.startsWith(`${closedId}:`), `new row ${key} must not reuse the closed id`).toBe(
      false,
    )
  }
}

describe('a closed track row never receives best media', () => {
  let booted: Booted | undefined

  afterEach(async () => {
    if (booted) await booted.addon.shutdown()
    booted = undefined
    vi.useRealTimers()
  })

  it('refuses thumbnail / keyFrame / lastFrame for a row the store already closed', async () => {
    const scenario = await runClosedRowThenRespawnScenario({ disableD220Gate: false })
    booted = scenario.booted
    assertClosedRowNeverRewritten(scenario.lastLiveTs, scenario.atClose, scenario.afterClose)

    // The drop is never silent, and it is answerable per camera.
    const refusals = booted.logs.filter((l) => l.message.includes('row already closed'))
    expect(refusals.length).toBeGreaterThan(0)
    const extras = refusals[0]?.extras
    expect(extras).toMatchObject({ tags: { deviceId: DEVICE_ID } })
  })

  it("stays green with D220's OWN media gate disabled (review R1) — the upstream filter is sufficient on its own", async () => {
    const scenario = await runClosedRowThenRespawnScenario({ disableD220Gate: true })
    booted = scenario.booted
    assertClosedRowNeverRewritten(scenario.lastLiveTs, scenario.atClose, scenario.afterClose)

    // Still never silent: the FRAME-PATH drop (N2/R1) logs independent of
    // D220, which this test forced to never log at all.
    const refusals = booted.logs.filter((l) => l.message.includes('row already closed'))
    expect(refusals.length).toBeGreaterThan(0)
  })
})
