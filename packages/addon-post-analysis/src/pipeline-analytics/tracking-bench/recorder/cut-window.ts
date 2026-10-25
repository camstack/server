/**
 * Cut `[fromMs, toMs]` out of a camera's segments into one promoted tape
 * (spec §3.3). Pure: the caller reads the segment files.
 *
 * A segment boundary is NOT a tracker reset — the live tracker ran straight
 * through it — so the next segment's header planes are ignored (a rebuild is
 * always its own `processor` record) and only a changed scene is carried, as
 * a `scene` record. Silence the recorder did not see is a `restart` gap,
 * which makes the tape `incomplete`:
 *
 *  - a boundary after a segment that ended any other way than
 *    `segment-end`/`size-cap`;
 *  - a boundary where the recorder SESSION changes, whatever the end reason
 *    (H1): a rotation ends a segment `segment-end`, and a boot that dies
 *    before the camera's next frame writes nothing after it;
 *  - the tail of the window after such an end, when no segment follows (M1);
 *  - the span of a segment that cannot be read.
 *
 * (Fix round, M2.) Async: the per-record rebase loop below yields to the
 * event loop every {@link CUT_WINDOW_YIELD_EVERY} records, so cutting a
 * dense 30-minute window never runs as one long synchronous chunk on the
 * analytics event loop — the same discipline `decodeTapeTextAsync` applies
 * to a segment's own decode.
 *
 * Face pseudonyms: the hub's `h:` key is minted per BOOT — one recorder
 * session. The per-tape remap is keyed on the hub pseudonym alone: it never
 * MERGES two of them (a cross-key collision is a 48-bit coincidence), and it
 * cannot join two keys' pseudonyms of one face — the key that would is gone.
 * So one person reads as `p1` before a session change and `p2` after it, and
 * every session change is a `restart` gap: fid inequality across a restart
 * gap is not evidence of two people. (A `restart` gap WITHIN a session — a
 * `recorder-error` end, an unreadable segment — keeps the key, and the same
 * face keeps the same `p`.) A carried identity cannot cross a session: track
 * ids are random per spawn, so a verdict from the previous boot names no
 * track the window binds.
 */
import { type Tape, yieldToEventLoop } from '../tape-codec.js'
import type {
  TapeBodyRecord,
  TapeEnd,
  TapeGap,
  TapeHeader,
  TapeLighting,
  TapeScene,
  TapeStationaryEntry,
} from '../tape-schema.js'
import { TapeFaceRemap } from './frame-record.js'
import { SEGMENT_MS } from './tape-recorder.js'

/**
 * `tape: null` = a segment file that could not be read — typically one the
 * addon never finished (no gzip trailer after a crash). It is NOT left out:
 * its span becomes a `restart` gap, because a window that silently skipped
 * it would be marked complete with up to 10 minutes missing.
 */
export interface DecodedSegment {
  readonly originMs: number
  readonly tape: Tape | null
}

interface ReadableSegment {
  readonly originMs: number
  readonly tape: Tape
}

interface SegmentSpan {
  readonly seg: DecodedSegment
  readonly endMs: number
}

function isReadable(s: DecodedSegment): s is ReadableSegment {
  return s.tape !== null
}

export interface CutWindowInput {
  readonly segments: readonly DecodedSegment[]
  /**
   * (fix round 2, N2) The segment just before the window and the one just
   * after it, when the shelf holds them — they tell silence at an edge that
   * is an idle camera (same session, clean end) from a recorder that was not
   * there. Absent: nothing precedes / follows, and the edge is judged as
   * before (a late first origin is an idle camera).
   */
  readonly before?: DecodedSegment | null
  readonly after?: DecodedSegment | null
  /**
   * The running recorder's session (null: none runs). With nothing after the
   * window, a last segment written in another session ended with its boot.
   * Absent: not judged.
   */
  readonly liveSession?: string | null
  readonly fromMs: number
  readonly toMs: number
  readonly tapeId: string
  readonly lighting?: TapeLighting
}

export interface CutWindowOk {
  readonly ok: true
  readonly tape: Tape
  readonly liveTrackIds: readonly string[]
}

export interface CutWindowNotRecorded {
  readonly ok: false
  readonly reason: 'window-not-recorded'
  readonly recordedFromMs: number | null
  readonly recordedToMs: number | null
}

export type CutWindowResult = CutWindowOk | CutWindowNotRecorded

function recordTime(r: TapeBodyRecord): number {
  return r.kind === 'gap' ? r.fromT : r.t
}

function segmentEndMs(s: ReadableSegment): number {
  const last = s.tape.body[s.tape.body.length - 1]
  return s.originMs + (s.tape.end?.durationMs ?? (last === undefined ? 0 : recordTime(last)))
}

/** An unreadable segment is taken to run until the next one begins (a
 *  segment never covers more than {@link SEGMENT_MS}). */
function spansOf(sorted: readonly DecodedSegment[]): readonly SegmentSpan[] {
  return sorted.map((seg, i) => ({
    seg,
    endMs: isReadable(seg)
      ? segmentEndMs(seg)
      : Math.min(sorted[i + 1]?.originMs ?? Infinity, seg.originMs + SEGMENT_MS),
  }))
}

function contiguousAfter(s: ReadableSegment): boolean {
  const reason = s.tape.end?.reason
  return reason === 'segment-end' || reason === 'size-cap'
}

/** Whether the recorder ran straight from `previous` into `next`: a clean
 *  rotation, in the same session (H1). */
function continuous(previous: ReadableSegment, next: ReadableSegment): boolean {
  return contiguousAfter(previous) && previous.tape.header.session === next.tape.header.session
}

/** Whether the silence between two consecutive segments is a recorder that
 *  was not there, rather than a camera with nothing to see. */
function silentBetween(earlier: DecodedSegment, later: DecodedSegment): boolean {
  if (!isReadable(earlier) || !isReadable(later)) return true
  return !continuous(earlier, later)
}

function restartGap(fromT: number, toT: number): TapeGap {
  return { kind: 'gap', fromT, toT, reason: 'restart' }
}

/** N2 leading edge: the window opens inside silence that follows a segment
 *  which did not run straight into the first one. */
function leadingGap(input: CutWindowInput, first: DecodedSegment | undefined): TapeGap | null {
  const before = input.before ?? null
  if (first === undefined || before === null || first.originMs <= input.fromMs) return null
  return silentBetween(before, first) ? restartGap(0, first.originMs - input.fromMs) : null
}

/** M1 + N2 tail edge: silence after the window's last readable segment. */
function tailGap(input: CutWindowInput, last: ReadableSegment | null): TapeGap | null {
  if (last === null) return null
  const endMs = segmentEndMs(last)
  if (endMs >= input.toMs) return null
  const after = input.after ?? null
  const silent =
    !contiguousAfter(last) ||
    (after !== null
      ? silentBetween(last, after)
      : input.liveSession !== undefined && input.liveSession !== last.tape.header.session)
  if (!silent) return null
  return restartGap(Math.max(endMs, input.fromMs) - input.fromMs, input.toMs - input.fromMs)
}

/** Clamp a rebased gap to the window: a straddling one would start before 0. */
function clampGap(r: TapeBodyRecord, durationMs: number): TapeBodyRecord {
  if (r.kind !== 'gap') return r
  return { ...r, fromT: Math.max(r.fromT, 0), toT: Math.min(r.toT, durationMs) }
}

function rebase(r: TapeBodyRecord, delta: number, faces: TapeFaceRemap): TapeBodyRecord {
  switch (r.kind) {
    case 'frame':
    case 'skip':
      return {
        ...r,
        t: r.t + delta,
        dets: r.dets.map((d) => (d.fid === undefined ? d : { ...d, fid: faces.remap(d.fid) })),
      }
    case 'gap':
      return { ...r, fromT: r.fromT + delta, toT: r.toT + delta }
    case 'processor':
    case 'scene':
    case 'drop':
      return { ...r, t: r.t + delta }
    // Amended 2026-09-29 for D683 R3: `TapeBodyRecord` includes `identity`
    // (Task 1), so this switch must handle it; its `fid` is remapped exactly
    // like a frame's, or a committed case would keep the hub HMAC.
    case 'identity':
      return { ...r, t: r.t + delta, fid: r.fid === null ? null : faces.remap(r.fid) }
    // (v2, D683) The ids inside are recorded LIVE ids, like `drop.trk`, and
    // are not remapped. A fusion is not an identity: it is never carried
    // across the window start.
    case 'fusion':
      return { ...r, t: r.t + delta }
  }
}

/** Records between yields in the main rebase loop (fix round, M2) — see the
 *  module header. */
export const CUT_WINDOW_YIELD_EVERY = 500

export async function cutWindow(input: CutWindowInput): Promise<CutWindowResult> {
  const spans = spansOf([...input.segments].toSorted((a, b) => a.originMs - b.originMs))
  const overlapping = spans.filter((s) => s.seg.originMs <= input.toMs && s.endMs >= input.fromMs)
  const first = overlapping.map((s) => s.seg).find(isReadable)
  if (first === undefined) {
    const readable = spans.filter((s) => isReadable(s.seg))
    const last = readable[readable.length - 1]
    return {
      ok: false,
      reason: 'window-not-recorded',
      recordedFromMs: readable[0]?.seg.originMs ?? null,
      recordedToMs: last === undefined ? null : last.endMs,
    }
  }

  // The processor inputs and scene in effect AT fromMs.
  let planes: TapeHeader['planes'] = first.tape.header.planes
  let sceneAtFrom: TapeScene = first.tape.header.scene
  for (const r of first.tape.body) {
    if (first.originMs + recordTime(r) >= input.fromMs) break
    if (r.kind === 'processor') {
      planes =
        r.plane === 'pipeline'
          ? { ...planes, pipeline: r.inputs }
          : { ...planes, onboard: r.inputs }
    }
    if (r.kind === 'scene') sceneAtFrom = r.scene
  }

  // Amended 2026-09-29 for D683 R3: the identities in force AT fromMs, per
  // live track — every readable record before the window, in time order
  // (a track can be named in an earlier segment and still be live here). A
  // retraction (`fid: null`) removes the entry. Carried as a SYNTHETIC
  // `identity` record at the first window frame whose `live[]` binds the
  // track, not as a header field: the replay joins it on that frame exactly
  // like a live verdict, the schema and TAPE_VERSION stay as they are, and a
  // tracker that ignores identities (`RecordedTracker`) is unaffected.
  const carried = new Map<string, string>()
  for (const { seg } of spans) {
    if (!isReadable(seg) || seg.originMs >= input.fromMs) continue
    for (const r of seg.tape.body) {
      if (seg.originMs + recordTime(r) >= input.fromMs) break
      if (r.kind !== 'identity') continue
      if (r.fid === null) carried.delete(r.trk)
      else carried.set(r.trk, r.fid)
    }
  }

  const faces = new TapeFaceRemap()
  const body: TapeBodyRecord[] = []
  const live = new Set<string>()
  let scene = sceneAtFrom
  let frames = 0
  let skips = 0
  let gaps = 0
  // `previous` = the readable segment just before, or null after an
  // unreadable one (whose gap already covers the boundary that follows it).
  let previous: ReadableSegment | null = null
  const leading = leadingGap(input, overlapping[0]?.seg)
  if (leading !== null) {
    body.push(leading)
    gaps += 1
  }
  const lastSpan = overlapping[overlapping.length - 1]
  let recordsSeen = 0
  for (const span of overlapping) {
    const { seg: candidate, endMs } = span
    if (!isReadable(candidate)) {
      // N4: an unreadable LAST segment runs to the window's end — nothing
      // after it inside the window says where the silence stopped.
      const toMs = span === lastSpan ? input.toMs : Math.min(endMs, input.toMs)
      body.push(
        restartGap(Math.max(candidate.originMs, input.fromMs) - input.fromMs, toMs - input.fromMs),
      )
      gaps += 1
      previous = null
      continue
    }
    const seg = candidate
    if (previous !== null && !continuous(previous, seg)) {
      body.push({
        kind: 'gap',
        fromT: Math.max(segmentEndMs(previous), input.fromMs) - input.fromMs,
        toT: seg.originMs - input.fromMs,
        reason: 'restart',
      })
      gaps += 1
    }
    if (seg !== first && JSON.stringify(seg.tape.header.scene) !== JSON.stringify(scene)) {
      scene = seg.tape.header.scene
      body.push({ kind: 'scene', t: seg.originMs - input.fromMs, scene })
    }
    for (const r of seg.tape.body) {
      const abs = seg.originMs + recordTime(r)
      const straddlingGap =
        r.kind === 'gap' && abs < input.fromMs && seg.originMs + r.toT >= input.fromMs
      if ((abs < input.fromMs && !straddlingGap) || abs > input.toMs) continue
      const rebased = clampGap(
        rebase(r, seg.originMs - input.fromMs, faces),
        input.toMs - input.fromMs,
      )
      body.push(rebased)
      if (rebased.kind === 'frame') {
        frames += 1
        for (const l of rebased.live) {
          live.add(l.trk)
          const fid = carried.get(l.trk)
          if (fid === undefined || l.det === undefined) continue
          body.push({ kind: 'identity', t: rebased.t, trk: l.trk, fid: faces.remap(fid) })
          carried.delete(l.trk)
        }
      } else if (rebased.kind === 'identity') carried.delete(rebased.trk)
      else if (rebased.kind === 'skip') skips += 1
      else if (rebased.kind === 'gap') gaps += 1
      else if (rebased.kind === 'scene') scene = rebased.scene
      recordsSeen += 1
      if (recordsSeen % CUT_WINDOW_YIELD_EVERY === 0) await yieldToEventLoop()
    }
    previous = seg
  }
  // M1 + N2: a window that runs past its last segment into silence the
  // recorder did not see — an unclean end, another session after it, or a
  // different recorder running now — ends in a restart gap.
  const tail = tailGap(input, previous)
  if (tail !== null) {
    body.push(tail)
    gaps += 1
  }

  const stationaryEntries: TapeStationaryEntry[] = first.tape.header.stationaryEntries.map((e) => ({
    ...e,
    since: e.since + first.originMs - input.fromMs,
  }))
  // Built field by field: a promoted tape carries no recorder session — its
  // session changes are already `restart` gaps in the body.
  const header: TapeHeader = {
    kind: 'header',
    format: first.tape.header.format,
    version: first.tape.header.version,
    tapeId: input.tapeId,
    deviceId: first.tape.header.deviceId,
    lighting: input.lighting ?? first.tape.header.lighting,
    recorder: first.tape.header.recorder,
    planes,
    scene: sceneAtFrom,
    stationaryEntries,
  }
  const end: TapeEnd = {
    kind: 'end',
    durationMs: input.toMs - input.fromMs,
    frames,
    skips,
    gaps,
    reason: 'window-end',
  }
  return { ok: true, tape: { header, body, end }, liveTrackIds: [...live] }
}
