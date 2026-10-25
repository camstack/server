/**
 * Which of a track's stored media can become a RETRAIN FRAME, and which one the
 * page pre-selects.
 *
 * Pure. Every decision here is made from media INDEX rows — no blob is read, so
 * the picker costs a couple of KB per track (the same discipline
 * `getTrainingExportSummary` follows: the cheap question first).
 *
 * ## Two rules, and why each exists
 *
 * **A training frame is a FULL frame with nothing drawn on it.** A `crop`, a
 * `thumbnail`, a `faceCrop` and a `plateCrop` are already cut — annotating them
 * produces boxes in a coordinate space nothing else shares, which is D52 one
 * level up. `fullFrameBoxed` is worse than useless: it has the model's own
 * rectangle burned into the pixels, so a detector trained on it learns to find
 * a green line.
 *
 * **The auto-pick is the NATIVE key frame, not the biggest file.** `keyFrame`
 * is the track's best-detection frame at capture resolution; `keyFrameSmall` is
 * its 960px downscale and can, on a low-motion scene, out-weigh a
 * heavily-compressed native frame in bytes. Ordering by size alone would then
 * hand the operator the downscale and never say so.
 */

import type { MediaFileKind, MediaFileRef } from '@camstack/types'

/**
 * Media kinds that are a whole, unannotated frame — the only ones a retrain
 * annotation may be anchored to.
 *
 * Order is the auto-pick PREFERENCE order, best first. `keyFrame` (native
 * best-shot) leads because that is what the operator agreed the default should
 * be; the downscales sit at the back so they are only ever chosen when nothing
 * native survived.
 */
export const RETRAIN_FRAME_KINDS: readonly MediaFileKind[] = [
  'keyFrame',
  'fullFrame',
  // The CLEAN twins of the timeline tiles (D654). `firstFrame` / `lastFrame` /
  // `snapshot` used to be listed here as "unannotated" — they are not: all
  // three carry the track's box burned in (`ANNOTATED_SCENE_KINDS` in the
  // notification centre), and an annotated frame is never a model input.
  'sceneFrame',
  'lastSceneFrame',
  'keyFrameSmall',
] as const

/** Is this media kind a full, unannotated frame? */
export function isRetrainFrameKind(kind: MediaFileKind): boolean {
  return RETRAIN_FRAME_KINDS.includes(kind)
}

/** A frame the picker can offer, with everything the UI needs to rank it. */
export interface RetrainFrameCandidate {
  /** The media row's own id (D482) — the address, never a composite key. */
  readonly mediaId: number
  readonly kind: MediaFileKind
  readonly timestamp: number
  readonly sizeBytes: number
}

function preferenceRank(kind: MediaFileKind): number {
  const i = RETRAIN_FRAME_KINDS.indexOf(kind)
  return i === -1 ? RETRAIN_FRAME_KINDS.length : i
}

/**
 * The frames of a track a human may annotate, best first.
 *
 * Sorted by kind preference, then by size descending (a bigger file at the same
 * kind is the higher-resolution capture), then by timestamp so the order is
 * total and a re-render never reshuffles the strip.
 */
export function selectableRetrainFrames(
  media: readonly MediaFileRef[],
): readonly RetrainFrameCandidate[] {
  return media
    .filter((m) => isRetrainFrameKind(m.kind))
    .map((m) => ({
      mediaId: m.mediaId,
      kind: m.kind,
      timestamp: m.timestamp,
      sizeBytes: m.sizeBytes ?? 0,
    }))
    .sort(
      (a, b) =>
        preferenceRank(a.kind) - preferenceRank(b.kind) ||
        b.sizeBytes - a.sizeBytes ||
        a.timestamp - b.timestamp,
    )
}

/**
 * The frame the page pre-selects: the best-shot native key frame when the track
 * has one, otherwise the best candidate by the same ordering.
 *
 * `null` when the track has no annotatable frame at all — a real state (a track
 * whose media aged out before it was marked), and the caller must render it as
 * "nothing to annotate" rather than an empty strip that looks like a load.
 */
export function autoPickRetrainFrame(media: readonly MediaFileRef[]): RetrainFrameCandidate | null {
  return selectableRetrainFrames(media)[0] ?? null
}
