/**
 * A cooldown on the kinds that never stop.
 *
 * ## Why
 *
 * Once the merge grain became the padding (D583) the list stopped being seven
 * day-long blocks and became 1 819 rows in a day on 592 — **1 090 of them
 * audio**, and 1 180 carrying a single event. Two thirds of the list was one
 * audio blip at a time:
 *
 * > *"teniamo gli audio come eventi, con un cooldown di 5 minuti tra uno e
 * > l'altro per evitare affollamento, gli audio sono costanti, esattamente
 * > come motion isolato (ma a 2 minuti)"* [we keep audio as events, with a 5-minute cooldown between one and the next to avoid crowding; audio is constant, exactly like isolated motion (but at 2 minutes)] — the operator.
 *
 * Audio and motion are KEPT. They are real, and dropping them would hide a
 * camera that only ever hears something. What a run of them yields is one row
 * per cooldown instead of one row per blip.
 *
 * ## What is never held back
 *
 * A visit holding an OBJECT event — the one the operator is looking for. This
 * needs no special case because `dominantKind` already ranks object > motion >
 * audio: an audio blip coinciding with a detection is part of THAT visit and
 * never a row of its own, so the cooldown only ever sees the ISOLATED ones.
 *
 * ## From the last EMITTED row
 *
 * Not from the last seen. Measuring from the last seen means a constant stream
 * emits once and never again — silence dressed as a filter.
 *
 * ## Why here and not in the types package
 *
 * These are the recorder's own density policy and nothing else reads them.
 * Putting them in `@camstack/types` would make a list-density tweak a
 * framework change: a publish and three node updates to move a number.
 */
import type { Clip } from '@camstack/types'

/** Audio is constant on an outdoor camera — one row per five minutes. */
export const AUDIO_QUIET_MS = 5 * 60_000

/** Isolated motion, same rule, shorter: one row per two minutes. */
export const MOTION_QUIET_MS = 2 * 60_000

/** How long each kind stays quiet after it has been listed. Absent = no bound. */
const QUIET_BY_KIND: Partial<Record<Clip['kind'], number>> = {
  audio: AUDIO_QUIET_MS,
  motion: MOTION_QUIET_MS,
}

/**
 * Thin a run of same-kind rows to one per cooldown.
 *
 * The DECISION is made oldest-first, because a cooldown read off an unsorted
 * list keeps an arbitrary subset. The ANSWER keeps the caller's own order:
 * this provider lists newest-first, and quietly reversing it here would have
 * turned a density filter into a reordering — caught by the spec that pins
 * `clips[0].kind`, which is the only reason it is not shipping.
 */
export function applyQuietKinds(clips: readonly Clip[]): Clip[] {
  const lastEmitted = new Map<Clip['kind'], number>()
  const dropped = new Set<string>()
  for (const clip of [...clips].toSorted((a, b) => a.timeRange.startMs - b.timeRange.startMs)) {
    const quietMs = QUIET_BY_KIND[clip.kind]
    if (quietMs === undefined) continue
    const previous = lastEmitted.get(clip.kind)
    if (previous !== undefined && clip.timeRange.startMs - previous < quietMs) {
      dropped.add(clip.id)
      continue
    }
    lastEmitted.set(clip.kind, clip.timeRange.startMs)
  }
  return clips.filter((clip) => !dropped.has(clip.id))
}
