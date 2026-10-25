import type { BackingTally } from '../stream-broker/session-mem'
import type { AccessUnit } from './segment-demux'

/**
 * scrub-fragment-cache — the demuxed-fragment LRU behind the feeder-scrub, as
 * its own SESSION-scoped object.
 *
 * It used to live inside `RecordedFeeder`, which made it die with the feeder —
 * and the feeder is rebuilt on every `enterRecorded`, so the fragments demuxed
 * for the timeline WARM-UP (pre-run on timeline open, before any drag) were
 * discarded exactly when the first drag needed them. Hoisted to the WebRTC
 * session, one cache serves the warm-up, every feeder rebuild, and every drag
 * of the session; recorded footage is immutable, so entries never go stale and
 * only the LRU bound evicts.
 *
 * Keys carry the PROFILE: a scrub is pinned to `low` while playback may run
 * `mid`/`high`, and a fragment demuxed at one quality must never answer for
 * another.
 */

/** One demuxed fragment: where it sits on the timeline, and its access units. */
export interface CachedFragment {
  /** Absolute epoch ms of the fragment's first sample. */
  readonly startMs: number
  /** Media ms the fragment covers. */
  readonly durMs: number
  /** Params-fused Annex-B access units, `ptsMs` anchored to 0 at the first. */
  readonly aus: AccessUnit[]
}

/**
 * How much demuxed scrub footage one viewer session may hold FOR THE SCRUB
 * PROFILE, in megabytes.
 *
 * The scrub is pinned to `low` and its read unit is a whole ~10 s segment
 * (~230 KB demuxed at the measured ~190 kbps). A budget this size is not
 * generosity, it is the entire point: 48 MB is ~200 segments, i.e. **~30
 * minutes of timeline resident in RAM** (a ±15 min window around the cursor),
 * so a drag that works around the playhead — or around a jump landing — touches
 * the disk once per ten seconds of footage and never again.
 *
 * It is per WebRTC session, so the fleet cost is `48 MB × concurrent timeline
 * viewers`. Lower it if that product stops fitting; the effect will show up as
 * `coverCache` falling on the drag census.
 */
export const SCRUB_FRAGMENT_CACHE_MB = 48
export const SCRUB_FRAGMENT_CACHE_MAX_BYTES = SCRUB_FRAGMENT_CACHE_MB * 1024 * 1024
/**
 * The profile the scrub budget is FOR. `low` is the profile every drag is
 * pinned to, and the only one whose segments are small enough to be a scrub
 * read unit.
 */
export const SCRUB_CACHE_BUDGET_PROFILE = 'low'
/**
 * Every OTHER profile keeps the old, small budget. A `high` segment is ~5 MB
 * demuxed — a handful of them would spend the whole session budget on a profile
 * no drag reads, and a scrub never pins anything but `low`. Entries here come
 * from playback-adjacent paths (the seek prefix, the warm-up before a profile
 * pin lands), so they are worth keeping, and worth keeping small.
 */
export const SCRUB_FRAGMENT_CACHE_OTHER_MB = 2
export const SCRUB_FRAGMENT_CACHE_OTHER_MAX_BYTES = SCRUB_FRAGMENT_CACHE_OTHER_MB * 1024 * 1024
export const SCRUB_FRAGMENT_CACHE_MIN_ENTRIES = 4

/** Demuxed bytes an entry holds — what the byte bound actually counts. */
function fragmentBytes(frag: CachedFragment): number {
  let total = 0
  for (const au of frag.aus) total += au.data.length
  return total
}

export class ScrubFragmentCache {
  private readonly map = new Map<string, CachedFragment>()
  /**
   * Bytes held PER PROFILE. Budgets are per profile and so is eviction: a
   * `high` entry must never be able to evict the `low` segments the drag is
   * running on, and the reverse would be just as wrong.
   */
  private readonly bytesByProfile = new Map<string, number>()

  constructor(
    private readonly maxBytes: number = SCRUB_FRAGMENT_CACHE_MAX_BYTES,
    private readonly otherMaxBytes: number = SCRUB_FRAGMENT_CACHE_OTHER_MAX_BYTES,
  ) {}

  /** The byte budget for a profile — the scrub profile gets the real one. */
  private budgetFor(profile: string): number {
    return profile === SCRUB_CACHE_BUDGET_PROFILE ? this.maxBytes : this.otherMaxBytes
  }

  private key(profile: string, startMs: number): string {
    return `${profile}|${startMs}`
  }

  /** Exact-start lookup with LRU touch (re-insertion marks most recent). */
  get(profile: string, startMs: number): CachedFragment | null {
    const k = this.key(profile, startMs)
    const frag = this.map.get(k)
    if (!frag) return null
    this.map.delete(k)
    this.map.set(k, frag)
    return frag
  }

  /**
   * The cached fragment COVERING an instant, if any — the lookup that lets a
   * warm drag tick skip `locate` entirely (an RPC measured at 1–8 s on a
   * saturated hub). Coverage is proof of footage: recorded fragments are
   * immutable, so a hit needs no re-validation. LRU-touches the hit.
   */
  covering(profile: string, epochMs: number): CachedFragment | null {
    for (const [k, frag] of this.map) {
      if (!k.startsWith(`${profile}|`)) continue
      if (epochMs >= frag.startMs && epochMs < frag.startMs + frag.durMs) {
        this.map.delete(k)
        this.map.set(k, frag)
        return frag
      }
    }
    return null
  }

  /** Insert (or refresh) a fragment, evicting that PROFILE's oldest past its bound. */
  put(profile: string, frag: CachedFragment): void {
    const k = this.key(profile, frag.startMs)
    const held = this.map.get(k)
    let bytes = this.bytesByProfile.get(profile) ?? 0
    if (held) bytes -= fragmentBytes(held)
    this.map.delete(k)
    this.map.set(k, frag)
    bytes += fragmentBytes(frag)
    this.bytesByProfile.set(profile, bytes)

    const budget = this.budgetFor(profile)
    const prefix = `${profile}|`
    while (
      (this.bytesByProfile.get(profile) ?? 0) > budget &&
      this.entriesFor(profile) > SCRUB_FRAGMENT_CACHE_MIN_ENTRIES
    ) {
      // Map iteration is insertion order and every hit re-inserts, so the first
      // key of this profile is its least recently used.
      const oldest = this.oldestKeyWithPrefix(prefix)
      if (oldest === undefined) break
      const evicted = this.map.get(oldest)
      this.map.delete(oldest)
      if (evicted) {
        this.bytesByProfile.set(
          profile,
          (this.bytesByProfile.get(profile) ?? 0) - fragmentBytes(evicted),
        )
      }
    }
  }

  private oldestKeyWithPrefix(prefix: string): string | undefined {
    for (const k of this.map.keys()) if (k.startsWith(prefix)) return k
    return undefined
  }

  private entriesFor(profile: string): number {
    const prefix = `${profile}|`
    let n = 0
    for (const k of this.map.keys()) if (k.startsWith(prefix)) n += 1
    return n
  }

  /** Demuxed bytes currently held across every profile. */
  get byteSize(): number {
    let total = 0
    for (const bytes of this.bytesByProfile.values()) total += bytes
    return total
  }

  /** Demuxed bytes held for one profile — the number its MB bound governs. */
  byteSizeFor(profile: string): number {
    return this.bytesByProfile.get(profile) ?? 0
  }

  get size(): number {
    return this.map.size
  }

  /**
   * Feed every cached access unit to `tally` — the BACKING-store view of what
   * `byteSize` counts by `.length`. Probe time only (`session-mem.ts`).
   */
  tallyBacking(tally: BackingTally): void {
    for (const frag of this.map.values()) for (const au of frag.aus) tally.add(au.data)
  }
}
