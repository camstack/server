/**
 * The segments a promotion reads (fix round, M3): the window's own, plus —
 * for identities in force at its start — the earlier segments of the SAME
 * recorder session that still bind one of its tracks. A face verdict is
 * recorded once; a track named twenty minutes before the window is still
 * that person inside it, and D683's cannot-link needs the name.
 *
 * Bound: the walk stops at the first earlier segment that binds none of the
 * window's tracks (they had not spawned), at a session change (another boot:
 * other track ids), at an unreadable segment (logged), and at the start of
 * the shelf — which keeps 24 h.
 *
 * Disarms:
 *  - return only the window's segments (no lookback) — "a name set more than
 *    10 minutes before the window is carried" fails;
 *  - ignore the session in the walk — "the walk stops at a session change"
 *    fails;
 *  - never narrow the needed tracks — "the walk stops once no window track is
 *    bound" fails (the oldest file is read).
 *
 * Fix round 2:
 *  - N5: the walk is capped at {@link MAX_IDENTITY_LOOKBACK_SEGMENTS} (6,
 *    about an hour), logged with the camera. Disarm: drop the cap — "the walk
 *    stops after six segments, and says so" fails.
 *  - N2: the window's EDGES are judged by session as well as end reason. The
 *    segment just before the window (P3) and the one just after it — or, with
 *    none, the running recorder's session (P4) — decide whether silence at an
 *    edge is an idle camera or a recorder that was not there. Disarms: drop
 *    the leading-edge gap — "P3" fails; judge the tail by end reason only —
 *    "P4" fails.
 */
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { sampleEnd, sampleFrame, sampleHeader } from '../../__tests__/tape-fixtures.js'
import { decodeTapeText, type Tape } from '../../tape-codec.js'
import { promoteTapeWindow } from '../tape-promotion.js'
import { SEGMENT_MS } from '../tape-recorder.js'
import type { TapeSegmentFile } from '../tape-shelf.js'
import {
  createSegmentCache,
  MAX_IDENTITY_LOOKBACK_SEGMENTS,
  readWindowSegments,
} from '../tape-window-read.js'
import { ORIGIN, type World, world } from './promotion-world.js'

const S = '1111111111111111'
const OTHER = '2222222222222222'

function seg(session: string, trk: string, named: boolean): Tape {
  return {
    header: sampleHeader({ session }),
    body: [
      sampleFrame(0, { live: [{ trk, det: 'd-0', m: true, st: 'moving' }] }),
      ...(named ? [{ kind: 'identity' as const, t: 10, trk, fid: 'h:aaaaaaaaaaaa' }] : []),
      sampleFrame(SEGMENT_MS - 1_000, { live: [{ trk, m: false, st: 'idle' }] }),
    ],
    end: sampleEnd({ durationMs: SEGMENT_MS - 1_000 }),
  }
}

/** Earlier segments ending just before the window (oldest first), plus the
 *  window's own. Returns the earlier segments' origins, oldest first. */
function shelf(w: World, earlier: readonly Tape[]): number[] {
  const origins: number[] = []
  const files: TapeSegmentFile[] = []
  earlier.forEach((tape, i) => {
    const originMs = ORIGIN - (earlier.length - i) * SEGMENT_MS - 1
    origins.push(originMs)
    const file = `seg-${String(originMs)}`
    w.tapes.set(file, tape)
    files.push({ deviceId: 101, originMs, file, bytes: 10 })
  })
  const windowTape: Tape = {
    header: sampleHeader({ session: S }),
    body: [
      sampleFrame(0, { live: [{ trk: 'trk-a', det: 'd-0', m: true, st: 'moving' }] }),
      sampleFrame(1_000, { live: [{ trk: 'trk-b', det: 'd-1000', m: true, st: 'moving' }] }),
    ],
    end: sampleEnd({ durationMs: 1_000 }),
  }
  w.tapes.set('seg-1', windowTape)
  files.push({ deviceId: 101, originMs: ORIGIN, file: 'seg-1', bytes: 10 })
  w.faults.listing = { ok: true, segments: files, unstatted: [] }
  return origins
}

describe('createSegmentCache — release (fix round, M1)', () => {
  it('forgets a decoded entry on release: the cache shrinks, and a repeat ask re-decodes', async () => {
    let calls = 0
    const cache = createSegmentCache(async (entry) => {
      calls += 1
      return { header: sampleHeader(), body: [], end: sampleEnd({ durationMs: entry.originMs }) }
    })
    const entry = { originMs: 42, file: 'seg-42' }

    await cache.decodeOnce(entry)
    expect(cache.size()).toBe(1)
    expect(calls).toBe(1)

    // A second ask for the SAME entry is served from the cache — no re-decode.
    await cache.decodeOnce(entry)
    expect(calls).toBe(1)

    cache.release(entry.originMs)
    expect(cache.size()).toBe(0)

    // Released ⇒ forgotten, not merely "not counted": asking again re-decodes.
    await cache.decodeOnce(entry)
    expect(calls).toBe(2)
    expect(cache.size()).toBe(1)
  })

  it('holds only what has not yet been released, across several entries', async () => {
    const cache = createSegmentCache(async (entry) => ({
      header: sampleHeader(),
      body: [],
      end: sampleEnd({ durationMs: entry.originMs }),
    }))
    await cache.decodeOnce({ originMs: 1, file: 'a' })
    await cache.decodeOnce({ originMs: 2, file: 'b' })
    expect(cache.size()).toBe(2)
    cache.release(1)
    expect(cache.size()).toBe(1)
    await cache.decodeOnce({ originMs: 3, file: 'c' })
    // Never more than 2 live at once in this walk (fix round, M1): release
    // the oldest before decoding the next.
    expect(cache.size()).toBe(2)
  })
})

describe('readWindowSegments — identity lookback', () => {
  it('a name set more than 10 minutes before the window is carried', async () => {
    const w = await world()
    shelf(w, [seg(S, 'trk-a', true), seg(S, 'trk-a', false)])
    const r = await promoteTapeWindow(w.deps, {
      deviceId: 101,
      fromMs: ORIGIN,
      toMs: ORIGIN + 1_000,
      scenario: 'named-early',
    })
    expect(r).toMatchObject({ ok: true })
    const [file] = [...w.written.values()]
    if (file === undefined) throw new Error('expected a promoted file')
    const tape = decodeTapeText(gunzipSync(file).toString('utf8'))
    expect(tape.body.filter((x) => x.kind === 'identity')).toEqual([
      { kind: 'identity', t: 0, trk: 'trk-a', fid: 'p1' },
    ])
  })

  it('the walk stops at a session change', async () => {
    const w = await world()
    shelf(w, [seg(OTHER, 'trk-a', true), seg(S, 'trk-a', false)])
    const r = await readWindowSegments(w.deps, {
      deviceId: 101,
      fromMs: ORIGIN,
      toMs: ORIGIN + 1_000,
    })
    if (!r.ok) throw new Error('expected a read')
    const identities = r.segments.flatMap((s) =>
      (s.tape?.body ?? []).filter((x) => x.kind === 'identity'),
    )
    expect(identities).toEqual([])
  })

  it('the walk stops once no window track is bound', async () => {
    const w = await world()
    const origins = shelf(w, [seg(S, 'trk-y', true), seg(S, 'trk-z', false), seg(S, 'trk-a', true)])
    const r = await readWindowSegments(w.deps, {
      deviceId: 101,
      fromMs: ORIGIN,
      toMs: ORIGIN + 1_000,
    })
    if (!r.ok) throw new Error('expected a read')
    // Newest first: the window, then trk-a's segment (kept), then trk-z's —
    // which binds no window track, so the walk ends there.
    const [, zOrigin, aOrigin] = origins
    expect(w.reads).toEqual(['seg-1', `seg-${String(aOrigin)}`, `seg-${String(zOrigin)}`])
    expect(r.segments.map((s) => s.originMs)).toEqual([aOrigin, ORIGIN])
  })
})

describe('readWindowSegments — the lookback cap (fix round 2, N5)', () => {
  it('the walk stops after six segments, and says so', async () => {
    const w = await world()
    const earlier = [
      seg(S, 'trk-a', true),
      ...Array.from({ length: MAX_IDENTITY_LOOKBACK_SEGMENTS }, () => seg(S, 'trk-a', false)),
    ]
    const origins = shelf(w, earlier)
    const r = await readWindowSegments(w.deps, {
      deviceId: 101,
      fromMs: ORIGIN,
      toMs: ORIGIN + 1_000,
    })
    if (!r.ok) throw new Error('expected a read')
    expect(w.reads).not.toContain(`seg-${String(origins[0])}`)
    expect(w.reads).toHaveLength(1 + MAX_IDENTITY_LOOKBACK_SEGMENTS)
    expect(w.logs).toContainEqual({
      level: 'warn',
      message: 'tracking tape identity carry capped',
      extras: {
        tags: { deviceId: 101 },
        meta: { segments: MAX_IDENTITY_LOOKBACK_SEGMENTS, tracksUnproven: 1 },
      },
    })
  })
})

/** One segment of `trk` in `session`, `durationMs` long, ended `reason`. */
function plain(
  session: string,
  trk: string,
  durationMs: number,
  reason: 'segment-end' | 'addon-stopped',
): Tape {
  return {
    header: sampleHeader({ session }),
    body: [sampleFrame(0, { live: [{ trk, det: 'd-0', m: true, st: 'moving' }] })],
    end: sampleEnd({ durationMs, reason }),
  }
}

function place(w: World, entries: readonly (readonly [number, Tape])[]): void {
  const files: TapeSegmentFile[] = []
  for (const [originMs, tape] of entries) {
    const file = `seg-${String(originMs)}`
    w.tapes.set(file, tape)
    files.push({ deviceId: 101, originMs, file, bytes: 10 })
  }
  w.faults.listing = { ok: true, segments: files, unstatted: [] }
}

async function promotedBody(w: World): Promise<Tape['body']> {
  const [file] = [...w.written.values()]
  if (file === undefined) throw new Error('expected a promoted file')
  return decodeTapeText(gunzipSync(file).toString('utf8')).body
}

describe('promotion — the window edges (fix round 2, N2)', () => {
  it('P3: a window that starts inside a downtime begins with a restart gap', async () => {
    const w = await world()
    w.faults.liveSession = OTHER
    // Boot S stopped a minute before the window's segment slot; boot OTHER's
    // first segment starts five minutes into the window.
    place(w, [
      [ORIGIN - SEGMENT_MS - 60_000, plain(S, 'trk-a', 60_000, 'addon-stopped')],
      [ORIGIN + 300_000, plain(OTHER, 'trk-b', 1_000, 'segment-end')],
    ])
    const r = await promoteTapeWindow(w.deps, {
      deviceId: 101,
      fromMs: ORIGIN,
      toMs: ORIGIN + 301_000,
      scenario: 'p3-leading',
    })
    expect(r).toMatchObject({ ok: true, state: 'incomplete', gaps: 1 })
    expect(await promotedBody(w)).toContainEqual({
      kind: 'gap',
      fromT: 0,
      toT: 300_000,
      reason: 'restart',
    })
  })

  it('P4: a window whose last segment is followed by another boot ends with a restart gap', async () => {
    const w = await world()
    w.faults.liveSession = OTHER
    place(w, [
      [ORIGIN, plain(S, 'trk-a', 1_000, 'segment-end')],
      [ORIGIN + 20 * 60_000, plain(OTHER, 'trk-b', 1_000, 'segment-end')],
    ])
    const r = await promoteTapeWindow(w.deps, {
      deviceId: 101,
      fromMs: ORIGIN,
      toMs: ORIGIN + 15 * 60_000,
      scenario: 'p4-tail',
    })
    expect(r).toMatchObject({ ok: true, state: 'incomplete', gaps: 1 })
    expect(await promotedBody(w)).toContainEqual({
      kind: 'gap',
      fromT: 1_000,
      toT: 15 * 60_000,
      reason: 'restart',
    })
  })

  it('P4: with nothing after it, a different running session means the boot changed', async () => {
    const w = await world()
    w.faults.liveSession = OTHER
    place(w, [[ORIGIN, plain(S, 'trk-a', 1_000, 'segment-end')]])
    const r = await promoteTapeWindow(w.deps, {
      deviceId: 101,
      fromMs: ORIGIN,
      toMs: ORIGIN + 15 * 60_000,
      scenario: 'p4-live',
    })
    expect(r).toMatchObject({ ok: true, state: 'incomplete', gaps: 1 })
  })

  it('an idle camera is not a gap: same session on both sides, or still running', async () => {
    const w = await world()
    w.faults.liveSession = S
    place(w, [
      [ORIGIN - SEGMENT_MS - 60_000, plain(S, 'trk-a', 60_000, 'segment-end')],
      [ORIGIN + 300_000, plain(S, 'trk-b', 1_000, 'segment-end')],
    ])
    const r = await promoteTapeWindow(w.deps, {
      deviceId: 101,
      fromMs: ORIGIN,
      toMs: ORIGIN + 15 * 60_000,
      scenario: 'idle-camera',
    })
    expect(r).toMatchObject({ ok: true, state: 'complete', gaps: 0 })
  })
})
