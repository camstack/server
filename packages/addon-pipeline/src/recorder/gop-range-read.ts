/**
 * gop-range-read — serve ONE GOP of a recorded segment by byte range, resolved
 * through the segment's own `mfra` (D31's letter, applied to the D42 feeder
 * path).
 *
 * The recorded feeder scrubs at GOP granularity: a drag target needs the
 * fragment covering ONE instant, yet `readSegmentBytes` hands it the whole
 * file — 100–600 KB on `low` to serve a 41–173 KB GOP, and proportionally
 * worse on bigger profiles. This module reads exactly three ranges instead:
 * the `mfra` TAIL (the time→moof index `mfro` makes reachable from the end),
 * the `moov` HEAD (codec params — the decoder init), and the single
 * `moof`+`mdat` covering the requested instant. The returned bytes are
 * standalone-demuxable (`default_base_moof` makes fragment offsets
 * self-relative), so the feeder's demux consumes them exactly like a whole
 * segment. Net I/O is strictly LOWER than the whole-file read it replaces.
 *
 * PURE over an injected {@link RangeReadable}: no fs here, so the specs run
 * against a real captured segment with every read recorded — "never the whole
 * file" is asserted in bytes.
 */
import { parseInitInfo, type InitInfo } from './init-info.js'
import {
  DEFAULT_TAIL_BYTES,
  fragmentRangeFor,
  fragmentsInWindow,
  fragmentsWithinBudget,
  type MfraIndex,
  MfraParseError,
  parseMfra,
} from './mfra-index.js'

/**
 * Byte budget for the `readGopBytes` fallback read, used with
 * {@link GopRangeArgs.maxBytes}.
 *
 * Same conceptual ceiling as `SCRUB_WHOLE_SEGMENT_MAX_BYTES` in
 * `stream-broker/recorded/recorded-feeder.ts` (D163, 1.5 MB) — declared here
 * independently rather than imported, because that module is the CLIENT
 * feeder (a different addon-internal concern; importing its whole dependency
 * graph for one number is the wrong direction). If D163's number moves,
 * this one moves with it.
 */
export const SCRUB_GOP_BUDGET_MAX_BYTES = 1_500_000

/** A file the reader can pull ranges from. `read` may return fewer bytes only at EOF. */
export interface RangeReadable {
  readonly size: number
  read(offset: number, length: number): Promise<Uint8Array>
}

/** Where the requested instant lives inside the segment. */
export interface GopRangeArgs {
  /** Absolute epoch ms of the segment's first sample (the index row's start). */
  readonly segmentStartMs: number
  /** The segment's covered window in ms (the index row's duration). */
  readonly segmentDurMs: number
  /** The absolute instant to serve. Clamped into the segment window. */
  readonly epochMs: number
  /**
   * Sync table captured at finalize while the file was still hot. When present,
   * the read path skips the random tail read and goes straight to init + media.
   */
  readonly seededIndex?: MfraIndex
  /**
   * Byte budget over `tfra`: when set, the read is not limited to the ONE
   * fragment covering `epochMs` — it walks forward, via
   * {@link fragmentsWithinBudget}, and includes as many CONSECUTIVE fragments
   * as fit in `maxBytes`. Omitted ⇒ exactly one fragment, today's behaviour,
   * unchanged (every existing caller that does not pass this keeps getting
   * precisely what it got before).
   */
  readonly maxBytes?: number
}

/** One GOP, cut by byte range, plus the accounting that proves the cut. */
export interface GopRange {
  /** `ftyp`+`moov` head + this fragment's `moof`+`mdat` — standalone-demuxable.
   *  Plain-`ArrayBuffer`-backed: the cap result schema's
   *  `z.instanceof(Uint8Array)` rejects `ArrayBufferLike` views. */
  readonly data: Uint8Array<ArrayBuffer>
  /** Absolute epoch ms of this fragment's first sample. */
  readonly gopStartMs: number
  /** Media ms this fragment covers (to the next sync entry, else the segment end). */
  readonly gopDurMs: number
  /** Total bytes pulled off disk for this answer — observable, so the
   *  byte-range property is testable rather than believed. */
  readonly bytesRead: number
  /**
   * True when this range reaches the segment's LAST fragment — i.e. nothing
   * beyond `maxBytes` was left unserved. False on a plain (no `maxBytes`)
   * single-fragment read whenever a later fragment exists, and on a
   * budget-limited read that had to stop early. Always true when
   * `maxBytes` was omitted and the segment carries exactly one fragment.
   */
  readonly reachesSegmentEnd: boolean
  /** True when the fragment covering `epochMs` alone exceeds `maxBytes` — it
   *  was still served in full (never an empty range). Always false when
   *  `maxBytes` was omitted. */
  readonly oversizeFragment: boolean
  /**
   * Only meaningful for {@link readGopWindowRange} — `undefined` on a plain
   * {@link readGopRange} call, which has no window to satisfy. `true` means
   * the returned bytes cover the whole requested window; `false` means the
   * read was cut short by its safety `maxBytes` before reaching it. See
   * `mfra-index.ts`'s `FragmentWindowPlan.reachesWindowEnd` for why this
   * cannot be inferred from `reachesSegmentEnd` alone.
   */
  readonly reachesWindowEnd?: boolean
}

/** A time window to read, instead of one instant ({@link GopRangeArgs}) or a
 *  byte budget from an anchor. The replay's primitive: "give me this many
 *  seconds of one segment", standalone-demuxable, in ONE range read. */
export interface GopWindowRangeArgs {
  /** Absolute epoch ms of the segment's first sample (the index row's start). */
  readonly segmentStartMs: number
  /** The segment's covered window in ms (the index row's duration). */
  readonly segmentDurMs: number
  /** Absolute epoch ms the window starts at. Clamped into the segment. */
  readonly fromMs: number
  /** Absolute epoch ms the window ends at (exclusive). Clamped into the segment. */
  readonly toMs: number
  readonly seededIndex?: MfraIndex
  /**
   * Safety ceiling, NOT the primary stop condition — the walk stops when the
   * collected fragments already cover `[fromMs, toMs)`; this bound exists so
   * a caller cannot pull an unbounded amount of one segment into memory. A
   * well-formed replay window is expected to hit the time condition first.
   */
  readonly maxBytes: number
}

/** Ticks → ms on the video timescale, rounded like the demux anchors samples. */
function ticksToMs(ticks: number, timescale: number): number {
  return Math.round((ticks / timescale) * 1000)
}

/** ms → ticks on the video timescale — the inverse of {@link ticksToMs}. */
function msToTicks(ms: number, timescale: number): number {
  return (ms / 1000) * timescale
}

/** The head (`ftyp`+`moov`) plus the video track's sync-sample table, shared
 *  by every range read below — resolving it is identical whether the caller
 *  wants one instant, a byte budget, or a time window. */
interface ResolvedSegmentIndex {
  readonly head: Uint8Array
  readonly init: InitInfo
  readonly videoIndex: MfraIndex
}

/**
 * Steps 1-2 shared by {@link readGopRange} and {@link readGopWindowRange}:
 * locate the `mfra` (seeded or from the tail), read the `ftyp`+`moov` head,
 * and pick the VIDEO track's sync table (never the audio one, which lists
 * every `moof` and would send a seek to bytes that do not open a GOP).
 * `null` on anything that does not look like a recorded segment.
 */
async function resolveSegmentIndex(
  file: RangeReadable,
  seededIndex: MfraIndex | undefined,
  read: (offset: number, length: number) => Promise<Uint8Array>,
): Promise<ResolvedSegmentIndex | null> {
  // 1. Prefer the finalize-time RAM index. Older/pruned segments recover it
  // from the tail (`mfro` is the last box by spec).
  const parsed = seededIndex === undefined ? await parseTail(file, read) : null
  if (seededIndex === undefined && parsed === null) return null
  const index = seededIndex ?? parsed!.index

  // 2. The head: everything before the first indexed fragment — `ftyp`+`moov`,
  //    which is exactly the decoder init the demux needs in front of a fragment.
  const firstMoof = index.samples[0]?.moofOffset ?? 0
  if (firstMoof <= 0 || firstMoof >= file.size) return null
  const head = await read(0, firstMoof)
  const init = parseInitInfo(head)
  if (init === null) return null

  // The tfra chosen by default is "the first table", which on this recorder is
  // video — but verify against the moov rather than trust the convention, and
  // re-pick (no extra I/O — the SAME tail bytes are re-parsed) when they
  // disagree. Indexing video moments against the audio table would send the
  // seek to bytes that do not open a GOP.
  const videoIndex =
    index.trackId === init.videoTrackId
      ? index
      : parsed === null
        ? null
        : reparseTail(parsed.tail, file.size, init.videoTrackId)
  if (videoIndex === null) return null

  return { head, init, videoIndex }
}

/**
 * Read the single GOP covering `epochMs` from `file`, by byte range.
 *
 * Returns `null` when the bytes do not carry a usable `mfra`/`moov` — the
 * caller's answer to null is the whole-segment read, which is slow but
 * correct; guessing offsets would be fast and wrong. A parse failure is a
 * property of the FILE, so the caller may cache the null per segment.
 */
export async function readGopRange(
  file: RangeReadable,
  args: GopRangeArgs,
): Promise<GopRange | null> {
  let bytesRead = 0
  const read = async (offset: number, length: number): Promise<Uint8Array> => {
    const chunk = await file.read(offset, length)
    bytesRead += chunk.length
    return chunk
  }

  const resolved = await resolveSegmentIndex(file, args.seededIndex, read)
  if (resolved === null) return null
  const { head, init, videoIndex } = resolved

  // 3. The fragment(s) covering the instant: exactly one when `maxBytes` is
  // omitted (today's behaviour, unchanged); as many CONSECUTIVE fragments as
  // fit `maxBytes` otherwise — a byte budget converted into a set of
  // fragments via `tfra` offsets alone, never the payload.
  const offsetMs = Math.max(0, args.epochMs - args.segmentStartMs)
  const offsetTicks = msToTicks(offsetMs, init.videoTimescale)

  let start: number
  let end: number
  let firstSampleIndex: number
  let lastSampleIndex: number
  let reachesSegmentEnd: boolean
  let oversizeFragment: boolean
  if (args.maxBytes === undefined) {
    const single = fragmentRangeFor(videoIndex, offsetTicks)
    start = single.start
    end = single.end
    firstSampleIndex = single.sampleIndex
    lastSampleIndex = single.sampleIndex
    reachesSegmentEnd = videoIndex.samples[single.sampleIndex + 1] === undefined
    oversizeFragment = false
  } else {
    const plan = fragmentsWithinBudget(videoIndex, offsetTicks, args.maxBytes)
    const firstFragment = plan.fragments[0]!
    const lastFragment = plan.fragments[plan.fragments.length - 1]!
    start = plan.start
    end = plan.end
    firstSampleIndex = firstFragment.sampleIndex
    lastSampleIndex = lastFragment.sampleIndex
    reachesSegmentEnd = plan.reachesSegmentEnd
    oversizeFragment = plan.oversizeFragment
  }
  if (start <= 0 || end <= start || end > file.size) return null
  const fragment = await read(start, end - start)

  const startTicks = videoIndex.samples[firstSampleIndex]?.timeTicks ?? 0
  const nextTicks = videoIndex.samples[lastSampleIndex + 1]?.timeTicks
  const gopStartOffsetMs = ticksToMs(startTicks, init.videoTimescale)
  const gopDurMs =
    nextTicks !== undefined
      ? ticksToMs(nextTicks - startTicks, init.videoTimescale)
      : Math.max(1, args.segmentDurMs - gopStartOffsetMs)

  const data = new Uint8Array(head.length + fragment.length)
  data.set(head, 0)
  data.set(fragment, head.length)
  return {
    data,
    gopStartMs: args.segmentStartMs + gopStartOffsetMs,
    gopDurMs,
    bytesRead,
    reachesSegmentEnd,
    oversizeFragment,
  }
}

/**
 * Read the fragments covering `[fromMs, toMs)` from `file`, by byte range —
 * the WINDOW twin of {@link readGopRange}'s single instant. Same shape, same
 * standalone-demuxable `ftyp`+`moov` head, same `null`-on-unparseable
 * contract; the only difference is the stop condition
 * ({@link fragmentsInWindow} instead of {@link fragmentRangeFor} /
 * {@link fragmentsWithinBudget}).
 */
export async function readGopWindowRange(
  file: RangeReadable,
  args: GopWindowRangeArgs,
): Promise<GopRange | null> {
  let bytesRead = 0
  const read = async (offset: number, length: number): Promise<Uint8Array> => {
    const chunk = await file.read(offset, length)
    bytesRead += chunk.length
    return chunk
  }

  const resolved = await resolveSegmentIndex(file, args.seededIndex, read)
  if (resolved === null) return null
  const { head, init, videoIndex } = resolved

  const fromOffsetMs = Math.max(0, args.fromMs - args.segmentStartMs)
  const toOffsetMs = Math.max(fromOffsetMs, args.toMs - args.segmentStartMs)
  const fromTicks = msToTicks(fromOffsetMs, init.videoTimescale)
  const toTicks = msToTicks(toOffsetMs, init.videoTimescale)

  const plan = fragmentsInWindow(videoIndex, fromTicks, toTicks, args.maxBytes)
  const { start, end } = plan
  if (start <= 0 || end <= start || end > file.size) return null
  const fragment = await read(start, end - start)

  const firstSampleIndex = plan.fragments[0]!.sampleIndex
  const lastSampleIndex = plan.fragments[plan.fragments.length - 1]!.sampleIndex
  const startTicks = videoIndex.samples[firstSampleIndex]?.timeTicks ?? 0
  const nextTicks = videoIndex.samples[lastSampleIndex + 1]?.timeTicks
  const gopStartOffsetMs = ticksToMs(startTicks, init.videoTimescale)
  const gopDurMs =
    nextTicks !== undefined
      ? ticksToMs(nextTicks - startTicks, init.videoTimescale)
      : Math.max(1, args.segmentDurMs - gopStartOffsetMs)

  const data = new Uint8Array(head.length + fragment.length)
  data.set(head, 0)
  data.set(fragment, head.length)
  return {
    data,
    gopStartMs: args.segmentStartMs + gopStartOffsetMs,
    gopDurMs,
    bytesRead,
    reachesSegmentEnd: plan.reachesSegmentEnd,
    reachesWindowEnd: plan.reachesWindowEnd,
    oversizeFragment: plan.oversizeFragment,
  }
}

/** The fetched tail alongside its parse, so a track re-pick costs no I/O. */
interface ParsedTail {
  readonly tail: Uint8Array
  readonly index: MfraIndex
}

/**
 * Fetch + parse the `mfra` tail, honouring `MfraParseError.needBytes` with ONE
 * widened retry. Null on anything else — bytes that are not a segment.
 */
async function parseTail(
  file: RangeReadable,
  read: (offset: number, length: number) => Promise<Uint8Array>,
): Promise<ParsedTail | null> {
  let tailBytes = Math.min(DEFAULT_TAIL_BYTES, file.size)
  for (let attempt = 0; attempt < 2; attempt++) {
    const tail = await read(file.size - tailBytes, tailBytes)
    try {
      return { tail, index: parseMfra(tail, file.size) }
    } catch (err) {
      if (err instanceof MfraParseError && err.needBytes && err.needBytes > tailBytes) {
        tailBytes = Math.min(err.needBytes, file.size)
        continue
      }
      return null
    }
  }
  return null
}

/** Re-parse an already-fetched tail for a specific track. Null when absent. */
function reparseTail(tail: Uint8Array, fileSize: number, trackId: number): MfraIndex | null {
  try {
    return parseMfra(tail, fileSize, { trackId })
  } catch {
    return null
  }
}
