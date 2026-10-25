/**
 * Re-align a stored 112×112 face TEMPLATE with the fixed detector (D644).
 *
 * A detected v1 sample keeps only the template its old alignment cut. The
 * detector cannot find a face that fills its whole input — tried on the live
 * hub, a raw template returns no detection at all — so the template is
 * upscaled and letterboxed onto a black canvas first, and the result goes
 * through the REAL photo analyze path (`analyzeStoredPhoto`: detect with the
 * fixed SCRFD, five landmarks, warp, embed with the cluster model). Nothing
 * here computes a crop rectangle for the embedder; the aligner does (D52).
 *
 * ## The geometry, measured (2026-09-26, live hub, read-only)
 *
 * Self-consistency on the nine photo v2 templates (re-aligned vs the direct
 * embedding of the same template) and same-instant v1 pairs against the
 * embedding of their source keyFrame:
 *
 * | scale / canvas | v2 self-consistency | v1 vs ground truth (mean, n=8) |
 * | --- | --- | --- |
 * | 2×/448 | 0.87–0.93 | 0.830 |
 * | 2.5×/512 | 0.88–0.97 | 0.828 (min 0.756) |
 * | 3×/640 | 0.88–0.96 | 0.822 |
 * | 4×/640 | 0.86–0.96 | 0.790 (min 0.512) |
 *
 * Mirror or edge-copy padding made duplicate faces (up to 9 detections) and
 * was dropped. 2.5× on 512 is kept: the best minimum at an equal mean. The
 * untouched v1 template scores 0.647 against the same ground truth.
 *
 * The face is chosen exactly as the photo re-enrol pass chooses one
 * (`choosePhotoFace`, by cosine to the old vector: floor 0.5, runner-up margin
 * 0.1, same model space), so a re-detection that latched onto the letterbox
 * edge or on nothing at all is refused and the old sample stays.
 */
import sharp from 'sharp'
import type { RealignVerdict } from './face-gallery-reset.js'
import { choosePhotoFace } from './face-photo-choice.js'
import type { PhotoFace } from './photo-enrollment.js'

/** Template upscale before the letterbox. See the table above. */
export const TEMPLATE_REALIGN_SCALE = 2.5
/** Letterbox canvas side, px. */
export const TEMPLATE_REALIGN_CANVAS_PX = 512
/** The aligned template side every face embedder takes. */
const TEMPLATE_SIDE_PX = 112

/** Upscale the template and centre it on a black square canvas. */
export async function letterboxFaceTemplate(templateJpeg: Buffer): Promise<Buffer> {
  const side = Math.round(TEMPLATE_SIDE_PX * TEMPLATE_REALIGN_SCALE)
  const offset = Math.round((TEMPLATE_REALIGN_CANVAS_PX - side) / 2)
  const upscaled = await sharp(templateJpeg)
    .resize(side, side, { kernel: 'lanczos3', fit: 'fill' })
    .toBuffer()
  return sharp({
    create: {
      width: TEMPLATE_REALIGN_CANVAS_PX,
      height: TEMPLATE_REALIGN_CANVAS_PX,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .composite([{ input: upscaled, left: offset, top: offset }])
    .jpeg({ quality: 95 })
    .toBuffer()
}

/** What the analyze path found on a letterboxed template → the reset's verdict. Pure. */
export function realignVerdictFrom(
  faces: readonly PhotoFace[],
  oldVector: readonly number[],
  modelId: string,
): RealignVerdict {
  const choice = choosePhotoFace({ faces, oldVector, modelId })
  if (choice.kind === 'refused') {
    return { kind: 'refused', reason: `${choice.reason}: ${choice.detail}` }
  }
  const { face } = choice
  if (
    face.embedding === undefined ||
    face.modelId === undefined ||
    face.alignedCropBase64 === undefined
  ) {
    return { kind: 'refused', reason: 'no-enrollable-face: the chosen face lost its vector' }
  }
  return {
    kind: 'realigned',
    embedding: face.embedding,
    modelId: face.modelId,
    templateJpeg: Buffer.from(face.alignedCropBase64, 'base64'),
    cosineToOld: choice.cosine,
    score: face.score,
  }
}
