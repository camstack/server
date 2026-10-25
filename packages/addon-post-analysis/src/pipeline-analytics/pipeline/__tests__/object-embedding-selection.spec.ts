import { describe, expect, it } from 'vitest'
import type { TrackedDetectionOut } from '../frame-processor.js'
import { isClipObjectEmbedding, resolveSearchThumbnailUrl } from '../object-embedding-selection.js'

function track(overrides: Partial<TrackedDetectionOut> = {}): TrackedDetectionOut {
  return {
    trackId: 't1',
    className: 'person',
    confidence: 0.9,
    bbox: { x: 0, y: 0, w: 10, h: 10 },
    zones: [],
    state: 'moving',
    matchedThisFrame: true,
    settling: false,
    confirmed: true,
    ...overrides,
  }
}

describe('isClipObjectEmbedding', () => {
  it('rejects a MobileCLIP embedding — the model left the catalog, so it has no CLIP metadata', () => {
    expect(
      isClipObjectEmbedding(track({ embedding: [1, 2], embeddingModelId: 'mobileclip-s1' })),
    ).toBe(false)
  })

  // D649: the filter was `startsWith('mobileclip-')`, and every SigLIP2 vector
  // was dropped before the store with no log line. A model is a CLIP model
  // because its catalog entry carries CLIP metadata, not because of its name.
  it('accepts a SigLIP2 embedding — any model with CLIP metadata', () => {
    expect(
      isClipObjectEmbedding(track({ embedding: [1, 2], embeddingModelId: 'siglip2-b16-224' })),
    ).toBe(true)
  })

  it('rejects an id with no CLIP metadata, whatever its name looks like (MobileCLIP included)', () => {
    expect(
      isClipObjectEmbedding(track({ embedding: [1, 2], embeddingModelId: 'mobileclip-s0' })),
    ).toBe(false)
  })

  it('rejects an arcface (face) embedding — handled by the FaceRecognizer', () => {
    expect(
      isClipObjectEmbedding(track({ embedding: [1, 2], embeddingModelId: 'arcface-r100' })),
    ).toBe(false)
  })

  it('rejects a track with no embedding', () => {
    expect(isClipObjectEmbedding(track())).toBe(false)
  })

  it('rejects an empty embedding', () => {
    expect(
      isClipObjectEmbedding(track({ embedding: [], embeddingModelId: 'siglip2-b16-224' })),
    ).toBe(false)
  })
})

describe('resolveSearchThumbnailUrl', () => {
  const baseUrl = '/addon/pipeline-analytics/event-media'

  it('points a hit at the embedding row crop (/m/<id>) when present', () => {
    const url = resolveSearchThumbnailUrl({
      baseUrl,
      eventId: '101314',
      deviceId: 101,
      recordAt: 1_727_800_000_000,
      embeddingMediaId: 7701,
    })
    // The embedding crop wins as a media-row address (D482), NOT the event id.
    expect(url).toBe(`${baseUrl}/m/7701`)
    expect(url).not.toContain('101314')
  })

  it('falls back to the generation-scoped object owner ladder (D694)', () => {
    const url = resolveSearchThumbnailUrl({
      baseUrl,
      eventId: '101314',
      deviceId: 101,
      recordAt: 1_727_800_000_000,
    })
    expect(url).toBe(`${baseUrl}/o/object/101314/g/101/1727800000000`)
  })

  it('returns undefined when the data-plane base URL is unavailable', () => {
    expect(
      resolveSearchThumbnailUrl({
        baseUrl: null,
        eventId: '101314',
        deviceId: 101,
        recordAt: 1,
        embeddingMediaId: 9,
      }),
    ).toBeUndefined()
  })
})
