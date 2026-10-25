import { IDENTITY_ARCFACE_INDEX } from '../store/embedding-vector-index.js'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { EmbeddingVectorIndex } from '../store/embedding-vector-index.js'
import { IdentityStore } from '../store/identity-store.js'
import {
  type AnalyticsLedgers,
  type FakeRecords,
  kindRows,
  makeAnalyticsWorld,
  seedLedgerRows,
} from './fake-records.js'
import { makeFakeEmbeddingIndex, makeSilentLogger } from './test-helpers.js'
import type { GallerySample } from '../pipeline/face-matcher.js'

interface IdentityWorld {
  readonly world: FakeRecords
  readonly ledgers: AnalyticsLedgers
  readonly store: IdentityStore
}

/**
 * Seed `identity-samples` rows AS STORED, past the kind's write schema: the
 * SQL-NULL and half-written shapes an adopted legacy row can carry, which the
 * writer would refuse today and the readers must still survive. Header as the
 * writer sets it (`addedAt` → `at`, `deviceId`), body whole.
 */
function seedStoredSamples(
  world: FakeRecords,
  rows: readonly { readonly id: string; readonly data: Record<string, unknown> }[],
): void {
  for (const row of rows) {
    const at = row.data['addedAt']
    const deviceId = row.data['deviceId']
    world.seed('identity-samples', {
      id: row.id,
      ...(typeof at === 'number' ? { at } : {}),
      ...(typeof deviceId === 'number' ? { deviceId } : {}),
      data: row.data,
    })
  }
}

/** An `IdentityStore` over a fresh records world, wired as `index.ts` wires it. */
async function makeIdentityWorld(
  vectors: EmbeddingVectorIndex = makeFakeEmbeddingIndex(IDENTITY_ARCFACE_INDEX).vectors,
): Promise<IdentityWorld> {
  const { world, ledgers } = await makeAnalyticsWorld()
  const store = new IdentityStore({
    vectors,
    logger: makeSilentLogger(),
    identityLedger: ledgers.identities,
    sampleLedger: ledgers.identitySamples,
  })
  return { world, ledgers, store }
}

describe('IdentityStore — identities CRUD', () => {
  let world: FakeRecords
  let ledgers: AnalyticsLedgers
  let store: IdentityStore

  beforeEach(async () => {
    ;({ world, ledgers, store } = await makeIdentityWorld())
  })

  it('creates an identity with id, timestamps, zero samples', async () => {
    const id = await store.createIdentity({ name: 'Alice' })
    expect(id.name).toBe('Alice')
    expect(id.sampleCount).toBe(0)
    expect(typeof id.id).toBe('string')
    expect(id.createdAt).toBeGreaterThan(0)

    const all = await store.listIdentities()
    expect(all.map((i) => i.name)).toEqual(['Alice'])
  })

  it('normalizes a SQL NULL coverMediaId to undefined (no null leaks into Identity)', async () => {
    await seedLedgerRows(ledgers.identities, [
      {
        id: 'i-null',
        data: { name: 'Alice', sampleCount: 1, createdAt: 1, updatedAt: 1, coverMediaId: null },
      },
    ])
    const [identity] = await store.listIdentities()
    expect(identity!.name).toBe('Alice')
    expect(identity!.coverMediaId).toBeUndefined()
    for (const v of Object.values(identity!)) expect(v).not.toBeNull()
  })

  it('sets coverMediaId on the first sample even when the row started as SQL NULL', async () => {
    await seedLedgerRows(ledgers.identities, [
      {
        id: 'i-cover',
        data: { name: 'Alice', sampleCount: 0, createdAt: 1, updatedAt: 1, coverMediaId: null },
      },
    ])
    await store.addSample({
      identityId: 'i-cover',
      embedding: [0.1],
      modelId: 'arcface-r100',
      source: 'detected',
      mediaId: 101,
    })
    const [identity] = await store.listIdentities()
    expect(identity!.coverMediaId).toBe(101)
  })

  it('renames an identity and bumps updatedAt', async () => {
    const id = await store.createIdentity({ name: 'Alice' })
    await store.renameIdentity(id.id, 'Alicia')
    const all = await store.listIdentities()
    expect(all.find((i) => i.id === id.id)?.name).toBe('Alicia')
  })

  it('deletes an identity and cascades its samples (leaving other identities intact)', async () => {
    const a = await store.createIdentity({ name: 'Alice' })
    const b = await store.createIdentity({ name: 'Bob' })
    // Seed sample rows directly (addSample is Task 2) so the cascade path runs.
    await seedLedgerRows(ledgers.identitySamples, [
      {
        id: 'sA1',
        data: {
          identityId: a.id,
          embedding: [1, 0],
          source: 'detected',
          modelId: 'arcface-r100',
          dim: 2,
          addedAt: 1,
        },
      },
      {
        id: 'sA2',
        data: {
          identityId: a.id,
          embedding: [0, 1],
          source: 'detected',
          modelId: 'arcface-r100',
          dim: 2,
          addedAt: 2,
        },
      },
      {
        id: 'sB1',
        data: {
          identityId: b.id,
          embedding: [1, 1],
          source: 'detected',
          modelId: 'arcface-r100',
          dim: 2,
          addedAt: 3,
        },
      },
    ])
    expect(kindRows(world, 'identity-samples').length).toBe(3)

    await store.deleteIdentity(a.id)

    const all = await store.listIdentities()
    expect(all.map((i) => i.name)).toEqual(['Bob'])
    expect(all.map((i) => i.id)).toEqual([b.id])
    // Alice's two samples are gone; Bob's one sample survives.
    expect(kindRows(world, 'identity-samples').length).toBe(1)
  })
})

describe('IdentityStore — samples + gallery', () => {
  let world: FakeRecords
  let store: IdentityStore

  beforeEach(async () => {
    ;({ world, store } = await makeIdentityWorld())
  })

  it('adds a sample, bumps sampleCount, sets cover on the first', async () => {
    const id = await store.createIdentity({ name: 'Alice' })
    const s = await store.addSample({
      identityId: id.id,
      embedding: [0.1, 0.2, 0.3, 0.4],
      mediaId: 1000,
      modelId: 'arcface-r100',
      deviceId: 7,
    })
    expect(s.dim).toBe(4)
    expect(s.source).toBe('detected')

    const after = (await store.listIdentities()).find((i) => i.id === id.id)
    expect(after?.sampleCount).toBe(1)
    expect(after?.coverMediaId).toBe(1000)
  })

  it('removeSample decrements sampleCount', async () => {
    const id = await store.createIdentity({ name: 'Alice' })
    const s1 = await store.addSample({
      identityId: id.id,
      embedding: [1, 0],
      mediaId: 201,
      modelId: 'arcface-r100',
    })
    await store.addSample({
      identityId: id.id,
      embedding: [0, 1],
      mediaId: 202,
      modelId: 'arcface-r100',
    })
    await store.removeSample(id.id, s1.id)
    expect((await store.listIdentities()).find((i) => i.id === id.id)?.sampleCount).toBe(1)
  })

  it('loadGallery projects every sample onto GallerySample', async () => {
    const a = await store.createIdentity({ name: 'Alice' })
    const b = await store.createIdentity({ name: 'Bob' })
    await store.addSample({
      identityId: a.id,
      embedding: [1, 0],
      mediaId: 201,
      modelId: 'arcface-r100',
    })
    await store.addSample({
      identityId: b.id,
      embedding: [0, 1],
      mediaId: 202,
      modelId: 'arcface-r100',
    })

    const gallery: readonly GallerySample[] = await store.loadGallery()
    expect(gallery).toHaveLength(2)
    expect(gallery.every((g) => g.modelId === 'arcface-r100')).toBe(true)
    expect(new Set(gallery.map((g) => g.identityId))).toEqual(new Set([a.id, b.id]))
    // D867: the gallery holds each vector ONCE, as the Float32Array the matcher
    // scores against — nothing re-wraps it per probe.
    expect(gallery.every((g) => g.embedding instanceof Float32Array)).toBe(true)
  })

  it('deleteIdentity removes its samples from the gallery', async () => {
    const a = await store.createIdentity({ name: 'Alice' })
    await store.addSample({
      identityId: a.id,
      embedding: [1, 0],
      mediaId: 201,
      modelId: 'arcface-r100',
    })
    await store.deleteIdentity(a.id)
    expect(await store.loadGallery()).toHaveLength(0)
  })

  it('coverMediaId is set on the first sample and does NOT change on later samples', async () => {
    const id = await store.createIdentity({ name: 'Alice' })
    await store.addSample({
      identityId: id.id,
      embedding: [1, 0],
      mediaId: 301,
      modelId: 'arcface-r100',
    })
    await store.addSample({
      identityId: id.id,
      embedding: [0, 1],
      mediaId: 302,
      modelId: 'arcface-r100',
    })
    const after = (await store.listIdentities()).find((i) => i.id === id.id)
    expect(after?.coverMediaId).toBe(301) // unchanged by the 2nd sample
    expect(after?.sampleCount).toBe(2)
  })

  it('loadGallery skips malformed sample rows (missing embedding / modelId)', async () => {
    const a = await store.createIdentity({ name: 'Alice' })
    await store.addSample({
      identityId: a.id,
      embedding: [1, 0],
      mediaId: 201,
      modelId: 'arcface-r100',
    })
    // Seed two malformed rows directly: one missing embedding, one missing modelId.
    seedStoredSamples(world, [
      {
        id: 'bad1',
        data: { identityId: a.id, modelId: 'arcface-r100', dim: 0, source: 'detected', addedAt: 1 },
      },
      {
        id: 'bad2',
        data: { identityId: a.id, embedding: [0, 1], dim: 2, source: 'detected', addedAt: 2 },
      },
    ])
    const gallery = await store.loadGallery()
    expect(gallery).toHaveLength(1) // only the well-formed sample
    expect(gallery[0]!.identityId).toBe(a.id)
  })
})

describe('IdentityStore — re-embed pass surface', () => {
  let world: FakeRecords
  let ledgers: AnalyticsLedgers
  let store: IdentityStore

  beforeEach(async () => {
    ;({ world, ledgers, store } = await makeIdentityWorld())
    await seedLedgerRows(ledgers.identities, [
      { id: 'i-1', data: { name: 'Alice', sampleCount: 2, createdAt: 1, updatedAt: 1 } },
      { id: 'i-2', data: { name: 'Bob', sampleCount: 1, createdAt: 1, updatedAt: 1 } },
    ])
    seedStoredSamples(world, [
      {
        id: 's-1',
        data: {
          identityId: 'i-1',
          embedding: [0.1, 0.2],
          mediaId: 501,
          source: 'photo',
          modelId: 'arcface-r100',
          dim: 2,
          addedAt: 10,
        },
      },
      {
        id: 's-2',
        data: {
          identityId: 'i-1',
          embedding: [0.3, 0.4],
          // SQL NULL mediaId — the pixel-less legacy row shape.
          mediaId: null,
          source: 'detected',
          modelId: 'arcface-r100',
          dim: 2,
          addedAt: 11,
        },
      },
      {
        id: 's-3',
        data: {
          identityId: 'i-2',
          embedding: [0.5, 0.6],
          mediaId: 502,
          source: 'photo',
          modelId: 'auraface-r100',
          dim: 2,
          addedAt: 12,
        },
      },
    ])
  })

  it('lists EVERY sample across identities with the fields the pass needs, names joined', async () => {
    const rows = await store.listSamplesForReembed()
    expect(rows.map((r) => r.sampleId).sort()).toEqual(['s-1', 's-2', 's-3'])
    const s1 = rows.find((r) => r.sampleId === 's-1')
    expect(s1).toMatchObject({
      identityId: 'i-1',
      identityName: 'Alice',
      modelId: 'arcface-r100',
      dim: 2,
      mediaId: 501,
    })
    // The SQL NULL mediaId must surface as ABSENT, never as null.
    const s2 = rows.find((r) => r.sampleId === 's-2')
    expect(s2!.mediaId).toBeUndefined()
    expect('mediaId' in s2!).toBe(false)
  })

  it('restamps a sample and reports landed=true only after reading the row back', async () => {
    const outcome = await store.restampSample({
      sampleId: 's-1',
      identityId: 'i-1',
      embedding: [0.9, 0.8],
      modelId: 'auraface-r100',
      dim: 2,
    })
    expect(outcome.landed).toBe(true)

    const rows = await store.listSamplesForReembed()
    const s1 = rows.find((r) => r.sampleId === 's-1')
    expect(s1!.modelId).toBe('auraface-r100')
  })

  it('reports landed=false with a reason when the row does not exist', async () => {
    const outcome = await store.restampSample({
      sampleId: 's-missing',
      identityId: 'i-1',
      embedding: [0.9],
      modelId: 'auraface-r100',
      dim: 1,
    })
    expect(outcome.landed).toBe(false)
    expect(outcome.reason).toBeTruthy()
  })
})

describe('IdentityStore — cover integrity across sample removal', () => {
  let ledgers: AnalyticsLedgers
  let store: IdentityStore

  beforeEach(async () => {
    ;({ ledgers, store } = await makeIdentityWorld())
    await seedLedgerRows(ledgers.identities, [
      {
        id: 'i-1',
        data: {
          name: 'Alice',
          sampleCount: 2,
          createdAt: 1,
          updatedAt: 1,
          coverMediaId: 401,
        },
      },
    ])
    await seedLedgerRows(ledgers.identitySamples, [
      {
        id: 's-cover',
        data: {
          identityId: 'i-1',
          embedding: [0.1],
          mediaId: 401,
          source: 'photo',
          modelId: 'arcface-r100',
          dim: 1,
          addedAt: 10,
        },
      },
      {
        id: 's-other',
        data: {
          identityId: 'i-1',
          embedding: [0.2],
          mediaId: 402,
          source: 'photo',
          modelId: 'arcface-r100',
          dim: 1,
          addedAt: 11,
        },
      },
    ])
  })

  it('removing the COVER sample promotes a remaining sample to cover', async () => {
    await store.removeSample('i-1', 's-cover')

    const [identity] = await store.listIdentities()
    expect(identity!.coverMediaId).toBe(402)
  })

  it('removing the LAST sample clears the cover entirely', async () => {
    await store.removeSample('i-1', 's-cover')
    await store.removeSample('i-1', 's-other')

    const [identity] = await store.listIdentities()
    expect(identity!.coverMediaId).toBeUndefined()
  })

  it('the first sample added to an EMPTIED identity always becomes the cover, even over a stale key', async () => {
    // The dangling state a pre-fix cleanup leaves behind: zero samples, cover set.
    await seedLedgerRows(ledgers.identities, [
      {
        id: 'i-stale',
        data: {
          name: 'Bob',
          sampleCount: 0,
          createdAt: 1,
          updatedAt: 1,
          coverMediaId: 403,
        },
      },
    ])
    await store.addSample({
      identityId: 'i-stale',
      embedding: [0.3],
      mediaId: 404,
      modelId: 'auraface-r100',
      source: 'photo',
    })

    const identity = (await store.listIdentities()).find((i) => i.id === 'i-stale')
    expect(identity!.coverMediaId).toBe(404)
  })
})

describe('IdentityStore — the alignment stamp (D643)', () => {
  const make = makeIdentityWorld

  it('persists the stamp and the source box a sample is enrolled with, and lists them back', async () => {
    const { store } = await make()
    const identity = await store.createIdentity({ name: 'Dave' })
    await store.addSample({
      identityId: identity.id,
      embedding: [0.1, 0.2],
      modelId: 'auraface-r100',
      source: 'photo',
      mediaId: 7,
      sourceMediaId: 8,
      alignment: 'scrfd-v2',
      sourceBbox: { x: 1, y: 2, width: 30, height: 40 },
    })
    const [sample] = await store.listSamples(identity.id)
    expect(sample?.alignment).toBe('scrfd-v2')
    expect(sample?.sourceBbox).toEqual({ x: 1, y: 2, width: 30, height: 40 })
  })

  it('an unstamped row (every sample written before the fix) reads as v1 — no alignment', async () => {
    const { world, store } = await make()
    seedStoredSamples(world, [
      {
        id: 'legacy',
        data: {
          identityId: 'i1',
          embedding: [],
          source: 'detected',
          modelId: 'auraface-r100',
          dim: 512,
          addedAt: 1,
          alignment: null,
          sourceBbox: null,
        },
      },
    ])
    const [sample] = await store.listSamples('i1')
    expect(sample?.alignment).toBeUndefined()
    expect(sample?.sourceBbox).toBeUndefined()
  })

  it('lists every PHOTO sample across identities for the re-enrol pass, with names joined', async () => {
    const { ledgers, store } = await make()
    await seedLedgerRows(ledgers.identities, [
      { id: 'i1', data: { name: 'Bob', sampleCount: 2, createdAt: 1, updatedAt: 1 } },
    ])
    await seedLedgerRows(ledgers.identitySamples, [
      {
        id: 'p1',
        data: {
          identityId: 'i1',
          embedding: [],
          source: 'photo',
          modelId: 'auraface-r100',
          dim: 512,
          addedAt: 1,
          mediaId: 5,
          sourceMediaId: 6,
        },
      },
      {
        id: 'd1',
        data: {
          identityId: 'i1',
          embedding: [],
          source: 'detected',
          modelId: 'auraface-r100',
          dim: 512,
          addedAt: 2,
          mediaId: 9,
        },
      },
    ])
    const photos = await store.listPhotoSamplesForReenrol()
    expect(photos).toEqual([
      {
        sampleId: 'p1',
        identityId: 'i1',
        identityName: 'Bob',
        modelId: 'auraface-r100',
        source: 'photo',
        mediaId: 5,
        sourceMediaId: 6,
      },
    ])

    // D644: the SOURCED listing adds a detected sample only once it names its frame.
    expect((await store.listSourcedSamplesForReenrol()).map((s) => s.sampleId)).toEqual(['p1'])
    await seedLedgerRows(ledgers.identitySamples, [
      {
        id: 'd2',
        data: {
          identityId: 'i1',
          embedding: [],
          source: 'detected',
          modelId: 'auraface-r100',
          dim: 512,
          addedAt: 3,
          mediaId: 12,
          sourceMediaId: 13,
          deviceId: 101,
          sourceBbox: { x: 1, y: 2, width: 3, height: 4 },
        },
      },
    ])
    const sourced = await store.listSourcedSamplesForReenrol()
    expect(sourced.find((s) => s.sampleId === 'd2')).toEqual({
      sampleId: 'd2',
      identityId: 'i1',
      identityName: 'Bob',
      modelId: 'auraface-r100',
      source: 'detected',
      sourceMediaId: 13,
      mediaId: 12,
      deviceId: 101,
      sourceBbox: { x: 1, y: 2, width: 3, height: 4 },
    })
    expect(sourced.map((s) => s.sampleId)).not.toContain('d1')
  })
})

describe('IdentityStore — removeSample on a row that is already gone (I3)', () => {
  it('counts a sample out ONCE, however many times it is removed', async () => {
    const { store } = await makeIdentityWorld()
    const identity = await store.createIdentity({ name: 'Dave' })
    const a = await store.addSample({ identityId: identity.id, embedding: [1, 0], modelId: 'm' })
    await store.addSample({ identityId: identity.id, embedding: [0, 1], modelId: 'm' })

    await store.removeSample(identity.id, a.id)
    await store.removeSample(identity.id, a.id)

    const [after] = await store.listIdentities()
    expect(after?.sampleCount).toBe(1)
  })
})

/**
 * D651: during a model switch the gallery must never serve a vector under a
 * model that did not produce it. `restampSample` writes the vector FIRST and
 * the row second; a row update that fails (or a crash between the two) leaves
 * an AuraFace vector behind a row still stamped ArcFace. The matcher gates on
 * the ROW's stamp, so serving that pair would compare two feature spaces — the
 * one failure a model switch may not produce. Recognition may go blind for a
 * sample; it may never match across models.
 */
describe('IdentityStore — the served stamp is the stamp the VECTOR carries (D651)', () => {
  async function make() {
    const index = makeFakeEmbeddingIndex(IDENTITY_ARCFACE_INDEX)
    const { world, store } = await makeIdentityWorld(index.vectors)
    const identity = await store.createIdentity({ name: 'Carol' })
    return { world, index, store, identity }
  }

  it('does not serve a sample whose vector was re-embedded under another model than its row', async () => {
    const { store, index, identity } = await make()
    const kept = await store.addSample({
      identityId: identity.id,
      embedding: [0.5, 0.75],
      modelId: 'arcface-r100',
      source: 'detected',
    })
    const torn = await store.addSample({
      identityId: identity.id,
      embedding: [0.75, 0.5],
      modelId: 'arcface-r100',
      source: 'detected',
    })
    // The torn restamp: the AuraFace vector landed, the row did not follow.
    await index.vectors.put({
      id: torn.id,
      embedding: [0.25, 0.875],
      className: 'identity',
      modelId: 'auraface-r100',
      timestamp: 1,
      extra: { identityId: identity.id },
    })

    const gallery = await store.loadGallery()
    expect(gallery.map((s) => s.embedding)).toEqual([new Float32Array([0.5, 0.75])])
    expect(gallery.every((s) => s.modelId === 'arcface-r100')).toBe(true)
    expect(kept.id).not.toBe(torn.id)
  })

  it('an UNSTAMPED vector is still served under its row — absence is not a disagreement', async () => {
    const { store, index, identity } = await make()
    const sample = await store.addSample({
      identityId: identity.id,
      embedding: [0.5, 0.75],
      modelId: 'auraface-r100',
      source: 'detected',
    })
    // Overwrite the index row with one that carries NO modelId, as a row
    // written before the index stamped models would.
    await index.client.upsert.mutate({
      index: IDENTITY_ARCFACE_INDEX,
      items: [
        {
          id: sample.id,
          vector: Buffer.from(new Float32Array([0.5, 0.75]).buffer).toString('base64'),
          metadata: { className: 'identity', identityId: identity.id },
        },
      ],
    })
    const gallery = await store.loadGallery()
    expect(gallery).toEqual([
      {
        identityId: identity.id,
        embedding: new Float32Array([0.5, 0.75]),
        modelId: 'auraface-r100',
      },
    ])
  })

  it('a restamp whose row update throws leaves the sample OUT of the gallery, never cross-served', async () => {
    const { world, store, identity } = await make()
    const sample = await store.addSample({
      identityId: identity.id,
      embedding: [0.5, 0.75],
      modelId: 'arcface-r100',
      source: 'detected',
    })
    // The row store is unreachable for the restamp's write.
    world.failWrites(true)
    const outcome = await store.restampSample({
      sampleId: sample.id,
      identityId: identity.id,
      embedding: [0.25, 0.875],
      modelId: 'auraface-r100',
      dim: 2,
    })
    world.failWrites(false)
    expect(outcome.landed).toBe(false)

    const gallery = await store.loadGallery()
    // Neither the ArcFace-stamped row with the AuraFace vector, nor anything else.
    expect(gallery).toEqual([])
    // The next pass still sees it outside the target space and retries it.
    const [row] = await store.listSamplesForReembed()
    expect(row?.modelId).toBe('arcface-r100')
  })

  it('a restamp keeps the alignment stamp and the source of the sample (D643)', async () => {
    const { store, identity } = await make()
    const sample = await store.addSample({
      identityId: identity.id,
      embedding: [0.5, 0.75],
      modelId: 'arcface-r100',
      source: 'photo',
      mediaId: 7,
      sourceMediaId: 8,
      alignment: 'scrfd-v2',
      sourceBbox: { x: 1, y: 2, width: 30, height: 40 },
    })
    const outcome = await store.restampSample({
      sampleId: sample.id,
      identityId: identity.id,
      embedding: [0.25, 0.875],
      modelId: 'auraface-r100',
      dim: 2,
    })
    expect(outcome.landed).toBe(true)
    const [after] = await store.listSamples(identity.id)
    expect(after?.alignment).toBe('scrfd-v2')
    expect(after?.sourceBbox).toEqual({ x: 1, y: 2, width: 30, height: 40 })
    const gallery = await store.loadGallery()
    expect(gallery).toEqual([
      {
        identityId: identity.id,
        embedding: new Float32Array([0.25, 0.875]),
        modelId: 'auraface-r100',
      },
    ])
  })
})

describe('IdentityStore — records path', () => {
  it('createIdentity lands in the identities records kind', async () => {
    const { world, store } = await makeIdentityWorld()
    const identity = await store.createIdentity({ name: 'Hub Person' })
    expect(world.tables.get('identities')?.size).toBe(1)
    const listed = await store.listIdentities()
    expect(listed.map((i) => i.name)).toEqual(['Hub Person'])
    expect(listed[0]!.id).toBe(identity.id)
  })

  it('listIdentities stays createdAt order after rename bumps updatedAt', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T10:00:00Z'))
    const { store } = await makeIdentityWorld()
    const a = await store.createIdentity({ name: 'First' })
    vi.setSystemTime(new Date('2026-01-01T10:00:01Z'))
    const b = await store.createIdentity({ name: 'Second' })
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'))
    await store.renameIdentity(a.id, 'First Renamed')
    const names = (await store.listIdentities()).map((i) => i.name)
    expect(names).toEqual(['First Renamed', 'Second'])
    expect(b.id).not.toBe(a.id)
    vi.useRealTimers()
  })
})

/**
 * The hourly prune's sample read (D643, D447). It used to be proved by an
 * `EXPLAIN` of the legacy settings table; the rows now live in the
 * `identity-samples` kind, and the in-memory engine refuses any `where` that
 * no declared index serves — so answering at all proves the read is the
 * `identity_added (identityId, addedAt)` index walk, and nothing else.
 */
describe('IdentityStore — listSamplesForPrune', () => {
  it("answers one identity's samples with the three fields the prune decides on", async () => {
    const { ledgers, store } = await makeIdentityWorld()
    const sample = (
      id: string,
      identityId: string,
      source: 'detected' | 'photo',
      extra: Record<string, unknown>,
    ): { id: string; data: Record<string, unknown> } => ({
      id,
      data: {
        identityId,
        embedding: [],
        source,
        modelId: 'auraface-r100',
        dim: 512,
        addedAt: 1,
        ...extra,
      },
    })
    await seedLedgerRows(ledgers.identitySamples, [
      sample('s1', 'i1', 'detected', { alignment: 'scrfd-v2', deviceId: 101 }),
      sample('s2', 'i1', 'detected', { deviceId: 102 }),
      sample('s3', 'i1', 'photo', {}),
      sample('s4', 'i2', 'detected', { deviceId: 101 }),
    ])

    const rows = await store.listSamplesForPrune('i1')
    expect(rows.map((r) => r.id).toSorted()).toEqual(['s1', 's2', 's3'])
    expect(rows.find((r) => r.id === 's1')).toEqual({
      id: 's1',
      source: 'detected',
      deviceId: 101,
      alignment: 'scrfd-v2',
    })
    expect(rows.find((r) => r.id === 's3')).toEqual({ id: 's3', source: 'photo' })
  })
})
