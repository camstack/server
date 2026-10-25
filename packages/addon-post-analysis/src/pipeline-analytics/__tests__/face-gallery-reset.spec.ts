/**
 * The face-gallery reset (D644): keep the best `keepPerIdentity` samples of
 * every identity, discard the rest and every pending face.
 *
 * The operator decided it ("cancelliamo e ripartiamo, tieni 3 esemplari
 * migliori per soggetto"), so what is pinned here is not WHETHER it deletes but
 * that it deletes only what the rule says, in an order that can never leave an
 * identity worse than before a failed step:
 *
 *  - the selection rule — photo v2, then detected v2, then photo v1, then
 *    detected v1, each tier ranked by closeness to the identity's centroid;
 *  - a re-aligned replacement is ADDED and READ BACK before anything of that
 *    identity is removed;
 *  - a refused or failed re-alignment keeps the old sample as it is;
 *  - an identity never ends with zero samples;
 *  - a dry run writes nothing;
 *  - pending faces go, and only pending ones (assigned history is the store's
 *    query, pinned in `face-store-pending.spec.ts`).
 */
import { describe, expect, it } from 'vitest'
import { FACE_ALIGNMENT_SCRFD_V2 } from '../face-alignment-version.js'
import {
  DEFAULT_KEEP_PER_IDENTITY,
  type GalleryResetDeps,
  type PendingFaceRef,
  type RealignVerdict,
  type ResetAddSampleInput,
  type ResetSample,
  resetGalleryToCore,
  selectCoreSamples,
} from '../face-gallery-reset.js'

const MODEL = 'auraface-r100'

interface SampleSpec {
  readonly id: string
  readonly source: 'photo' | 'detected'
  readonly v2: boolean
  /** Unit vector direction — closeness to the centroid is decided by it. */
  readonly vector: readonly number[]
  readonly modelId?: string
}

function sample(identityId: string, spec: SampleSpec, addedAt: number): ResetSample {
  return {
    sampleId: spec.id,
    identityId,
    source: spec.source,
    modelId: spec.modelId ?? MODEL,
    mediaId: 1000 + addedAt,
    deviceId: 101,
    addedAt,
    ...(spec.v2 ? { alignment: FACE_ALIGNMENT_SCRFD_V2 } : {}),
  }
}

// The centroid of the vectors below sits near [1,0,0]; `far` points away.
const near = [1, 0, 0]
const mid = [0.8, 0.6, 0]
const far = [0, 0, 1]

describe('selectCoreSamples', () => {
  it('prefers photo v2, then detected v2, then the closest v1 detected — exactly keep', () => {
    const specs: SampleSpec[] = [
      { id: 'd1-far', source: 'detected', v2: false, vector: far },
      { id: 'd1-near', source: 'detected', v2: false, vector: near },
      { id: 'd2-mid', source: 'detected', v2: true, vector: mid },
      { id: 'p2', source: 'photo', v2: true, vector: mid },
      { id: 'd1-mid', source: 'detected', v2: false, vector: near },
    ]
    const samples = specs.map((s, i) => sample('i', s, i))
    const vectors = new Map(specs.map((s) => [s.id, s.vector]))
    const picks = selectCoreSamples(samples, vectors, 3)
    expect(picks.map((p) => p.sample.sampleId)).toEqual(['p2', 'd2-mid', expect.any(String)])
    expect(picks.map((p) => p.tier)).toEqual(['photo-v2', 'detected-v2', 'detected-v1'])
    // The v1 pick is one of the two nearest, never the far one.
    expect(['d1-near', 'd1-mid']).toContain(picks[2]?.sample.sampleId)
  })

  it('ranks v1 detected samples by closeness to the identity centroid (Alice: 0 photo)', () => {
    const specs: SampleSpec[] = [
      { id: 'a', source: 'detected', v2: false, vector: far },
      { id: 'b', source: 'detected', v2: false, vector: near },
      { id: 'c', source: 'detected', v2: false, vector: near },
      { id: 'd', source: 'detected', v2: false, vector: mid },
      { id: 'e', source: 'detected', v2: false, vector: near },
    ]
    const samples = specs.map((s, i) => sample('g', s, i))
    const picks = selectCoreSamples(samples, new Map(specs.map((s) => [s.id, s.vector])), 3)
    expect(picks.map((p) => p.sample.sampleId).toSorted()).toEqual(['b', 'c', 'e'])
    for (const p of picks) expect(p.centroidCosine).not.toBeNull()
  })

  it('keeps fewer when the identity has fewer', () => {
    const specs: SampleSpec[] = [{ id: 'only', source: 'detected', v2: false, vector: near }]
    const picks = selectCoreSamples(
      specs.map((s, i) => sample('i', s, i)),
      new Map(specs.map((s) => [s.id, s.vector])),
      3,
    )
    expect(picks.map((p) => p.sample.sampleId)).toEqual(['only'])
  })

  it('a sample of another model space or with no vector ranks last in its tier', () => {
    const specs: SampleSpec[] = [
      { id: 'foreign', source: 'detected', v2: false, vector: near, modelId: 'arcface-r100' },
      { id: 'novec', source: 'detected', v2: false, vector: [] },
      { id: 'x', source: 'detected', v2: false, vector: near },
      { id: 'y', source: 'detected', v2: false, vector: near },
    ]
    const samples = specs.map((s, i) => sample('i', s, i))
    const vectors = new Map(specs.filter((s) => s.vector.length > 0).map((s) => [s.id, s.vector]))
    const picks = selectCoreSamples(samples, vectors, 2)
    expect(picks.map((p) => p.sample.sampleId).toSorted()).toEqual(['x', 'y'])
  })

  it('the default is three per identity', () => {
    expect(DEFAULT_KEEP_PER_IDENTITY).toBe(3)
  })
})

// ── the run ─────────────────────────────────────────────────────────────────

interface Harness {
  readonly deps: GalleryResetDeps
  readonly table: Map<string, ResetSample[]>
  readonly vectors: Map<string, readonly number[]>
  readonly calls: string[]
  readonly deletedFaces: PendingFaceRef[]
  realign: (s: ResetSample) => RealignVerdict
  /** Sample ids whose read-back answers "absent". */
  readonly phantom: Set<string>
  pending: PendingFaceRef[]
}

function harness(identities: Record<string, readonly SampleSpec[]>): Harness {
  const table = new Map<string, ResetSample[]>()
  const vectors = new Map<string, readonly number[]>()
  let t = 0
  for (const [identityId, specs] of Object.entries(identities)) {
    table.set(
      identityId,
      specs.map((s) => sample(identityId, s, t++)),
    )
    for (const s of specs) if (s.vector.length > 0) vectors.set(s.id, s.vector)
  }
  const calls: string[] = []
  const deletedFaces: PendingFaceRef[] = []
  let nextMedia = 5000
  let nextSample = 0
  const h: Harness = {
    table,
    vectors,
    calls,
    deletedFaces,
    phantom: new Set(),
    pending: [],
    realign: () => ({ kind: 'refused', reason: 'not configured' }),
    deps: {
      listIdentities: async () => [...table.keys()].map((id) => ({ id, name: id.toUpperCase() })),
      listSamples: async (identityId) => [...(table.get(identityId) ?? [])],
      loadVectors: async (ids) =>
        new Map(
          ids.flatMap((id) => {
            const v = vectors.get(id)
            return v === undefined ? [] : [[id, v] as const]
          }),
        ),
      realign: async (s) => {
        calls.push(`realign:${s.sampleId}`)
        return h.realign(s)
      },
      putTemplate: async () => {
        calls.push('putTemplate')
        return nextMedia++
      },
      deleteMedia: async (id) => {
        calls.push(`deleteMedia:${id}`)
      },
      addSample: async (input: ResetAddSampleInput) => {
        const id = `new-${nextSample++}`
        calls.push(`add:${input.identityId}:${id}`)
        const row: ResetSample = {
          sampleId: id,
          identityId: input.identityId,
          source: input.source,
          modelId: input.modelId,
          mediaId: input.mediaId,
          addedAt: 999,
          alignment: input.alignment,
          replacesSampleId: input.replacesSampleId,
          ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
        }
        table.get(input.identityId)?.push(row)
        vectors.set(id, input.embedding)
        return { id }
      },
      sampleExists: async (id) => {
        if (h.phantom.has(id)) return false
        return [...table.values()].some((rows) => rows.some((r) => r.sampleId === id))
      },
      removeSample: async (identityId, sampleId) => {
        calls.push(`remove:${identityId}:${sampleId}`)
        const rows = table.get(identityId) ?? []
        table.set(
          identityId,
          rows.filter((r) => r.sampleId !== sampleId),
        )
      },
      listPendingFaces: async () => [...h.pending],
      deleteFaces: async (faces) => {
        calls.push(`deleteFaces:${faces.length}`)
        deletedFaces.push(...faces)
        return faces.length
      },
      refreshGallery: async () => {
        calls.push('refresh')
      },
      logger: { info: () => {}, warn: () => {} },
    },
  }
  return h
}

const alice: SampleSpec[] = [
  { id: 'g-far', source: 'detected', v2: false, vector: far },
  { id: 'g1', source: 'detected', v2: false, vector: near },
  { id: 'g2', source: 'detected', v2: false, vector: near },
  { id: 'g3', source: 'detected', v2: false, vector: mid },
  { id: 'g-far2', source: 'detected', v2: false, vector: far },
]
const dave: SampleSpec[] = [
  { id: 'p1', source: 'photo', v2: true, vector: near },
  { id: 'p2', source: 'photo', v2: true, vector: near },
  { id: 'p3', source: 'photo', v2: true, vector: mid },
  { id: 'm-d1', source: 'detected', v2: false, vector: near },
  { id: 'm-d2', source: 'detected', v2: false, vector: far },
]

function ok(s: ResetSample): RealignVerdict {
  return {
    kind: 'realigned',
    embedding: [0.9, 0.1, 0],
    modelId: s.modelId,
    templateJpeg: Buffer.from(`t-${s.sampleId}`),
    cosineToOld: 0.7,
    score: 0.8,
  }
}

describe('resetGalleryToCore', () => {
  it('keeps the photo v2 samples and removes the rest (Dave)', async () => {
    const h = harness({ m: dave })
    const result = await resetGalleryToCore(h.deps, {})
    expect(
      h.table
        .get('m')
        ?.map((r) => r.sampleId)
        .toSorted(),
    ).toEqual(['p1', 'p2', 'p3'])
    expect(result.identities[0]?.kept.map((k) => k.reason)).toEqual([
      'photo-v2',
      'photo-v2',
      'photo-v2',
    ])
    expect(result.totals.removed).toBe(2)
  })

  it('without realignDetected, the v1 representatives are KEPT AS THEY ARE — nothing is written', async () => {
    const h = harness({ g: alice })
    const result = await resetGalleryToCore(h.deps, {})
    expect(h.calls.filter((c) => c.startsWith('realign') || c === 'putTemplate')).toEqual([])
    expect(
      h.table
        .get('g')
        ?.map((r) => r.sampleId)
        .toSorted(),
    ).toEqual(['g1', 'g2', 'g3'])
    expect(result.identities[0]?.kept.every((k) => k.reason === 'kept-as-is')).toBe(true)
  })

  it('re-aligned replacements are ADDED and read back before ANY removal of that identity', async () => {
    const h = harness({ g: alice })
    h.realign = ok
    const result = await resetGalleryToCore(h.deps, { realignDetected: true })
    const firstRemove = h.calls.findIndex((c) => c.startsWith('remove:g:'))
    const lastAdd = h.calls.map((c) => c.startsWith('add:g:')).lastIndexOf(true)
    expect(lastAdd).toBeGreaterThan(-1)
    expect(firstRemove).toBeGreaterThan(lastAdd)
    // The three new rows stand, stamped v2; every old row went.
    const rows = h.table.get('g') ?? []
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.alignment === FACE_ALIGNMENT_SCRFD_V2)).toBe(true)
    expect(result.identities[0]?.kept.every((k) => k.reason === 'realigned')).toBe(true)
  })

  it('a refused re-alignment keeps THAT sample as it is', async () => {
    const h = harness({ g: alice })
    h.realign = (s) => (s.sampleId === 'g2' ? { kind: 'refused', reason: 'below-floor' } : ok(s))
    const result = await resetGalleryToCore(h.deps, { realignDetected: true })
    const ids = h.table.get('g')?.map((r) => r.sampleId) ?? []
    expect(ids).toContain('g2')
    expect(ids).toHaveLength(3)
    const kept = result.identities[0]?.kept.find((k) => k.sampleId === 'g2')
    expect(kept?.reason).toBe('kept-as-is')
    expect(kept?.keptAsIsBecause).toBe('below-floor')
  })

  it('a replacement that does not read back keeps the old sample, and its blob is reclaimed', async () => {
    const h = harness({ g: alice })
    h.realign = ok
    // The first new row "lands" but the read-back says it is absent.
    h.phantom.add('new-0')
    await resetGalleryToCore(h.deps, { realignDetected: true })
    const ids = h.table.get('g')?.map((r) => r.sampleId) ?? []
    // The old sample of the phantom pick is still there.
    expect(ids.filter((id) => id.startsWith('g')).length).toBeGreaterThanOrEqual(1)
    expect(ids).toHaveLength(4) // 2 realigned + 1 old kept + the phantom (never removed by the reset)
    expect(h.calls.filter((c) => c.startsWith('deleteMedia:'))).toEqual(['deleteMedia:5000'])
  })

  it('never leaves an identity with zero samples, even when every kept read-back fails', async () => {
    const h = harness({ g: alice })
    for (const id of ['g1', 'g2', 'g3']) h.phantom.add(id)
    const result = await resetGalleryToCore(h.deps, {})
    expect(h.calls.some((c) => c.startsWith('remove:g:'))).toBe(false)
    expect(h.table.get('g')).toHaveLength(5)
    expect(result.identities[0]?.skipped).toBeDefined()
  })

  it('deletes the pending faces', async () => {
    const h = harness({ m: dave })
    h.pending = [
      { faceId: 'face-a', deviceId: 101 },
      { faceId: 'face-b', deviceId: 102 },
    ]
    const result = await resetGalleryToCore(h.deps, {})
    expect(h.deletedFaces.map((f) => f.faceId)).toEqual(['face-a', 'face-b'])
    expect(result.pendingFaces).toEqual({ found: 2, deleted: 2 })
  })

  it('a DRY RUN writes nothing — no template, no row, no removal, no face — and reports the plan', async () => {
    const h = harness({ g: alice, m: dave })
    h.realign = ok
    h.pending = [{ faceId: 'face-a', deviceId: 101 }]
    const result = await resetGalleryToCore(h.deps, { dryRun: true, realignDetected: true })
    expect(h.calls.filter((c) => !c.startsWith('realign:'))).toEqual([])
    expect(h.table.get('g')).toHaveLength(5)
    expect(h.table.get('m')).toHaveLength(5)
    expect(result.dryRun).toBe(true)
    expect(result.totals.wouldRemove).toBe(4)
    expect(result.pendingFaces).toEqual({ found: 1, deleted: 0 })
    expect(result.identities.find((i) => i.identityId === 'g')?.kept.map((k) => k.reason)).toEqual([
      'realigned',
      'realigned',
      'realigned',
    ])
  })

  it('is idempotent: a second run removes nothing', async () => {
    const h = harness({ g: alice, m: dave })
    await resetGalleryToCore(h.deps, {})
    h.calls.length = 0
    const again = await resetGalleryToCore(h.deps, {})
    expect(h.calls.filter((c) => c.startsWith('remove:'))).toEqual([])
    expect(again.totals.removed).toBe(0)
  })

  it('a template that cannot be WRITTEN keeps that sample as it is, logged', async () => {
    const h = harness({ g: alice })
    h.realign = ok
    let first = true
    const warn: string[] = []
    const result = await resetGalleryToCore(
      {
        ...h.deps,
        putTemplate: async (s, jpeg) => {
          if (first) {
            first = false
            throw new Error('disk full')
          }
          return h.deps.putTemplate(s, jpeg)
        },
        logger: { info: () => {}, warn: (m) => warn.push(m) },
      },
      { realignDetected: true },
    )
    const kept = result.identities[0]?.kept ?? []
    expect(kept.filter((k) => k.reason === 'kept-as-is')).toHaveLength(1)
    expect(kept.filter((k) => k.reason === 'realigned')).toHaveLength(2)
    expect(warn.some((m) => m.includes('template could not be written'))).toBe(true)
  })

  it('refreshes the gallery even when the run throws midway', async () => {
    const h = harness({ g: alice, m: dave })
    await expect(
      resetGalleryToCore(
        {
          ...h.deps,
          listPendingFaces: async () => {
            throw new Error('store down')
          },
        },
        {},
      ),
    ).rejects.toThrow('store down')
    expect(h.calls).toContain('refresh')
  })

  it('after a crash, a rerun FINISHES: a landed replacement stands and its v1 is never re-aligned', async () => {
    const h = harness({ g: alice })
    h.realign = ok
    // The first run lands every replacement, then "crashes" before removing anything.
    await resetGalleryToCore(
      {
        ...h.deps,
        removeSample: async () => {
          throw new Error('crash')
        },
      },
      { realignDetected: true },
    )
    const realignedBefore = h.calls.filter((c) => c.startsWith('realign:')).length
    h.calls.length = 0
    const rerun = await resetGalleryToCore(h.deps, { realignDetected: true })
    expect(h.calls.filter((c) => c.startsWith('realign:'))).toEqual([])
    expect(h.calls.filter((c) => c.startsWith('add:'))).toEqual([])
    expect(realignedBefore).toBe(3)
    const rows = h.table.get('g') ?? []
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.replacesSampleId !== undefined)).toBe(true)
    expect(rerun.identities[0]?.kept.every((k) => k.reason === 'realigned')).toBe(true)
  })

  it('after a PARTIAL crash, the replaced v1 sample is never re-aligned again', async () => {
    const h = harness({ g: alice })
    // Run 1: only the first pick re-aligns and lands; then nothing is removed.
    let n = 0
    h.realign = (s) => (n++ === 0 ? ok(s) : { kind: 'refused', reason: 'flaky node' })
    await resetGalleryToCore(
      {
        ...h.deps,
        removeSample: async () => {
          throw new Error('crash')
        },
      },
      { realignDetected: true },
    )
    const replaced = (h.table.get('g') ?? []).find((r) => r.replacesSampleId !== undefined)
    expect(replaced).toBeDefined()
    h.calls.length = 0
    h.realign = ok
    await resetGalleryToCore(h.deps, { realignDetected: true })
    expect(h.calls).not.toContain(`realign:${replaced?.replacesSampleId ?? ''}`)
    expect(h.table.get('g')?.map((r) => r.sampleId)).not.toContain(replaced?.replacesSampleId)
  })
})
