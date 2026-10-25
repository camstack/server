/**
 * Which face in a photograph an OLD photo sample was (D643). Pure.
 *
 * A photograph can hold several people (three of the live nine are family
 * photos shared by several identities), so the photo re-enrol pass must pick
 * the face the old sample WAS: by IoU with the stored face box when the row
 * has one, otherwise by the highest cosine to the old vector. Either way the
 * pick must clear a cosine floor, and a pick another face could equally be is
 * REFUSED — including a face analysis refused to enrol: a non-enrollable face
 * sitting on the old box, or closer to the old vector, may be the real one,
 * and choosing the enrollable stranger beside it would enrol a stranger under
 * a name. Measured on the live nine: IoU 0.53–0.83, new-vs-stored cosine
 * 0.63–0.86, unambiguous 9/9.
 */
import { cosineSimilarity } from '@camstack/types'
import type { PhotoBbox, PhotoFace } from './photo-enrollment.js'
import { iou, type PixelBox } from './pipeline/event-child-crops.js'

/** A new face must resemble the old vector at least this much (measured min 0.634). */
export const PHOTO_REENROL_COSINE_FLOOR = 0.5
/** A face overlapping the old box less than this is not the same face. */
export const PHOTO_REENROL_MIN_IOU = 0.3
/** Two faces whose cosines to the old vector are this close cannot be told apart. */
export const PHOTO_REENROL_AMBIGUITY_MARGIN = 0.1

/** Why a photo sample was not re-enrolled. Each is logged by name. */
export type PhotoReenrolRefusal =
  | 'no-source'
  | 'no-old-vector'
  | 'no-enrollable-face'
  | 'model-mismatch'
  | 'no-iou-match'
  | 'ambiguous'
  | 'below-floor'
  | 'promiscuous'

export interface PhotoFaceChosen {
  readonly kind: 'chosen'
  readonly face: PhotoFace
  readonly by: 'iou' | 'cosine'
  readonly cosine: number
  readonly iou?: number
}

export interface PhotoFaceRefused {
  readonly kind: 'refused'
  readonly reason: PhotoReenrolRefusal
  readonly detail: string
}

export type PhotoFaceChoice = PhotoFaceChosen | PhotoFaceRefused

export interface PhotoFaceChoiceInput {
  readonly faces: readonly PhotoFace[]
  readonly oldBox?: PhotoBbox
  readonly oldVector: readonly number[]
  /** The model space of the OLD sample; a face from another space is not comparable. */
  readonly modelId: string
}

/** A face with a vector comparable to the old one — enrollable or not. */
interface ComparableFace {
  readonly face: PhotoFace
  readonly cosine: number
}

function toPixelBox(b: PhotoBbox): PixelBox {
  return { x: b.x, y: b.y, w: b.width, h: b.height }
}

function refused(reason: PhotoReenrolRefusal, detail: string): PhotoFaceRefused {
  return { kind: 'refused', reason, detail }
}

function isEnrollableIn(face: PhotoFace, modelId: string): boolean {
  return (
    face.enrollable &&
    face.embedding !== undefined &&
    face.modelId === modelId &&
    face.alignedCropBase64 !== undefined
  )
}

/** Every face whose vector lives in the old sample's space, scored against it. */
function comparableFaces(input: PhotoFaceChoiceInput): readonly ComparableFace[] {
  const probe = new Float32Array(input.oldVector)
  const out: ComparableFace[] = []
  for (const face of input.faces) {
    const embedding = face.embedding
    if (embedding === undefined || face.modelId !== input.modelId) continue
    if (embedding.length !== input.oldVector.length) continue
    out.push({ face, cosine: cosineSimilarity(probe, new Float32Array(embedding)) })
  }
  return out
}

/** Refuse before choosing when nothing in the photo can become the sample. */
function precondition(input: PhotoFaceChoiceInput): PhotoFaceRefused | null {
  const enrollable = input.faces.filter((f) => f.enrollable && f.embedding !== undefined)
  if (enrollable.length === 0) {
    return refused(
      'no-enrollable-face',
      `${input.faces.length} face(s) found, none enrollable (${input.faces
        .map((f) => f.refusedReason ?? 'unknown')
        .join(', ')})`,
    )
  }
  if (!enrollable.some((f) => isEnrollableIn(f, input.modelId))) {
    return refused(
      'model-mismatch',
      `faces were embedded by ${[...new Set(enrollable.map((f) => f.modelId))].join(', ')}, the old sample by ${input.modelId} — re-embed the gallery first`,
    )
  }
  return null
}

function chooseByIou(
  input: PhotoFaceChoiceInput,
  oldBox: PhotoBbox,
  scored: readonly ComparableFace[],
): PhotoFaceChoice {
  const box = toPixelBox(oldBox)
  // EVERY face competes for the box, enrollable or not.
  const overlapping = input.faces
    .map((face) => ({ face, iou: iou(box, toPixelBox(face.bbox)) }))
    .filter((c) => c.iou >= PHOTO_REENROL_MIN_IOU)
  if (overlapping.length === 0) {
    return refused('no-iou-match', `no face overlaps the old box at IoU ≥ ${PHOTO_REENROL_MIN_IOU}`)
  }
  if (overlapping.length > 1) {
    return refused(
      'ambiguous',
      `${overlapping.length} faces overlap the old box (IoU ${overlapping.map((c) => c.iou.toFixed(2)).join(', ')})`,
    )
  }
  const [only] = overlapping
  if (only === undefined) return refused('no-iou-match', 'no overlapping face')
  if (!isEnrollableIn(only.face, input.modelId)) {
    return refused(
      'no-enrollable-face',
      `the face on the old box is not enrollable (${only.face.refusedReason ?? `model ${only.face.modelId ?? 'none'}`})`,
    )
  }
  const cosine = scored.find((s) => s.face === only.face)?.cosine
  if (cosine === undefined || cosine < PHOTO_REENROL_COSINE_FLOOR) {
    return refused(
      'below-floor',
      `the overlapping face scores cosine ${cosine?.toFixed(3) ?? 'n/a'} < ${PHOTO_REENROL_COSINE_FLOOR}`,
    )
  }
  return { kind: 'chosen', face: only.face, by: 'iou', cosine, iou: only.iou }
}

function chooseByCosine(
  input: PhotoFaceChoiceInput,
  scored: readonly ComparableFace[],
): PhotoFaceChoice {
  // Ranked over EVERY comparable face, enrollable or not.
  const ranked = [...scored].toSorted((a, b) => b.cosine - a.cosine)
  const [best, runnerUp] = ranked
  if (best === undefined) return refused('model-mismatch', 'no face has a comparable vector')
  if (best.cosine < PHOTO_REENROL_COSINE_FLOOR) {
    return refused(
      'below-floor',
      `best cosine ${best.cosine.toFixed(3)} < ${PHOTO_REENROL_COSINE_FLOOR}`,
    )
  }
  if (
    runnerUp !== undefined &&
    runnerUp.cosine >= PHOTO_REENROL_COSINE_FLOOR &&
    best.cosine - runnerUp.cosine < PHOTO_REENROL_AMBIGUITY_MARGIN
  ) {
    return refused(
      'ambiguous',
      `two faces clear the floor within ${PHOTO_REENROL_AMBIGUITY_MARGIN}: ${best.cosine.toFixed(3)} vs ${runnerUp.cosine.toFixed(3)}`,
    )
  }
  if (!isEnrollableIn(best.face, input.modelId)) {
    return refused(
      'ambiguous',
      `the closest face (cosine ${best.cosine.toFixed(3)}) is not enrollable (${best.face.refusedReason ?? 'unknown'}) — the enrollable ones may be someone else`,
    )
  }
  return { kind: 'chosen', face: best.face, by: 'cosine', cosine: best.cosine }
}

/**
 * Pick the face the old sample was. IoU first (when the row recorded a box),
 * cosine otherwise; the cosine floor applies to both.
 */
export function choosePhotoFace(input: PhotoFaceChoiceInput): PhotoFaceChoice {
  const blocked = precondition(input)
  if (blocked !== null) return blocked
  const scored = comparableFaces(input)
  return input.oldBox !== undefined
    ? chooseByIou(input, input.oldBox, scored)
    : chooseByCosine(input, scored)
}
