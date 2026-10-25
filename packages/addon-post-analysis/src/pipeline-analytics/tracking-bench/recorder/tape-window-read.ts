/**
 * Read the segments a promotion cuts from (D681, Task 12): those the window
 * overlaps, and — for the identities in force at its start — the earlier
 * segments of the same recorder session that still hold one of its tracks.
 *
 * **Overlap.** A segment the window touches is decoded whole. One that cannot
 * be read — a crash left no gzip trailer, or the listing saw the file but
 * could not stat it (its origin is in the NAME, so it is still placed) — is
 * `tape: null`, which `cutWindow` turns into a `restart` gap: the promotion is
 * `incomplete`, never silently short.
 *
 * **Identity lookback (fix round, M3).** A face verdict is recorded once, when
 * the recognizer settles, and a track can stay live for many segments after.
 * So the walk goes back from the window, newest first, one segment at a time,
 * keeping only `identity` records, while:
 *
 *  - the segment is readable — an unreadable one ends the walk, logged, since
 *    a verdict inside it cannot be proved either way;
 *  - it is the SAME recorder session — track ids are random per spawn, so an
 *    earlier session cannot name a track of this one;
 *  - it still binds at least one track that was live at the window's start —
 *    a track absent from a whole segment had not spawned yet.
 *
 * The walk is CAPPED at {@link MAX_IDENTITY_LOOKBACK_SEGMENTS} segments —
 * about an hour of frame time (fix round 2, N5). Each segment is decoded
 * whole and synchronously (a 32 MiB-raw one measured 552 ms on a Mac, more on
 * the hub), and retention is by age, so without a cap the count is bounded
 * only by how long a track stays live — the worst case is what would make a
 * promotion outlive its deadline. A verdict older than the cap on a track
 * still live is not carried, and a tagged line says so. In practice the walk
 * stops after one or two segments. Each segment is decoded, filtered and
 * released before the next, so memory holds identity records, not frames.
 *
 * **Edges (fix round 2, N2).** The read also returns the segment just before
 * the window and the one just after it, so `cutWindow` can tell an idle
 * camera (same session, clean end) from a recorder that was not there. The
 * one before is the lookback's first segment and is decoded once.
 */
import { errMsg, type IScopedLogger } from '@camstack/types'
import type { Tape } from '../tape-codec.js'
import type { TapeBodyRecord } from '../tape-schema.js'
import type { DecodedSegment } from './cut-window.js'
import { SEGMENT_MS } from './tape-recorder.js'
import type { TapeSegmentListing } from './tape-shelf.js'

export interface TapeWindowReadDeps {
  /** The camera's segments, or why they could not be listed (D393). */
  readonly readSegments: (deviceId: number) => Promise<TapeSegmentListing>
  readonly readTape: (file: string, deviceId?: number) => Promise<Tape>
  readonly logger: IScopedLogger
}

export interface TapeWindowQuery {
  readonly deviceId: number
  readonly fromMs: number
  readonly toMs: number
}

/** At most this many earlier segments are read for identities (~1 h). */
export const MAX_IDENTITY_LOOKBACK_SEGMENTS = 6

export interface TapeWindowSegments {
  readonly ok: true
  /** Identity-only lookback segments, then the window's own, oldest first. */
  readonly segments: readonly DecodedSegment[]
  /** The segment just before the window, or null when the shelf holds none. */
  readonly before: DecodedSegment | null
  /** The segment just after the window, or null when the shelf holds none. */
  readonly after: DecodedSegment | null
}

export type TapeWindowRead = TapeWindowSegments | { readonly ok: false; readonly reason: string }

/** Decodes each shelf entry at most once. */
type SegmentDecoder = (entry: ShelfEntry) => Promise<Tape | null>

/** A segment the shelf holds: `file` null when it was seen but not sized. */
interface ShelfEntry {
  readonly originMs: number
  readonly file: string | null
}

/**
 * Decodes each shelf entry at most once, and lets a caller FORGET one once it
 * no longer needs the full decode (fix round, M1) — so a segment kept only
 * for its identity records does not sit in memory for the rest of the read.
 * Exported so the release contract is unit-testable on its own, without a
 * `readWindowSegments` round trip.
 */
export function createSegmentCache(decodeEntry: (entry: ShelfEntry) => Promise<Tape | null>): {
  readonly decodeOnce: SegmentDecoder
  /** Forget a decoded entry. Harmless on one still held elsewhere (a plain
   *  object reference, not a pool) — it only stops the CACHE holding it. */
  readonly release: (originMs: number) => void
  /** How many entries the cache currently holds — a peak-memory assertion. */
  readonly size: () => number
} {
  const decoded = new Map<number, Tape | null>()
  return {
    decodeOnce: async (entry) => {
      if (decoded.has(entry.originMs)) return decoded.get(entry.originMs) ?? null
      const tape = await decodeEntry(entry)
      decoded.set(entry.originMs, tape)
      return tape
    },
    release: (originMs) => {
      decoded.delete(originMs)
    },
    size: () => decoded.size,
  }
}

function shelfEntries(listing: Extract<TapeSegmentListing, { ok: true }>): readonly ShelfEntry[] {
  return [
    ...listing.segments.map((s) => ({ originMs: s.originMs, file: s.file })),
    ...listing.unstatted.map((originMs) => ({ originMs, file: null })),
  ].toSorted((a, b) => a.originMs - b.originMs)
}

async function decode(
  deps: TapeWindowReadDeps,
  deviceId: number,
  entry: ShelfEntry,
): Promise<Tape | null> {
  if (entry.file === null) return null
  try {
    return await deps.readTape(entry.file, deviceId)
  } catch (err) {
    deps.logger.warn('tracking tape segment unreadable — its span becomes a gap', {
      tags: { deviceId },
      meta: { file: entry.file, error: errMsg(err) },
    })
    return null
  }
}

function liveTracks(body: readonly TapeBodyRecord[]): Set<string> {
  const out = new Set<string>()
  for (const r of body) if (r.kind === 'frame') for (const l of r.live) out.add(l.trk)
  return out
}

/**
 * The identity-only earlier segments, oldest first. See the file header.
 *
 * (Fix round, M1.) Every entry this walk decodes is released from `cache`
 * once it has answered the question the walk asked of it — the session
 * check, the still-live filter, the identity filter — because nothing later
 * in the read needs the FULL segment again. The first entry is shared with
 * `readWindowSegments`'s `before` neighbour, already decoded before this
 * walk starts; releasing it here only stops the cache holding a second
 * reference, it does not disturb `before`'s own. At most one lookback-only
 * segment is ever resident at a time.
 */
async function identityLookback(
  deps: TapeWindowReadDeps,
  query: TapeWindowQuery,
  earlier: readonly ShelfEntry[],
  anchor: Tape,
  cache: Pick<ReturnType<typeof createSegmentCache>, 'decodeOnce' | 'release'>,
): Promise<readonly DecodedSegment[]> {
  let needed = liveTracks(anchor.body)
  const kept: DecodedSegment[] = []
  let walked = 0
  for (let i = earlier.length - 1; i >= 0 && needed.size > 0; i -= 1) {
    const entry = earlier[i]
    if (entry === undefined) break
    if (walked === MAX_IDENTITY_LOOKBACK_SEGMENTS) {
      deps.logger.warn('tracking tape identity carry capped', {
        tags: { deviceId: query.deviceId },
        meta: { segments: MAX_IDENTITY_LOOKBACK_SEGMENTS, tracksUnproven: needed.size },
      })
      break
    }
    walked += 1
    const tape = await cache.decodeOnce(entry)
    if (tape === null) {
      deps.logger.warn('tracking tape identity carry stops at an unreadable segment', {
        tags: { deviceId: query.deviceId },
        meta: { originMs: entry.originMs, tracksUnproven: needed.size },
      })
      return kept.toReversed()
    }
    if (tape.header.session !== anchor.header.session) {
      cache.release(entry.originMs)
      return kept.toReversed()
    }
    const present = liveTracks(tape.body)
    needed = new Set([...needed].filter((trk) => present.has(trk)))
    if (needed.size === 0) {
      cache.release(entry.originMs)
      break
    }
    kept.push({
      originMs: entry.originMs,
      tape: { ...tape, body: tape.body.filter((r) => r.kind === 'identity') },
    })
    cache.release(entry.originMs)
    if (i === 0) {
      deps.logger.info('tracking tape identity carry reached the oldest held segment', {
        tags: { deviceId: query.deviceId },
        meta: { originMs: entry.originMs, tracksStillLive: needed.size },
      })
    }
  }
  return kept.toReversed()
}

export async function readWindowSegments(
  deps: TapeWindowReadDeps,
  query: TapeWindowQuery,
): Promise<TapeWindowRead> {
  const listing = await deps.readSegments(query.deviceId)
  if (!listing.ok) return { ok: false, reason: listing.reason }
  const entries = shelfEntries(listing)
  const overlaps = (e: ShelfEntry): boolean =>
    e.originMs <= query.toMs && e.originMs + SEGMENT_MS >= query.fromMs
  const firstOverlap = entries.findIndex(overlaps)
  if (firstOverlap === -1) return { ok: true, segments: [], before: null, after: null }
  const lastOverlap = entries.findLastIndex(overlaps)
  const cache = createSegmentCache((entry) => decode(deps, query.deviceId, entry))
  const decodeOnce = cache.decodeOnce
  const neighbour = async (entry: ShelfEntry | undefined): Promise<DecodedSegment | null> =>
    entry === undefined ? null : { originMs: entry.originMs, tape: await decodeOnce(entry) }
  const window: DecodedSegment[] = []
  for (const entry of entries.slice(firstOverlap, lastOverlap + 1)) {
    window.push({ originMs: entry.originMs, tape: await decodeOnce(entry) })
  }
  const before = await neighbour(entries[firstOverlap - 1])
  const after = await neighbour(entries[lastOverlap + 1])
  const anchor = window[0]?.tape ?? null
  if (anchor === null) {
    deps.logger.warn(
      'tracking tape identity carry skipped — the first window segment is unreadable',
      {
        tags: { deviceId: query.deviceId },
        meta: { originMs: window[0]?.originMs },
      },
    )
    return { ok: true, segments: window, before, after }
  }
  const lookback = await identityLookback(
    deps,
    query,
    entries.slice(0, firstOverlap),
    anchor,
    cache,
  )
  return { ok: true, segments: [...lookback, ...window], before, after }
}
