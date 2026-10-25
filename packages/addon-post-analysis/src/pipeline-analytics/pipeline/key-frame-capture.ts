/**
 * Pure helpers for the per-track NATIVE-resolution `keyFrame` capture
 * (Design B — one native full-frame per track at its best-detection moment).
 *
 * ## Why this exists (the missing native keyFrame)
 *
 * `keyFrame` was historically captured ONLY inside the CLIP object-embedding
 * best path (`persistObjectEmbeddingBests`, gated by `isClipObjectEmbedding`).
 * Under the two-plane pipeline the root frame carries NO CLIP embedding (clip is
 * a per-track DETAIL served via `runDetailSubtree`, and is disabled cluster-
 * wide), so that gate was never satisfied and the native `keyFrame` was NEVER
 * produced — every stored frame stayed at the ≤640×360 detection resolution.
 *
 * The fix decouples the `keyFrame` from the clip path: it is selected on the
 * GENERAL best-frame signal (the same `bestThumbnail` decision that drives the
 * `thumbnail`) by {@link selectKeyFrameCaptures}.
 *
 * ## How the pixels arrive, since D422
 *
 * Not by handle. At the best instant the owning node PARKS the whole frame at
 * {@link KEYFRAME_NATIVE_MAX_WIDTH} (`track-park.ts` orders it; the runner
 * refuses a ≤640 `ram-fullframe` answer at park time), and `persistKeyFrames`
 * stores that parcel verbatim as `keyFrame` (`key-frame-persist.ts`). The web
 * companion is {@link deriveKeyFrameSmall} of the same bytes — never a second
 * fetch. A retrieval keyed by a track never falls back to a handle
 * (`scripts/check-parked-frame-no-handle-fallback.ts`).
 */

import sharp from 'sharp'
import { MEDIA_QUALITY } from '../../shared/frame/media-quality.js'

/** Cap (px) on the width of the native KEY FRAME (full-frame native capture).
 *  Native resolution is the point: a 4K cam (3840) resolves TRUE native (no
 *  resize, 3840 ≤ 4096); an 8K cam is bounded to 4096 (still far past the retired
 *  1920 cap). This honours "native, no 1920 intermediate" while keeping the raw
 *  rgb transfer wire-safe. Env-overridable (`CAMSTACK_KEYFRAME_NATIVE_MAX_WIDTH`)
 *  for a homelab that wants a tighter/looser bound. */
export const KEYFRAME_NATIVE_MAX_WIDTH =
  Number.parseInt(process.env.CAMSTACK_KEYFRAME_NATIVE_MAX_WIDTH ?? '', 10) || 4096

/** Long-side cap (px) for the companion `keyFrameSmall` variant — the clean best
 *  full frame at a web-friendly size, written ALONGSIDE the native `keyFrame`
 *  from the SAME native surface (no second fetch). */
export const KEYFRAME_SMALL_MAX_WIDTH = 960

/** The minimal shape this selector needs from a periodic-media target. */
export interface KeyFrameSelectable {
  readonly trackId: string
  /**
   * Which key-frame path this frame chose for the track, as
   * `decideKeyFrameCapture` (`key-frame-retry.ts`) resolved it:
   *
   *  - `'new-best'` — a GENUINE new best-detection peak (strictly better, past
   *    the hysteresis + min gap). Deliberately NOT the `bestThumbnail` retry
   *    signal, which re-fires every frame while a thumbnail hasn't landed and
   *    once re-shot the native keyFrame 13 times for one track (RC-1);
   *  - `'retry'` — the BOUNDED catch-up path added 2026-08-06, because a
   *    peak-only gate left 71.6% of miss-logged tracks with no key frame at
   *    all, hence unable to be re-embedded, ever;
   *  - `'skip'` — no capture this frame.
   *
   * `putReplacing` downstream keeps one `keyFrame` row per track either way.
   */
  readonly keyFrame: KeyFrameSelectionKind
}

/** The three verdicts a per-frame key-frame decision can produce. */
export type KeyFrameSelectionKind = 'skip' | 'new-best' | 'retry'

/** One track due a key-frame capture this frame, and on which path. */
export interface KeyFrameSelection {
  readonly trackId: string
  /** Retry path: lower scheduler priority, charged against the retry budget. */
  readonly retry: boolean
}

/**
 * The tracks whose native `keyFrame` should be (re)captured THIS frame, each
 * tagged with the path that selected it. The two paths must not be flattened:
 * a retry is dispatched at a LOWER priority (it must never displace live
 * media) and it spends one of the track's bounded attempts.
 */
export function selectKeyFrameCaptures(
  targets: readonly KeyFrameSelectable[],
): readonly KeyFrameSelection[] {
  const selected: KeyFrameSelection[] = []
  for (const target of targets) {
    if (target.keyFrame === 'skip') continue
    selected.push({ trackId: target.trackId, retry: target.keyFrame === 'retry' })
  }
  return selected
}

/**
 * The web companion from the PARKED key frame's own JPEG (D422): the parcel is
 * stored verbatim as `keyFrame`, and `keyFrameSmall` is this — the same bytes
 * downscaled to {@link KEYFRAME_SMALL_MAX_WIDTH}. One decode, one encode,
 * never a second fetch; `withoutEnlargement` never upscales a sub-960 frame.
 */
export async function deriveKeyFrameSmall(keyFrameJpeg: Buffer): Promise<Buffer> {
  return sharp(keyFrameJpeg)
    .resize(KEYFRAME_SMALL_MAX_WIDTH, null, { withoutEnlargement: true })
    .jpeg({ quality: MEDIA_QUALITY })
    .toBuffer()
}
