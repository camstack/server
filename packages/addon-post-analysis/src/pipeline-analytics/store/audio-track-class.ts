/**
 * The class of an audio-sourced track — one value, everywhere (D189).
 *
 * ## The contract
 *
 * A track whose `source` is `'audio'` has `className === 'audio'`: the
 * taxonomy MACRO that already exists (`EVENT_KIND_ICONS.audio`,
 * `AudioEvent.kind`), never a naked audio sub-macro (`speech`, `animal`,
 * `water`). The class heard lives on `Track.audioLabels[].label` — the field a
 * REGULAR track already uses when its camera hears something while a subject
 * is on screen.
 *
 * That is the whole point: a synthetic audio track and a regular track carry
 * audio information in the SAME field, so a consumer written for one renders
 * the other correctly without knowing which it is holding. `source` stays on
 * the row — honest, and useful for a query — but no consumer has to read it to
 * interpret `className`.
 *
 * ## What went wrong
 *
 * `openAudioEpisode` materialized the episode with the naked macro, so
 * `className: 'animal'` meant a COCO quadruped on a pipeline row and a barking
 * dog on an audio row. The audio macro vocabulary OVERLAPS the detection one
 * (`animal`, `vehicle`, `siren`, `door`), and this hub has a live
 * `classes: ['animal']` notification rule — so the collision was not
 * theoretical. Meanwhile the sibling projector
 * (`services/audio-marker-projector.ts`) had always written `'audio'`: two
 * producers of the same row disagreed, and the disagreement is what every
 * consumer then had to absorb.
 *
 * ## Legacy rows
 *
 * Rows written before the contract carry a naked macro. Every one of them also
 * carries the same macro on `audioLabels` (the `addAudioLabelEpisode` stamp has
 * always run on this path), so nothing has to be RECOVERED — the class is
 * simply rewritten. {@link normalizeAudioTrackClass} does that in the single
 * hydration point (`TrackStore.rowToTrack`), and the boot backfill converges
 * the disk so the read compat can be RETIRED rather than lived with forever
 * (D182/D185).
 */

import type { Track } from '@camstack/types'

/** One entry of `Track.audioLabels`, derived from the schema rather than
 *  restated — the shape has exactly one definition (`TrackAudioLabelSchema`). */
type TrackAudioLabelEntry = NonNullable<Track['audioLabels']>[number]

/** The taxonomy macro every audio-sourced track carries as its class. */
export const AUDIO_TRACK_CLASS = 'audio'

/**
 * True when this row predates the contract: audio-sourced, but carrying a
 * naked audio macro as its class.
 *
 * Deliberately NOT "className is in AUDIO_MACRO_LABELS" — an id added to the
 * vocabulary after a row was written would then read as modern forever. The
 * question is the simple one: is this an audio row that does not say `audio`?
 */
function isLegacyAudioTrackClass(track: Track): boolean {
  return track.source === 'audio' && track.className !== AUDIO_TRACK_CLASS
}

/**
 * Bring a hydrated row up to the contract. Returns the SAME reference when
 * there is nothing to do, so the hot path (every non-audio track, and every
 * audio track written after this shipped) allocates nothing.
 *
 * The naked class is preserved as an `audioLabels` entry when — and only when
 * — the row carries none. On the 576 legacy rows measured on the live hub that
 * branch is unreachable (all of them have labels); it exists so the rewrite
 * can never be the step that DESTROYS the only copy of what was heard.
 */
export function normalizeAudioTrackClass<T extends Track>(track: T): T {
  if (!isLegacyAudioTrackClass(track)) return track
  const heard: TrackAudioLabelEntry = {
    label: track.className,
    peakScore: 0,
    count: 1,
    firstAt: track.firstSeen,
    lastAt: track.lastSeen,
  }
  const audioLabels =
    track.audioLabels !== undefined && track.audioLabels.length > 0 ? track.audioLabels : [heard]
  return { ...track, className: AUDIO_TRACK_CLASS, audioLabels }
}
