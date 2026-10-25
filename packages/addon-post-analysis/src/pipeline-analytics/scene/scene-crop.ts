/**
 * Scene crop derivation — the ONE place a scene's ROI rectangle becomes pixels,
 * and the one place a whole-frame anchor is downscaled.
 *
 * Both the engine (every check) and the provider (every operator capture) go
 * through here. That is not tidiness: a reference captured with one crop
 * derivation and scored against another produces a cosine that is wrong by an
 * amount nobody can see, and the scene would simply be a bit worse forever.
 * D52 states the rule for the detail/CLIP index; this is the same rule for the
 * scene index.
 *
 * Two products from one decode:
 *   - `crop`   — the normalized rect, at native resolution, JPEG q90.
 *   - `anchor` — the WHOLE frame, downscaled. The view-shift guard: bump the
 *     camera or run a PTZ preset and the same normalized rect now frames a
 *     different piece of world, so the scene diverges forever with a perfectly
 *     plausible cosine. The anchor is what tells those two apart.
 */

import type { MaskRectShape } from '@camstack/types'
import sharp from 'sharp'

/** Whole-frame anchor edge length. Small on purpose — the anchor answers "is
 *  this the same view", not "what is in it". */
export const SCENE_ANCHOR_PX = 224

export interface SceneCropResult {
  readonly crop: Buffer
  readonly width: number
  readonly height: number
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, hi))
}

/**
 * Decode an encoded snapshot and extract the normalized rect ROI as a JPEG crop
 * plus its pixel dimensions (what the embedding-encoder cap expects).
 *
 * The snapshot cap returns an ENCODED image, so this decodes via sharp
 * (auto-detect) rather than the raw-RGB `extractCrop` the shm frame plane uses.
 */
export async function cropSnapshotRoi(
  encoded: Buffer,
  roi: MaskRectShape,
): Promise<SceneCropResult> {
  const meta = await sharp(encoded).metadata()
  const frameW = meta.width ?? 0
  const frameH = meta.height ?? 0
  if (frameW <= 0 || frameH <= 0) throw new Error('snapshot has no decodable dimensions')
  const left = clamp(Math.round(roi.x * frameW), 0, frameW - 1)
  const top = clamp(Math.round(roi.y * frameH), 0, frameH - 1)
  const width = clamp(Math.round(roi.width * frameW), 1, frameW - left)
  const height = clamp(Math.round(roi.height * frameH), 1, frameH - top)
  const crop = await sharp(encoded)
    .extract({ left, top, width, height })
    .jpeg({ quality: 90 })
    .toBuffer()
  return { crop, width, height }
}

/** Downscale the whole frame for the view-shift anchor. */
export async function anchorFrame(encoded: Buffer): Promise<SceneCropResult> {
  const out = await sharp(encoded)
    .resize({
      width: SCENE_ANCHOR_PX,
      height: SCENE_ANCHOR_PX,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 85 })
    .toBuffer({ resolveWithObject: true })
  return { crop: out.data, width: out.info.width, height: out.info.height }
}

/**
 * Mean per-pixel channel spread of a downscaled frame — the IR-cut detector.
 *
 * An infrared frame is chromatically FLAT: every pixel's R, G and B agree
 * because there is no colour information in it. Downscaling to 32×32 first
 * makes this sub-millisecond on a frame that is being decoded anyway, and it is
 * a DIRECT observation of the thing that shifts the embedding — unlike the
 * `day-night` cap, which reports the configured mode (`auto` most of the time)
 * and says nothing about now, and unlike a clock, which is a guess.
 *
 * Returns 0..255. A daylight frame measures tens; an IR frame measures ~0.
 */
export async function chromaSpread(encoded: Buffer): Promise<number> {
  const { data, info } = await sharp(encoded)
    .resize({ width: 32, height: 32, fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (info.channels < 3) return 0 // a greyscale frame IS flat
  let total = 0
  let pixels = 0
  for (let i = 0; i + 2 < data.length; i += info.channels) {
    const r = data[i]!
    const g = data[i + 1]!
    const b = data[i + 2]!
    total += Math.max(r, g, b) - Math.min(r, g, b)
    pixels += 1
  }
  return pixels === 0 ? 0 : total / pixels
}
