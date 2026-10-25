import { describe, expect, it } from 'vitest'
import {
  type GalleryBlobState,
  type GalleryReconcileDeps,
  type GalleryReconcileSampleRow,
  reconcileGallerySamples,
} from '../gallery-reconcile.js'

const NOW = 1_000_000_000
const OLD = NOW - 60 * 60 * 1000
const FRESH = NOW - 1000

interface Harness {
  readonly deps: GalleryReconcileDeps
  readonly removed: Array<{ identityId: string; sampleId: string }>
}

function harness(
  samples: Record<string, readonly GalleryReconcileSampleRow[]>,
  states: Record<number, GalleryBlobState | Error>,
): Harness {
  const removed: Array<{ identityId: string; sampleId: string }> = []
  const deps: GalleryReconcileDeps = {
    listIdentities: async () => Object.keys(samples).map((id) => ({ id, name: `name-${id}` })),
    listSamples: async (identityId) => samples[identityId] ?? [],
    blobState: async (mediaId) => {
      const s = states[mediaId]
      if (s === undefined) throw new Error(`unexpected probe: ${mediaId}`)
      if (s instanceof Error) throw s
      return s
    },
    removeSample: async (identityId, sampleId) => {
      removed.push({ identityId, sampleId })
    },
    logger: { info: () => undefined, warn: () => undefined },
  }
  return { deps, removed }
}

const OPTS = { now: NOW, graceMs: 10 * 60 * 1000, maxReclaimPerRun: 16 }

describe('reconcileGallerySamples', () => {
  it('removes a sample whose blob is gone, keeps one whose blob exists', async () => {
    const h = harness(
      {
        'i-1': [
          { id: 's-dead', mediaId: 1, addedAt: OLD },
          { id: 's-live', mediaId: 2, addedAt: OLD },
        ],
      },
      { 1: 'missing-blob', 2: 'exists' },
    )

    const report = await reconcileGallerySamples(h.deps, OPTS)

    expect(h.removed).toEqual([{ identityId: 'i-1', sampleId: 's-dead' }])
    expect(report).toMatchObject({ checked: 2, reclaimed: 1, keyless: 0 })
  })

  it('a reference whose INDEX ROW is gone counts as deleted too', async () => {
    const h = harness({ 'i-1': [{ id: 's-1', mediaId: 3, addedAt: OLD }] }, { 3: 'missing-row' })

    const report = await reconcileGallerySamples(h.deps, OPTS)

    expect(h.removed).toHaveLength(1)
    expect(report.reclaimed).toBe(1)
  })

  it('a sample inside the grace window is never touched — the write race is not a wipe', async () => {
    const h = harness(
      { 'i-1': [{ id: 's-fresh', mediaId: 4, addedAt: FRESH }] },
      { 4: 'missing-blob' },
    )

    const report = await reconcileGallerySamples(h.deps, OPTS)

    expect(h.removed).toHaveLength(0)
    expect(report.skippedGrace).toBe(1)
  })

  it('a mediaId-less row is counted and left alone — there is nothing to probe', async () => {
    const h = harness({ 'i-1': [{ id: 's-nokey', addedAt: OLD }] }, {})

    const report = await reconcileGallerySamples(h.deps, OPTS)

    expect(h.removed).toHaveLength(0)
    expect(report.keyless).toBe(1)
  })

  it('a probe that THROWS aborts the whole pass and keeps every remaining row', async () => {
    const h = harness(
      {
        'i-1': [
          { id: 's-1', mediaId: 5, addedAt: OLD },
          { id: 's-2', mediaId: 6, addedAt: OLD },
        ],
      },
      { 5: new Error('volume unreachable'), 6: 'missing-blob' },
    )

    const report = await reconcileGallerySamples(h.deps, OPTS)

    expect(h.removed).toHaveLength(0)
    expect(report.aborted).toContain('volume unreachable')
  })

  it('stops at the reclaim ceiling instead of emptying a gallery on a lying probe', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: `s-${i}`,
      mediaId: 100 + i,
      addedAt: OLD,
    }))
    const states = Object.fromEntries(rows.map((r) => [r.mediaId, 'missing-blob' as const]))
    const h = harness({ 'i-1': rows }, states)

    const report = await reconcileGallerySamples(h.deps, {
      ...OPTS,
      maxReclaimPerRun: 2,
    })

    expect(h.removed).toHaveLength(2)
    expect(report.stoppedByCeiling).toBe(true)
  })
})

describe('reconcileGallerySamples — a location that MOVED is not a gallery that died', () => {
  /** Ten old samples, every blob unreadable — the shape of a repointed volume. */
  function everythingMissing(): Harness {
    const rows: GalleryReconcileSampleRow[] = Array.from({ length: 10 }, (_, i) => ({
      id: `s${i}`,
      mediaId: 200 + i,
      addedAt: OLD,
    }))
    const states: Record<number, GalleryBlobState> = {}
    for (const row of rows) if (row.mediaId !== undefined) states[row.mediaId] = 'missing-blob'
    return harness({ p1: rows }, states)
  }

  it('removes NOTHING when every probe comes back missing', () => {
    // What actually happened on the hub, 2026-09-08: the `galleryMedia`
    // location was re-pointed at a new basePath and the blobs stayed at the
    // old one. Every row then probes "missing", and this pass — whose rule is
    // "not on the filesystem means deleted" — was one boot away from removing
    // the references, 16 per run, until the gallery was gone. The pixels were
    // never deleted; they were 304 files sitting under the previous path.
    //
    // A MASS miss is evidence about the volume, not about the samples.
    const h = everythingMissing()
    return reconcileGallerySamples(h.deps, OPTS).then((report) => {
      expect(h.removed).toEqual([])
      expect(report.reclaimed).toBe(0)
      expect(report.aborted).toBeDefined()
    })
  })

  it('still collects a genuine straggler among healthy samples', async () => {
    // The rule must not become "never delete anything": one dead reference in
    // a gallery that is otherwise present is exactly what this pass is for.
    const rows: GalleryReconcileSampleRow[] = Array.from({ length: 10 }, (_, i) => ({
      id: `s${i}`,
      mediaId: 300 + i,
      addedAt: OLD,
    }))
    const states: Record<number, GalleryBlobState> = {}
    for (const row of rows) if (row.mediaId !== undefined) states[row.mediaId] = 'exists'
    states[307] = 'missing-blob'
    const h = harness({ p1: rows }, states)

    const report = await reconcileGallerySamples(h.deps, OPTS)

    expect(h.removed).toEqual([{ identityId: 'p1', sampleId: 's7' }])
    expect(report.aborted).toBeUndefined()
  })

  it('does not cry mass-miss on a gallery too small to judge', async () => {
    // Two samples, both gone, is a person who deleted their own photos — not
    // a volume that moved. The bar needs a floor or it protects nothing that
    // small and refuses to work on new installs.
    const rows: GalleryReconcileSampleRow[] = [
      { id: 's0', mediaId: 400, addedAt: OLD },
      { id: 's1', mediaId: 401, addedAt: OLD },
    ]
    const h = harness({ p1: rows }, { 400: 'missing-blob', 401: 'missing-blob' })

    const report = await reconcileGallerySamples(h.deps, OPTS)

    expect(report.reclaimed).toBe(2)
    expect(report.aborted).toBeUndefined()
  })
})
