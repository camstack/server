/**
 * face-clustering — pure greedy clustering of face embeddings by cosine
 * similarity, used to SUGGEST groups of look-alike unassigned faces for batch
 * assignment. No I/O, no `any`. The embeddings never leave the server; only the
 * resulting faceId groupings are returned to the UI.
 */
import { cosineSimilarity } from '@camstack/types'

export interface ClusterItem {
  readonly id: string
  readonly embedding: readonly number[]
}

export interface FaceCluster {
  /** Member face ids, in insertion order (representative first). */
  readonly faceIds: readonly string[]
  /** The cluster's seed/representative face id. */
  readonly representativeFaceId: string
  readonly size: number
  /** Mean cosine of members to the representative (cluster tightness, 0..1). */
  readonly cohesion: number
}

interface Bucket {
  readonly repId: string
  readonly repVec: Float32Array
  readonly ids: string[]
  scoreSum: number
}

/**
 * Greedily cluster items by cosine similarity to each cluster's representative
 * (the first item that opened it). An item joins the BEST cluster whose
 * representative similarity ≥ `threshold`; otherwise it opens a new cluster.
 * Only same-length embeddings are compared (model-version safety).
 *
 * @param items     Faces with embeddings (assumed L2-normalized arcface vectors).
 * @param threshold Minimum cosine to join a cluster (default 0.5).
 * @returns Clusters sorted largest-first, ties broken by cohesion desc.
 */
export function clusterByEmbedding(items: readonly ClusterItem[], threshold = 0.5): FaceCluster[] {
  const buckets: Bucket[] = []

  for (const item of items) {
    if (item.embedding.length === 0) continue
    const vec = new Float32Array(item.embedding)

    let best: Bucket | null = null
    let bestScore = threshold // must meet/exceed to join
    for (const b of buckets) {
      if (b.repVec.length !== vec.length) continue
      const score = cosineSimilarity(vec, b.repVec)
      if (score >= bestScore) {
        bestScore = score
        best = b
      }
    }

    if (best) {
      best.ids.push(item.id)
      best.scoreSum += bestScore
    } else {
      buckets.push({ repId: item.id, repVec: vec, ids: [item.id], scoreSum: 1 })
    }
  }

  return buckets
    .map(
      (b): FaceCluster => ({
        faceIds: b.ids,
        representativeFaceId: b.repId,
        size: b.ids.length,
        // scoreSum includes the representative's self-similarity (1); average over members.
        cohesion: b.scoreSum / b.ids.length,
      }),
    )
    .toSorted((a, b) => b.size - a.size || b.cohesion - a.cohesion)
}
