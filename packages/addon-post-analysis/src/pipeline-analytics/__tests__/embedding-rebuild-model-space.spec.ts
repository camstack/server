/**
 * The CLIP rebuild as the second half of a model change.
 *
 * The property that matters is the boring one: a pass run with the model that
 * is ALREADY stored must be a declared no-op — zero media reads, zero
 * dispatches, and a counter that says so. That is the only way to distinguish
 * "the mechanism read the right state and had nothing to do" from "the
 * mechanism did nothing", because the index looks identical either way.
 *
 * And the failure direction is asymmetric: skipping work because a lookup
 * failed is data loss, doing redundant work is a cost. So a failed lookup must
 * process the page in full.
 */
import { describe, expect, it } from 'vitest'
import {
  type RebuildDeps,
  type RebuildSource,
  rebuildObjectEmbeddings,
} from '../embedding-rebuild.js'

const silent = { info: () => undefined, warn: () => undefined }

interface Harness {
  readonly deps: RebuildDeps
  readonly loaded: string[]
  readonly embedded: string[]
}

function harness(trackIds: readonly string[], filter: RebuildDeps['filterOutOfSpace']): Harness {
  const loaded: string[] = []
  const embedded: string[] = []
  const source = (trackId: string): RebuildSource => ({
    trackId,
    deviceId: 102,
    timestamp: 1,
    className: 'person',
    confidence: 0.9,
    keyFrame: Buffer.from('jpeg'),
    bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.4 },
    boxSource: { kind: 'subjectBox' },
  })
  const deps: RebuildDeps = {
    listTrackIdPage: async (cursor) =>
      cursor === null
        ? { trackIds: [...trackIds], nextCursor: null }
        : { trackIds: [], nextCursor: null },
    canDispatch: () => true,
    ...(filter ? { filterOutOfSpace: filter } : {}),
    loadSource: async (trackId) => {
      loaded.push(trackId)
      return source(trackId)
    },
    embed: async (s) => {
      embedded.push(s.trackId)
      return { kind: 'embedded', embeddingBase64: 'AAAAAA==' }
    },
    store: async () => 'persisted',
    pause: async () => undefined,
    logger: silent,
  }
  return { deps, loaded, embedded }
}

describe('rebuildObjectEmbeddings — model space', () => {
  it('a pass with the model already stored is a NO-OP, and says so', async () => {
    const h = harness(['t1', 't2', 't3'], async (ids) => ({
      outOfSpace: [],
      alreadyInSpace: ids.length,
      inSpace: [...ids],
    }))
    const out = await rebuildObjectEmbeddings(h.deps)
    expect(out).toMatchObject({ scanned: 0, rebuilt: 0, alreadyInSpace: 3, complete: true })
    // No media touched. The cheap question came first — the ordering that was
    // the difference between a maintenance job and 43 minutes of hub-main
    // saturation on 2026-08-06.
    expect(h.loaded).toEqual([])
    expect(h.embedded).toEqual([])
  })

  it('re-embeds ONLY the tracks outside the space, and counts the rest', async () => {
    const h = harness(['stale', 'fresh', 'never'], async () => ({
      outOfSpace: ['stale', 'never'],
      alreadyInSpace: 1,
      inSpace: ['fresh'],
    }))
    const out = await rebuildObjectEmbeddings(h.deps)
    expect(h.embedded).toEqual(['stale', 'never'])
    expect(out).toMatchObject({ rebuilt: 2, alreadyInSpace: 1, scanned: 2 })
  })

  it('a FAILED lookup processes the page in full — skipping on a bad read would be data loss', async () => {
    const h = harness(['t1', 't2'], async () => null)
    const out = await rebuildObjectEmbeddings(h.deps)
    expect(h.embedded).toEqual(['t1', 't2'])
    expect(out).toMatchObject({ rebuilt: 2, alreadyInSpace: 0 })
  })

  it('without the dep at all, behaviour is exactly what it was', async () => {
    const h = harness(['t1', 't2'], undefined)
    const out = await rebuildObjectEmbeddings(h.deps)
    expect(h.embedded).toEqual(['t1', 't2'])
    expect(out).toMatchObject({ rebuilt: 2, alreadyInSpace: 0 })
  })

  it('the budget applies to the OUT-OF-SPACE tracks, not to the page it came from', async () => {
    // Otherwise `maxTracks: 2` on a page where 8 of 10 are already done would
    // "spend" its budget on tracks it never touched, and a resumed pass would
    // creep forward two rows at a time.
    const h = harness(['a', 'b', 'c', 'd'], async () => ({
      outOfSpace: ['c', 'd'],
      alreadyInSpace: 2,
      inSpace: ['a', 'b'],
    }))
    const out = await rebuildObjectEmbeddings(h.deps, { maxTracks: 2 })
    expect(h.embedded).toEqual(['c', 'd'])
    expect(out).toMatchObject({ rebuilt: 2, alreadyInSpace: 2 })
  })
})
