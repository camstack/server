/**
 * Re-embedding the enrolled face gallery into a new model's space.
 *
 * Two things make this pass different from the CLIP rebuild, and both are
 * failures this repo has already paid for:
 *
 *  1. **The stored pixels are an ALREADY-ALIGNED 112×112 template**, not a
 *     source frame (`face-recognizer.ts` re-owns `faceAlignedCrop` as the
 *     sample's media). Re-running detection + alignment over it passes every
 *     gate and applies a SECOND warp to templated pixels — a plausible,
 *     useless vector with nothing on screen to say so (session 2026-08-20 §3).
 *     So the pass sends the template as the whole frame with a full-image box,
 *     which the crop derivation returns unchanged. That identity is asserted
 *     here against the real `deriveDetailCropRect`, because if it ever stops
 *     holding the vectors are silently wrong.
 *
 *  2. **Most samples have no pixels at all** (28 of 32 on 2026-08-20). The pass
 *     must SKIP and COUNT them, never wait for them and never fail because of
 *     them.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DETAIL_CROP_CONVENTION,
  deriveDetailCropRect,
  FULL_IMAGE_BBOX,
} from '@camstack/types'
import {
  type FaceReembedDeps,
  type FaceReembedSample,
  reembedFaceGallery,
} from '../face-reembed-pass.js'

const silent = {
  info: () => undefined,
  warn: () => undefined,
}

function sample(over: Partial<FaceReembedSample> = {}): FaceReembedSample {
  return {
    sampleId: 's1',
    identityId: 'i1',
    identityName: 'Alice',
    modelId: 'arcface-r100',
    dim: 512,
    mediaId: 1,
    ...over,
  }
}

interface Harness {
  readonly deps: FaceReembedDeps
  readonly stored: Array<{ sampleId: string; modelId: string; embedding: readonly number[] }>
  readonly embedCalls: string[]
}

function harness(
  samples: readonly FaceReembedSample[],
  over: Partial<FaceReembedDeps> = {},
): Harness {
  const stored: Harness['stored'] = []
  const embedCalls: string[] = []
  const deps: FaceReembedDeps = {
    listSamples: async () => samples,
    loadAlignedCrop: async (s) => (s.mediaId ? Buffer.from(`px:${s.sampleId}`) : null),
    embed: async (s) => {
      embedCalls.push(s.sampleId)
      return { kind: 'embedded', embedding: [0.1, 0.2], dim: 2 }
    },
    store: async (s, embedding, modelId) => {
      stored.push({ sampleId: s.sampleId, modelId, embedding })
      return { landed: true }
    },
    pause: async () => undefined,
    logger: silent,
    ...over,
  }
  return { deps, stored, embedCalls }
}

describe('the aligned-template convention', () => {
  it('a full-image box over a square template survives the crop derivation UNCHANGED', () => {
    // This is what makes `face-embedding` alone a correct re-embed: the runner
    // still derives a rectangle, and for a full-image box on a square image the
    // derivation is the identity — under BOTH conventions, so an operator's
    // crop-margin setting cannot silently re-cut an already-aligned template.
    for (const convention of [
      DEFAULT_DETAIL_CROP_CONVENTION,
      { paddingRatio: 0.5, square: true },
      { paddingRatio: 0, square: false },
    ]) {
      const rect = deriveDetailCropRect({ x: 0, y: 0, w: 112, h: 112 }, 112, 112, convention)
      expect(rect).toEqual({ x: 0, y: 0, w: 112, h: 112 })
    }
  })

  it('FULL_IMAGE_BBOX is the normalised whole frame', () => {
    expect(FULL_IMAGE_BBOX).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })
})

describe('reembedFaceGallery', () => {
  it('is a declared NO-OP when every sample is already in the target space', async () => {
    const h = harness([sample({ modelId: 'auraface-r100' })])
    const out = await reembedFaceGallery(h.deps, { targetModelId: 'auraface-r100' })
    expect(out).toMatchObject({ total: 1, alreadyInSpace: 1, reembedded: 0, remaining: 0 })
    expect(h.embedCalls).toEqual([])
    expect(out.complete).toBe(true)
  })

  it('re-embeds the samples that are NOT in the target space, and stamps the new model', async () => {
    const h = harness([
      sample({ sampleId: 'a' }),
      sample({ sampleId: 'b', modelId: 'auraface-r100' }),
    ])
    const out = await reembedFaceGallery(h.deps, { targetModelId: 'auraface-r100' })
    expect(h.embedCalls).toEqual(['a'])
    expect(h.stored).toEqual([{ sampleId: 'a', modelId: 'auraface-r100', embedding: [0.1, 0.2] }])
    expect(out).toMatchObject({ total: 2, alreadyInSpace: 1, reembedded: 1, remaining: 0 })
  })

  it('SKIPS a sample whose pixels are gone, counts it, and does not stop the pass', async () => {
    // The live condition on 2026-08-20: 28 of 32 samples have a mediaId whose
    // blob no longer exists. A pass that treated that as a failure would report
    // a broken gallery; a pass that stopped would never reach the 4 good ones.
    const h = harness([
      sample({ sampleId: 'gone', mediaId: undefined }),
      sample({ sampleId: 'ok' }),
    ])
    const out = await reembedFaceGallery(h.deps, { targetModelId: 'auraface-r100' })
    expect(out).toMatchObject({ total: 2, noPixels: 1, reembedded: 1 })
    expect(h.embedCalls).toEqual(['ok'])
    // …and the pass is COMPLETE. A pixel-less sample stays in `remaining`
    // forever; letting it hold `complete` back would make a healthy pass look
    // permanently stuck and hide a real budget stop behind it.
    expect(out).toMatchObject({ remaining: 1, complete: true })
  })

  it('a FAILED sample does hold `complete` back — unlike a pixel-less one, it is retryable', async () => {
    const h = harness([sample()], { store: async () => ({ landed: false }) })
    const out = await reembedFaceGallery(h.deps, { targetModelId: 'auraface-r100' })
    expect(out).toMatchObject({ failed: 1, complete: false })
  })

  it('counts a mediaId that resolves to NOTHING exactly like an absent one', async () => {
    const h = harness([sample({ sampleId: 'dangling' })], {
      loadAlignedCrop: async () => null,
    })
    const out = await reembedFaceGallery(h.deps, { targetModelId: 'auraface-r100' })
    expect(out).toMatchObject({ noPixels: 1, reembedded: 0 })
  })

  it('gates on whether the row LANDED, never on the embed returning (D58)', async () => {
    // A store that logs and returns normally used to count as success: a live
    // CLIP pass once reported 704 rebuilt against an index holding 0.
    const h = harness([sample()], { store: async () => ({ landed: false, reason: 'disk full' }) })
    const out = await reembedFaceGallery(h.deps, { targetModelId: 'auraface-r100' })
    expect(out).toMatchObject({ reembedded: 0, failed: 1 })
  })

  it('is BOUNDED and RESUMABLE — a budget stop reports what is left, and complete is false', async () => {
    const h = harness([
      sample({ sampleId: 'a' }),
      sample({ sampleId: 'b' }),
      sample({ sampleId: 'c' }),
    ])
    const out = await reembedFaceGallery(h.deps, { targetModelId: 'auraface-r100', maxSamples: 2 })
    expect(h.embedCalls).toEqual(['a', 'b'])
    expect(out).toMatchObject({ reembedded: 2, remaining: 1, complete: false })
  })

  it('SAYS when the per-pass budget stops it, with what is left for the next pass (D651)', async () => {
    const infos: Array<{ message: string; meta?: Record<string, unknown> }> = []
    const h = harness(
      [sample({ sampleId: 'a' }), sample({ sampleId: 'b' }), sample({ sampleId: 'c' })],
      {
        logger: {
          info: (message, extras) =>
            infos.push({ message, ...(extras?.meta ? { meta: extras.meta } : {}) }),
          warn: () => undefined,
        },
      },
    )
    await reembedFaceGallery(h.deps, { targetModelId: 'auraface-r100', maxSamples: 2 })
    const hit = infos.find((l) => /budget/i.test(l.message))
    expect(hit?.meta).toMatchObject({ maxSamples: 2, reembedded: 2, remaining: 1 })
  })

  it('stays quiet about the budget when the pass finished inside it', async () => {
    const infos: string[] = []
    const h = harness([sample({ sampleId: 'a' })], {
      logger: { info: (message) => infos.push(message), warn: () => undefined },
    })
    await reembedFaceGallery(h.deps, { targetModelId: 'auraface-r100', maxSamples: 2 })
    expect(infos.some((m) => /budget/i.test(m))).toBe(false)
  })

  it('ABANDONS the pass when the cluster cannot serve the model — not once per sample', async () => {
    // Same rule as the CLIP pass: "nowhere can run this" is a verdict about the
    // PASS. Re-discovering it per sample means one media read per sample for
    // nothing, which is what saturated hub-main for 43 minutes on 2026-08-06.
    let calls = 0
    const h = harness([sample({ sampleId: 'a' }), sample({ sampleId: 'b' })], {
      embed: async () => {
        calls += 1
        return { kind: 'no-capable-node', reason: 'no node serves auraface-r100' }
      },
    })
    const out = await reembedFaceGallery(h.deps, { targetModelId: 'auraface-r100' })
    expect(calls).toBe(1)
    expect(out).toMatchObject({ noCapableNode: 1, complete: false, remaining: 2 })
  })

  it('never lets one sample throw take the pass down', async () => {
    let n = 0
    const h = harness([sample({ sampleId: 'a' }), sample({ sampleId: 'b' })], {
      embed: async (s) => {
        n += 1
        if (s.sampleId === 'a') throw new Error('pool died')
        return { kind: 'embedded', embedding: [1], dim: 1 }
      },
    })
    const out = await reembedFaceGallery(h.deps, { targetModelId: 'auraface-r100' })
    expect(n).toBe(2)
    expect(out).toMatchObject({ failed: 1, reembedded: 1 })
  })

  it('REFUSES to run against a blank model id rather than stamping vectors nothing ran', async () => {
    const h = harness([sample()])
    const out = await reembedFaceGallery(h.deps, { targetModelId: '' })
    expect(out).toMatchObject({ refused: 'no target model', total: 0, complete: false })
    expect(h.embedCalls).toEqual([])
  })
})

describe('faceReembedProgress — the operator-facing "N of M"', () => {
  it('reports how much of the gallery is in the CURRENT space, per identity', async () => {
    const { faceReembedProgress } = await import('../face-reembed-pass.js')
    const progress = faceReembedProgress(
      [
        sample({
          sampleId: 'a',
          identityId: 'i1',
          identityName: 'Alice',
          modelId: 'auraface-r100',
        }),
        sample({ sampleId: 'b', identityId: 'i1', identityName: 'Alice' }),
        sample({ sampleId: 'c', identityId: 'i2', identityName: 'Carol' }),
        sample({ sampleId: 'd', identityId: 'i2', identityName: 'Carol', mediaId: undefined }),
      ],
      'auraface-r100',
    )
    expect(progress).toMatchObject({
      modelId: 'auraface-r100',
      inSpace: 1,
      total: 4,
      // The number that decides whether a flip is safe: how many samples could
      // NEVER be re-embedded, because their pixels are gone.
      unrecoverable: 1,
    })
    expect(progress.byIdentity).toEqual([
      { identityId: 'i1', name: 'Alice', inSpace: 1, total: 2, unrecoverable: 0 },
      { identityId: 'i2', name: 'Carol', inSpace: 0, total: 2, unrecoverable: 1 },
    ])
  })

  it('is what answers "is the flip safe" — an identity with 0 in the new space is stranded', async () => {
    const { faceReembedProgress } = await import('../face-reembed-pass.js')
    // Carol had 64 recognitions on 2026-08-20 and would have had ZERO auraface
    // samples. This is the number that has to be looked at before a flip.
    const p = faceReembedProgress(
      [sample({ identityId: 'i2', identityName: 'Carol' })],
      'auraface-r100',
    )
    expect(p.byIdentity[0]?.inSpace).toBe(0)
  })
})
