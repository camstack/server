import type { DetailResult } from '@camstack/types'
import { PHOTO_FACE_EMBEDDING_STEP_ID } from '../../pipeline-analytics/photo-enrollment.js'

/** Minimal {@link DetailResult} for face-embedding step stubs in wiring specs. */
export function testFaceEmbeddingDetail(embedding: string): DetailResult {
  return {
    stepId: PHOTO_FACE_EMBEDDING_STEP_ID,
    className: 'face',
    score: 1,
    embedding,
  }
}
