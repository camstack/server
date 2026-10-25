/**
 * What a track surface actually needs to draw a track.
 *
 * `EventCard` and `EventDetailPanel` were typed on `KeyEventRow` — the events
 * FEED's row — which meant only the feed could open them. The Debug tab
 * therefore grew its own text-only list of the same subjects, and the two
 * screens diverged: one showed a picture, a filmstrip, a trajectory and the
 * flag toggles, the other showed a line of grey text.
 *
 * This is the intersection: the fields both components read, and nothing else.
 * `KeyEventRow` satisfies it structurally, so the feed is unchanged and needs
 * no adapter; a debug row satisfies it too. Narrowing a prop is the whole fix —
 * there is no second card, no second panel and no copy of either.
 *
 * It is NOT a mirror of `KeyEventSchema`. A field is added here when a
 * component starts reading it, never speculatively: a structural type that
 * claims more than its consumers read is a contract nobody is checking.
 */

export interface TrackSubject {
  readonly deviceId: number
  readonly trackId: string
  readonly className: string
  /** Tier 1 — the sub-class (`bird`). */
  readonly label?: string
  /** Tier 2 — the instance (`Turdus migratorius`). The finest thing known. */
  readonly subLabel?: string
  /** 0‥1. A track nobody scored is `0`, which renders as no badge. */
  readonly importance: number
  /**
   * A specific media row this subject is best drawn from, when the producer
   * already resolved one (D482) — e.g. a CLIP search hit's own
   * `keyFrameMediaId`/`mediaId`. `EventCard`/`EventDetailPanel` prefer this
   * for the tile source and fall back to the owner form
   * (`mediaOwnerPath('track', trackId)`) when it is absent — every producer
   * of this interface carries a `trackId`, so that fallback always has
   * something to ask.
   */
  readonly mediaId?: number
  /**
   * Id of the track's representative ObjectEvent, when one was assigned
   * (`''` = none). NOT read for media addressing any more (D482): the id
   * alone cannot be turned into a plane URL without also naming the owner
   * TABLE, and this field predates that requirement. `EventCard` /
   * `EventDetailPanel` resolve the tile from {@link mediaId} and `trackId`
   * instead. Kept because every producer (`KeyEvent`, the debug bridge)
   * still supplies it.
   */
  readonly bestEventId: string
  /** Track start (firstSeen). */
  readonly timestamp: number
  /** Track lifetime in ms. Absent = unknown, which renders as no duration. */
  readonly windowMs?: number
  /**
   * Heard audio macros (D189). Optional — the Events feed carries it on
   * `KeyEvent` so the card/panel can name what was heard without waiting for
   * `getTrack`. Absent on rows with no confident audio.
   */
  readonly audioLabels?: readonly {
    readonly label: string
    readonly peakScore: number
    readonly count: number
    readonly firstAt: number
    readonly lastAt: number
  }[]
  /** Operator flags. **Absent ≠ false** — a row that predates the columns
   *  omits them, and every consumer tests `=== true`. */
  readonly markForTrain?: boolean
  readonly debug?: boolean
  readonly favourited?: boolean
  /**
   * Retrain lifecycle (`none` | `staging` | `trained`). `markForTrain` is the
   * wire face of staging only — a trained track reports markForTrain false,
   * so the card needs this field to show that the work is done (I6).
   */
  readonly retrainStatus?: 'none' | 'staging' | 'trained'
}
