/**
 * A face probe must be matched in the feature space it was MEASURED in.
 *
 * `face-matcher` has always had the guard — `sample.modelId !== probe.modelId`
 * skips the sample — but `ingestFaceDetail` had nothing to fill `probe.modelId`
 * with, because `DetailResult` did not carry the embedding's model. So it used
 * `this.gallery[0].modelId`: the probe's id was copied FROM the collection it
 * was about to be compared against, and the guard could not fire. A tautology,
 * the same shape as the `assignUniquePerFrame` margin that was dead exactly
 * where it mattered (2026-08-18).
 *
 * Why this is the precondition for changing the face model at all: the catalog
 * comment and `face-model-provenance.spec.ts` both assert that flipping
 * `face-embedding`'s `defaultModelId` "strands every enrolled face". With the
 * gate dead that was FALSE, and false in the dangerous direction — the new
 * model's vectors would have been scored against the old model's samples in
 * one cosine space, with nothing in the data to say so. Stranding is loud and
 * reversible. Cross-space matching is neither.
 *
 * The fallback is deliberate and must stay: a runner that predates
 * `embeddingModelId` degrades to the OLD assumption, never to a refusal.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FaceRecognizer } from '../face-recognizer.js'
import { FACE_DEFAULTS } from '../face-settings.js'
import type { GallerySample } from '../pipeline/face-matcher.js'
import type { LabelCandidate } from '../pipeline/label-tier.js'

const ARCFACE_GALLERY: readonly GallerySample[] = [
  { identityId: 'id-alice', embedding: [1, 0, 0, 0], modelId: 'arcface-r100' },
  { identityId: 'id-alice', embedding: [1, 0, 0, 0], modelId: 'arcface-r100' },
]

function deps(gallery: readonly GallerySample[]) {
  return {
    identityStore: {
      loadGallery: vi.fn(async () => gallery),
      listIdentities: vi.fn(async () => [{ id: 'id-alice', name: 'Alice' }]),
    },
    faceStore: { insert: vi.fn(async () => {}) },
    mediaStore: { put: vi.fn(async () => 'k') },
    trackStore: {
      applyLabelCandidate: vi.fn(async (_t: string, c: LabelCandidate) => ({
        kind: 'write' as const,
        tier: 2 as const,
        patch: { subLabel: c.text, subLabelScore: c.score },
      })),
    },
    eventStore: { projectTrackLabel: vi.fn(async () => 0) },
    captureCrop: vi.fn(async () => Buffer.from('jpg')),
    logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
  }
}

const SETTINGS = {
  ...FACE_DEFAULTS,
  enabled: true,
  confirmFrames: 1,
  minFacePx: 0,
  recognitionMinFacePx: 0,
  minIdentitySamples: 1,
}

function detail(embeddingModelId: string | undefined) {
  return {
    deviceId: 107,
    trackId: 'track-1',
    timestamp: 1_000,
    frameWidth: 640,
    frameHeight: 480,
    score: 0.9,
    // Byte-identical to the gallery sample: if the model gate is bypassed this
    // scores cosine 1.0 and MUST be recognised, so a "no match" can only come
    // from the gate itself and never from a weak vector.
    embedding: [1, 0, 0, 0],
    parentBbox: { x: 0, y: 0, w: 100, h: 100 },
    faceBbox: { x: 10, y: 10, w: 50, h: 50 },
    settings: SETTINGS,
    cropPadding: 0,
    ...(embeddingModelId !== undefined ? { embeddingModelId } : {}),
  }
}

describe('the probe is matched in the space it was measured in', () => {
  let d: ReturnType<typeof deps>
  let rec: FaceRecognizer

  beforeEach(() => {
    d = deps(ARCFACE_GALLERY)
    rec = new FaceRecognizer(d as never)
  })

  it('recognises a probe whose model matches the gallery', async () => {
    await rec.refreshGallery()
    await rec.ingestFaceDetail(detail('arcface-r100') as never)
    await rec.onTrackEnd(592, 'track-1')

    expect(d.trackStore.applyLabelCandidate).toHaveBeenCalled()
  })

  it('REFUSES a probe from another model, even at cosine 1.0 against the gallery', async () => {
    await rec.refreshGallery()
    await rec.ingestFaceDetail(detail('auraface-r100') as never)
    await rec.onTrackEnd(592, 'track-1')

    expect(d.trackStore.applyLabelCandidate).not.toHaveBeenCalled()
  })

  /**
   * The drop must be AUDIBLE. A gallery that speaks a different language than
   * the pipeline is the exact failure an operator would otherwise diagnose as
   * "recognition just stopped", and this repo has paid for a silent
   * work-dropping branch more than once.
   */
  it('says so when the probe finds no sample in its own feature space', async () => {
    await rec.refreshGallery()
    await rec.ingestFaceDetail(detail('auraface-r100') as never)

    const said = [...d.logger.warn.mock.calls, ...d.logger.info.mock.calls].some(
      ([msg]) => typeof msg === 'string' && /model/i.test(msg),
    )
    expect(said).toBe(true)
  })

  it('falls back to the gallery id when an older runner sends no model id', async () => {
    await rec.refreshGallery()
    await rec.ingestFaceDetail(detail(undefined) as never)
    await rec.onTrackEnd(592, 'track-1')

    expect(d.trackStore.applyLabelCandidate).toHaveBeenCalled()
  })
})

/**
 * D651: the fallback above guesses the probe's model from `gallery[0]`. That
 * is a safe guess only while the gallery speaks ONE model. In the window of a
 * model switch it speaks two, and the guess can name the model that did NOT
 * produce the probe — a cross-space comparison, i.e. a possible wrong match.
 * A probe with no model of its own against a mixed gallery is not compared.
 */
describe('a probe that names no model meets a gallery mid-switch (D651)', () => {
  const MIXED_GALLERY: readonly GallerySample[] = [
    // Listed first on purpose: the old guess would pick this model.
    { identityId: 'id-alice', embedding: [1, 0, 0, 0], modelId: 'arcface-r100' },
    { identityId: 'id-alice', embedding: [1, 0, 0, 0], modelId: 'arcface-r100' },
    { identityId: 'id-alice', embedding: [0, 1, 0, 0], modelId: 'auraface-r100' },
  ]

  it('is not matched against either model, and the refusal is logged per camera', async () => {
    const d = deps(MIXED_GALLERY)
    const rec = new FaceRecognizer(d as never)
    await rec.refreshGallery()
    await rec.ingestFaceDetail(detail(undefined) as never)
    await rec.onTrackEnd(592, 'track-1')

    expect(d.trackStore.applyLabelCandidate).not.toHaveBeenCalled()
    const refusal = d.logger.warn.mock.calls.find(
      ([msg]) => typeof msg === 'string' && /names no model/i.test(msg),
    )
    expect(refusal).toBeDefined()
    expect(refusal?.[1]).toMatchObject({ tags: { deviceId: 107 } })
  })
})
