/**
 * The whole-archive face rescore job (D866).
 *
 * The scoring and the persistence gate are NOT re-tested here — they are
 * `buildFaceRescoreReport` / `persistRescoreResult`, covered in
 * `face-rescore.spec.ts`. What is asserted is what the job adds: ONE gallery,
 * paced batches written in one transaction each, the raise / lower / clear
 * accounting, single-flight, and that an incomparable face is never written.
 */
import { describe, expect, it } from 'vitest'
import type { FaceRescoreParams } from '../face-rescore.js'
import {
  classifyRescoreChange,
  computeRescoreFingerprint,
  FaceRescoreJob,
  type FaceRescorePorts,
  RESCORE_BATCH_SIZE,
} from '../face-rescore-job.js'
import type { GallerySample } from '../pipeline/face-matcher.js'
import type { RescoreBatchRow, SuggestionUpdate } from '../store/face-store.js'
import { makeSilentLogger } from './test-helpers.js'

const MODEL = 'cluster-model'
const PARAMS: FaceRescoreParams = {
  threshold: 0.9,
  margin: 0.05,
  minIdentitySamples: 1,
  suggestionMinCosine: 0.5,
  suggestionBandFactor: 0.55,
}
const GALLERY: readonly GallerySample[] = [
  { identityId: 'anna', embedding: [1, 0], modelId: MODEL },
  { identityId: 'bruno', embedding: [0, 1], modelId: MODEL },
]
/** cos([1, 0.1], [1, 0]) */
const NEAR_ANNA = 1 / Math.sqrt(1.01)

interface Harness {
  readonly ports: FaceRescorePorts
  readonly events: string[]
  readonly applied: SuggestionUpdate[][]
  readonly recorded: string[]
  readonly gate: { release: () => void } | null
  listCalls: () => number
}

function face(
  id: string,
  embedding: readonly number[],
  stored?: { identityId: string; score: number },
  modelId = MODEL,
): RescoreBatchRow {
  return {
    id,
    deviceId: 101,
    embedding,
    modelId,
    ...(stored !== undefined
      ? { suggestedIdentityId: stored.identityId, suggestedMatchScore: stored.score }
      : {}),
  }
}

function harness(
  faces: readonly RescoreBatchRow[],
  options: { holdFirstPause?: boolean; failApply?: boolean; noVector?: number } = {},
): Harness {
  const events: string[] = []
  const applied: SuggestionUpdate[][] = []
  const recorded: string[] = []
  let listCalls = 0
  let release: () => void = () => {}
  const held = options.holdFirstPause
    ? new Promise<void>((resolve) => {
        release = resolve
      })
    : null
  let firstPause = true
  const ports: FaceRescorePorts = {
    resolveClusterModelId: () => Promise.resolve(MODEL),
    galleryManifest: () =>
      Promise.resolve([{ sampleId: 's1', identityId: 'anna', modelId: MODEL }]),
    pendingMarker: () => Promise.resolve({ count: faces.length, maxTimestamp: 1_000 }),
    loadGallery: () => {
      events.push('gallery')
      return Promise.resolve(GALLERY)
    },
    identityNames: () => Promise.resolve(new Map([['anna', 'Anna']])),
    paramsForDevice: () => Promise.resolve(PARAMS),
    listPendingFaceIds: () => {
      listCalls += 1
      return Promise.resolve(faces.map((f) => f.id))
    },
    loadRescoreBatch: (ids) => {
      events.push(`load:${String(ids.length)}`)
      const wanted = new Set(ids)
      return Promise.resolve({
        rows: faces.filter((f) => wanted.has(f.id)),
        noVector: options.noVector ?? 0,
        gone: 0,
      })
    },
    applySuggestionBatch: (updates) => {
      events.push(`apply:${String(updates.length)}`)
      if (options.failApply) return Promise.reject(new Error('store down'))
      applied.push([...updates])
      return Promise.resolve()
    },
    recordCompletion: (status) => {
      recorded.push(status.fingerprint)
      return Promise.resolve()
    },
    pause: async (ms) => {
      events.push(`pause:${ms >= 25 ? 'ok' : 'short'}`)
      if (firstPause && held !== null) {
        firstPause = false
        await held
      }
    },
    now: () => Date.now(),
    newJobId: () => 'job-1',
    logger: makeSilentLogger(),
  }
  return {
    ports,
    events,
    applied,
    recorded,
    gate: held !== null ? { release } : null,
    listCalls: () => listCalls,
  }
}

describe('classifyRescoreChange', () => {
  const a = { identityId: 'anna', score: 0.8 }
  it.each([
    ['none → none', null, null, 'unchanged'],
    ['none → some', null, a, 'new'],
    ['some → none', a, null, 'cleared'],
    ['same identity, same score', a, { ...a }, 'unchanged'],
    ['same identity, higher', a, { ...a, score: 0.9 }, 'raised'],
    ['same identity, lower', a, { ...a, score: 0.6 }, 'lowered'],
    ['other identity, lower', a, { identityId: 'bruno', score: 0.6 }, 'lowered'],
    ['other identity, higher', a, { identityId: 'bruno', score: 0.95 }, 'raised'],
  ] as const)('%s', (_label, stored, next, expected) => {
    expect(classifyRescoreChange(stored, next)).toBe(expected)
  })
})

describe('FaceRescoreJob', () => {
  it('raises, lowers, clears and adds suggestions against ONE gallery, writing changes only', async () => {
    const h = harness([
      face('new', [1, 0.1]),
      face('raised', [1, 0.1], { identityId: 'anna', score: 0.3 }),
      face('lowered', [0.7, 0.7], { identityId: 'anna', score: 0.99 }),
      face('cleared', [-1, 0], { identityId: 'anna', score: 0.9 }),
      face('same', [1, 0.1], { identityId: 'anna', score: NEAR_ANNA }),
      face('empty', [-1, 0]),
    ])
    const job = new FaceRescoreJob(h.ports)
    job.start()
    await job.whenSettled()

    const s = job.status()
    expect(s.state).toBe('completed')
    expect(s).toMatchObject({
      scanned: 6,
      total: 6,
      changed: 4,
      newlySuggested: 1,
      raised: 1,
      lowered: 1,
      cleared: 1,
      modelMismatch: 0,
    })
    expect(h.events.filter((e) => e === 'gallery')).toHaveLength(1)
    const written = new Map(h.applied.flat().map((u) => [u.faceId, u.suggestion]))
    expect([...written.keys()].sort()).toEqual(['cleared', 'lowered', 'new', 'raised'])
    expect(written.get('cleared')).toBeNull()
    expect(written.get('new')?.identityId).toBe('anna')
    // The result is persisted as the completed run's memory.
    expect(h.recorded).toEqual([s.fingerprint])
  })

  it('NEVER writes a face in an old feature space, and leaves its stored suggestion alone', async () => {
    const h = harness([
      face('old-space', [1, 0.1], { identityId: 'bruno', score: 0.77 }, 'previous-model'),
      face('ok', [1, 0.1]),
    ])
    const job = new FaceRescoreJob(h.ports)
    job.start()
    await job.whenSettled()
    expect(job.status().modelMismatch).toBe(1)
    expect(h.applied.flat().map((u) => u.faceId)).toEqual(['ok'])
  })

  it('pages in batches: one read, one transaction and one pause per batch', async () => {
    const faces: RescoreBatchRow[] = []
    for (let i = 0; i < RESCORE_BATCH_SIZE * 2 + 50; i++)
      faces.push(face(`f${String(i)}`, [1, 0.1]))
    const h = harness(faces)
    const job = new FaceRescoreJob(h.ports)
    job.start()
    await job.whenSettled()

    expect(h.events.filter((e) => e !== 'gallery')).toEqual([
      `load:${String(RESCORE_BATCH_SIZE)}`,
      `apply:${String(RESCORE_BATCH_SIZE)}`,
      'pause:ok',
      `load:${String(RESCORE_BATCH_SIZE)}`,
      `apply:${String(RESCORE_BATCH_SIZE)}`,
      'pause:ok',
      'load:50',
      'apply:50',
      'pause:ok',
    ])
    expect(job.status().batches).toBe(3)
  })

  it('is single-flight: a second start returns the running job and scans once', async () => {
    const h = harness([face('a', [1, 0.1])], { holdFirstPause: true })
    const job = new FaceRescoreJob(h.ports)
    const first = job.start()
    // Let the job reach its held pause.
    await new Promise((resolve) => setTimeout(resolve, 10))
    const second = job.start()
    expect(second.jobId).toBe(first.jobId)
    expect(job.isRunning()).toBe(true)
    expect(job.status().state).toBe('running')
    h.gate?.release()
    await job.whenSettled()
    expect(h.listCalls()).toBe(1)
    expect(job.status().state).toBe('completed')
    // After it settles a new job may start.
    job.start()
    await job.whenSettled()
    expect(h.listCalls()).toBe(2)
  })

  it('reports faces without a vector instead of folding them into "no match"', async () => {
    const h = harness([face('a', [1, 0.1])], { noVector: 3 })
    const job = new FaceRescoreJob(h.ports)
    job.start()
    await job.whenSettled()
    expect(job.status().noVector).toBe(3)
  })

  it('a failed batch fails the job and records nothing', async () => {
    const h = harness([face('a', [1, 0.1])], { failApply: true })
    const job = new FaceRescoreJob(h.ports)
    job.start()
    await job.whenSettled()
    expect(job.status().state).toBe('failed')
    expect(job.status().error).toBe('store down')
    expect(h.recorded).toEqual([])
  })
})

describe('computeRescoreFingerprint', () => {
  const manifest = [
    { sampleId: 's1', identityId: 'anna', modelId: 'm1' },
    { sampleId: 's2', identityId: 'bruno', modelId: 'm1' },
  ]
  const marker = { count: 10, maxTimestamp: 5_000 }
  const base = computeRescoreFingerprint({ manifest, marker, clusterModelId: 'm1' })

  it('is stable for an unchanged archive, whatever the read order', () => {
    const again = computeRescoreFingerprint({
      manifest: [...manifest].reverse(),
      marker: { ...marker },
      clusterModelId: 'm1',
    })
    expect(again.combined).toBe(base.combined)
  })

  it('changes when a sample is added', () => {
    const f = computeRescoreFingerprint({
      manifest: [...manifest, { sampleId: 's3', identityId: 'anna', modelId: 'm1' }],
      marker,
      clusterModelId: 'm1',
    })
    expect(f.combined).not.toBe(base.combined)
    expect(f.gallery).not.toBe(base.gallery)
  })

  it('changes when a sample is removed', () => {
    const f = computeRescoreFingerprint({
      manifest: manifest.slice(1),
      marker,
      clusterModelId: 'm1',
    })
    expect(f.combined).not.toBe(base.combined)
  })

  it('changes when a sample is restamped to another model, or the cluster model flips', () => {
    const restamped = computeRescoreFingerprint({
      manifest: [{ ...manifest[0]!, modelId: 'm2' }, manifest[1]!],
      marker,
      clusterModelId: 'm1',
    })
    expect(restamped.combined).not.toBe(base.combined)
    const flipped = computeRescoreFingerprint({ manifest, marker, clusterModelId: 'm2' })
    expect(flipped.combined).not.toBe(base.combined)
  })

  it('changes when a new unassigned face arrives or one leaves', () => {
    const arrived = computeRescoreFingerprint({
      manifest,
      marker: { count: 11, maxTimestamp: 6_000 },
      clusterModelId: 'm1',
    })
    expect(arrived.combined).not.toBe(base.combined)
    expect(arrived.gallery).toBe(base.gallery)
    const left = computeRescoreFingerprint({
      manifest,
      marker: { count: 9, maxTimestamp: 5_000 },
      clusterModelId: 'm1',
    })
    expect(left.combined).not.toBe(base.combined)
  })
})
