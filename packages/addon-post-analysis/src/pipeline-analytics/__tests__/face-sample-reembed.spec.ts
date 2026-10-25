/**
 * D658 — the forced re-embed of a named sample list: the repair for what
 * `faceGallery.auditEmbeddings` accuses.
 *
 * Driven end to end over the REAL `IdentityStore` (records world, fake
 * vector index) and the REAL `FaceReembedEmbedder`, so the vector-first write
 * with its read-back, the torn-stamp gate of `loadGallery` (D651) and the
 * pinned node rotation are the production ones. Only `runStatelessStep` is
 * faked.
 */
import {
  encodeVectorBase64,
  type RunStatelessStepInput,
  type RunStatelessStepResult,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { FaceReembedEmbedder } from '../face-reembed-wiring.js'
import type { FaceReembedOutcome } from '../face-reembed-pass.js'
import { type FaceSampleReembedDeps, reembedFaceSamples } from '../face-sample-reembed.js'
import { IDENTITY_ARCFACE_INDEX } from '../store/embedding-vector-index.js'
import { IdentityStore } from '../store/identity-store.js'
import { makeAnalyticsWorld } from './fake-records.js'
import { makeFakeEmbeddingIndex, makeSilentLogger } from './test-helpers.js'

const AURA = 'auraface-r100'
const ARC = 'arcface-r100'
const ARCFACE_LIKE = [1, 0]
const AURAFACE_LIKE = [0, 1]

type Runner = (nodeId: string, input: RunStatelessStepInput) => Promise<RunStatelessStepResult>

/** A node that RAN `ranModelId` and answers `vector`. */
const nodeRunning =
  (ranModelId: string, vector: readonly number[]): Runner =>
  async (nodeId) => ({
    kind: 'ran',
    nodeId,
    modelId: ranModelId,
    details: [
      {
        stepId: 'face-embedding',
        className: 'face',
        score: 1,
        embedding: encodeVectorBase64(vector),
      },
    ],
  })

/** A D658 runner asked for a model it cannot run: refused by name. */
const nodeRefusing: Runner = async (nodeId) => ({
  kind: 'refused',
  nodeId,
  reason: 'model-not-servable',
  detail: `the executor ran "${ARC}" for a call pinned to "${AURA}"`,
})

async function gallery() {
  const { world, ledgers } = await makeAnalyticsWorld()
  const index = makeFakeEmbeddingIndex(IDENTITY_ARCFACE_INDEX)
  const store = new IdentityStore({
    vectors: index.vectors,
    logger: makeSilentLogger(),
    identityLedger: ledgers.identities,
    sampleLedger: ledgers.identitySamples,
  })
  const identity = await store.createIdentity({ name: 'Carol' })
  // The accused sample: stamped AuraFace, holding an ArcFace vector.
  const accused = await store.addSample({
    identityId: identity.id,
    embedding: ARCFACE_LIKE,
    modelId: AURA,
    source: 'photo',
    mediaId: 7,
    sourceMediaId: 8,
    alignment: 'scrfd-v2',
    sourceBbox: { x: 1, y: 2, width: 30, height: 40 },
  })
  const bystander = await store.addSample({
    identityId: identity.id,
    embedding: [0.5, 0.75],
    modelId: AURA,
    source: 'detected',
    mediaId: 9,
  })
  return { world, index, store, identity, accused, bystander }
}

function depsOver(
  store: IdentityStore,
  runner: Runner,
  embedOverride?: FaceSampleReembedDeps['embed'],
): FaceSampleReembedDeps {
  const embedder = new FaceReembedEmbedder(
    { runStatelessStep: runner, logger: { warn: () => undefined } },
    ['hub'],
    AURA,
  )
  return {
    listSamples: () => store.listSamplesForReembed(),
    loadAlignedCrop: async (s) => (s.mediaId === undefined ? null : Buffer.from('template')),
    embed: embedOverride ?? ((s, crop) => embedder.embed(s, crop)),
    store: (s, embedding, modelId, dim) =>
      store.restampSample({
        sampleId: s.sampleId,
        identityId: s.identityId,
        embedding,
        modelId,
        dim,
      }),
    pause: async () => undefined,
    logger: { info: () => undefined, warn: () => undefined },
  }
}

describe('faceGallery.reembedSamples (D658)', () => {
  it('an accused sample already stamped with the model gets a NEW vector, stamped from what RAN, alignment and source kept', async () => {
    const { store, identity, accused, bystander } = await gallery()
    const result = await reembedFaceSamples(depsOver(store, nodeRunning(AURA, AURAFACE_LIKE)), {
      sampleIds: [accused.id],
      modelId: AURA,
    })
    expect(result).toMatchObject({ requested: 1, reembedded: 1, failed: 0 })
    expect(result.rows[0]).toMatchObject({
      sampleId: accused.id,
      outcome: 'reembedded',
      previousModelId: AURA,
      modelId: AURA,
    })
    const served = await store.loadGallery()
    expect(served).toContainEqual({
      identityId: identity.id,
      embedding: new Float32Array(AURAFACE_LIKE),
      modelId: AURA,
    })
    // Only the NAMED sample moved.
    expect(served).toContainEqual({
      identityId: identity.id,
      embedding: new Float32Array([0.5, 0.75]),
      modelId: AURA,
    })
    const after = (await store.listSamples(identity.id)).find((s) => s.id === accused.id)
    expect(after?.alignment).toBe('scrfd-v2')
    expect(after?.sourceBbox).toEqual({ x: 1, y: 2, width: 30, height: 40 })
    expect(bystander.id).not.toBe(accused.id)
  })

  it('a node serving another model is refused — nothing is written, and the sample is named', async () => {
    for (const runner of [nodeRefusing, nodeRunning(ARC, [0.9, 0.1])]) {
      const { store, identity, accused } = await gallery()
      const result = await reembedFaceSamples(depsOver(store, runner), {
        sampleIds: [accused.id],
        modelId: AURA,
      })
      expect(result.rows).toEqual([
        expect.objectContaining({ sampleId: accused.id, outcome: 'no-capable-node' }),
      ])
      expect(await store.loadGallery()).toContainEqual({
        identityId: identity.id,
        embedding: new Float32Array(ARCFACE_LIKE),
        modelId: AURA,
      })
    }
  })

  it('an embed that names no model is not written', async () => {
    const { store, identity, accused } = await gallery()
    const unnamed = async (): Promise<FaceReembedOutcome> => ({
      kind: 'embedded',
      embedding: AURAFACE_LIKE,
      dim: 2,
    })
    const result = await reembedFaceSamples(depsOver(store, nodeRefusing, unnamed), {
      sampleIds: [accused.id],
      modelId: AURA,
    })
    expect(result.rows[0]?.outcome).toBe('no-model-stamp')
    expect(await store.loadGallery()).toContainEqual({
      identityId: identity.id,
      embedding: new Float32Array(ARCFACE_LIKE),
      modelId: AURA,
    })
  })

  it('the torn-write check still holds: a row update that fails leaves the sample OUT of the gallery, never cross-served', async () => {
    const { world, store, identity } = await gallery()
    const arcRow = await store.addSample({
      identityId: identity.id,
      embedding: ARCFACE_LIKE,
      modelId: ARC,
      source: 'detected',
      mediaId: 11,
    })
    // The row store is unreachable for the restamp's write.
    world.failWrites(true)
    const result = await reembedFaceSamples(depsOver(store, nodeRunning(AURA, AURAFACE_LIKE)), {
      sampleIds: [arcRow.id],
      modelId: AURA,
    })
    world.failWrites(false)
    expect(result.rows[0]).toMatchObject({ outcome: 'not-landed', previousModelId: ARC })
    const served = await store.loadGallery()
    expect(served.some((s) => s.modelId === ARC)).toBe(false)
    expect(served.some((s) => s.embedding[0] === 0 && s.embedding[1] === 1)).toBe(false)
  })

  it('vector first: a vector that does not reach the index never moves the stamp', async () => {
    const { index, store, identity } = await gallery()
    const arcRow = await store.addSample({
      identityId: identity.id,
      embedding: ARCFACE_LIKE,
      modelId: ARC,
      source: 'detected',
      mediaId: 11,
    })
    index.vectors.put = async () => false
    const result = await reembedFaceSamples(depsOver(store, nodeRunning(AURA, AURAFACE_LIKE)), {
      sampleIds: [arcRow.id],
      modelId: AURA,
    })
    expect(result.rows[0]).toMatchObject({ outcome: 'not-landed' })
    const row = (await store.listSamplesForReembed()).find((r) => r.sampleId === arcRow.id)
    expect(row?.modelId).toBe(ARC)
  })

  it('names what it could not do: unknown ids, duplicates, missing pixels', async () => {
    const { store, identity } = await gallery()
    const noPixels = await store.addSample({
      identityId: identity.id,
      embedding: ARCFACE_LIKE,
      modelId: AURA,
      source: 'detected',
    })
    const result = await reembedFaceSamples(depsOver(store, nodeRunning(AURA, AURAFACE_LIKE)), {
      sampleIds: ['nope', noPixels.id, noPixels.id],
      modelId: AURA,
    })
    expect(result.rows.map((r) => [r.sampleId, r.outcome])).toEqual([
      ['nope', 'not-found'],
      [noPixels.id, 'no-pixels'],
      [noPixels.id, 'duplicate'],
    ])
    expect(result).toMatchObject({ requested: 3, reembedded: 0, failed: 3 })
  })
})
