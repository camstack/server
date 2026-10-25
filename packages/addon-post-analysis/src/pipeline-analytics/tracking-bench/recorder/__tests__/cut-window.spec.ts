/**
 * Promotion cuts a window out of the camera's segments (spec §3.3).
 *
 *  - records are rebased to the window start; nothing absolute survives;
 *  - a segment boundary is NOT a tracker reset: the next segment's header
 *    planes are ignored (a changed scene becomes a `scene` record);
 *  - a boundary after `addon-stopped` (or a crash) is a `gap` (`restart`);
 *  - hub face pseudonyms become p1, p2 … for this tape;
 *  - a window no segment covers is refused with the span that does exist;
 *  - (amended 2026-09-29 for D683 R3) an `identity` record inside the window
 *    is rebased and its `fid` remapped like a frame's; an identity SETTLED
 *    BEFORE the window, on a track still live in it, is carried as a
 *    synthetic `identity` record stamped at the first window frame whose
 *    `live[]` binds that track — so a case cut after someone was named still
 *    replays D683's cannot-link.
 *  - (Task 12) a segment that ended `recorder-error` is followed by a
 *    `restart` gap like any other end that is not `segment-end`/`size-cap`;
 *  - (Task 12) the hub pseudonym key is minted per BOOT, so one face is two
 *    hub pseudonyms across a restart. The remap keeps them apart (p1, p2) and
 *    never merges them; the `restart` gap between them is what tells a reader
 *    that fid inequality across it is not evidence of two people.
 *  - (Task 12 fix round, H1) a change of recorder SESSION between two
 *    segments is a `restart` gap whatever the end reason — a boot that died
 *    before its next frame after a rotation left a `segment-end` behind;
 *  - (Task 12 fix round, M1) silence after a non-contiguous end at the TAIL
 *    of the window is a `restart` gap up to the window's end;
 *  - (Task 12 fix round, L3) a gap that straddles the window start is
 *    clamped to it; nothing in a cut has a negative time;
 *  - (Task 12 fix round) a promoted tape carries no session id.
 *
 * Disarms:
 *  - at a boundary, push a `processor` record for each plane of the next
 *    header — "a boundary is not a reset" must fail;
 *  - (amended for D683 R3) drop the carried identities: "an identity settled
 *    before the window is carried" fails;
 *  - (amended for D683 R3) in `rebase`'s `identity` case, keep the hub `fid`:
 *    "an identity inside the window is rebased and remapped" fails;
 *  - (Task 12) add `recorder-error` to `contiguousAfter` — "a recorder-error
 *    end is a restart gap" fails;
 *  - (Task 12 fix round, H1) compare end reasons only, not sessions — "a
 *    session change with no end marker is a restart gap" fails;
 *  - (Task 12 fix round, M1) drop the tail-gap push after the loop — "the
 *    silence after an addon stop at the tail is a restart gap" fails;
 *  - (Task 12 fix round, L3) drop the clamp — "a straddling gap is clamped"
 *    fails;
 *  - (fix round 2, N4) cap an unreadable LAST segment at `SEGMENT_MS` again —
 *    "an unreadable last segment is a restart gap to the end of the window"
 *    fails.
 *  - (D683 Task 12) in `rebase`'s `fusion` case, return the record
 *    unchanged: "a fusion is rebased" fails (t stays 300).
 *  - (fix round, M2) `cutWindow` is async and yields to the event loop every
 *    `CUT_WINDOW_YIELD_EVERY` records — dropping the yield turns a dense
 *    window's rebase into one long synchronous chunk again.
 */
import { describe, expect, it } from 'vitest'
import {
  sampleEnd,
  sampleFrame,
  sampleHeader,
  sampleInputs,
  sampleScene,
} from '../../__tests__/tape-fixtures.js'
import type { Tape } from '../../tape-codec.js'
import type { TapeEndReason } from '../../tape-schema.js'
import { defined } from '../../../../__tests__/support/vitest-mock.js'
import { CUT_WINDOW_YIELD_EVERY, cutWindow, type DecodedSegment } from '../cut-window.js'
import { SEGMENT_MS } from '../tape-recorder.js'

const A = 1_000_000
const B = 1_000_400

function segA(
  endReason: TapeEndReason = 'segment-end',
  faceFid = 'h:aaaaaaaaaaaa',
): DecodedSegment {
  const faceFrame = sampleFrame(200)
  const tape: Tape = {
    header: sampleHeader({ tapeId: 'seg-a' }),
    body: [
      sampleFrame(0),
      sampleFrame(100),
      {
        ...faceFrame,
        dets: [
          ...faceFrame.dets,
          {
            id: 'face-200',
            k: 'detail',
            cls: 'face',
            s: 0.7,
            b: [1, 1, 2, 2],
            src: 'frame',
            pid: 'd-200',
            fid: faceFid,
            fs: 0.6,
          },
        ],
      },
      sampleFrame(300),
    ],
    end: sampleEnd({ durationMs: 300, reason: endReason }),
  }
  return { originMs: A, tape }
}

function segB(faceFid?: string): DecodedSegment {
  const onboardInputs = { ...sampleInputs(), stillSpeedFracPerSec: 0.01 }
  const first = sampleFrame(0, { live: [{ trk: 'trk-b', det: 'd-0', m: true, st: 'moving' }] })
  const tape: Tape = {
    header: sampleHeader({
      tapeId: 'seg-b',
      planes: { pipeline: sampleInputs(), onboard: onboardInputs },
      scene: { ...sampleScene(), zoneMembershipMinOverlap: 0.3 },
    }),
    body: [
      faceFid === undefined
        ? first
        : {
            ...first,
            dets: [
              ...first.dets,
              {
                id: 'face-b',
                k: 'detail',
                cls: 'face',
                s: 0.7,
                b: [1, 1, 2, 2],
                src: 'frame',
                pid: 'd-0',
                fid: faceFid,
                fs: 0.6,
              },
            ],
          },
      sampleFrame(100),
    ],
    end: sampleEnd({ durationMs: 100 }),
  }
  return { originMs: B, tape }
}

/** Segment A with a verdict: `trk-a` named at t=50 (after frame 0). Amended 2026-09-29 for D683 R3. */
function segNamed(): DecodedSegment {
  const base = segA()
  if (base.tape === null) throw new Error('segA is readable')
  const [f0, ...rest] = base.tape.body
  if (f0 === undefined) throw new Error('segA has frames')
  return {
    originMs: A,
    tape: {
      ...base.tape,
      body: [f0, { kind: 'identity', t: 50, trk: 'trk-a', fid: 'h:bbbbbbbbbbbb' }, ...rest],
    },
  }
}

/** Stamp a session on a readable segment. */
function inSession(seg: DecodedSegment, session: string): DecodedSegment {
  if (seg.tape === null) throw new Error('readable segment expected')
  return { ...seg, tape: { ...seg.tape, header: { ...seg.tape.header, session } } }
}

describe('cutWindow', () => {
  it('a session change with no end marker is a restart gap (Task 12 fix round, H1)', async () => {
    // Boot 1 rotated segA (`segment-end`) and died before the camera's next
    // frame: no `addon-stopped`, no half-written file. Boot 2 opened segB.
    const r = await cutWindow({
      segments: [inSession(segA(), 'aaaaaaaaaaaaaaaa'), inSession(segB(), 'bbbbbbbbbbbbbbbb')],
      fromMs: A + 150,
      toMs: A + 450,
      tapeId: 'promo-0010',
    })
    if (!r.ok) throw new Error('expected a cut')
    expect(r.tape.body).toContainEqual({ kind: 'gap', fromT: 150, toT: 250, reason: 'restart' })
    expect(r.tape.end?.gaps).toBe(1)
    expect(r.tape.header.session).toBeUndefined()
  })

  it('the same session across a rotation is contiguous (Task 12 fix round, H1)', async () => {
    const r = await cutWindow({
      segments: [inSession(segA(), 'aaaaaaaaaaaaaaaa'), inSession(segB(), 'aaaaaaaaaaaaaaaa')],
      fromMs: A + 150,
      toMs: A + 450,
      tapeId: 'promo-0011',
    })
    if (!r.ok) throw new Error('expected a cut')
    expect(r.tape.end?.gaps).toBe(0)
  })

  it('the silence after an addon stop at the tail is a restart gap (Task 12 fix round, M1)', async () => {
    const r = await cutWindow({
      segments: [segA('addon-stopped')],
      fromMs: A + 150,
      toMs: A + 2_000,
      tapeId: 'promo-0012',
    })
    if (!r.ok) throw new Error('expected a cut')
    expect(r.tape.body[r.tape.body.length - 1]).toEqual({
      kind: 'gap',
      fromT: 150,
      toT: 1_850,
      reason: 'restart',
    })
    expect(r.tape.end?.gaps).toBe(1)
  })

  it('an unreadable last segment is a restart gap to the end of the window (fix round 2, N4)', async () => {
    const unreadable: DecodedSegment = { originMs: A + 300, tape: null }
    const r = await cutWindow({
      segments: [segA(), unreadable],
      fromMs: A,
      toMs: A + 2 * SEGMENT_MS,
      tapeId: 'promo-0014',
    })
    if (!r.ok) throw new Error('expected a cut')
    expect(r.tape.body.filter((x) => x.kind === 'gap')).toEqual([
      { kind: 'gap', fromT: 300, toT: 2 * SEGMENT_MS, reason: 'restart' },
    ])
  })

  it('a straddling gap is clamped to the window (Task 12 fix round, L3)', async () => {
    const base = segA()
    if (base.tape === null) throw new Error('segA is readable')
    const withGap: DecodedSegment = {
      originMs: A,
      tape: {
        ...base.tape,
        body: [
          ...base.tape.body.slice(0, 2),
          { kind: 'gap', fromT: 110, toT: 190, reason: 'backpressure' },
          ...base.tape.body.slice(2),
        ],
      },
    }
    const r = await cutWindow({
      segments: [withGap],
      fromMs: A + 150,
      toMs: A + 170,
      tapeId: 'promo-0013',
    })
    if (!r.ok) throw new Error('expected a cut')
    expect(r.tape.body.filter((x) => x.kind === 'gap')).toEqual([
      { kind: 'gap', fromT: 0, toT: 20, reason: 'backpressure' },
    ])
  })

  it('an identity settled before the window is carried to the first frame that binds its track (amended 2026-09-29 for D683 R3)', async () => {
    const r = await cutWindow({
      segments: [segNamed()],
      fromMs: A + 150,
      toMs: A + 300,
      tapeId: 'promo-0006',
    })
    if (!r.ok) throw new Error('expected a cut')
    const kinds = r.tape.body.map((x) => ('t' in x ? `${x.kind}@${String(x.t)}` : x.kind))
    expect(kinds).toEqual(['frame@50', 'identity@50', 'frame@150'])
    // frame@50 carries the face h:aaaa… → p1; the carried verdict h:bbbb… → p2.
    expect(r.tape.body[1]).toEqual({ kind: 'identity', t: 50, trk: 'trk-a', fid: 'p2' })
  })

  it('an identity inside the window is rebased and remapped (amended 2026-09-29 for D683 R3)', async () => {
    const r = await cutWindow({
      segments: [segNamed()],
      fromMs: A,
      toMs: A + 300,
      tapeId: 'promo-0007',
    })
    if (!r.ok) throw new Error('expected a cut')
    expect(r.tape.body.filter((x) => x.kind === 'identity')).toEqual([
      { kind: 'identity', t: 50, trk: 'trk-a', fid: 'p1' },
    ])
  })

  it('a fusion is rebased, its live ids kept, and never carried across the window start (D683 Task 12)', async () => {
    const fusion = (t: number, survivor: string) => ({
      kind: 'fusion' as const,
      t,
      plane: 'pipeline' as const,
      survivor,
      absorbed: 'trk-x',
      members: ['trk-x'],
    })
    const base = segA()
    const baseTape = defined(base.tape, 'segA tape')
    const seg: DecodedSegment = {
      ...base,
      tape: {
        ...baseTape,
        body: [
          ...baseTape.body.slice(0, 2),
          fusion(100, 'trk-before'),
          ...baseTape.body.slice(2),
          fusion(300, 'trk-a'),
        ],
      },
    }
    const r = await cutWindow({
      segments: [seg],
      fromMs: A + 150,
      toMs: A + 300,
      tapeId: 'promo-0008',
    })
    if (!r.ok) throw new Error('expected a cut')
    expect(r.tape.body.filter((x) => x.kind === 'fusion')).toEqual([fusion(150, 'trk-a')])
  })

  it('rebases records to the window start and ends at the window', async () => {
    const r = await cutWindow({
      segments: [segA(), segB()],
      fromMs: A + 150,
      toMs: A + 450,
      tapeId: 'promo-0001',
    })
    if (!r.ok) throw new Error('expected a cut')
    const times = r.tape.body.map((x) => ('t' in x ? `${x.kind}@${String(x.t)}` : x.kind))
    expect(times).toEqual(['frame@50', 'frame@150', 'scene@250', 'frame@250'])
    expect(r.tape.end).toEqual({
      kind: 'end',
      durationMs: 300,
      frames: 3,
      skips: 0,
      gaps: 0,
      reason: 'window-end',
    })
    expect(r.tape.header.tapeId).toBe('promo-0001')
    expect(r.liveTrackIds.toSorted()).toEqual(['trk-a', 'trk-b'])
  })

  it('a boundary is not a reset — no processor record, the header planes of A stand', async () => {
    const r = await cutWindow({
      segments: [segA(), segB()],
      fromMs: A + 150,
      toMs: A + 450,
      tapeId: 'promo-0001',
    })
    if (!r.ok) throw new Error('expected a cut')
    expect(r.tape.body.some((x) => x.kind === 'processor')).toBe(false)
    expect(r.tape.header.planes).toEqual({ pipeline: sampleInputs() })
  })

  it('marks the silence after an addon stop as a restart gap', async () => {
    const r = await cutWindow({
      segments: [segA('addon-stopped'), segB()],
      fromMs: A + 150,
      toMs: A + 450,
      tapeId: 'promo-0002',
    })
    if (!r.ok) throw new Error('expected a cut')
    expect(r.tape.body).toContainEqual({ kind: 'gap', fromT: 150, toT: 250, reason: 'restart' })
    expect(r.tape.end?.gaps).toBe(1)
  })

  it('a recorder-error end is a restart gap, like any end that is not segment-end/size-cap (Task 12)', async () => {
    const r = await cutWindow({
      segments: [segA('recorder-error'), segB()],
      fromMs: A + 150,
      toMs: A + 450,
      tapeId: 'promo-0008',
    })
    if (!r.ok) throw new Error('expected a cut')
    expect(r.tape.body).toContainEqual({ kind: 'gap', fromT: 150, toT: 250, reason: 'restart' })
    expect(r.tape.end?.gaps).toBe(1)
  })

  it('an unreadable segment is a restart gap, never a silent hole', async () => {
    const unreadable: DecodedSegment = { originMs: A + 300, tape: null }
    const r = await cutWindow({
      segments: [segA(), unreadable, segB()],
      fromMs: A + 150,
      toMs: A + 450,
      tapeId: 'promo-0005',
    })
    if (!r.ok) throw new Error('expected a cut')
    expect(r.tape.body).toContainEqual({ kind: 'gap', fromT: 150, toT: 250, reason: 'restart' })
    expect(r.tape.end?.gaps).toBe(1)
  })

  it('remaps hub face pseudonyms to p1 for this tape', async () => {
    const r = await cutWindow({
      segments: [segA()],
      fromMs: A,
      toMs: A + 300,
      tapeId: 'promo-0003',
    })
    if (!r.ok) throw new Error('expected a cut')
    const fids = r.tape.body
      .flatMap((x) => (x.kind === 'frame' ? x.dets.map((d) => d.fid) : []))
      .filter((f) => f !== undefined)
    expect(fids).toEqual(['p1'])
  })

  it('one face under two boot keys stays two pseudonyms, split by the restart gap (Task 12)', async () => {
    // The same person, pseudonymised under boot 1's key and then boot 2's.
    const r = await cutWindow({
      segments: [segA('addon-stopped', 'h:111111111111'), segB('h:222222222222')],
      fromMs: A,
      toMs: A + 450,
      tapeId: 'promo-0009',
    })
    if (!r.ok) throw new Error('expected a cut')
    const seen = r.tape.body.flatMap((x) => {
      if (x.kind === 'gap') return [`gap@${String(x.fromT)}`]
      if (x.kind !== 'frame') return []
      return x.dets.flatMap((d) => (d.fid === undefined ? [] : [`${d.fid}@${String(x.t)}`]))
    })
    expect(seen).toEqual(['p1@200', 'gap@300', 'p2@400'])
  })

  it('refuses a window no segment covers, naming what exists', async () => {
    const r = await cutWindow({
      segments: [segA(), segB()],
      fromMs: A - 10_000,
      toMs: A - 5_000,
      tapeId: 'promo-0004',
    })
    expect(r).toEqual({
      ok: false,
      reason: 'window-not-recorded',
      recordedFromMs: A,
      recordedToMs: B + 100,
    })
  })
})

/** One segment with enough frames to cross the yield threshold at least
 *  twice — no faces, no identities, just plain frames spaced 100 ms apart. */
function bigSegment(frameCount: number): DecodedSegment {
  const tape: Tape = {
    header: sampleHeader(),
    body: Array.from({ length: frameCount }, (_, i) => sampleFrame(i * 100)),
    end: sampleEnd({ durationMs: frameCount * 100 }),
  }
  return { originMs: A, tape }
}

describe('cutWindow — event-loop yield (fix round, M2)', () => {
  it('yields to the event loop instead of blocking it for one long synchronous chunk', async () => {
    const frameCount = CUT_WINDOW_YIELD_EVERY * 2 + 10
    const seg = bigSegment(frameCount)
    // `setImmediate` callbacks run FIFO: scheduled here, BEFORE `cutWindow`
    // starts, this marker can only have fired by the time `cutWindow`
    // resolves if `cutWindow` itself yielded the event loop (via its own
    // internal `setImmediate`) at least once first.
    let fired = false
    setImmediate(() => {
      fired = true
    })
    const r = await cutWindow({
      segments: [seg],
      fromMs: A,
      toMs: A + frameCount * 100,
      tapeId: 'promo-yield',
    })
    if (!r.ok) throw new Error('expected a cut')
    expect(r.tape.end?.frames).toBe(frameCount)
    expect(fired).toBe(true)
  })
})
