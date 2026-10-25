/**
 * The matching gallery is held once as Float32Array and scored against without
 * a per-probe copy (D867): ~3200 samples x 2 KB = 6.5 MB of garbage per probe
 * used to be allocated by `new Float32Array(s.embedding)` inside the loop.
 *
 * Two contracts: the gallery's own vector reaches the scorer BY IDENTITY, and
 * the scores are bit-identical to what the number[] gallery produced.
 */
import { cosineSimilarity } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assignUniquePerFrame,
  enrollmentPromiscuity,
  type GallerySample,
  matchEmbedding,
  rankIdentities,
} from '../pipeline/face-matcher.js'

vi.mock('@camstack/types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@camstack/types')>()
  return { ...actual, cosineSimilarity: vi.fn(actual.cosineSimilarity) }
})

const DIM = 512
const MODEL = 'arcface-r100'

/** Deterministic float32-representable pseudo-random vector (LCG). */
function vec(seed: number): number[] {
  let s = seed >>> 0
  const out: number[] = []
  for (let i = 0; i < DIM; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    out.push(Math.fround(s / 4294967296 - 0.5))
  }
  return out
}

function galleryOf(
  kind: 'f32' | 'array',
  identities: number,
  perIdentity: number,
): GallerySample[] {
  const out: GallerySample[] = []
  for (let i = 0; i < identities; i++) {
    for (let j = 0; j < perIdentity; j++) {
      const v = vec(i * 1000 + j)
      out.push({
        identityId: `id-${i}`,
        embedding: kind === 'f32' ? new Float32Array(v) : v,
        modelId: MODEL,
      })
    }
  }
  return out
}

const mockedCosine = vi.mocked(cosineSimilarity)

describe('face matcher — Float32Array gallery (D867)', () => {
  beforeEach(() => {
    mockedCosine.mockClear()
  })

  it('rankIdentities scores against the gallery vector itself, not a copy', () => {
    const gallery = galleryOf('f32', 4, 3)
    rankIdentities({ embedding: vec(1), modelId: MODEL }, gallery, 1)
    expect(mockedCosine).toHaveBeenCalledTimes(gallery.length)
    const seen = new Set(mockedCosine.mock.calls.map((c) => c[1]))
    for (const s of gallery) {
      expect(s.embedding instanceof Float32Array && seen.has(s.embedding)).toBe(true)
    }
  })

  it('assignUniquePerFrame and enrollmentPromiscuity score against it by identity too', () => {
    const gallery = galleryOf('f32', 3, 2)
    assignUniquePerFrame([{ trackId: 't', embedding: vec(2), modelId: MODEL }], gallery, {
      threshold: 0.1,
      margin: 0.01,
    })
    enrollmentPromiscuity(vec(3), MODEL, 'someone-else', gallery)
    const seen = new Set(mockedCosine.mock.calls.map((c) => c[1]))
    for (const s of gallery) {
      expect(s.embedding instanceof Float32Array && seen.has(s.embedding)).toBe(true)
    }
  })

  it('scores are BIT-identical to the number[] gallery', () => {
    const probe = { embedding: vec(77), modelId: MODEL }
    const asArray = rankIdentities(probe, galleryOf('array', 6, 4), 1)
    const asF32 = rankIdentities(probe, galleryOf('f32', 6, 4), 1)
    expect(asF32).toEqual(asArray)
    for (let i = 0; i < asArray.length; i++) {
      expect(Object.is(asF32[i]!.score, asArray[i]!.score)).toBe(true)
    }
  })

  it('matchEmbedding decides the same on both representations', () => {
    const arr = galleryOf('array', 5, 3)
    const f32 = galleryOf('f32', 5, 3)
    const probe = { embedding: vec(2 * 1000 + 1), modelId: MODEL }
    const opts = { threshold: 0.3, margin: 0.02 }
    expect(matchEmbedding(probe, f32, opts)).toEqual(matchEmbedding(probe, arr, opts))
    expect(matchEmbedding(probe, f32, opts)?.identityId).toBe('id-2')
  })
})
