/**
 * Poll-based tail of an ffmpeg `-segment_list` (`live.m3u8`) for one
 * (camera, profile) output dir — recorder variant.
 *
 * Adapted from the old recorder (`addon-pipeline/src/recorder/segment-watcher.ts`).
 * The robust playlist-tailing core is unchanged: it polls `live.m3u8`, derives
 * `startMs` from the flat `<epochSec>.m4s` filename, corrects the inflated
 * first-segment EXTINF duration against the successor's start, and handles
 * pending/phantom (file-not-yet-flushed) entries with a bounded retry.
 *
 * KEY ADAPTATION vs the old watcher: this watcher does NOT relocate the flat
 * file, does NOT classify a continuous/events subtree, and does NOT touch a RAM
 * index. For each finalized flat segment it simply calls
 * `onFinalized(startMs, durMs, flatAbsPath)` and lets the v2 `SegmentStore`
 * (`onFinalized`) do the stat + relocate-into-bucket + index. The watcher only
 * verifies the flat file is on disk (so `onFinalized` does not race the flush)
 * before handing it off; the SegmentStore re-stats for the authoritative byte
 * count that goes into the path. B2 records CONTINUOUS bands only, so there is
 * no subtree to classify.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { IScopedLogger } from '@camstack/types'

/** Called for each finalized segment whose flat file is on disk. `flatAbsPath`
 *  is the absolute path of the flat `<epochSec>.m4s` file under `outDir`; the
 *  v2 SegmentStore stats + relocates it into the bucket tree. */
export type OnFinalizedSegment = (
  startMs: number,
  durMs: number,
  flatAbsPath: string,
) => void | Promise<void>

/**
 * Segments this watcher knows it did NOT hand to `onFinalized` — the playlist
 * rolled past them (see {@link FinalizationPlan.rolledOff}).
 *
 * `fromMs`/`toMs` bound the MEDIA that was missed, not the instant it was
 * noticed, and both are `null` when the playlist gave nothing to derive them
 * from. A consumer that turns this into hours must treat `null` as "unknown",
 * never as "now": marking the wrong hour is the same as marking none, and it
 * costs a directory read on an hour that was never damaged.
 */
export interface MissedSegments {
  readonly deviceId: number
  readonly count: number
  readonly fromMs: number | null
  readonly toMs: number | null
}

/** Told about {@link MissedSegments} — the hour ledger's cue that a row it is
 *  about to seal is short (D521). */
export type OnSegmentsMissed = (missed: MissedSegments) => void

export interface SegmentWatcherDeps {
  readonly outDir: string
  /** The camera this watcher tails, for the tag every line about it carries. */
  readonly deviceId: number
  readonly intervalMs: number
  readonly onFinalized: OnFinalizedSegment
  /**
   * Absent → the loss is logged and nothing else: byte-identical to the
   * pre-D521 behaviour, which is the shape every test that does not care uses.
   */
  readonly onSegmentsMissed?: OnSegmentsMissed
  readonly logger: IScopedLogger
  /**
   * When the ffmpeg process feeding this playlist was spawned. Entries named
   * before it belong to a PREVIOUS run — see {@link classifyMissingEntry}.
   */
  readonly writerStartedMs: number
  /** Injectable clock (ms) — defaults to `Date.now`. */
  readonly now?: () => number
  /**
   * What a watcher of THIS process drained in this directory before this one
   * started (see {@link DrainedPlaylist}). Absent → every roll-off is reported.
   */
  readonly drainedPredecessor?: DrainedPlaylist | null
  /** Told what this watcher drained, once its final pass READ the playlist. */
  readonly onDrained?: (drained: DrainedPlaylist) => void
}

export interface ParsedEntry {
  readonly durSeconds: number
  readonly segPath: string
}

const EPOCH_NAME_RE = /^(\d+)\.m4s$/

/**
 * How long a finalized segment's flat file may take to appear before the entry
 * is given up on.
 *
 * This used to be `MAX_PENDING_TICKS = 8` — a count of TICKS, which is not a
 * measure of time. The tick loop self-excludes while a pass is running and each
 * pass does real filesystem work, so on 2026-08-10..13 eight ticks measured
 * anywhere from 8 s to 819 s. A bound has to be denominated in the thing it
 * bounds.
 *
 * 30 s is chosen from the measurement, not from taste. Over four days the
 * segments that were retried and then DID land waited p50 7.8 s and p90 11.6 s,
 * and widening the window from 16 s to 120 s moved coverage only from 92.9% to
 * 93.8%. There is no tail to chase: past this knee a segment is not slow, it is
 * lost (a writer killed mid-segment), and waiting only delays the skip and the
 * log line that reports it.
 */
export const PENDING_GRACE_MS = 30_000

/**
 * How far before the writer's own start a segment may be named and still be
 * treated as belonging to THIS run.
 *
 * ffmpeg names segments with whole-second `%s`, so the first segment of a run
 * carries the second that was already in progress when the process spawned —
 * up to ~1 s "before" the writer started. Without this tolerance the very first
 * segment of every recording would be classified as a previous run's leftover
 * and dropped.
 */
export const PREVIOUS_RUN_SKEW_MS = 1_000

/**
 * The longest a single watcher pass has been observed to take, end to end.
 *
 * From this file's own field measurement (see {@link PENDING_GRACE_MS}): eight
 * ticks spanned up to 819 s on 2026-08-10..13, i.e. ~102 s for one pass, on a
 * runner whose loop was starved by GC and filesystem work. It is a MEASURED
 * worst case, not a margin picked for roundness, and it is the only thing that
 * decides how far behind the live edge this watcher can legitimately be.
 */
export const WATCHER_PASS_WORST_MS = 102_000

/**
 * How many entries ffmpeg's `-segment_list` must retain — the argument for
 * `-segment_list_size`.
 *
 * ## Why the list is bounded at all
 *
 * It was not, and the muxer default (0) means "keep every segment for the
 * writer's whole life". `parseLivePlaylist` re-splits and re-objectifies the
 * WHOLE body on every 2 s tick, per writer: at 10 s segments a 5-hour writer
 * holds 1 800 entries ⇒ ~220 KB/tick ⇒ **3.3 MB/s across 30 writers**, growing
 * linearly with uptime and bounded by nothing. It is latent today only because
 * writers restart constantly (59 restarts in 16 minutes, measured 2026-08-29)
 * and ffmpeg truncates the list on every spawn.
 *
 * ## Why THIS size
 *
 * The size is what the PARSER has to be able to answer, and the parser has
 * exactly two questions open at any moment:
 *
 *   1. the live tail, which is deliberately held back until its successor
 *      exists ({@link correctedDurMs}) — **1 entry**;
 *   2. every entry whose flat file has not landed yet. That entry stays this
 *      watcher's business for at most {@link PENDING_GRACE_MS}, after which the
 *      pass gives up on it and advances — and the pass that gives up may be as
 *      far as {@link WATCHER_PASS_WORST_MS} behind the one that first saw it.
 *
 * So the window is `1 + (grace + worst pass) / segment length`, rounded up.
 * At the default 10 s segments that is 1 + ceil(132/10) = **15 entries**
 * (~2.5 minutes of playlist, ~1.8 KB) instead of an unbounded list. A shorter
 * segment length buys proportionally more entries, which is exactly right: the
 * bound is denominated in TIME, and the entry count is only how that time is
 * spelled for a given `-segment_time`.
 *
 * Undersizing does not lose footage — a segment that rolls off unhandled stays
 * flat in staging and `staging-reconcile` recovers it at the next boot — but it
 * delays it by a whole process lifetime, so the tick loop reports it
 * ({@link FinalizationPlan.rolledOff}) rather than advancing in silence.
 */
export function segmentListSize(segmentSeconds: number): number {
  const usable = segmentSeconds > 0 ? segmentSeconds : 1
  return 1 + Math.ceil((PENDING_GRACE_MS + WATCHER_PASS_WORST_MS) / (usable * 1000))
}

/** What a missing flat file means for one playlist entry. */
export type MissingEntryVerdict = 'pending' | 'stale-previous-run'

export interface MissingEntryInput {
  /** Segment start, from its `<epochSec>.m4s` name. */
  readonly segmentStartMs: number
  /** When the ffmpeg process feeding THIS playlist was spawned. */
  readonly writerStartedMs: number
}

/**
 * Decide whether a missing flat file is a late flush or a previous run's entry.
 *
 * ffmpeg opens `-segment_list` in TRUNCATE mode when it spawns, but not
 * instantly: a fresh watcher starts at `processed = 0` and, in the window
 * between spawn and that truncation, reads the PREVIOUS run's playlist body.
 * Those entries were relocated into the bucket tree long ago; their absence is
 * the system working. Over 2026-08-10..13 they were 83% of all retries (median
 * age 1 101 s, max 17.4 h) and produced 68 of the 122 `never landed` warnings —
 * a warning that reads like data loss for a file that was correctly filed hours
 * earlier.
 *
 * What this is NOT is crash recovery, and an earlier version of this comment
 * claimed it was. Once ffmpeg truncates, the previous run's un-relocated
 * segments are named by NOTHING, so no amount of care in this function can
 * reach them — on 2026-08-14 that had stranded 179 GB across the fleet. They
 * are recovered from the DIRECTORY instead, by `staging-reconcile.ts`, which
 * the addon runs once at boot. This function only has to be right about the
 * entries a playlist does name.
 */
export function classifyMissingEntry(input: MissingEntryInput): MissingEntryVerdict {
  return input.segmentStartMs < input.writerStartedMs - PREVIOUS_RUN_SKEW_MS
    ? 'stale-previous-run'
    : 'pending'
}

export interface PendingGiveUpInput {
  readonly waitedMs: number
  readonly boundMs: number
}

/** Whether a pending entry has outlived its grace. Pure — the caller clocks it. */
export function shouldGiveUpOnPending(input: PendingGiveUpInput): boolean {
  return input.waitedMs > input.boundMs
}

/**
 * Derive `startMs` (epoch milliseconds) from a flat ffmpeg segment path
 * (`<epochSec>.m4s`, possibly absolute). Returns null for any non-epoch path.
 */
export function parseEpochStartMs(segPath: string): number | null {
  const m = EPOCH_NAME_RE.exec(path.basename(segPath))
  if (!m) return null
  const epochSec = Number(m[1])
  return Number.isFinite(epochSec) ? epochSec * 1000 : null
}

/**
 * Correct a finalized segment's duration. ffmpeg's first-segment `#EXTINF` is
 * unreliable under `-c copy` from RTSP — it is inflated by the initial PTS
 * offset (observed: 87.961s for a segment whose successor starts only 12s
 * later). A segment physically cannot outlast the start of the next segment, so
 * when a successor exists we clamp the rounded EXTINF to the inter-segment gap.
 * For normal segments EXTINF (millisecond-accurate) is below the
 * integer-second start gap and wins, preserving sub-second precision. When
 * there is no successor (genuine last segment) or the gap is non-positive
 * (restart / same-second), we trust EXTINF.
 */
export function correctedDurMs(
  durSeconds: number,
  startMs: number,
  nextStartMs: number | null,
): number {
  const extinfMs = Math.round(durSeconds * 1000)
  if (nextStartMs === null) return extinfMs
  const gapMs = nextStartMs - startMs
  if (gapMs <= 0) return extinfMs
  return Math.min(extinfMs, gapMs)
}

const MEDIA_SEQUENCE_RE = /^#EXT-X-MEDIA-SEQUENCE:(\d+)/m

/**
 * How many entries ffmpeg has already dropped off the FRONT of this playlist.
 *
 * With `-segment_list_size` the list is a sliding window, so an index into the
 * body is not a stable name for a segment: index 0 means a different file every
 * time the window advances. `#EXT-X-MEDIA-SEQUENCE` is the offset that turns a
 * body index back into a monotone global one, and ffmpeg maintains it for
 * exactly this purpose — verified against the ffmpeg 6.1.1 build the hub image
 * ships (12 segments, `-segment_list_size 4` ⇒ 4 entries and
 * `#EXT-X-MEDIA-SEQUENCE:8`; unbounded ⇒ 12 entries and `:0`).
 *
 * Absent (an unbounded list, or a pre-truncation body) it is 0, which is the
 * old behaviour exactly.
 */
export function parseMediaSequence(body: string): number {
  const m = MEDIA_SEQUENCE_RE.exec(body)
  if (m?.[1] === undefined) return 0
  const n = Number(m[1])
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/** Parse a `live.m3u8` body into ordered `#EXTINF` → segment-path pairs. */
export function parseLivePlaylist(body: string): ParsedEntry[] {
  const lines = body.split('\n')
  const out: ParsedEntry[] = []
  let pendingDur: number | null = null
  for (const raw of lines) {
    const line = raw.trim()
    if (line.length === 0) continue
    if (line.startsWith('#EXTINF:')) {
      // `#EXTINF:4.000,` → 4.000
      const v = line.slice('#EXTINF:'.length).replace(/,.*$/, '')
      const dur = Number(v)
      pendingDur = Number.isFinite(dur) ? dur : null
      continue
    }
    if (line.startsWith('#')) continue
    if (pendingDur !== null) {
      out.push({ durSeconds: pendingDur, segPath: line })
      pendingDur = null
    }
  }
  return out
}

/** `fs.stat` size, or null when the path does not exist. */
async function statSize(p: string): Promise<number | null> {
  try {
    return (await fs.stat(p)).size
  } catch {
    return null
  }
}

/**
 * Process ONE finalized playlist entry: verify the flat file is on disk and, if
 * so, hand it to `onFinalized` (the v2 SegmentStore stats + relocates + indexes
 * it). Returns:
 *   - `'retained'` — the flat file is on disk and was handed off;
 *   - `'skipped'`  — not a relocatable epoch-named segment (caller advances past it);
 *   - `'pending'`  — a valid segment whose flat file has NOT landed on disk yet.
 *      ffmpeg's first segment is slow to flush, so the caller must RETRY this
 *      entry on a later tick instead of orphaning it.
 *
 * Unlike the old recorder, this watcher does NOT relocate or re-stat: the
 * SegmentStore owns the move + the authoritative byte count.
 */
export async function handleSegmentEntry(
  outDir: string,
  entry: ParsedEntry,
  durMs: number,
  onFinalized: OnFinalizedSegment,
  logger: IScopedLogger,
  writerStartedMs: number,
): Promise<'retained' | 'skipped' | 'pending'> {
  const flatAbsPath = path.isAbsolute(entry.segPath)
    ? entry.segPath
    : path.join(outDir, entry.segPath)
  const startMs = parseEpochStartMs(flatAbsPath)
  if (startMs === null) return 'skipped'

  // The flat source must be on disk before we hand it to the SegmentStore. Note
  // the ORDER: stat first, classify second. A previous run's segment that is
  // still on disk is un-relocated footage from an unclean stop, and it gets
  // indexed here exactly like a fresh one — that is the crash recovery.
  if ((await statSize(flatAbsPath)) === null) {
    if (
      classifyMissingEntry({ segmentStartMs: startMs, writerStartedMs }) === 'stale-previous-run'
    ) {
      // Not late, and not lost: this run inherited the previous run's playlist
      // and the file was relocated into the bucket tree long ago. Advance past
      // it immediately instead of spending the whole grace window on it and
      // then reporting a phantom loss.
      logger.debug('segment entry predates this writer — already relocated, skipping', {
        meta: { path: flatAbsPath, segmentStartMs: startMs, writerStartedMs },
      })
      return 'skipped'
    }
    logger.debug('segment flat file not on disk yet — will retry', { meta: { path: flatAbsPath } })
    return 'pending'
  }

  await onFinalized(startMs, durMs, flatAbsPath)
  return 'retained'
}

export interface PlannedSegment {
  readonly entry: ParsedEntry
  /** Duration corrected against the successor's start (see `correctedDurMs`). */
  readonly durMs: number
}

export interface FinalizationPlan {
  readonly toHandle: ReadonlyArray<PlannedSegment>
  /** First GLOBAL entry index covered by `toHandle` (the effective high-water
   *  mark after any truncation reset or window roll). The caller advances from
   *  here. Global = `#EXT-X-MEDIA-SEQUENCE` + index in the body. */
  readonly from: number
  /** New high-water mark if every entry in `toHandle` is handled. Global. */
  readonly processed: number
  /**
   * Entries that rolled off the FRONT of a bounded playlist before this watcher
   * handled them. Never a loss — the flat files are still in staging and
   * `staging-reconcile` recovers them at the next boot — but it IS work this
   * pass silently would not do, so the caller says so.
   */
  readonly rolledOff: number
  /**
   * The earliest a rolled-off segment can have begun, and the latest it can
   * have: the front entry of the body is media this pass DID see, so everything
   * it missed began before it, and no earlier than that front minus the missed
   * count at the longest segment length the body shows.
   *
   * An ESTIMATE on the `from` side — the playlist no longer names those
   * entries, so nothing here can be exact — deliberately biased WIDE: an hour
   * named that was never damaged costs one directory read, once, and an hour
   * missed costs the footage (which is the defect this pair exists for).
   *
   * Both `null` when the body's front is not epoch-named: the count is still
   * real, the span is not derivable, and a made-up span marks the wrong hours.
   */
  readonly rolledOffFromMs: number | null
  readonly rolledOffToMs: number | null
}

/**
 * Decide which playlist entries are FINALIZABLE this tick and their corrected
 * durations, given the previously-processed high-water mark. Pure (no I/O) so
 * the tick loop is just: read file → plan → hand each off → advance mark.
 *
 * The live tail entry is held back while recording continues: a segment's true
 * duration needs its SUCCESSOR's start (ffmpeg's first-segment EXTINF is
 * inflated by the initial PTS offset). Once `#EXT-X-ENDLIST` appears the tail
 * is flushed too — by then it is never the unreliable first segment.
 *
 * ## The mark is GLOBAL, not an index into the body
 *
 * `-segment_list_size` (see {@link segmentListSize}) makes the playlist a
 * sliding window, and the moment it starts sliding a body index stops naming a
 * segment: entry 0 is a different file after every roll. A high-water mark kept
 * as a body index would sit at `entries.length - 1` forever and finalize
 * NOTHING while ffmpeg kept writing — a bounded list without this rebase would
 * have stopped the recorder indexing footage while looking like a memory fix.
 * So the mark counts segments since the writer's first, `#EXT-X-MEDIA-SEQUENCE`
 * supplies the offset, and an unbounded list (sequence 0) behaves exactly as
 * before.
 */
export function planFinalizations(
  body: string,
  processed: number,
  forceFinal = false,
): FinalizationPlan {
  const entries = parseLivePlaylist(body)
  const endlist = body.includes('#EXT-X-ENDLIST')
  const base = parseMediaSequence(body)
  // A truncated/rotated playlist (the body ends BELOW the mark) means ffmpeg
  // restarted its list — replay from the top of what it now holds.
  const restarted = base + entries.length < processed
  // Entries the window dropped before we got to them: the mark is behind the
  // front of the body. Not on a restart — there the mark belongs to a dead run.
  const rolledOff = restarted ? 0 : Math.max(0, base - processed)
  const hw = restarted ? base : Math.max(processed, base)
  const finalizableCount = endlist || forceFinal ? entries.length : Math.max(0, entries.length - 1)
  const finalizable = base + finalizableCount
  const toHandle: PlannedSegment[] = []
  for (let g = hw; g < finalizable; g++) {
    const i = g - base
    const entry = entries[i]!
    const startMs = parseEpochStartMs(entry.segPath)
    const nextStartMs = i + 1 < entries.length ? parseEpochStartMs(entries[i + 1]!.segPath) : null
    const durMs =
      startMs === null
        ? Math.round(entry.durSeconds * 1000)
        : correctedDurMs(entry.durSeconds, startMs, nextStartMs)
    toHandle.push({ entry, durMs })
  }
  const front = entries.length > 0 ? parseEpochStartMs(entries[0]!.segPath) : null
  const longestDurMs = entries.reduce(
    (longest, entry) => Math.max(longest, Math.round(entry.durSeconds * 1000)),
    0,
  )
  const spanKnown = rolledOff > 0 && front !== null && longestDurMs > 0
  return {
    toHandle,
    from: hw,
    processed: Math.max(hw, finalizable),
    rolledOff,
    rolledOffFromMs: spanKnown ? front - rolledOff * longestDurMs : null,
    rolledOffToMs: spanKnown ? front : null,
  }
}

/**
 * What a watcher DRAINED: the last entry of the playlist body its final,
 * successful pass read — the identity of that body, so a later watcher can
 * tell "the same playlist" from "a playlist somebody wrote since".
 *
 * Why it exists: a fresh watcher's first read is usually the PREVIOUS run's
 * bounded `live.m3u8` — ffmpeg has not rewritten it yet — and with its mark at
 * 0 every entry before that body's front looks "rolled past". When the previous
 * run was tailed by a watcher of this process through a final pass that READ
 * that very body, that is false: every entry before its front was handled by
 * that watcher, or reported by it when it rolled. Measured on 2026-09-28: 1149
 * such lines in 90 minutes, one per spawn on every camera, each holding its
 * hours unsealed for nothing.
 *
 * Why it is not simply "ignore anything older than the spawn": after a RUNNER
 * RESPAWN the previous watcher died with the process, and then the new
 * watcher's report is the ONLY record that those finalizes never happened —
 * D521's 101 case (`rolledOff=175, processed=0`, two hours sealed short). The
 * ledger that holds these records is owned by the recorder process
 * (`RecordingController`), so a new process starts with none and still reports.
 */
export interface DrainedPlaylist {
  /** `startMs` of the last entry of the body the final pass read. */
  readonly lastSegStartMs: number
  /** Global media sequence (`#EXT-X-MEDIA-SEQUENCE` + index) of that entry. */
  readonly lastMediaSequence: number
}

/** The last entry of one playlist body, as {@link DrainedPlaylist} names it;
 *  `null` when the body has no epoch-named last entry (nothing to vouch for). */
export function playlistTail(body: string): DrainedPlaylist | null {
  const entries = parseLivePlaylist(body)
  const last = entries[entries.length - 1]
  if (last === undefined) return null
  const startMs = parseEpochStartMs(last.segPath)
  if (startMs === null) return null
  return {
    lastSegStartMs: startMs,
    lastMediaSequence: parseMediaSequence(body) + entries.length - 1,
  }
}

export interface DrainedPredecessorInput {
  /** {@link FinalizationPlan.rolledOffToMs} — the front of the body read. */
  readonly rolledOffToMs: number | null
  readonly writerStartedMs: number
  /** {@link playlistTail} of the body read now. */
  readonly bodyTail: DrainedPlaylist | null
  /** What a watcher of this process drained in this directory, if anything. */
  readonly drained: DrainedPlaylist | null
}

/**
 * Did everything a plan says rolled off belong to a predecessor run that a
 * watcher of this process already accounted for? Pure. All three must hold:
 *  - a predecessor was DRAINED here, by a final pass that read its playlist;
 *  - the body read now is NOT NEWER than the one it drained (last entry no
 *    later, sequence no higher) — so it is that playlist, not one a foreign or
 *    later writer produced since, whose roll-off nobody has seen;
 *  - the body's front predates THIS writer — so none of it is this writer's.
 */
export function rolledOffIsDrainedPredecessor(input: DrainedPredecessorInput): boolean {
  const { drained, bodyTail } = input
  return (
    drained !== null &&
    bodyTail !== null &&
    bodyTail.lastSegStartMs <= drained.lastSegStartMs &&
    bodyTail.lastMediaSequence <= drained.lastMediaSequence &&
    input.rolledOffToMs !== null &&
    classifyMissingEntry({
      segmentStartMs: input.rolledOffToMs,
      writerStartedMs: input.writerStartedMs,
    }) === 'stale-previous-run'
  )
}

/** One watcher pass: it read a playlist, or it could not read one. */
type TickOutcome = 'read' | 'unreadable'

export interface SegmentWatcherHandle {
  stop(): void
  /** Force one final playlist pass after ffmpeg exits. */
  flush?(): Promise<void>
}

/**
 * Start polling `<outDir>/live.m3u8`. Returns a handle whose `stop()`
 * cancels the timer. Errors during a tick are swallowed (logged at debug)
 * — a transient read race self-corrects on the next interval.
 */
export function startSegmentWatcher(deps: SegmentWatcherDeps): SegmentWatcherHandle {
  const playlistPath = path.join(deps.outDir, 'live.m3u8')
  const drained = deps.drainedPredecessor ?? null
  // The tail of the last body a pass READ — what a final flush vouches for.
  let lastReadTail: DrainedPlaylist | null = null
  const now = (): number => deps.now?.() ?? Date.now()
  let processed = 0
  let stopped = false
  let ticking = false
  let currentTick: Promise<TickOutcome> | null = null
  // A finalized entry whose flat file hasn't landed yet blocks the high-water
  // mark so it is retried, not orphaned. Bounded IN TIME (see PENDING_GRACE_MS)
  // so a genuine phantom can't stall the stream forever — and so the bound means
  // the same thing whether the tick loop is idle or starved.
  let pendingIndex = -1
  let pendingSinceMs = 0

  const tick = async (forceFinal = false): Promise<TickOutcome> => {
    if (stopped || ticking) return 'unreadable'
    ticking = true
    try {
      let body: string
      try {
        body = await fs.readFile(playlistPath, 'utf8')
      } catch {
        // Playlist not created yet (ffmpeg still warming up) — skip.
        return 'unreadable'
      }
      const bodyTail = playlistTail(body)
      lastReadTail = bodyTail
      const plan = planFinalizations(body, processed, forceFinal)
      if (
        plan.rolledOff > 0 &&
        rolledOffIsDrainedPredecessor({
          rolledOffToMs: plan.rolledOffToMs,
          writerStartedMs: deps.writerStartedMs,
          bodyTail,
          drained,
        })
      ) {
        // The previous run's playlist, not yet rewritten by this writer, and
        // that run was tailed to its end by a watcher of this process: nothing
        // here was missed. Named at debug, per camera, so the skip is visible
        // when asked for and costs nothing when not.
        deps.logger.debug('segment playlist is the drained previous run — no roll-off to report', {
          tags: { deviceId: deps.deviceId },
          meta: {
            rolledOff: plan.rolledOff,
            processed,
            frontMs: plan.rolledOffToMs,
            writerStartedMs: deps.writerStartedMs,
            drainedLastSegStartMs: drained?.lastSegStartMs,
          },
        })
      } else if (plan.rolledOff > 0) {
        // The bounded playlist advanced past entries this watcher never
        // handled. The footage is not lost — the flat files are still in
        // staging and the boot reconcile recovers them — but it is delayed by a
        // whole process lifetime, and a pass that skipped work in silence is
        // exactly what made 179 GB accumulate unnoticed. If this appears at
        // all, `segmentListSize` is too small for this camera's stall profile.
        //
        // The tag is on the LINE. The controller does bind a device-scoped
        // logger, but "the logger is scoped" is a convention a caller can
        // forget, and this is the primary signal for a whole failure mode that
        // is only ever asked per camera ("why is 101 worse than 616?").
        deps.logger.warn('segment playlist rolled past entries this watcher had not handled', {
          tags: { deviceId: deps.deviceId },
          meta: {
            rolledOff: plan.rolledOff,
            processed,
            from: plan.from,
            fromMs: plan.rolledOffFromMs,
            toMs: plan.rolledOffToMs,
          },
        })
        // …and it reaches the hour ledger, which is about to be asked whether
        // the hours this loss falls in are COMPLETE (D521). Reporting it is not
        // optional work: this is the only moment anybody knows.
        deps.onSegmentsMissed?.({
          deviceId: deps.deviceId,
          count: plan.rolledOff,
          fromMs: plan.rolledOffFromMs,
          toMs: plan.rolledOffToMs,
        })
      }
      let index = plan.from
      for (const { entry, durMs } of plan.toHandle) {
        const status = await handleSegmentEntry(
          deps.outDir,
          entry,
          durMs,
          deps.onFinalized,
          deps.logger,
          deps.writerStartedMs,
        )
        if (status === 'pending') {
          if (pendingIndex === index) {
            const waitedMs = now() - pendingSinceMs
            if (shouldGiveUpOnPending({ waitedMs, boundMs: PENDING_GRACE_MS })) {
              // Give up on this entry's file and advance past it. Report the
              // MEASURED wait, not just the fact: "never landed" with no number
              // is what made a 16s bound and an 819s bound indistinguishable in
              // the logs for months. Tagged on the line, not merely on the
              // logger the controller happens to bind.
              deps.logger.warn('segment file never landed — skipping', {
                tags: { deviceId: deps.deviceId },
                meta: { seg: entry.segPath, waitedMs, boundMs: PENDING_GRACE_MS },
              })
              pendingIndex = -1
              pendingSinceMs = 0
              index++
              continue
            }
          } else {
            pendingIndex = index
            pendingSinceMs = now()
          }
          break // retry this index on the next tick; hold the high-water mark here
        }
        index++
      }
      if (pendingIndex !== index) {
        pendingIndex = -1
        pendingSinceMs = 0
      }
      processed = index
      return 'read'
    } finally {
      ticking = false
    }
  }

  const startTick = (forceFinal = false): Promise<TickOutcome> => {
    if (currentTick !== null) return currentTick
    const running = tick(forceFinal)
    currentTick = running
    void running.then(
      () => {
        if (currentTick === running) currentTick = null
      },
      () => {
        if (currentTick === running) currentTick = null
      },
    )
    return running
  }

  const timer = setInterval(() => {
    void startTick()
  }, deps.intervalMs)
  timer.unref?.()

  return {
    stop(): void {
      stopped = true
      clearInterval(timer)
    },
    flush: async (): Promise<void> => {
      // Let an in-progress polling pass settle first; then force an ENDLIST
      // pass. Stopping immediately after a concurrent tick used to drop the
      // final ffmpeg segment during a maintenance drain.
      await currentTick
      const outcome = await startTick(true)
      // Vouch only for a body the final pass actually READ: every entry before
      // its front was handled or reported by this watcher. A pass that could
      // not read the playlist vouches for nothing — a playlist appearing later
      // may hold a roll-off nobody saw.
      if (outcome === 'read' && lastReadTail !== null) deps.onDrained?.(lastReadTail)
    },
  }
}
