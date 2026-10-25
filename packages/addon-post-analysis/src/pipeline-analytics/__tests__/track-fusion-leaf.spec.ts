/**
 * Spec §6.1 invariant 4: every leaf the delete cascade knows, the fusion
 * re-points — one registry, typed so a deletable-but-not-fusible store does
 * not compile, and built from the same stores in the same order.
 *
 * Disarm: make `buildAnalyticsFusionRegistry` skip `plateStore` — "the fusion
 * registry is the cascade registry" fails.
 */
import { describe, expect, it } from 'vitest'
import {
  buildAnalyticsCascadeRegistry,
  buildAnalyticsFusionRegistry,
} from '../pipeline/delete-track-cascade.js'
import {
  fuseTrackLeaves,
  type TrackFusionRequest,
  type TrackLeafStore,
} from '../pipeline/track-fusion-leaf.js'

type Family = 'events' | 'media' | 'faces' | 'plates' | 'embeddings'

function leaf(family: Family, calls: string[], fail = false): TrackLeafStore {
  return {
    deleteByTracks: async () => [],
    reassignTrack: async (req) => {
      calls.push(`${family}:${req.absorbedId}->${req.survivorId}`)
      if (fail) throw new Error('boom')
      return [{ family, moved: 1, dropped: 0 }]
    },
  }
}

const req = (): TrackFusionRequest => ({
  deviceId: 101,
  survivorId: 'A',
  absorbedId: 'B',
  bestShotFrom: 'absorbed',
  media: { moveOwner: async () => 0, deleteOwner: async () => 0, stillPresent: async () => true },
})

describe('track leaf registry', () => {
  it('the fusion registry is the cascade registry', () => {
    const calls: string[] = []
    const stores = {
      eventStore: leaf('events', calls),
      mediaStore: leaf('media', calls),
      faceStore: leaf('faces', calls),
      plateStore: leaf('plates', calls),
      objectEmbeddingStore: leaf('embeddings', calls),
    }
    const fusion = buildAnalyticsFusionRegistry(stores)
    expect(fusion).toEqual(buildAnalyticsCascadeRegistry(stores))
    expect(fusion).toHaveLength(5)
  })

  it('runs every leaf, and one failure neither stops the others nor goes unreported', async () => {
    const calls: string[] = []
    const report = await fuseTrackLeaves(
      [leaf('events', calls), leaf('media', calls, true), leaf('faces', calls)],
      req(),
    )
    expect(calls).toEqual(['events:B->A', 'media:B->A', 'faces:B->A'])
    expect(report.counts.map((c) => c.family)).toEqual(['events', 'faces'])
    expect(report.failures).toEqual([{ index: 1, error: 'Error: boom' }])
  })
})
