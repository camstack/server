/**
 * `mfra`/`tfra` — the random-access index every recorded segment already carries.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Painting the frame at a timestamp used to mean downloading the whole covering
 * segment (103 KB on `low`, 8.8 MB on `high`) or a pre-baked scrub pack. Both
 * are bulk transfers standing in for a pointwise question. But fMP4 already
 * answers it: `mfra` maps presentation time → the byte offset of the `moof`
 * holding that sync sample, and `mfro` — always the LAST box in the file —
 * states the index's size, so it is reachable by reading the file TAIL. The
 * recorder writes with `+frag_keyframe`, so every fragment starts at a keyframe
 * and each `moof`+`mdat` pair is independently decodable.
 *
 * Verified across 80 sampled segments on the live archive: 100% carry `mfra`,
 * on both codecs and all three profiles, 2–4 sync samples each (~4 s GOPs).
 *
 * This module is PURE: bytes in, table out. No fetching, no decoding — so it is
 * tested against real captured tails rather than a mock that could agree with a
 * wrong implementation.
 */

/** One sync sample: when it plays, and where its fragment starts in the file. */
export interface SyncSample {
  /** Presentation time in the track's own timescale (not ms — see `timescale`). */
  readonly timeTicks: number
  /** Byte offset of the `moof` box containing this sample. */
  readonly moofOffset: number
}

export interface MfraIndex {
  readonly samples: readonly SyncSample[]
  /** Byte offset where `mfra` itself begins — the upper bound of media data. */
  readonly mfraOffset: number
  /** Which track this table indexes. See `parseMfra`'s `trackId` option. */
  readonly trackId: number
}

export interface ParseMfraOptions {
  /**
   * The track whose table to return.
   *
   * Every recorded segment carries TWO — video and audio. The audio one lists
   * more entries (audio has no delta samples, so every `moof` appears in it),
   * and its offsets are the same moofs seen through a different clock. Indexing
   * video moments against it would send a seek to bytes that do not open a GOP.
   *
   * Omitted → the first table in the box, which on this recorder is video. That
   * default exists only so a caller who has not yet read the `moov` can still
   * work; prefer passing the id from {@link parseInitInfo}.
   */
  readonly trackId?: number
}

/** Thrown when a tail does not contain a usable index. */
export class MfraParseError extends Error {
  constructor(
    message: string,
    /** When set, re-fetch a tail of at least this many bytes and retry. */
    readonly needBytes?: number,
  ) {
    super(message)
    this.name = 'MfraParseError'
  }
}

const MFRO_BOX_SIZE = 16

function asDataView(tail: Uint8Array): DataView {
  return new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
}

/** Index of the last occurrence of a 4-char box type in `buf`. */
function lastIndexOfType(buf: Uint8Array, type: string): number {
  const a = type.charCodeAt(0)
  const b = type.charCodeAt(1)
  const c = type.charCodeAt(2)
  const d = type.charCodeAt(3)
  for (let i = buf.length - 4; i >= 0; i--) {
    if (buf[i] === a && buf[i + 1] === b && buf[i + 2] === c && buf[i + 3] === d) return i
  }
  return -1
}

/**
 * How many tail bytes to request on the first try. Comfortably covers the
 * observed index sizes (a handful of sync samples) without a second round trip;
 * `MfraParseError.needBytes` asks for more on the rare segment that exceeds it.
 */
export const DEFAULT_TAIL_BYTES = 2048

/**
 * Position of the `tfra` for `trackId` (or the first one when unspecified).
 *
 * Walks the `mfra`'s children properly rather than scanning for the ASCII
 * `tfra`: a byte scan cannot tell one table from the next, and picking "the
 * first match" is what made track selection accidental.
 */
function findTfra(mfra: Uint8Array, mv: DataView, trackId?: number): number {
  let p = 8 // past the mfra box header
  while (p + 8 <= mfra.length) {
    const size = mv.getUint32(p)
    if (size < 8 || p + size > mfra.length) break
    const type = String.fromCharCode(mfra[p + 4]!, mfra[p + 5]!, mfra[p + 6]!, mfra[p + 7]!)
    if (type === 'tfra') {
      // tfra body: version(1) flags(3) track_ID(4) …  — the box start is `p`,
      // and the rest of the parser indexes from `type`, hence `p + 4`.
      if (trackId === undefined || mv.getUint32(p + 12) === trackId) return p + 4
    }
    p += size
  }
  return -1
}

/**
 * Parse a segment's trailing bytes into its sync-sample table.
 *
 * @param tail  the LAST `tail.length` bytes of the segment
 * @param fileSize  the segment's total size, needed to turn positions inside
 *                  the tail into absolute file offsets
 */
export function parseMfra(
  tail: Uint8Array,
  fileSize: number,
  opts: ParseMfraOptions = {},
): MfraIndex {
  if (tail.length < MFRO_BOX_SIZE) {
    throw new MfraParseError('tail too short to contain mfro', DEFAULT_TAIL_BYTES)
  }
  const view = asDataView(tail)

  // `mfro` is by specification the last box in the file, and it carries the
  // size of the whole `mfra` — that is the only reason this works without
  // scanning the file from the front.
  const mfroPos = lastIndexOfType(tail, 'mfro')
  if (mfroPos < 0) throw new MfraParseError('no mfro box in tail')
  const mfraSize = view.getUint32(mfroPos + 8)
  if (mfraSize <= 0 || mfraSize > fileSize) {
    throw new MfraParseError(`implausible mfra size ${mfraSize}`)
  }

  // The whole index must be inside what we fetched; otherwise say how much is
  // needed rather than parsing a truncated table into plausible nonsense.
  if (mfraSize > tail.length) {
    throw new MfraParseError(`mfra spans ${mfraSize} bytes, tail has ${tail.length}`, mfraSize)
  }

  const mfraStart = tail.length - mfraSize
  const mfra = tail.subarray(mfraStart)
  const mfraOffset = fileSize - mfraSize

  const mv = asDataView(mfra)
  const tfraPos = findTfra(mfra, mv, opts.trackId)
  if (tfraPos < 0) {
    throw new MfraParseError(
      opts.trackId === undefined
        ? 'no tfra box inside mfra'
        : `no tfra box for track ${opts.trackId}`,
    )
  }

  let p = tfraPos + 4
  const version = mfra[p] ?? 0
  p += 4 // version(1) + flags(3)
  const trackId = mv.getUint32(p)
  p += 4 // track_ID

  // 26 reserved bits then three 2-bit length fields, each encoding (length - 1).
  const sizes = mv.getUint32(p)
  p += 4
  const lenTraf = ((sizes >> 4) & 0x3) + 1
  const lenTrun = ((sizes >> 2) & 0x3) + 1
  const lenSample = (sizes & 0x3) + 1

  const count = mv.getUint32(p)
  p += 4

  const samples: SyncSample[] = []
  for (let i = 0; i < count; i++) {
    let timeTicks: number
    let moofOffset: number
    if (version === 1) {
      timeTicks = Number(mv.getBigUint64(p))
      p += 8
      moofOffset = Number(mv.getBigUint64(p))
      p += 8
    } else {
      timeTicks = mv.getUint32(p)
      p += 4
      moofOffset = mv.getUint32(p)
      p += 4
    }
    p += lenTraf + lenTrun + lenSample
    if (p > mfra.length) {
      throw new MfraParseError(`tfra declares ${count} entries but the box ends early`)
    }
    samples.push({ timeTicks, moofOffset })
  }
  if (samples.length === 0) throw new MfraParseError('tfra has no entries')

  return { samples, mfraOffset, trackId }
}

/**
 * The byte range of the fragment covering `offsetTicks`, and the index of the
 * sync sample chosen.
 *
 * `end` is the START of the next fragment (exclusive), or the start of `mfra`
 * for the last one — never the end of the file, which would drag the index
 * bytes along with every final-GOP fetch.
 */
export function fragmentRangeFor(
  index: MfraIndex,
  offsetTicks: number,
): { start: number; end: number; sampleIndex: number } {
  const { samples, mfraOffset } = index
  // Last sync sample at or before the target — the keyframe a decoder must
  // start from to reach it.
  let lo = 0
  let hi = samples.length - 1
  let chosen = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = samples[mid]
    if (s === undefined) break
    if (s.timeTicks <= offsetTicks) {
      chosen = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  const start = samples[chosen]?.moofOffset ?? 0
  const next = samples[chosen + 1]?.moofOffset
  return { start, end: next ?? mfraOffset, sampleIndex: chosen }
}

/** One fragment included in a {@link FragmentBudgetPlan}: its byte range in the
 *  file, and which sync-sample entry it corresponds to. */
export interface BudgetFragment {
  readonly start: number
  readonly end: number
  readonly sampleIndex: number
}

/**
 * The answer to "how many consecutive GOPs fit in N bytes" — computed purely
 * from `tfra` offsets, no payload read. See {@link fragmentsWithinBudget}.
 */
export interface FragmentBudgetPlan {
  /** Included fragments, in file order, starting at the anchor. Never empty —
   *  see {@link fragmentsWithinBudget}'s never-empty guarantee. */
  readonly fragments: readonly BudgetFragment[]
  /** `fragments[0].start` — where the caller's read should begin. */
  readonly start: number
  /** The last included fragment's `end` — where the caller's read should stop. */
  readonly end: number
  /** True when the last included fragment is the segment's last fragment
   *  (its `end` reaches `mfraOffset`) — the plan covers everything from the
   *  anchor to the end of the segment, not a truncated prefix. */
  readonly reachesSegmentEnd: boolean
  /** True when the ANCHOR fragment alone exceeds `maxBytes`. It is still the
   *  sole entry in `fragments` — the never-empty guarantee applies precisely
   *  to this case. A caller that treats an empty result as "nothing to read"
   *  is the exact silent-degradation class of bug this exists to prevent. */
  readonly oversizeFragment: boolean
}

/**
 * Convert a byte budget into the SET of consecutive fragments that fits,
 * starting at the fragment covering `offsetTicks` and walking FORWARD —
 * matching the read direction a scrub or a sequential-forward strategy
 * actually uses. Pure: `index` is the already-parsed `tfra` table, so this
 * never touches the segment's payload.
 *
 * Greedy: adds the next fragment only while the running total stays within
 * `maxBytes`. The anchor fragment is ALWAYS included, even when it alone
 * exceeds `maxBytes` — {@link FragmentBudgetPlan.oversizeFragment} says so
 * explicitly rather than the caller receiving an empty set and reading it as
 * "nothing to read" (D49's letter, applied to a byte budget: a fallible
 * computation must never silently look like an unbind).
 */
/**
 * The last sync sample at or before `offsetTicks` — the keyframe a decoder
 * must start from. Shared by {@link fragmentsWithinBudget} and
 * {@link fragmentsInWindow}: both walk forward from the same anchor, they
 * only differ in the condition that stops the walk.
 */
function findAnchor(samples: readonly SyncSample[], offsetTicks: number): number {
  let lo = 0
  let hi = samples.length - 1
  let anchor = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = samples[mid]
    if (s === undefined) break
    if (s.timeTicks <= offsetTicks) {
      anchor = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return anchor
}

export function fragmentsWithinBudget(
  index: MfraIndex,
  offsetTicks: number,
  maxBytes: number,
): FragmentBudgetPlan {
  const { samples, mfraOffset } = index
  const anchor = findAnchor(samples, offsetTicks)

  const endOf = (i: number): number => samples[i + 1]?.moofOffset ?? mfraOffset

  const anchorStart = samples[anchor]?.moofOffset ?? 0
  const anchorEnd = endOf(anchor)
  const fragments: BudgetFragment[] = [{ start: anchorStart, end: anchorEnd, sampleIndex: anchor }]
  let total = anchorEnd - anchorStart
  const oversizeFragment = total > maxBytes

  let i = anchor
  while (i + 1 < samples.length) {
    const nextIndex = i + 1
    const nextSample = samples[nextIndex]
    if (nextSample === undefined) break
    const nextStart = nextSample.moofOffset
    const nextEnd = endOf(nextIndex)
    const nextSize = nextEnd - nextStart
    if (total + nextSize > maxBytes) break
    fragments.push({ start: nextStart, end: nextEnd, sampleIndex: nextIndex })
    total += nextSize
    i = nextIndex
  }

  const last = fragments[fragments.length - 1]!
  return {
    fragments,
    start: fragments[0]!.start,
    end: last.end,
    reachesSegmentEnd: last.end >= mfraOffset,
    oversizeFragment,
  }
}

/**
 * {@link FragmentBudgetPlan} plus the answer a TIME window needs:
 * `reachesWindowEnd` says whether the fragments collected already cover the
 * requested `toTicks`, as opposed to the walk having been cut short by
 * `maxBytes` with more fragments still unread. The two are indistinguishable
 * from `fragments` alone — a plan with `reachesSegmentEnd: false` could mean
 * either "the window wants more" or "we hit the safety cap early" — so a
 * caller that skips this field cannot tell a satisfied window from a
 * truncated read of the same shape.
 */
export interface FragmentWindowPlan extends FragmentBudgetPlan {
  readonly reachesWindowEnd: boolean
}

/**
 * Convert a TIME WINDOW `[fromTicks, toTicks)` into the set of consecutive
 * fragments that covers it — the replay's primitive for "give me this many
 * seconds of one segment", as opposed to {@link fragmentsWithinBudget}'s
 * "give me as much as fits in N bytes" (the scrub GOP read's primitive).
 *
 * Stops walking forward the instant the NEXT fragment's own start time
 * already reaches `toTicks`: at that point the fragments already collected
 * cover the whole window, because each fragment's coverage runs up to the
 * next one's start (the same relationship {@link fragmentsWithinBudget}'s
 * `endOf` encodes). `maxBytes` is a SAFETY CEILING, not the primary stop
 * condition — a caller with a well-formed window is expected to hit the time
 * condition first; the byte cap exists so a pathological request cannot pull
 * an unbounded amount of one segment into memory.
 *
 * Same never-empty guarantee as {@link fragmentsWithinBudget}: the anchor
 * fragment is always returned, even when it alone exceeds `maxBytes`.
 */
export function fragmentsInWindow(
  index: MfraIndex,
  fromTicks: number,
  toTicks: number,
  maxBytes: number,
): FragmentWindowPlan {
  const { samples, mfraOffset } = index
  const anchor = findAnchor(samples, fromTicks)

  const endOf = (i: number): number => samples[i + 1]?.moofOffset ?? mfraOffset
  const windowCoveredAt = (i: number): boolean => {
    const next = samples[i + 1]
    return next === undefined || next.timeTicks >= toTicks
  }

  const anchorStart = samples[anchor]?.moofOffset ?? 0
  const anchorEnd = endOf(anchor)
  const fragments: BudgetFragment[] = [{ start: anchorStart, end: anchorEnd, sampleIndex: anchor }]
  let total = anchorEnd - anchorStart
  const oversizeFragment = total > maxBytes

  let i = anchor
  let reachesWindowEnd = windowCoveredAt(i)
  while (!reachesWindowEnd) {
    const nextIndex = i + 1
    const nextSample = samples[nextIndex]
    if (nextSample === undefined) break // unreachable: windowCoveredAt already caught this
    const nextStart = nextSample.moofOffset
    const nextEnd = endOf(nextIndex)
    const nextSize = nextEnd - nextStart
    if (total + nextSize > maxBytes) break // safety cap cut it short — NOT the window being satisfied
    fragments.push({ start: nextStart, end: nextEnd, sampleIndex: nextIndex })
    total += nextSize
    i = nextIndex
    reachesWindowEnd = windowCoveredAt(i)
  }

  const last = fragments[fragments.length - 1]!
  return {
    fragments,
    start: fragments[0]!.start,
    end: last.end,
    reachesSegmentEnd: last.end >= mfraOffset,
    reachesWindowEnd,
    oversizeFragment,
  }
}

// ── moof / trun ────────────────────────────────────────────────────────────

/** What a fragment's `trun` says about its samples. */
export interface FragmentSamples {
  /** Byte size of each sample, in decode order. The first is the keyframe. */
  readonly sizes: readonly number[]
  /** Byte offset, from the START of the fragment, where sample data begins. */
  readonly dataOffset: number
}

/** Walk top-level boxes, returning [type, start, end] for each. */
function* boxes(buf: Uint8Array, from = 0, to = buf.length): Generator<[string, number, number]> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let p = from
  while (p + 8 <= to) {
    const size = view.getUint32(p)
    const type = String.fromCharCode(buf[p + 4]!, buf[p + 5]!, buf[p + 6]!, buf[p + 7]!)
    if (size < 8) return
    const end = Math.min(p + size, to)
    yield [type, p, end]
    p = end
  }
}

function findBox(
  buf: Uint8Array,
  type: string,
  from = 0,
  to = buf.length,
): [number, number] | null {
  for (const [t, s, e] of boxes(buf, from, to)) if (t === type) return [s, e]
  return null
}

/**
 * Parse a fragment's `moof` for its per-sample sizes.
 *
 * This is what makes a SEEK cheap on a big profile: painting one frame needs the
 * keyframe sample, not the whole GOP. On `high` a GOP is 3.5 MB while its
 * keyframe is a fraction of that — the difference between a seek that works
 * remotely and one that takes seconds.
 *
 * `bytes` must start at the fragment's `moof`. Returns null when the buffer does
 * not yet hold the whole `moof` (the caller widens its read).
 */
export function parseFragmentSamples(bytes: Uint8Array): FragmentSamples | null {
  const moof = findBox(bytes, 'moof')
  if (!moof) return null
  const [moofStart, moofEnd] = moof
  if (moofEnd > bytes.length) return null

  const traf = findBox(bytes, 'traf', moofStart + 8, moofEnd)
  if (!traf) return null
  const trun = findBox(bytes, 'trun', traf[0] + 8, traf[1])
  if (!trun) return null

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let p = trun[0] + 8
  const versionAndFlags = view.getUint32(p)
  const flags = versionAndFlags & 0xffffff
  p += 4
  const sampleCount = view.getUint32(p)
  p += 4

  // Flag bits that decide which optional fields are present per sample.
  const hasDataOffset = (flags & 0x000001) !== 0
  const hasFirstSampleFlags = (flags & 0x000004) !== 0
  const hasDuration = (flags & 0x000100) !== 0
  const hasSize = (flags & 0x000200) !== 0
  const hasFlags = (flags & 0x000400) !== 0
  const hasCts = (flags & 0x000800) !== 0

  let dataOffset = moofEnd - moofStart + 8 // default: just past moof, into mdat
  if (hasDataOffset) {
    dataOffset = view.getInt32(p)
    p += 4
  }
  if (hasFirstSampleFlags) p += 4

  // Without per-sample sizes there is nothing to slice on — the caller must
  // fall back to fetching the whole fragment.
  if (!hasSize) return null

  const sizes: number[] = []
  for (let i = 0; i < sampleCount; i++) {
    if (hasDuration) p += 4
    const size = view.getUint32(p)
    p += 4
    if (hasFlags) p += 4
    if (hasCts) p += 4
    if (p > bytes.length) return null
    sizes.push(size)
  }
  return { sizes, dataOffset }
}
