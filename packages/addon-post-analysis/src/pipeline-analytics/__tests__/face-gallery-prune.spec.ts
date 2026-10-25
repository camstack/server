/**
 * Pruning old-aligned DETECTED samples once the new alignment has taken over
 * (D643, operator decision: 10).
 *
 * The measurement (2026-09-26) is why the rule waits: against today's old
 * gallery a new-aligned camera face auto-matches ~10 points less often, and the
 * old samples are what carries the match rate until enough new ones exist. So
 * the prune is a DESTRUCTIVE act gated on a count — which makes the read it
 * rests on the thing to be careful about (D49): a read that failed must change
 * nothing, and the plan is only acted on when a second read agrees.
 */
import { describe, expect, it } from 'vitest'
import { FACE_ALIGNMENT_SCRFD_V2 } from '../face-alignment-version.js'
import {
  DEFAULT_PRUNE_MIN_V2_DETECTED,
  type GalleryPruneDeps,
  type PruneSample,
  planV1DetectedPrune,
  pruneV1DetectedSamples,
} from '../face-gallery-prune.js'

function detected(id: string, v2: boolean, deviceId = 101): PruneSample {
  return {
    id,
    source: 'detected',
    deviceId,
    ...(v2 ? { alignment: FACE_ALIGNMENT_SCRFD_V2 } : {}),
  }
}

function photo(id: string, v2: boolean): PruneSample {
  return { id, source: 'photo', ...(v2 ? { alignment: FACE_ALIGNMENT_SCRFD_V2 } : {}) }
}

function many(prefix: string, n: number, v2: boolean): PruneSample[] {
  return Array.from({ length: n }, (_, i) => detected(`${prefix}${i}`, v2))
}

describe('planV1DetectedPrune', () => {
  it('the operator threshold is 10', () => {
    expect(DEFAULT_PRUNE_MIN_V2_DETECTED).toBe(10)
  })

  it('at 10 v2 DETECTED samples, every v1 detected sample goes', () => {
    const plan = planV1DetectedPrune([...many('new', 10, true), ...many('old', 5, false)])
    expect(plan.remove.toSorted()).toEqual(['old0', 'old1', 'old2', 'old3', 'old4'])
    expect(plan.v2Detected).toBe(10)
  })

  it('at 9, nothing goes — the old samples still carry the match rate', () => {
    const plan = planV1DetectedPrune([...many('new', 9, true), ...many('old', 5, false)])
    expect(plan.remove).toEqual([])
  })

  it('never counts v2 PHOTO samples toward the threshold, and never removes a photo sample', () => {
    const samples = [
      ...many('new', 9, true),
      photo('p-new', true),
      photo('p-old', false),
      ...many('old', 3, false),
    ]
    expect(planV1DetectedPrune(samples).remove).toEqual([])
    const plan = planV1DetectedPrune([...samples, detected('new9', true)])
    expect(plan.remove).not.toContain('p-old')
    expect(plan.remove).not.toContain('p-new')
    expect(plan.remove.toSorted()).toEqual(['old0', 'old1', 'old2'])
  })

  it('never removes the last sample of an identity, whatever the threshold says', () => {
    const plan = planV1DetectedPrune(many('old', 2, false), 0)
    expect(plan.remove.length).toBeLessThan(2)
  })
})

// ── the sweep ───────────────────────────────────────────────────────────────

interface Harness {
  readonly deps: GalleryPruneDeps
  readonly table: Map<string, PruneSample[]>
  readonly removed: Array<{ identityId: string; sampleId: string }>
  readonly warns: Array<{ message: string; meta: Record<string, unknown> }>
  readonly infos: Array<{
    message: string
    tags: Record<string, unknown>
    meta: Record<string, unknown>
  }>
  refreshed: number
}

function harness(table: Map<string, PruneSample[]>, over: Partial<GalleryPruneDeps> = {}): Harness {
  const removed: Harness['removed'] = []
  const warns: Harness['warns'] = []
  const infos: Harness['infos'] = []
  const h: Harness = {
    table,
    removed,
    warns,
    infos,
    refreshed: 0,
    deps: {
      listIdentities: async () => [...table.keys()].map((id) => ({ id, name: `name-${id}` })),
      listSamples: async (identityId) => [...(table.get(identityId) ?? [])],
      removeSample: async (identityId, sampleId) => {
        removed.push({ identityId, sampleId })
        table.set(
          identityId,
          (table.get(identityId) ?? []).filter((s) => s.id !== sampleId),
        )
      },
      refreshGallery: () => {
        h.refreshed += 1
      },
      logger: {
        info: (message, extras) =>
          infos.push({ message, tags: { ...extras?.tags }, meta: extras?.meta ?? {} }),
        warn: (message, extras) => warns.push({ message, meta: extras?.meta ?? {} }),
      },
      ...over,
    },
  }
  return h
}

describe('pruneV1DetectedSamples', () => {
  it('removes v1 detected samples of an identity past the threshold and reports every identity', async () => {
    const h = harness(
      new Map([
        ['alice', [...many('new', 10, true), ...many('old', 3, false)]],
        ['carol', [...many('new', 4, true), ...many('old', 3, false)]],
      ]),
    )
    const result = await pruneV1DetectedSamples(h.deps, {})

    expect(h.removed.map((r) => r.sampleId).toSorted()).toEqual(['old0', 'old1', 'old2'])
    expect(h.removed.every((r) => r.identityId === 'alice')).toBe(true)
    expect(result.byIdentity).toEqual([
      {
        identityId: 'alice',
        name: 'name-alice',
        removed: 3,
        v1Detected: 0,
        v2Detected: 10,
        v1Photo: 0,
      },
      {
        identityId: 'carol',
        name: 'name-carol',
        removed: 0,
        v1Detected: 3,
        v2Detected: 4,
        v1Photo: 0,
      },
    ])
    expect(h.refreshed).toBe(1)
  })

  it('every removal line carries the camera in tags.deviceId and the identity in meta', async () => {
    const h = harness(new Map([['g', [...many('new', 10, true), detected('old', false, 102)]]]))
    await pruneV1DetectedSamples(h.deps, {})
    const line = h.infos.find((l) => l.meta['sampleId'] === 'old')
    expect(line?.tags['deviceId']).toBe(102)
    expect(line?.meta['identityId']).toBe('g')
  })

  it('a FAILED read changes nothing and is logged', async () => {
    const h = harness(new Map([['g', [...many('new', 10, true), ...many('old', 3, false)]]]), {
      listSamples: async () => {
        throw new Error('sqlite busy')
      },
    })
    const result = await pruneV1DetectedSamples(h.deps, {})
    expect(h.removed).toEqual([])
    expect(result.byIdentity).toEqual([])
    expect(h.warns.some((w) => w.meta['identityId'] === 'g')).toBe(true)
    expect(h.refreshed).toBe(0)
  })

  it('a failed IDENTITY list changes nothing and is logged', async () => {
    const h = harness(new Map([['g', [...many('new', 10, true), ...many('old', 3, false)]]]), {
      listIdentities: async () => {
        throw new Error('sqlite busy')
      },
    })
    await pruneV1DetectedSamples(h.deps, {})
    expect(h.removed).toEqual([])
    expect(h.warns).toHaveLength(1)
  })

  it('acts only when a SECOND read agrees (D49): a confirm read that fails removes nothing', async () => {
    const table = new Map([['g', [...many('new', 10, true), ...many('old', 3, false)]]])
    let reads = 0
    const h = harness(table, {
      listSamples: async (identityId) => {
        reads += 1
        if (reads === 2) throw new Error('second read failed')
        return [...(table.get(identityId) ?? [])]
      },
    })
    await pruneV1DetectedSamples(h.deps, {})
    expect(h.removed).toEqual([])
  })

  it('a confirm read that no longer shows the threshold removes nothing', async () => {
    const table = new Map([['g', [...many('new', 10, true), ...many('old', 3, false)]]])
    let reads = 0
    const h = harness(table, {
      listSamples: async () => {
        reads += 1
        // Between the two reads the operator removed a new sample: 9 left.
        return reads === 1
          ? [...many('new', 10, true), ...many('old', 3, false)]
          : [...many('new', 9, true), ...many('old', 3, false)]
      },
    })
    await pruneV1DetectedSamples(h.deps, {})
    expect(h.removed).toEqual([])
  })

  it('narrows to one identity when asked (the after-enrol trigger)', async () => {
    const h = harness(
      new Map([
        ['a', [...many('new', 10, true), ...many('old', 1, false)]],
        ['b', [...many('bnew', 10, true), ...many('bold', 1, false)]],
      ]),
    )
    const result = await pruneV1DetectedSamples(h.deps, { identityId: 'b' })
    expect(h.removed).toEqual([{ identityId: 'b', sampleId: 'bold0' }])
    expect(result.byIdentity.map((r) => r.identityId)).toEqual(['b'])
  })

  it('one removal that throws is logged and the rest still go', async () => {
    const table = new Map([['g', [...many('new', 10, true), ...many('old', 2, false)]]])
    const h = harness(table)
    const base = h.deps.removeSample
    const deps: GalleryPruneDeps = {
      ...h.deps,
      removeSample: async (identityId, sampleId) => {
        if (sampleId === 'old0') throw new Error('row locked')
        await base(identityId, sampleId)
      },
    }
    const result = await pruneV1DetectedSamples(deps, {})
    expect(h.removed.map((r) => r.sampleId)).toEqual(['old1'])
    expect(result.byIdentity[0]).toMatchObject({ removed: 1, v1Detected: 1 })
    expect(h.warns.some((w) => w.meta['sampleId'] === 'old0')).toBe(true)
  })
})
