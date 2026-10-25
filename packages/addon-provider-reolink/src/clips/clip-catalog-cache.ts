/**
 * The per-`(device, day)` clip catalog cache.
 *
 * Two freshness windows, because a closed day and today are different
 * questions:
 *
 * - a **closed day** cannot gain or lose a recording, so its listing is
 *   immutable for {@link CLOSED_DAY_TTL_MS}. Re-listing yesterday on every
 *   scroll would cost 2.0 s of camera time (measured: 546 clips on 107) for an
 *   answer that cannot have changed;
 * - **today** is `serve-and-revalidate` under `OPERATOR_WRITTEN_STALE_MS` —
 *   the same discipline every other Reolink read uses (D224), for the same
 *   reason: the list moves only when the camera records something, and the
 *   surface must never WAIT on a camera to draw a row it already has.
 *
 * Every answer carries `catalogAsOf`. That is load-bearing rather than
 * decorative: with a persisted catalog a sleeping camera lists its cached day,
 * and a list drawn as current when its refresh is hours old is exactly the
 * misreading this whole line of work exists to end (D549 13).
 *
 * **A read never joins a refresh already in flight.** It is answered from what
 * is held — empty included — because unknown is the truth about a camera
 * nobody reached, and because a listing that waits for a UDP battery camera is
 * a spinner nobody can cancel (D224).
 */
import { OPERATOR_WRITTEN_STALE_MS } from '@camstack/types'

/** A closed day's listing is immutable for this long. */
export const CLOSED_DAY_TTL_MS = 24 * 60 * 60_000

export interface ClipCatalogEntry<TClip> {
  readonly clips: readonly TClip[]
  /** When this listing was last CONFIRMED against the device. */
  readonly catalogAsOf: number
  /** True when the caller should revalidate — it is served either way. */
  readonly stale: boolean
}

export interface ClipCatalogCacheDeps {
  readonly now: () => number
}

export interface DayKind {
  /** True for a day that is already over in the CAMERA's wall clock. */
  readonly closed: boolean
}

interface Slot<TClip> {
  clips: readonly TClip[]
  catalogAsOf: number
  closed: boolean
  /** Set by `markStale` — a timer that declines to wake a camera (D549 12)
   *  changes this and nothing else. */
  forcedStale: boolean
}

export class ClipCatalogCache<TClip> {
  private readonly slots = new Map<string, Slot<TClip>>()
  private readonly inFlight = new Map<string, Promise<void>>()

  constructor(private readonly deps: ClipCatalogCacheDeps) {}

  private static key(deviceId: number, day: string): string {
    return `${deviceId}|${day}`
  }

  private ttlFor(slot: Slot<TClip>): number {
    return slot.closed ? CLOSED_DAY_TTL_MS : OPERATOR_WRITTEN_STALE_MS
  }

  /** What is held for this day, or `null` when nothing ever was. Never a read
   *  of the camera. */
  peek(deviceId: number, day: string): ClipCatalogEntry<TClip> | null {
    const slot = this.slots.get(ClipCatalogCache.key(deviceId, day))
    if (slot === undefined) return null
    const age = this.deps.now() - slot.catalogAsOf
    return {
      clips: slot.clips,
      catalogAsOf: slot.catalogAsOf,
      stale: slot.forcedStale || age > this.ttlFor(slot),
    }
  }

  put(deviceId: number, day: string, clips: readonly TClip[], kind: DayKind): void {
    this.slots.set(ClipCatalogCache.key(deviceId, day), {
      clips,
      catalogAsOf: this.deps.now(),
      closed: kind.closed,
      forcedStale: false,
    })
  }

  /**
   * Mark every day this device holds as stale WITHOUT dropping it.
   *
   * This is the standalone-battery timer's whole effect (D549 12): the catalog
   * ages, the rows stay, and the refresh runs when the camera is awake for its
   * own reasons. Dropping the rows here would turn "we have not checked
   * lately" into "this camera has no recordings".
   */
  markStale(deviceId: number): void {
    for (const [key, slot] of this.slots) {
      if (key.startsWith(`${deviceId}|`)) slot.forcedStale = true
    }
  }

  /**
   * The first row this device holds that matches — across every day.
   *
   * The thumbnail and playback routes are addressed by `clipKey` alone, and
   * both must resolve the row (its byte handle, its window) WITHOUT re-listing
   * the camera: a click on a tile is not a reason to pay 2.0 s of Baichuan.
   * `null`, never `undefined`: "no such row" is an answer.
   */
  findBy(deviceId: number, predicate: (row: TClip) => boolean): TClip | null {
    for (const [key, slot] of this.slots) {
      if (!key.startsWith(`${deviceId}|`)) continue
      const found = slot.clips.find(predicate)
      if (found !== undefined) return found
    }
    return null
  }

  /**
   * Every day key this device holds a listing for, in no particular order.
   *
   * It is what lets an availability probe say WHEN a catalog was last
   * confirmed without listing anything: a camera nobody may wake reports the
   * age of what is held, and a source with nothing held says so rather than
   * claiming to be current.
   */
  daysHeld(deviceId: number): readonly string[] {
    const out: string[] = []
    const prefix = `${deviceId}|`
    for (const key of this.slots.keys()) {
      if (key.startsWith(prefix)) out.push(key.slice(prefix.length))
    }
    return out
  }

  /** Every row held for a device, in no particular order. The prefetch sorts. */
  allRows(deviceId: number): readonly TClip[] {
    const out: TClip[] = []
    for (const [key, slot] of this.slots) {
      if (key.startsWith(`${deviceId}|`)) out.push(...slot.clips)
    }
    return out
  }

  /** Forget everything held for a device (used when a device leaves). */
  forget(deviceId: number): void {
    for (const key of [...this.slots.keys()]) {
      if (key.startsWith(`${deviceId}|`)) this.slots.delete(key)
    }
  }

  /**
   * Serve what is held and revalidate behind it; wait only when nothing is
   * held at all.
   *
   * A failed revalidation leaves the cached rows in place — fail OPEN on the
   * LIST (a fallible read must never empty a surface) — and rejects only when
   * there was nothing to serve, which is the one case where the caller must
   * learn the reason rather than draw an empty day.
   */
  async serveAndRevalidate(
    deviceId: number,
    day: string,
    kind: DayKind,
    refresh: () => Promise<readonly TClip[]>,
  ): Promise<ClipCatalogEntry<TClip>> {
    const key = ClipCatalogCache.key(deviceId, day)
    const held = this.peek(deviceId, day)

    if (held !== null && !held.stale) return held

    if (held !== null) {
      // Stale but present: kick a revalidation at most once and answer NOW.
      if (!this.inFlight.has(key)) {
        const run = refresh()
          .then((clips) => {
            this.put(deviceId, day, clips, kind)
          })
          .catch(() => {
            // Swallowed on purpose: the rows we already serve are the answer,
            // and the caller's own logging names the refusal per device. A
            // throw here would reject an unawaited promise.
          })
          .finally(() => {
            this.inFlight.delete(key)
          })
        this.inFlight.set(key, run)
      }
      return held
    }

    const existing = this.inFlight.get(key)
    if (existing !== undefined) {
      await existing
      const after = this.peek(deviceId, day)
      if (after !== null) return after
    }

    const run = refresh()
      .then((clips) => {
        this.put(deviceId, day, clips, kind)
      })
      .finally(() => {
        this.inFlight.delete(key)
      })
    this.inFlight.set(key, run)
    await run
    const fresh = this.peek(deviceId, day)
    if (fresh === null) {
      throw new Error(`clip catalog: refresh for device ${deviceId} day ${day} stored nothing`)
    }
    return fresh
  }
}
