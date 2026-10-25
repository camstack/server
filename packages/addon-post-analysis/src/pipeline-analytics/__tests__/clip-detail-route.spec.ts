/**
 * D658 — a CLIP detail is stored under the model the RUNNER says produced it,
 * and under nothing else.
 *
 * `routeClipDetail` used to fall back to the embedding encoder's active model
 * (`embeddingEncoder.getInfo`, cached for a minute) when a detail carried no
 * `embeddingModelId`. That is a second process's opinion of which encoder ran
 * — the cluster row, read on another schedule — and it is exactly how a vector
 * lands in the wrong space: the index is chosen from the stamp (D649). A
 * detail with no model id is now refused by name, and nobody is asked to guess.
 */
import { encodeVectorBase64 } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeFakeVectorStore, makeLogRecorder } from './test-helpers.js'
import {
  TEST_SIGLIP_INDEX,
  TEST_STAND_IN_INDEX,
  testClipRegistry,
} from './fixtures/clip-test-registry.js'
import { ObjectEmbeddingStore } from '../store/object-embedding-store.js'
import { routeClipDetailToStore } from '../clip-detail-route.js'

const MC_DIM = 4
const SIG_DIM = 6

function makeStore() {
  const vectors = makeFakeVectorStore()
  const logs = makeLogRecorder()
  const store = new ObjectEmbeddingStore({
    vectorStore: vectors.client,
    logger: logs.logger,
    clipModels: testClipRegistry(MC_DIM, { siglipDim: SIG_DIM }),
  })
  return { store, vectors, logs }
}

const unit = (dim: number): number[] => Array.from({ length: dim }, (_, i) => (i === 0 ? 1 : 0))

function detail(embeddingModelId: string | undefined, dim: number) {
  return {
    deviceId: 101,
    trackId: 't1',
    timestamp: 1_000,
    className: 'person',
    score: 0.8,
    embeddingBase64: encodeVectorBase64(unit(dim)),
    embeddingModelId,
  }
}

describe('routeClipDetailToStore (D658)', () => {
  it('stores a SigLIP2-stamped 768-class vector in the SigLIP2 index', async () => {
    const { store, vectors } = makeStore()
    expect(await routeClipDetailToStore(store, detail('siglip2-b16-224', SIG_DIM))).toBe(
      'persisted',
    )
    expect(vectors.rows.get(TEST_SIGLIP_INDEX)?.get('t1')?.metadata['modelId']).toBe(
      'siglip2-b16-224',
    )
    expect(vectors.rows.get(TEST_STAND_IN_INDEX)?.size ?? 0).toBe(0)
  })

  it('stores a MobileCLIP-stamped vector in object-clip', async () => {
    const { store, vectors } = makeStore()
    expect(await routeClipDetailToStore(store, detail('mobileclip-s1', MC_DIM))).toBe('persisted')
    expect(vectors.rows.get(TEST_STAND_IN_INDEX)?.get('t1')?.metadata['modelId']).toBe(
      'mobileclip-s1',
    )
  })

  it('refuses a detail that names no model — by name, writing nothing, guessing nothing', async () => {
    const { store, vectors, logs } = makeStore()
    for (const unstamped of [undefined, '']) {
      expect(await routeClipDetailToStore(store, detail(unstamped, MC_DIM))).toBe('failed')
    }
    expect(vectors.rows.get(TEST_STAND_IN_INDEX)?.size ?? 0).toBe(0)
    expect(vectors.rows.get(TEST_SIGLIP_INDEX)?.size ?? 0).toBe(0)
    const lines = logs.entries.filter((e) => e.level === 'warn')
    expect(lines).toHaveLength(1)
    expect(lines[0]!.message).toBe('object embeddings refused — the result names no model')
    expect(lines[0]!.extras?.tags).toEqual({ deviceId: 101 })
    expect(lines[0]!.extras?.meta).toMatchObject({ reason: 'no-model-id', modelId: null })
  })
})
