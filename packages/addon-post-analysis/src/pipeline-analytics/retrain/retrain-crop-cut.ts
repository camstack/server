/**
 * The `crops` layout's cutter: one subject crop from a retrain frame copy.
 *
 * A classifier must be trained on the crop the runtime feeds it, so the
 * rectangle comes from THE detail-crop derivation (`deriveDetailCropRect`,
 * `types/src/pipeline/detail-crop.ts`) with the convention the manifest
 * records — never a second rectangle maths. This is the second permitted
 * caller of that derivation (`scripts/check-clip-crop-single-owner.ts`): it
 * writes training files, never a vector, so it cannot split a feature space;
 * what it must not do is cut differently, and calling the one function is how
 * it doesn't.
 */
import sharp from 'sharp'
import {
  type DetailCropConvention,
  deriveDetailCropRect,
  type NativeCropBbox,
} from '@camstack/types'

export interface RetrainCropInput {
  readonly frameBytes: Buffer
  readonly frameWidth: number
  readonly frameHeight: number
  /** Normalised `[0,1]` against the full frame. */
  readonly bbox: NativeCropBbox
  readonly convention: DetailCropConvention
  /** Longest side of the output; `0` keeps the native size. */
  readonly maxSide: number
}

/** The pixel window to extract, or `null` when nothing of it is inside the frame. */
export function retrainCropWindow(
  input: Omit<RetrainCropInput, 'frameBytes' | 'maxSide'>,
): { left: number; top: number; width: number; height: number } | null {
  const { frameWidth: fw, frameHeight: fh, bbox } = input
  const rect = deriveDetailCropRect(
    { x: bbox.x * fw, y: bbox.y * fh, w: bbox.w * fw, h: bbox.h * fh },
    fw,
    fh,
    input.convention,
  )
  const left = Math.max(0, Math.floor(rect.x))
  const top = Math.max(0, Math.floor(rect.y))
  const right = Math.min(fw, Math.ceil(rect.x + rect.w))
  const bottom = Math.min(fh, Math.ceil(rect.y + rect.h))
  if (right - left < 1 || bottom - top < 1) return null
  return { left, top, width: right - left, height: bottom - top }
}

/** A frame re-encoded to a JPEG whose longest side is at most `maxSide` (grid thumbnails). */
export async function resizeRetrainJpeg(bytes: Buffer, maxSide: number): Promise<Buffer> {
  return sharp(bytes)
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer()
}

export async function cutRetrainCrop(input: RetrainCropInput): Promise<Buffer | null> {
  const window = retrainCropWindow(input)
  if (window === null) return null
  let pipeline = sharp(input.frameBytes).extract(window)
  if (input.maxSide > 0) {
    pipeline = pipeline.resize({
      width: input.maxSide,
      height: input.maxSide,
      fit: 'inside',
      withoutEnlargement: true,
    })
  }
  return pipeline.jpeg({ quality: 92 }).toBuffer()
}
