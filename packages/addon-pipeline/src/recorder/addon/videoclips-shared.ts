/** Shared shapes for the default videoclips composer. Kept in their own
 *  module so `videoclips-provider` and `videoclip-visits` can both import
 *  them without a cycle. */

import type { EventOwnerType } from '@camstack/types'

export interface EventLike {
  readonly id: string
  readonly timestamp: number
  /**
   * The event-media data-plane URL. Stamped for EVERY slim event by
   * `AnalyticsQueryFacade.withMediaUrl` from a template — its presence proves
   * only that the plane is up, never that bytes exist behind it. A clip may
   * publish it as `thumbnail` only for an id in the vouched set.
   */
  readonly mediaUrl?: string
  /**
   * Owning track, on object events only (motion/audio are trackless roots).
   * `crop`/`fullFrameBoxed` are retired, so a new object event usually owns no
   * media of its own and resolves its still through this track — which is why
   * the presence probe needs a second, track-scoped pass.
   */
  readonly trackId?: string
  /** Object class (`person`, `car`, …) — object events only; the visit
   *  aggregates the distinct ones into {@link ClipSchema.labels}. */
  readonly className?: string
}

/**
 * The same event as the analytics READS answer it: a numeric id (D474).
 *
 * `EventLike.id` stays text because downstream it is a clip-id component and a
 * media owner id. {@link toEventLike} is the ONE conversion, so the composer
 * and the media-presence probe cannot disagree about the spelling.
 */
export type NumericIdEvent = Omit<EventLike, 'id'> & { readonly id: number }

/** Stringify the numeric event ids of one bucket. Lossless. */
export function toEventLike(events: readonly NumericIdEvent[]): readonly EventLike[] {
  return events.map((e) => ({ ...e, id: String(e.id) }))
}

export interface EventBuckets {
  readonly motion: readonly EventLike[]
  readonly object: readonly EventLike[]
  readonly audio: readonly EventLike[]
}

export interface ClipPad {
  readonly preMs: number
  readonly postMs: number
}

/** One recorded-footage range, as reported by `recording.getAvailability`. */
export interface FootageRange {
  readonly startMs: number
  readonly endMs: number
}

/**
 * Media-index owner kinds the presence probe may ask about. Mirrors
 * `MediaStore`'s `OwnerKind`, narrowed to what the clip thumbnail path
 * resolves through (`resolveDefaultEventMedia`: event's own media, else its
 * owning track's).
 *
 * `'event'` was ONE kind covering three tables; D476 split it into the three
 * real owner types (`EventOwnerType`, from `@camstack/types` — the authority
 * this union must not drift from) plus `'track'` for the fallback. A presence
 * probe must now ask per EVENT KIND: an id from the motion bucket and an id
 * from the object bucket can be the same number post-D474 and are answered by
 * different rows.
 */
export type MediaOwnerKind = EventOwnerType | 'track'

export interface MediaOwnersQuery {
  readonly deviceId: number
  readonly ownerKind: MediaOwnerKind
  readonly ownerIds: readonly string[]
}

/**
 * Event ids CONFIRMED to have at least one media row behind them — the only
 * licence to publish a `thumbnail`.
 *
 * Passed in as an explicit set rather than resolved inside the pure composers,
 * so a test fake can never pre-seed a URL that production forgot to verify.
 */
export type VouchedEventIds = ReadonlySet<string>
