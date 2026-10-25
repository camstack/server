/**
 * D649: which feature space a search reads, with which floor, and which one a
 * rebuild fills — from the model's metadata, before any text is encoded or any
 * key frame read.
 */
import { describe, expect, it } from 'vitest'
import type { ModelCatalogEntry } from '@camstack/types'
import { buildClipModelRegistry } from '../../shared/clip/clip-model-registry.js'
import { CLIP_IMAGE_MODELS } from '../../embedding-encoder/catalogs/embedding-models.js'
import { requireCompleteWipe, WIPE_INCOMPLETE } from '../embedding-actions.js'
import {
  encodeClipQuery,
  MODEL_OVERRIDE_REQUIRES_ADMIN,
  pinClipRebuild,
  resolveClipSearchPlan,
} from '../clip-space-plan.js'

/**
 * The production catalog holds ONE CLIP model, but "a named model wins over the
 * cluster row" and the per-model floors are about SEVERAL. A synthetic 512-d
 * model in the pre-SigLIP2 `object-clip` index stands in for the second one.
 */
const OTHER_ID = 'test-other-clip'
const OTHER: ModelCatalogEntry = {
  id: OTHER_ID,
  name: OTHER_ID,
  description: 'synthetic second CLIP model',
  inputSize: { width: 256, height: 256 },
  labels: [],
  formats: {},
  clip: {
    textModelId: `${OTHER_ID}-text`,
    embeddingDim: 512,
    vectorIndex: 'object-clip',
    tokenizerFile: 'test-tokenizer.json',
    contextLength: 77,
    padId: 0,
    searchMinScore: 0.2,
  },
}
const TEST_MODELS = buildClipModelRegistry([...CLIP_IMAGE_MODELS, OTHER])

const ADMIN = { isAdmin: true }
const VIEWER = { isAdmin: false }

describe("search: the floor is the MODEL's", () => {
  it("a model's floors follow its searchMinScore (0.20 / 0.25 / 0.30 for a 0.2 model)", () => {
    const plan = (strictness?: 'loose' | 'balanced' | 'strict') =>
      resolveClipSearchPlan(strictness ? { strictness } : {}, OTHER_ID, TEST_MODELS, ADMIN)
    expect(plan()).toEqual({ modelId: OTHER_ID, index: 'object-clip', minScore: 0.2 })
    expect(plan('balanced').minScore).toBe(0.25)
    expect(plan('strict').minScore).toBe(0.3)
  })

  it('SigLIP2 searches its own index at ITS floor — 0.2 kept 2.7% of matched pairs there', () => {
    // Measured through the shipped formats on 300 COCO caption-image pairs:
    // 0.099 keeps 96% of matches (OpenVINO), 0.101 (CoreML); 0.2 keeps 4.3%.
    expect(resolveClipSearchPlan({}, 'siglip2-b16-224', TEST_MODELS, ADMIN)).toEqual({
      modelId: 'siglip2-b16-224',
      index: 'object-clip-siglip2-b16-224',
      minScore: 0.1,
    })
    expect(
      resolveClipSearchPlan({ strictness: 'strict' }, 'siglip2-b16-224', TEST_MODELS, ADMIN)
        .minScore,
    ).toBe(0.15)
  })

  it('an explicit absolute minScore is honoured verbatim — a URL means the same thing everywhere', () => {
    expect(
      resolveClipSearchPlan({ minScore: 0.2 }, 'siglip2-b16-224', TEST_MODELS, ADMIN).minScore,
    ).toBe(0.2)
  })

  it('a named model wins over the cluster row: the old index stays searchable through a cutover', () => {
    expect(
      resolveClipSearchPlan({ modelId: OTHER_ID }, 'siglip2-b16-224', TEST_MODELS, ADMIN),
    ).toMatchObject({ modelId: OTHER_ID, index: 'object-clip', minScore: 0.2 })
  })

  it('THROWS when no space can be named — an empty list would read as "nothing matched" (D315)', () => {
    expect(() => resolveClipSearchPlan({}, null, TEST_MODELS, ADMIN)).toThrow(/could not be read/)
    expect(() =>
      resolveClipSearchPlan({ modelId: 'arcface-r100' }, OTHER_ID, TEST_MODELS, ADMIN),
    ).toThrow(/not a CLIP model/)
  })
})

describe('rebuild: ONE pinned model per pass (D54), refused by name', () => {
  it('pins the cluster row and names the index the pass fills', () => {
    expect(pinClipRebuild('siglip2-b16-224', TEST_MODELS)).toEqual({
      kind: 'pinned',
      modelId: 'siglip2-b16-224',
      index: 'object-clip-siglip2-b16-224',
    })
    expect(pinClipRebuild(OTHER_ID, TEST_MODELS)).toMatchObject({
      index: 'object-clip',
    })
  })

  // An unreadable / unconfirmed row never reaches `pinClipRebuild`: the
  // owner's confirmer refuses it first, under its own reason (D651) —
  // `face-reembed-auto-pin.spec.ts` drives those refusals through the addon.

  it('refuses a model with no CLIP metadata (a DELETED MobileCLIP id included) — no index to fill, no dimension to check', () => {
    expect(pinClipRebuild('mobileclip-s1', TEST_MODELS)).toEqual({
      kind: 'refused',
      refusal: 'not-a-clip-model',
      modelId: 'mobileclip-s1',
    })
  })
})

describe('search: overriding the model is ADMIN-only (share links, viewers)', () => {
  it('a non-admin naming ANOTHER model is refused by name — never re-pointed silently', () => {
    expect(() =>
      resolveClipSearchPlan({ modelId: OTHER_ID }, 'siglip2-b16-224', TEST_MODELS, VIEWER),
    ).toThrow(MODEL_OVERRIDE_REQUIRES_ADMIN)
    // No identity at all is not an admin either.
    expect(() =>
      resolveClipSearchPlan({ modelId: OTHER_ID }, 'siglip2-b16-224', TEST_MODELS, null),
    ).toThrow(MODEL_OVERRIDE_REQUIRES_ADMIN)
  })

  it("a non-admin may name the cluster's OWN model, or none", () => {
    expect(
      resolveClipSearchPlan({ modelId: 'siglip2-b16-224' }, 'siglip2-b16-224', TEST_MODELS, VIEWER)
        .modelId,
    ).toBe('siglip2-b16-224')
    expect(resolveClipSearchPlan({}, 'siglip2-b16-224', TEST_MODELS, VIEWER).modelId).toBe(
      'siglip2-b16-224',
    )
  })

  it('a non-admin naming a model while the row is unreadable is refused — nothing can confirm it', () => {
    expect(() =>
      resolveClipSearchPlan({ modelId: 'siglip2-b16-224' }, null, TEST_MODELS, VIEWER),
    ).toThrow(MODEL_OVERRIDE_REQUIRES_ADMIN)
  })

  it('an admin keeps the override (the cutover comparison)', () => {
    expect(
      resolveClipSearchPlan({ modelId: OTHER_ID }, 'siglip2-b16-224', TEST_MODELS, ADMIN),
    ).toMatchObject({ modelId: OTHER_ID, index: 'object-clip' })
  })
})

describe('search: a failed encode is an ERROR, not "nothing matched" (D315)', () => {
  it("throws with the encoder's cause and logs it with the model", async () => {
    const warns: unknown[] = []
    await expect(
      encodeClipQuery(
        async () => {
          throw new Error('tokenizer not found at /models/camstack-siglip2-b16-224-tokenizer.json')
        },
        'a van',
        'siglip2-b16-224',
        (_m, extras) => warns.push(extras.meta),
      ),
    ).rejects.toThrow(/siglip2-b16-224.*tokenizer not found/)
    expect(warns).toEqual([
      {
        modelId: 'siglip2-b16-224',
        error: 'tokenizer not found at /models/camstack-siglip2-b16-224-tokenizer.json',
      },
    ])
  })

  it('returns the vector when the encoder answers', async () => {
    const v = await encodeClipQuery(
      async () => ({ embedding: [0.6, 0.8] }),
      'a',
      'm',
      () => {},
    )
    expect(Array.from(v)).toEqual([0.6000000238418579, 0.800000011920929])
  })
})

describe('the operator wipe button never reports a partial wipe as success (D649)', () => {
  it('names the indexes that kept their vectors', () => {
    expect(() =>
      requireCompleteWipe({ deleted: 12, failedIndexes: ['object-clip-siglip2-b16-224'] }),
    ).toThrow(`${WIPE_INCOMPLETE}: object-clip-siglip2-b16-224 NOT emptied (12 vectors removed`)
  })

  it('passes a complete wipe through', () => {
    expect(requireCompleteWipe({ deleted: 12, failedIndexes: [] })).toEqual({
      deleted: 12,
      failedIndexes: [],
    })
  })
})
