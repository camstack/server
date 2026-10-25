/**
 * The embedding's model id must SURVIVE the detail-plane wire boundary.
 *
 * `ObjectDetection.embeddingModelId` exists and is populated by the result
 * assembler (`result-assembler.ts`, `case 'embedding'`), and its own doc says
 * what it is for: "lets consumers skip samples from a stale model". But
 * `toDetailResult` did not copy it, so every face that reached post-analysis
 * over the two-plane detail path arrived ANONYMOUS.
 *
 * What that costs is not "a missing field". `FaceRecognizer` has to name the
 * probe's model to use `face-matcher`'s same-model gate, and with nothing on
 * the wire it used the GALLERY's own id (`this.gallery[0].modelId`). The gate
 * is `sample.modelId !== probe.modelId` — so the probe's id was copied from
 * the very thing it was about to be compared against, and the guard could
 * never fire. A tautology, exactly like the `assignUniquePerFrame` margin that
 * was dead where it mattered (2026-08-18).
 *
 * The consequence is the one that blocks the AuraFace cutover: pointing
 * `face-embedding` at a different model does NOT strand the enrolled gallery
 * (the outcome the catalog comment and `face-model-provenance.spec.ts` both
 * predict) — it silently compares AuraFace vectors against ArcFace samples in
 * one cosine space. Stranding is loud and reversible; cross-space matching is
 * neither.
 */
import { describe, expect, it } from 'vitest'
import type { ObjectDetection } from '@camstack/types'
import { type CropSource, toDetailResult } from '../detail-subtree.js'

const CROP: Pick<CropSource, 'width' | 'height' | 'frameSpace'> = {
  width: 112,
  height: 112,
  frameSpace: { x: 0, y: 0, w: 112, h: 112 },
}

function faceDetection(extra: Partial<ObjectDetection>): ObjectDetection {
  return {
    id: 'det-1',
    kind: 'detail',
    macroClass: 'face',
    score: 0.9,
    labels: [],
    bbox: { x: 0, y: 0, width: 100, height: 100 },
    ...extra,
  } as ObjectDetection
}

describe('the detail plane carries the embedding model id', () => {
  it('copies `embeddingModelId` onto the DetailResult beside the embedding', () => {
    const detail = toDetailResult(
      faceDetection({ embedding: [1, 0, 0, 0], embeddingModelId: 'auraface-r100' }),
      'face-embedding',
      CROP,
    )

    expect(detail.embedding).toBeDefined()
    expect(detail.embeddingModelId).toBe('auraface-r100')
  })

  it('omits it when the step produced no embedding — never invents an id', () => {
    const detail = toDetailResult(faceDetection({}), 'face-detection', CROP)

    expect(detail.embedding).toBeUndefined()
    expect(detail.embeddingModelId).toBeUndefined()
  })

  /**
   * A geometry-only face-detection pass carries no embedding, so it must carry
   * no model id either: an id without a vector would let a consumer believe a
   * probe was measured in a feature space that never ran.
   */
  it('does not leak the id when a detection has a model id but no vector', () => {
    const detail = toDetailResult(
      faceDetection({ embeddingModelId: 'arcface-r100' }),
      'face-detection',
      CROP,
    )

    expect(detail.embeddingModelId).toBeUndefined()
  })
})
