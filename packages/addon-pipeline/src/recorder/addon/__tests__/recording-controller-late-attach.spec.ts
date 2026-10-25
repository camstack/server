/**
 * COMPOSITION of the two `events`-band gates: the LIVE gate that decides to
 * attach (`shouldRecordAt`, evaluated against the wall clock) and the KEEP gate
 * that decides whether the resulting segment survives finalize
 * (`segmentRetainedForEvents`, evaluated against segment timestamps).
 *
 * Each is correct alone. Composed, they used to guarantee data loss.
 *
 * Camera 1439 ("Camera garage", events mode, pre 5s / post 30s), field
 * evidence 2026-08-18: motion at `1787010352461`; the recorder attached 29.5 s
 * later (the hub was overloaded — `pass exceeded its budget durationMs=151112`,
 * event-bus `busLagMs=142173`), i.e. with ~460 ms of the post window left. The
 * live gate said YES. ffmpeg then dialled 4K RTSP, ran ~31 s and finalized six
 * segments — and the keep gate deleted every one of them, because a writer that
 * starts at T cannot NAME a segment before T + dial + keyframe (~3.2 s here) and
 * cannot FINALIZE one before that plus a full `segmentSeconds`. The first `high`
 * segment was named 2.5 s past `lastMotionMs + postMs`.
 *
 * So the last ~`segmentSeconds` of every demand window was a zone in which the
 * recorder was GUARANTEED to spawn ffmpeg, pull the camera for half a minute,
 * and index nothing. The operator saw "pinned" then "unpinned" with an empty
 * timeline in between, and — because the discard branch logged NOTHING — no line
 * anywhere said why.
 *
 * The invariant these tests pin: IF THE RECORDER DECIDED TO ATTACH, IT KEEPS AT
 * LEAST THE FIRST SEGMENT THAT ATTACH PRODUCES. Nothing here widens the
 * operator's `postBufferSec` — a punctual attach retains exactly what it
 * retained before (third test).
 *
 * These drive the REAL controller against a REAL staging directory and a REAL
 * `live.m3u8`, because the bug lives in the composition and not in either
 * function: `band-decision.spec.ts` asserted the keep gate's arithmetic
 * correctly for years while this was losing footage in the field.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RecordingConfig } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GATE_INCLUSIVE_EPSILON_MS } from '../decision-schedule.js'
import { RecordingController, type RecordingControllerDeps } from '../recording-controller'
import { settleUntil } from './settle.js'
import { recordingsLocationOfMode } from '../roots.js'

interface FakeProc {
  kill: ReturnType<typeof vi.fn>
  on: (ev: string, cb: (...a: unknown[]) => void) => void
  stderr: { on: () => void }
}

function makeFakeProc(): FakeProc {
  return {
    kill: vi.fn(),
    on: () => {},
    stderr: { on: () => {} },
  }
}

interface LogCall {
  readonly level: 'info' | 'warn'
  readonly msg: string
  readonly meta: Record<string, unknown>
  readonly tags: Record<string, unknown>
}

interface FinalizedCall {
  readonly deviceId: number
  readonly startMs: number
  readonly durMs: number
  readonly flatAbsPath: string
}

interface Harness {
  readonly controller: RecordingController
  readonly finalized: FinalizedCall[]
  readonly logs: LogCall[]
  readonly outDir: string
  setClock(ms: number): void
}

const DEVICE_ID = 1439
/** The incident's trigger instant, floored to a whole second for readable arithmetic. */
const T = 1_787_010_352_000
const SEGMENT_SECONDS = 10
const PRE_BUFFER_SEC = 5
const POST_BUFFER_SEC = 30

/** Camera 1439's shape: events band, motion trigger, 5 s pre / 30 s post. */
const EVENTS_CONFIG: RecordingConfig = {
  enabled: true,
  segmentSeconds: SEGMENT_SECONDS,
  bands: [
    {
      mode: 'events',
      days: [],
      start: '00:00',
      end: '00:00',
      triggers: { motion: true },
      preBufferSec: PRE_BUFFER_SEC,
      postBufferSec: POST_BUFFER_SEC,
    },
  ],
}

async function makeHarness(root: string): Promise<Harness> {
  let clock = T
  const finalized: FinalizedCall[] = []
  const logs: LogCall[] = []

  const record =
    (level: LogCall['level'], tags: Record<string, unknown>) =>
    (
      msg: string,
      fields?: {
        meta?: Record<string, unknown>
        tags?: Record<string, unknown>
      },
    ) => {
      logs.push({
        level,
        msg,
        meta: fields?.meta ?? {},
        tags: { ...tags, ...fields?.tags },
      })
    }
  const makeLogger = (tags: Record<string, unknown>): Record<string, unknown> => ({
    info: record('info', tags),
    warn: record('warn', tags),
    error: record('error' as 'warn', tags),
    debug: () => {},
    child: () => makeLogger(tags),
    withTags: (extra: Record<string, unknown>) => makeLogger({ ...tags, ...extra }),
  })

  const api = {
    streamBroker: {
      getStreamWithCodec: {
        mutate: async () => ({
          url: 'rtsp://127.0.0.1:8554/cam1439-high',
          videoCodec: 'H265' as const,
          audioCodec: 'aac' as const,
          resolution: { width: 3840, height: 2160 },
          transcoded: false,
          encoder: 'copy',
          pipelineKey: 'pk-1439-high',
        }),
      },
      releaseStreamWithCodec: {
        mutate: async () => ({ released: true, refcount: 0 }),
      },
      listAllProfileSlots: {
        query: async () => [
          {
            deviceId: DEVICE_ID,
            profile: 'high',
            camStreamId: 'native:main',
            status: 'streaming',
          },
        ],
      },
    },
  } as never

  const deps: RecordingControllerDeps = {
    resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
    api,
    logger: makeLogger({}) as never,
    nodeId: 'hub',
    ownerNodeId: 'hub',
    segmentStore: {
      onFinalized: async (input: FinalizedCall) => {
        finalized.push(input)
        return null
      },
    } as never,
    loadConfig: async () => EVENTS_CONFIG,
    enabledDeviceIds: async () => [DEVICE_ID],
    locations: () => [
      recordingsLocationOfMode({ id: 'recordings:default', type: 'recordings', root }, 'active'),
    ],
    spawn: (() => makeFakeProc()) as never,
    segmentSeconds: SEGMENT_SECONDS,
    // Longer than the 501 ms to the late attach's window-close wake-up, so the
    // close's flush is what handles its segments; shorter than the punctual
    // attach's 29.8 s, so the watcher's own passes get there first (third test).
    watchIntervalMs: 1_000,
    onBrokerReady: () => () => {},
    brokerCall: (fn) => fn(),
    now: () => clock,
  }

  return {
    controller: new RecordingController(deps),
    finalized,
    logs,
    outDir: path.join(root, '.rec-tmp', String(DEVICE_ID), 'high'),
    setClock: (ms: number) => {
      clock = ms
    },
  }
}

/** Write the flat segments + the `live.m3u8` ffmpeg would have written. While
 *  the writer runs, only entries with a SUCCESSOR are finalizable (the live tail
 *  is held back); the detach's flush finalizes the tail as well. */
async function writeSegments(
  outDir: string,
  segments: ReadonlyArray<{ startMs: number; extinf: number }>,
): Promise<string[]> {
  const paths: string[] = []
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7']
  for (const seg of segments) {
    const name = `${Math.floor(seg.startMs / 1000)}.m4s`
    const abs = path.join(outDir, name)
    await fs.writeFile(abs, 'fake-segment-bytes')
    paths.push(abs)
    lines.push(`#EXTINF:${seg.extinf.toFixed(3)},`, name)
  }
  await fs.writeFile(path.join(outDir, 'live.m3u8'), `${lines.join('\n')}\n`)
  return paths
}

/**
 * Drive the composition to its verdict: fire the window-close wake-up, then
 * drain until the detach it causes has LANDED.
 *
 * What ACTUALLY runs in these tests is not the watcher's own pass. `onTrigger`
 * at T+29.5 s arms the window-close wake-up for T+30.001 s — 501 ms of fake
 * time — and the wait that used to live here advanced the clock 50 ms per turn
 * (up to 20 000 turns), so the wake-up fired on its eleventh turn, the
 * evaluate saw the clock past the window, detached, and the teardown FLUSHED
 * the playlist (`forceFinal`): every entry finalized, the held-back tail
 * included. The old assertion `[T+33 s]` held only when the loop's check
 * happened to land between the two hand-offs of that single flush — a race in
 * REAL time against a fixed list. Measured 2026-09-23: red in 3 of the last 4
 * CI runs and in 3 of 7 runs on an idle Mac, always with the same value.
 *
 * So the wake-up is named and driven on purpose, because it IS the field
 * sequence: the clock has moved on while the wake-up was still pending — the
 * starved event loop of the 1439 incident (`busLagMs=142173`), in which the
 * writer had time to name segments before the close was ever served. Advance
 * exactly to the wake-up, then drain WITHOUT moving the clock (`settle.ts`)
 * until the detach is observable — real filesystem work, however slow the box.
 */
async function settleWindowClose(h: Harness, attachedAtClockMs: number): Promise<void> {
  const closeAtMs = T + POST_BUFFER_SEC * 1000 + GATE_INCLUSIVE_EPSILON_MS
  await vi.advanceTimersByTimeAsync(closeAtMs - attachedAtClockMs)
  await settleUntil(
    () => h.logs.some((l) => l.msg.includes('recorder unpinned broker source')),
    'the window-close wake-up detached the writer',
  )
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

describe('late attach: the recorder keeps what it decided to record (camera 1439)', () => {
  let root: string

  beforeEach(async () => {
    vi.useFakeTimers()
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-late-attach-'))
  })
  afterEach(async () => {
    vi.useRealTimers()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('INDEXES the first segment of an attach that opened 29.5s into a 30s window', async () => {
    const h = await makeHarness(root)

    // The live gate: motion at T, delivered to the recorder 29.5 s late (bus lag).
    // 29 500 <= postMs (30 000) => shouldRecordAt YES => attach.
    const attachedAt = T + 29_500
    h.setClock(attachedAt)
    await h.controller.onTrigger(DEVICE_ID, { kind: 'motion' }, T)

    // ffmpeg dials 4K RTSP and names its first segment 3.2 s later (measured on
    // 1439: writer spawned at +29.5 s, first `high` segment named at +32.7 s).
    // Rounded to ffmpeg's whole-second `%s`: T + 33 s. Its successor lands one
    // segmentSeconds later.
    const [first, second] = await writeSegments(h.outDir, [
      { startMs: T + 33_000, extinf: 13.76 }, // inflated first EXTINF, as in the field
      { startMs: T + 43_000, extinf: 10.0 },
    ])
    // The window closed at T+30 s but the wake-up for it is only served now,
    // with the clock at T+44 s: the close detaches the writer and its teardown
    // flushes what the writer produced.
    h.setClock(T + 44_000)
    await settleWindowClose(h, attachedAt)

    // BEFORE THE FIX: the keep gate compared segStart (T+33 000) against
    // lastMotionMs + postMs (T+30 000) alone and deleted it — 2.5 s too late.
    // Both are kept, and that is the allowance's arithmetic, not an accident:
    // the deadline is attachedAt + segmentSeconds + FIRST_SEGMENT_GRACE_MS =
    // T+44.5 s, and the successor was named 1.5 s inside it.
    expect(h.finalized.map((f) => f.startMs)).toEqual([T + 33_000, T + 43_000])
    expect(await exists(first!)).toBe(true)
    expect(await exists(second!)).toBe(true)
    // Nothing this attach produced went through the discard branch.
    expect(h.logs.find((l) => l.msg.includes('discarding'))).toBeUndefined()

    await h.controller.stop()
  })

  it('still DISCARDS a segment past the attach allowance — and says so, with the deviceId', async () => {
    const h = await makeHarness(root)

    const attachedAt = T + 29_500
    h.setClock(attachedAt)
    await h.controller.onTrigger(DEVICE_ID, { kind: 'motion' }, T)

    // A segment named 60 s after the trigger: past the operator's post window
    // AND past `attachedAt + segmentSeconds + grace`. No second trigger ever
    // arrived, so nothing asked for this footage — it must still be dropped.
    const [stale] = await writeSegments(h.outDir, [
      { startMs: T + 60_000, extinf: 10.0 },
      { startMs: T + 70_000, extinf: 10.0 },
    ])
    h.setClock(T + 71_000)
    await settleWindowClose(h, attachedAt)

    expect(h.finalized).toEqual([])
    expect(await exists(stale!)).toBe(false)

    // The branch that drops work must never be silent: this discard is what the
    // operator could not see on 1439 (pinned → unpinned, nothing in between).
    const discard = h.logs.find((l) => l.msg.includes('discarding'))
    expect(discard).toBeDefined()
    expect(discard!.tags).toMatchObject({ deviceId: DEVICE_ID })
    expect(discard!.meta).toMatchObject({
      profile: 'high',
      startMs: T + 60_000,
      durMs: 10_000,
      // The WINDOWS the gate compared against — the one trigger at T, as the
      // zero-width episode it is. A bare `lastMotionMs` could not distinguish
      // "one trigger" from "an episode that ran for 20 s".
      //
      // Keyed by source since 2026-08-27: the pair `motionWindows` /
      // `audioWindows` could not name `object:person` or `sensor:42`, and the
      // key for a source the band does NOT listen for is absent rather than
      // empty — the gate never consulted it.
      triggerWindows: { motion: [{ firstMs: T, lastMs: T }] },
      postMs: POST_BUFFER_SEC * 1000,
    })
    expect(discard!.meta.missedByMs).toBeTypeOf('number')
    // Nothing from this attach was ever kept — that is a fault, not the normal
    // tail-of-window drop, so it is a warn.
    expect(discard!.level).toBe('warn')

    await h.controller.stop()
  })

  it('does NOT widen the window for a PUNCTUAL attach — the post-buffer still bounds it', async () => {
    const h = await makeHarness(root)

    // Attach 200 ms after the trigger: the attach allowance
    // (attachedAt + segmentSeconds + grace = T + 15.2 s) is far INSIDE
    // lastMotionMs + postMs (T + 30 s), so the operator's window is what bounds
    // retention — exactly as before this fix.
    const attachedAt = T + 200
    h.setClock(attachedAt)
    await h.controller.onTrigger(DEVICE_ID, { kind: 'motion' }, T)

    const [inside, outside] = await writeSegments(h.outDir, [
      { startMs: T + 25_000, extinf: 10.0 }, // inside the post window: kept
      { startMs: T + 35_000, extinf: 10.0 }, // outside it, and outside the attach allowance
      { startMs: T + 45_000, extinf: 10.0 }, // successor, so the middle one finalizes too
    ])
    // The wake-up is 29.8 s of fake time away here, so the watcher's own passes
    // run first and reach the same verdict the close's flush would: the outcome
    // does not depend on which of the two handles an entry.
    h.setClock(T + 46_000)
    await settleWindowClose(h, attachedAt)

    expect(h.finalized.map((f) => f.startMs)).toEqual([T + 25_000])
    expect(await exists(inside!)).toBe(true)
    expect(await exists(outside!)).toBe(false)

    await h.controller.stop()
  })
})
