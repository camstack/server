/**
 * The ONE place a late label reaches a track AND its already-emitted events.
 *
 * Before 4g there were three of these, written independently and drifting:
 * `applyTrackEnrichmentLabel` (classifier / plate OCR), the FaceRecognizer's
 * identity propagation, and the two gallery providers' operator assignment.
 * Each did `trackStore.setLabel` + `eventStore.setLabelForTrack` +
 * `recomputeTrackImportance` in its own order, with its own error handling, and
 * with no rule about what may replace what.
 *
 * They now all pass a {@link LabelCandidate} through here. The tier decision is
 * `resolveTieredLabelWrite`'s, taken ONCE — on the TRACK — and the object
 * events take a copy of it; this function is only the plumbing plus the refusal
 * log — a branch that DROPS work says so, per camera, because "why is 107
 * unlabelled" is always asked about one camera.
 */

import type { IScopedLogger } from '@camstack/types'
import type { EventStore } from '../store/event-store.js'
import type { TrackStore } from '../store/track-store.js'
import { recomputeTrackImportance } from './key-event-recompute.js'
import { type LabelCandidate, refusalLogMeta, type TieredLabelPatch } from './label-tier.js'

/** The stores + logger a late label write needs. */
export interface ApplyTrackLabelDeps {
  readonly trackStore?: TrackStore
  readonly eventStore?: EventStore
  readonly logger: IScopedLogger
}

/** What a late label write did, for the caller that wants to react to it. */
export interface ApplyTrackLabelResult {
  /** The candidate reached the track row. */
  readonly trackWritten: boolean
  /** How many already-emitted object events took it. */
  readonly eventsUpdated: number
}

/**
 * Offer `candidate` to a track and to every object event it already emitted.
 *
 * Best-effort in three independent steps, in this order and for this reason:
 * the TRACK is the authority a later reader resolves against, the EVENTS are a
 * denormalised copy, and importance is derived from both. A failure in one does
 * not abandon the others — a half-labelled track is strictly better than an
 * unlabelled one, and the next answer re-offers itself.
 */
export async function applyTrackLabelCandidate(
  deps: ApplyTrackLabelDeps,
  deviceId: number,
  trackId: string,
  candidate: LabelCandidate,
): Promise<ApplyTrackLabelResult> {
  let trackWritten = false
  /** The patch the TRACK accepted — the ONE decision the events copy. */
  let accepted: TieredLabelPatch | undefined
  try {
    const decision = await deps.trackStore?.applyLabelCandidate(trackId, candidate)
    if (decision?.kind === 'write') {
      trackWritten = true
      accepted = decision.patch
    }
    if (decision?.kind === 'refused') {
      // The tier collapse keeps its original line and its original meta keys —
      // it shipped on 2026-08-07 and anything already querying it must keep
      // matching. Every other refusal is new information and says so.
      const message =
        decision.reason.kind === 'macro-class'
          ? 'label tier collapse refused'
          : 'label write refused'
      deps.logger.info(message, {
        tags: { deviceId },
        meta: { trackId, ...refusalLogMeta(decision.reason) },
      })
    }
  } catch (err) {
    deps.logger.warn('track label write failed', {
      tags: { deviceId },
      meta: { trackId, error: String(err) },
    })
  }

  // The events are a DENORMALISED COPY of the track's answer, never a second
  // evaluation of it — see `EventStore.projectTrackLabel`. A refused track write
  // changed nothing, so there is nothing to copy and the rows keep what they
  // have.
  let eventsUpdated = 0
  try {
    eventsUpdated =
      accepted !== undefined
        ? ((await deps.eventStore?.projectTrackLabel(trackId, accepted)) ?? 0)
        : 0
  } catch (err) {
    deps.logger.warn('event label back-patch failed', {
      tags: { deviceId },
      meta: { trackId, error: String(err) },
    })
  }

  if (trackWritten || eventsUpdated > 0) {
    try {
      const trackStore = deps.trackStore
      const eventStore = deps.eventStore
      if (trackStore && eventStore) {
        await recomputeTrackImportance({ trackStore, eventStore }, trackId)
      }
    } catch (err) {
      deps.logger.debug('label recomputeImportance failed', {
        tags: { deviceId },
        meta: { trackId, error: String(err) },
      })
    }
  }

  return { trackWritten, eventsUpdated }
}
