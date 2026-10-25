/**
 * The rebuild's contract is "every skip is counted". Most of these tests check
 * that a track which cannot be re-embedded is reported rather than quietly
 * dropped — a rebuild that says "rebuilt 40" while silently skipping 300 would
 * be taken as proof the index is consistent when it is not.
 *
 * The other half pins what the rebuild must NOT do any more: cut its own crop.
 * It used to widen the box by 0.2 and square it while the live path widened by
 * 0.15 and did not, so every pass poured a second, incomparable feature space
 * into the one index it exists to keep consistent. Cutting now happens inside
 * the runner, for both paths, through one convention.
 *
 * The newest half pins the fleet behaviour: the step runs on any capable node
 * via `pipelineRunner.runStatelessStep`, so "no node can do this at all" is a
 * distinct outcome from "this track was refused", and it must STOP the pass
 * rather than repeat the discovery once per track.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REBUILD_PACING_MS,
  type RebuildDeps,
  type RebuildEmbedOutcome,
  type RebuildSource,
  rebuildObjectEmbeddings,
} from '../embedding-rebuild.js'

const silent = { info: () => undefined, warn: () => undefined }

const EMBEDDING_B64 = Buffer.from(Float32Array.from([1, 0, 0, 0]).buffer).toString('base64')

function source(overrides: Partial<RebuildSource> = {}): RebuildSource {
  return {
    trackId: 't1',
    deviceId: 101,
    timestamp: 1000,
    className: 'dog',
    confidence: 0.9,
    keyFrame: Buffer.from('key-frame-bytes'),
    bbox: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
    boxSource: { kind: 'subjectBox' },
    ...overrides,
  }
}

function makeDeps(
  sources: Record<string, RebuildSource | null>,
  overrides: Partial<RebuildDeps> = {},
  pageSize = 100,
): RebuildDeps & {
  stored: string[]
  storedVectors: string[]
  embedded: RebuildSource[]
  pagesServed: Array<string | null>
} {
  const stored: string[] = []
  const storedVectors: string[] = []
  const embedded: RebuildSource[] = []
  const pagesServed: Array<string | null> = []
  return {
    stored,
    storedVectors,
    embedded,
    pagesServed,
    listTrackIdPage: async (cursor: string | null) => {
      const ids = Object.keys(sources)
      const start = cursor === null ? 0 : Number(cursor)
      const slice = ids.slice(start, start + pageSize)
      const next = start + pageSize < ids.length ? String(start + pageSize) : null
      pagesServed.push(cursor)
      return { trackIds: slice, nextCursor: next }
    },
    loadSource: async (id) => sources[id] ?? null,
    embed: async (s): Promise<RebuildEmbedOutcome> => {
      embedded.push(s)
      return { kind: 'embedded', embeddingBase64: EMBEDDING_B64 }
    },
    canDispatch: () => true,
    pause: async () => undefined,
    store: async (s, embeddingBase64) => {
      stored.push(s.trackId)
      storedVectors.push(embeddingBase64)
      return 'persisted'
    },
    logger: silent,
    ...overrides,
  }
}

describe('rebuildObjectEmbeddings — the rebuild no longer cuts', () => {
  it('hands the WHOLE source to the embedder and never touches pixels itself', async () => {
    // The rebuild's only pixel-related job is to fetch the key frame; the
    // rectangle is the runner's to derive. If this module ever regains a crop
    // step the two paths diverge again — see `scripts/check-clip-crop-single-owner.ts`.
    const deps = makeDeps({ a: source({ trackId: 'a' }) })
    await rebuildObjectEmbeddings(deps)

    expect(deps.embedded).toHaveLength(1)
    expect(deps.embedded[0]!.keyFrame).toEqual(Buffer.from('key-frame-bytes'))
    expect(deps.embedded[0]!.bbox).toEqual({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 })
  })

  it('passes the embedding through as base64 — no decode/re-encode round trip', async () => {
    const deps = makeDeps({ a: source({ trackId: 'a' }) })
    await rebuildObjectEmbeddings(deps)
    expect(deps.storedVectors).toEqual([EMBEDDING_B64])
  })
})

describe('rebuildObjectEmbeddings', () => {
  it('re-embeds every track that has a key frame and a bbox', async () => {
    const deps = makeDeps({
      a: source({ trackId: 'a' }),
      b: source({ trackId: 'b' }),
    })

    const out = await rebuildObjectEmbeddings(deps)

    expect(out.rebuilt).toBe(2)
    expect(deps.stored).toEqual(['a', 'b'])
    expect(out.complete).toBe(true)
  })

  it('COUNTS a track with no key frame instead of dropping it', async () => {
    const deps = makeDeps({ a: source({ trackId: 'a', keyFrame: null }) })
    const out = await rebuildObjectEmbeddings(deps)
    expect(out.rebuilt).toBe(0)
    expect(out.missingKeyFrame).toBe(1)
    expect(out.missingEvent).toBe(0)
  })

  // Two causes wore one counter: `loadSource → null` means the track has no
  // OBJECT EVENT at all (nothing to describe), which is a track-store problem;
  // `keyFrame === null` means the pixels are missing, which is a media-capture
  // problem. Only 6 tracks fleet-wide hit the first, but reading one number
  // for both is how the 21.7% key-frame gap stayed mis-attributed to retention.
  it('COUNTS a track with no object event on its OWN axis', async () => {
    const deps = makeDeps({ a: null })
    const out = await rebuildObjectEmbeddings(deps)
    expect(out.missingEvent).toBe(1)
    expect(out.missingKeyFrame).toBe(0)
  })

  it('COUNTS a track whose bbox is degenerate', async () => {
    const deps = makeDeps({
      a: source({ trackId: 'a', bbox: { x: 0.1, y: 0.1, w: 0, h: 0.2 } }),
    })
    const out = await rebuildObjectEmbeddings(deps)
    expect(out.missingBbox).toBe(1)
  })

  it('COUNTS an encoder failure and carries on with the rest', async () => {
    let calls = 0
    const deps = makeDeps(
      { a: source({ trackId: 'a' }), b: source({ trackId: 'b' }) },
      {
        embed: async () => {
          calls += 1
          if (calls === 1) throw new Error('engine busy')
          return { kind: 'embedded', embeddingBase64: EMBEDDING_B64 }
        },
      },
    )

    const out = await rebuildObjectEmbeddings(deps)
    expect(out.failed).toBe(1)
    expect(out.rebuilt).toBe(1)
  })

  it('treats an empty embedding as a failure, not a success', async () => {
    const deps = makeDeps(
      { a: source({ trackId: 'a' }) },
      { embed: async () => ({ kind: 'failed', reason: 'empty embedding' }) },
    )
    const out = await rebuildObjectEmbeddings(deps)
    expect(out.rebuilt).toBe(0)
    expect(out.failed).toBe(1)
    expect(deps.stored).toEqual([])
  })

  // ── The detached-camera case ────────────────────────────────────────
  //
  // A rebuild walks STORED tracks, which outlive the camera that produced
  // them. Routing through the runner means a track whose camera is detached,
  // disabled or deleted cannot be re-embedded at all. Folding that into
  // `failed` would read as an engine problem; leaving it uncounted would let a
  // pass over a decommissioned camera report a clean run having done nothing.

  it('COUNTS a track whose camera cannot run the step, separately from a failure', async () => {
    const deps = makeDeps(
      { a: source({ trackId: 'a' }), b: source({ trackId: 'b' }) },
      {
        embed: async (s) =>
          s.trackId === 'a'
            ? { kind: 'not-runnable', reason: 'camera not attached' }
            : { kind: 'embedded', embeddingBase64: EMBEDDING_B64 },
      },
    )

    const out = await rebuildObjectEmbeddings(deps)
    expect(out.notRunnable).toBe(1)
    expect(out.failed).toBe(0)
    expect(out.rebuilt).toBe(1)
  })

  it('a not-runnable track is LOUD — the reason reaches the log, with the deviceId', async () => {
    const warnings: Array<Record<string, unknown>> = []
    const deps = makeDeps(
      { a: source({ trackId: 'a', deviceId: 102 }) },
      {
        embed: async () => ({ kind: 'not-runnable', reason: 'clip-embedding is disabled' }),
        logger: {
          info: () => undefined,
          warn: (message, extras) => warnings.push({ message, ...extras }),
        },
      },
    )

    await rebuildObjectEmbeddings(deps)
    expect(warnings).toHaveLength(1)
    expect(String(warnings[0]!['message'])).toMatch(/could not be re-embedded/i)
    expect(warnings[0]!['tags']).toEqual({ deviceId: 102 })
    expect(JSON.stringify(warnings[0]!['meta'])).toContain('clip-embedding is disabled')
  })

  it('a pass where NOTHING was runnable still shows it in the counters', async () => {
    // `complete` still means "the store ran out", but the counters must make
    // the difference visible: 0 rebuilt / 3 notRunnable is a configuration
    // problem, not an empty fleet.
    const deps = makeDeps(
      { a: source({ trackId: 'a' }), b: source({ trackId: 'b' }), c: source({ trackId: 'c' }) },
      { embed: async () => ({ kind: 'not-runnable', reason: 'camera not attached' }) },
    )
    const out = await rebuildObjectEmbeddings(deps)
    expect(out.rebuilt).toBe(0)
    expect(out.notRunnable).toBe(3)
    expect(out.scanned).toBe(3)
  })

  // ── The pass has nowhere to run ────────────────────────────────────
  //
  // Distinct from `notRunnable`, which is a verdict about one track. This is a
  // verdict about the CLUSTER: no node has the step, or none can serve the
  // pinned model. Continuing would reload media for every remaining track only
  // to reach the same answer, and would bury the one line that explains the run.

  it('STOPS the pass when no node can serve the pinned model', async () => {
    const attempts: string[] = []
    const deps = makeDeps(
      { a: source({ trackId: 'a' }), b: source({ trackId: 'b' }), c: source({ trackId: 'c' }) },
      {
        embed: async (s) => {
          attempts.push(s.trackId)
          return { kind: 'no-capable-node', reason: 'every candidate node left' }
        },
      },
    )

    const out = await rebuildObjectEmbeddings(deps)
    expect(out.noCapableNode).toBe(1)
    // Not three: the pass gave up on the first track rather than paying a media
    // load per track to re-learn the same thing.
    expect(out.scanned).toBe(1)
    expect(attempts).toEqual(['a'])
    // NEVER complete — the store still holds tracks nobody could rebuild.
    expect(out.complete).toBe(false)
    expect(out.notRunnable).toBe(0)
    expect(out.failed).toBe(0)
  })

  it('an abandoned pass is LOUD, tagged, and says the store was not exhausted', async () => {
    const warnings: Array<Record<string, unknown>> = []
    const infos: Array<Record<string, unknown>> = []
    const deps = makeDeps(
      { a: source({ trackId: 'a', deviceId: 102 }), b: source({ trackId: 'b' }) },
      {
        embed: async () => ({ kind: 'no-capable-node', reason: 'hub: no openvino build' }),
        logger: {
          info: (message, extras) => infos.push({ message, ...extras }),
          warn: (message, extras) => warnings.push({ message, ...extras }),
        },
      },
    )

    const out = await rebuildObjectEmbeddings(deps)
    expect(warnings).toHaveLength(1)
    expect(String(warnings[0]!['message'])).toMatch(/abandoned/i)
    expect(warnings[0]!['tags']).toEqual({ deviceId: 102 })
    expect(JSON.stringify(warnings[0]!['meta'])).toContain('no openvino build')
    // The closing summary must carry the reason too — that is the line an
    // operator reads when the run is already over.
    expect(JSON.stringify(infos.at(-1)?.['meta'])).toContain('no openvino build')
    expect(out.complete).toBe(false)
  })

  it('a pass that hits it AFTER real work keeps the work it did', async () => {
    const deps = makeDeps(
      { a: source({ trackId: 'a' }), b: source({ trackId: 'b' }), c: source({ trackId: 'c' }) },
      {
        embed: async (s) =>
          s.trackId === 'a'
            ? { kind: 'embedded', embeddingBase64: EMBEDDING_B64 }
            : { kind: 'no-capable-node', reason: 'fleet exhausted' },
      },
    )

    const out = await rebuildObjectEmbeddings(deps)
    expect(out.rebuilt).toBe(1)
    expect(out.noCapableNode).toBe(1)
    expect(out.scanned).toBe(2)
    expect(out.complete).toBe(false)
  })

  // ── The cheap question comes first ─────────────────────────────────
  //
  // The loop used to load a track's media and THEN find out nothing could run
  // it. On the live hub, 2026-08-06: 3,611 tracks scanned, 198 vectors written,
  // 2,598 rejected — every rejection after a full media load, ~10 MB allocated
  // per track, on hub-main's only thread, for 43 minutes.

  it('does NOT touch media when there is nowhere to dispatch', async () => {
    const loaded: string[] = []
    const deps = makeDeps(
      { a: source({ trackId: 'a' }), b: source({ trackId: 'b' }) },
      {
        canDispatch: () => false,
        loadSource: async (id) => {
          loaded.push(id)
          return source({ trackId: id })
        },
      },
    )

    const out = await rebuildObjectEmbeddings(deps)
    // THE assertion: not one media read was paid to learn what the rotation
    // already knew.
    expect(loaded).toEqual([])
    expect(out.noCapableNode).toBe(1)
    expect(out.scanned).toBe(0)
    expect(out.complete).toBe(false)
  })

  it('stops as soon as the fleet empties, without loading the remaining tracks', async () => {
    const loaded: string[] = []
    let dispatchable = true
    const deps = makeDeps(
      { a: source({ trackId: 'a' }), b: source({ trackId: 'b' }), c: source({ trackId: 'c' }) },
      {
        canDispatch: () => dispatchable,
        loadSource: async (id) => {
          loaded.push(id)
          return source({ trackId: id })
        },
        embed: async () => {
          dispatchable = false
          return { kind: 'embedded', embeddingBase64: EMBEDDING_B64 }
        },
      },
    )

    const out = await rebuildObjectEmbeddings(deps)
    expect(loaded).toEqual(['a'])
    expect(out.rebuilt).toBe(1)
    expect(out.noCapableNode).toBe(1)
  })

  it('an empty-fleet stop is LOUD and never reports complete', async () => {
    const warnings: Array<Record<string, unknown>> = []
    const deps = makeDeps(
      { a: source({ trackId: 'a' }) },
      {
        canDispatch: () => false,
        logger: {
          info: () => undefined,
          warn: (message, extras) => warnings.push({ message, ...extras }),
        },
      },
    )

    const out = await rebuildObjectEmbeddings(deps)
    expect(warnings).toHaveLength(1)
    expect(String(warnings[0]!['message'])).toMatch(/abandoned/i)
    expect(out.complete).toBe(false)
  })

  // ── Pacing ─────────────────────────────────────────────────────────
  //
  // A rebuild shares hub-main's single thread with every live request. An
  // unpaced loop over thousands of tracks is what turned this job into an
  // outage, so the yield is part of the algorithm, not a caller's courtesy.

  it('yields between tracks with the default pacing', async () => {
    const paused: number[] = []
    const deps = makeDeps(
      { a: source({ trackId: 'a' }), b: source({ trackId: 'b' }) },
      { pause: async (ms) => void paused.push(ms) },
    )

    await rebuildObjectEmbeddings(deps)
    expect(paused).toEqual([DEFAULT_REBUILD_PACING_MS, DEFAULT_REBUILD_PACING_MS])
  })

  it('honours an explicit pacing and can be turned off with 0', async () => {
    const paused: number[] = []
    const deps = makeDeps(
      { a: source({ trackId: 'a' }) },
      { pause: async (ms) => void paused.push(ms) },
    )
    await rebuildObjectEmbeddings(deps, { pacingMs: 250 })
    expect(paused).toEqual([250])

    const paused2: number[] = []
    const deps2 = makeDeps(
      { a: source({ trackId: 'a' }) },
      { pause: async (ms) => void paused2.push(ms) },
    )
    await rebuildObjectEmbeddings(deps2, { pacingMs: 0 })
    expect(paused2).toEqual([])
  })

  it('yields even for tracks it skipped — a skip still costs a loop iteration', async () => {
    const paused: number[] = []
    const deps = makeDeps(
      { a: source({ trackId: 'a', keyFrame: null }) },
      { pause: async (ms) => void paused.push(ms) },
    )
    await rebuildObjectEmbeddings(deps)
    expect(paused).toHaveLength(1)
  })

  it('names the pacing in force in the closing line', async () => {
    // An operator watching a slow pass must be able to tell "throttled" from
    // "stalled", and the only artefact left after a detached run is the log.
    const infos: Array<Record<string, unknown>> = []
    const deps = makeDeps(
      { a: source({ trackId: 'a' }) },
      {
        pause: async () => undefined,
        logger: {
          info: (message, extras) => infos.push({ message, ...extras }),
          warn: () => undefined,
        },
      },
    )
    await rebuildObjectEmbeddings(deps, { pacingMs: 125 })
    expect(JSON.stringify(infos.at(-1)?.['meta'])).toContain('"pacingMs":125')
  })

  it('reports complete:false when it stops at maxTracks', async () => {
    const deps = makeDeps({ a: source({ trackId: 'a' }), b: source({ trackId: 'b' }) })
    const out = await rebuildObjectEmbeddings(deps, { maxTracks: 1 })
    expect(out.scanned).toBe(1)
    expect(out.complete).toBe(false)
  })

  it('WALKS PAST the first page instead of re-embedding it', async () => {
    // The defect this pins: with a flat bounded list, maxTracks selected the
    // newest N and every pass re-embedded exactly those. On the live hub the
    // index went 372 -> 384 across three 150-track passes against 2,596 tracks.
    const sources: Record<string, RebuildSource> = {}
    for (let i = 0; i < 7; i += 1) {
      sources[`t${i}`] = source({ trackId: `t${i}` })
    }
    const deps = makeDeps(sources, {}, 2)

    const out = await rebuildObjectEmbeddings(deps)

    expect(out.rebuilt).toBe(7)
    expect(deps.stored.toSorted()).toEqual(['t0', 't1', 't2', 't3', 't4', 't5', 't6'])
    // Four pages for seven items at two per page, and each asked for a
    // DIFFERENT cursor — re-serving page one would show as repeated nulls.
    expect(deps.pagesServed[0]).toBeNull()
    expect(new Set(deps.pagesServed).size).toBe(deps.pagesServed.length)
  })

  it('stops at maxTracks mid-page without losing the count', async () => {
    const sources: Record<string, RebuildSource> = {}
    for (let i = 0; i < 10; i += 1) {
      sources[`t${i}`] = source({ trackId: `t${i}` })
    }
    const deps = makeDeps(sources, {}, 4)

    const out = await rebuildObjectEmbeddings(deps, { maxTracks: 6 })
    expect(out.scanned).toBe(6)
    expect(out.rebuilt).toBe(6)
    expect(out.complete).toBe(false)
  })

  it('does NOT count a track whose write did not land', async () => {
    // The defect this replaces: `rebuilt` was incremented on RETURN from
    // `store`, and the store logged its failures and returned normally. On the
    // live hub that produced 704 "rebuilt" against an index holding 0 — the
    // number the operator watches, saying the opposite of the truth.
    const sources: Record<string, RebuildSource> = {
      a: source({ trackId: 'a' }),
      b: source({ trackId: 'b' }),
    }
    const deps = makeDeps(sources, {
      store: async (s: RebuildSource) => (s.trackId === 'a' ? 'persisted' : 'failed'),
    })

    const out = await rebuildObjectEmbeddings(deps, {})
    expect(out.scanned).toBe(2)
    expect(out.rebuilt).toBe(1)
    expect(out.failed).toBe(1)
  })

  it('reports complete:true when the store runs out before the budget', async () => {
    const deps = makeDeps({ a: source({ trackId: 'a' }), b: source({ trackId: 'b' }) }, {}, 1)
    const out = await rebuildObjectEmbeddings(deps, { maxTracks: 100 })
    expect(out.scanned).toBe(2)
    expect(out.complete).toBe(true)
  })
})
