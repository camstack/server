import { describe, it, expect } from 'vitest'
import { clusterByEmbedding } from '../pipeline/face-clustering.js'

/** Two tight groups (A near [1,0], B near [0,1]) + one singleton outlier. */
const A1 = { id: 'a1', embedding: [1, 0, 0] }
const A2 = { id: 'a2', embedding: [0.98, 0.2, 0] }
const A3 = { id: 'a3', embedding: [0.95, 0.31, 0] }
const B1 = { id: 'b1', embedding: [0, 1, 0] }
const B2 = { id: 'b2', embedding: [0.1, 0.99, 0] }
const OUT = { id: 'x', embedding: [0, 0, 1] }

describe('clusterByEmbedding', () => {
  it('groups look-alikes and isolates outliers', () => {
    const clusters = clusterByEmbedding([A1, A2, A3, B1, B2, OUT], 0.7)
    // 3 clusters: A (3), B (2), outlier (1) — sorted largest-first.
    expect(clusters).toHaveLength(3)
    expect(clusters[0]!.size).toBe(3)
    expect(new Set(clusters[0]!.faceIds)).toEqual(new Set(['a1', 'a2', 'a3']))
    expect(clusters[1]!.size).toBe(2)
    expect(new Set(clusters[1]!.faceIds)).toEqual(new Set(['b1', 'b2']))
    expect(clusters[2]!.size).toBe(1)
    // Representative is the cluster's seed (first member encountered).
    expect(clusters[0]!.representativeFaceId).toBe('a1')
    // Cohesion is a 0..1 average cosine to the representative.
    expect(clusters[0]!.cohesion).toBeGreaterThan(0.7)
    expect(clusters[0]!.cohesion).toBeLessThanOrEqual(1)
  })

  it('a high threshold splits everything into singletons', () => {
    const clusters = clusterByEmbedding([A1, A2, B1], 0.999)
    expect(clusters.every((c) => c.size === 1)).toBe(true)
    expect(clusters).toHaveLength(3)
  })

  it('skips empty embeddings and ignores mismatched dimensions', () => {
    const clusters = clusterByEmbedding(
      [{ id: 'e', embedding: [] }, A1, { id: 'd', embedding: [1, 0] }],
      0.7,
    )
    // Empty dropped; [1,0,0] and [1,0] never compared (dim mismatch) → 2 singletons.
    expect(clusters.map((c) => c.size).toSorted()).toEqual([1, 1])
  })
})
