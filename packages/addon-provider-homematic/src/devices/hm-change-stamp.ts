/**
 * What a Homematic slice's CHANGE timestamp (`lastChangedAt`, and `motion`'s
 * `lastDetectedAt`) may claim, per where the value came from.
 *
 * ## The cross-package convention this module obeys
 *
 * Consumers (`addon-post-analysis`: the sensor-transition gate and the alarm's
 * `alarm-openings`) read a change timestamp as three things, and a provider
 * must write exactly one of them:
 *
 *  - `0` — a PLACEHOLDER. Nobody has read the device; the value beside it is a
 *    constructor's guess (`COLD_LOCK`'s `unlocked`, `COLD_COVER`'s `closed`).
 *    The gate drops it (`cold-slice`), the alarm reads it as `unknown`.
 *  - `> 0` but older than the gate's first-sighting floor,
 *    `max(startedAt, now - freshness)` — a KNOWN value whose change time is
 *    old or unknown. The alarm reads it as a real open/secure reading (an arm
 *    check blocks on a lock that is really unlocked); the gate's first
 *    sighting seeds it as a baseline instead of emitting it.
 *  - recent — a change that happened at that instant. A first sighting of an
 *    active value carrying it is an EVENT, and while the panel is armed an
 *    event on an opening can fire the siren.
 *
 * ## Why a seeded value is stamped {@link HM_SEEDED_CHANGED_AT}
 *
 * After a respawn (or a CCU reconnect) the child replays the library's cached
 * values — read by `getParamset(…, 'VALUES')` — through the same decoders. That
 * read says WHAT the value is, never WHEN it last changed: XML-RPC's
 * `getParamset` / `getValue` carry no timestamp, and the library's own
 * `receivedAt` (its `ValueChangedEvent.ts`, `HmDataPoint.lastUpdatedAt`) is the
 * moment IT read the value. Stamping that `now` turned a lock unlocked for
 * hours into an unlock that "just happened", which cleared the gate's
 * first-sighting floor and could fire an armed rule.
 *
 * `1` (epoch + 1 ms) is the least lying number available: it is not `0`, so
 * the value is a reading; it is below every freshness floor, so it is never a
 * fresh change; and nobody can mistake 1970 for a measured instant. The
 * alternatives were rejected: the provider's start time minus the freshness
 * window is a fabricated instant a UI would show as "5 minutes ago", and the
 * library's receipt time is the lie being removed. (The CCU's ReGa layer keeps
 * a per-datapoint `Timestamp()`, but it is the LAST UPDATE — HmIP devices
 * re-send their status cyclically — not the last change, and the library does
 * not expose it.)
 *
 * A seed that CONFIRMS what the slice already holds keeps the slice's real
 * stamp: the replay changed nothing, and moving a real `lastChangedAt` back
 * to 1970 would lose a fact.
 *
 * Measurement stamps (`lastFetchedAt`) are NOT change stamps and keep `now` —
 * the value WAS fetched then.
 */

/** A known value whose change time is unknown. See the module header. */
export const HM_SEEDED_CHANGED_AT = 1

/** Where a value reached the child from: a live CCU event, or a replay of the cache. */
export type HmValueOrigin = 'live' | 'seed'

/**
 * The change stamp for one decoded update.
 *
 * `live` ⇒ `now`. `seed` ⇒ the previous stamp when the level did not move and
 * that stamp is a real one, otherwise {@link HM_SEEDED_CHANGED_AT} — never `0`
 * (the value is known) and never `now` (its change time is not).
 */
export function changeStamp(
  origin: HmValueOrigin,
  now: number,
  previousChangedAt: number | null,
  levelUnchanged: boolean,
): number {
  if (origin === 'live') return now
  if (levelUnchanged && previousChangedAt !== null && previousChangedAt > 0) {
    return previousChangedAt
  }
  return HM_SEEDED_CHANGED_AT
}

/** A slice whose change is stamped on `lastChangedAt`. */
export interface HmChangeStamped {
  readonly lastChangedAt: number
}

/**
 * Re-stamp a decoder's result for its origin. Decoders stay pure and stamp
 * `now`; a seeded result is corrected here, so the rule lives in one place.
 */
export function stampForOrigin<T extends HmChangeStamped>(
  origin: HmValueOrigin,
  previous: T,
  next: T,
  levelUnchanged: boolean,
): T {
  if (origin === 'live') return next
  return {
    ...next,
    lastChangedAt: changeStamp(origin, next.lastChangedAt, previous.lastChangedAt, levelUnchanged),
  }
}
