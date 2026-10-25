/**
 * D664 — the rebuild pass judges the BOX before the pixels, says where every
 * box came from, and can redo vectors it already wrote from the wrong one.
 *
 * The loader decides the box (`rebuild-source-loader.spec.ts`); this file pins
 * what the PASS does with that decision: a refused box never costs a recording
 * decode, every rule is counted on its own axis, a refusal is logged per camera
 * without flooding, and `force` re-embeds only what is already in the space.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  BOX_REFUSAL_LOG_EVERY,
  REBUILD_EXCLUDED_SOURCES,
  type RebuildDeps,
  type RebuildSource,
  rebuildObjectEmbeddings,
  rebuildTrackPageQuery,
} from '../embedding-rebuild.js'

const EMBEDDING_B64 = Buffer.from(Float32Array.from([1, 0, 0, 0]).buffer).toString('base64')

function source(overrides: Partial<RebuildSource> = {}): RebuildSource {
  return {
    trackId: 't1',
    deviceId: 101,
    timestamp: 1000,
    className: 'person',
    confidence: 0.9,
    keyFrame: Buffer.from('key-frame'),
    bbox: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
    boxSource: { kind: 'subjectBox' },
    ...overrides,
  }
}

interface Warned {
  readonly message: string
  readonly deviceId: number | undefined
  readonly meta: Record<string, unknown> | undefined
}

function makeDeps(
  sources: Record<string, RebuildSource | null>,
  overrides: Partial<RebuildDeps> = {},
): RebuildDeps & { embedded: string[]; warned: Warned[] } {
  const embedded: string[] = []
  const warned: Warned[] = []
  return {
    embedded,
    warned,
    listTrackIdPage: async (cursor) =>
      cursor === null
        ? { trackIds: Object.keys(sources), nextCursor: null }
        : { trackIds: [], nextCursor: null },
    canDispatch: () => true,
    loadSource: async (id) => sources[id] ?? null,
    embed: async (s) => {
      embedded.push(s.trackId)
      return { kind: 'embedded', embeddingBase64: EMBEDDING_B64 }
    },
    store: async () => 'persisted',
    pause: async () => undefined,
    logger: {
      info: () => undefined,
      warn: (message, extras) =>
        warned.push({ message, deviceId: extras?.tags?.deviceId, meta: extras?.meta }),
    },
    ...overrides,
  }
}

describe('rebuild pass — the box before the pixels (D664)', () => {
  it('a refused box never pays a recording decode, and is counted by rule', async () => {
    const recover = vi.fn(async () => Buffer.from('decoded'))
    const deps = makeDeps(
      {
        t1: source({
          keyFrame: null,
          bbox: null,
          boxSource: { kind: 'refused', reason: 'no-position-at-key-frame' },
        }),
      },
      { recoverKeyFrame: recover },
    )
    const out = await rebuildObjectEmbeddings(deps)
    expect(recover).not.toHaveBeenCalled()
    expect(out.missingBbox).toBe(1)
    expect(out.missingKeyFrame).toBe(0)
    expect(out.boxSource).toEqual({ subjectBox: 0, positions: 0, event: 0, refused: 1 })
  })

  it('counts every rule on its own axis', async () => {
    const deps = makeDeps(
      {
        a: source({ trackId: 'a', boxSource: { kind: 'subjectBox' } }),
        b: source({ trackId: 'b', boxSource: { kind: 'subjectBox' } }),
        c: source({ trackId: 'c', boxSource: { kind: 'positions' } }),
        d: source({ trackId: 'd', keyFrame: null, boxSource: { kind: 'event' } }),
        e: source({
          trackId: 'e',
          bbox: null,
          boxSource: { kind: 'refused', reason: 'track-frame-size-unknown' },
        }),
      },
      { recoverKeyFrame: async () => Buffer.from('decoded') },
    )
    const out = await rebuildObjectEmbeddings(deps)
    expect(out.boxSource).toEqual({ subjectBox: 2, positions: 1, event: 1, refused: 1 })
    expect(out.rebuilt).toBe(4)
    expect(out.recoveredKeyFrame).toBe(1)
  })

  it('logs a refusal per camera, tagged, first and then every Nth — never silent, never a flood', async () => {
    const sources: Record<string, RebuildSource> = {}
    const refusedCount = BOX_REFUSAL_LOG_EVERY * 2 + 5
    for (let i = 0; i < refusedCount; i++) {
      sources[`r${i}`] = source({
        trackId: `r${i}`,
        deviceId: 102,
        bbox: null,
        boxSource: { kind: 'refused', reason: 'no-position-at-key-frame' },
      })
    }
    sources['other'] = source({
      trackId: 'other',
      deviceId: 101,
      bbox: null,
      boxSource: { kind: 'refused', reason: 'track-row-missing' },
    })
    const deps = makeDeps(sources)
    const out = await rebuildObjectEmbeddings(deps)
    const refusalLines = deps.warned.filter((w) => w.message.includes('track refused'))
    expect(out.missingBbox).toBe(refusedCount + 1)
    expect(refusalLines.map((w) => w.deviceId)).toEqual([102, 102, 102, 101])
    expect(refusalLines[0]?.meta?.['reason']).toBe('no-position-at-key-frame')
    expect(refusalLines[3]?.meta?.['reason']).toBe('track-row-missing')
  })
})

describe('rebuild pass — force re-embeds what is ALREADY in the space (D664)', () => {
  const split = async (ids: readonly string[]) => ({
    outOfSpace: ids.filter((id) => id.startsWith('new')),
    alreadyInSpace: ids.filter((id) => id.startsWith('done')).length,
    inSpace: ids.filter((id) => id.startsWith('done')),
  })
  const tracks = {
    done1: source({ trackId: 'done1' }),
    new1: source({ trackId: 'new1' }),
    done2: source({ trackId: 'done2' }),
    done3: source({ trackId: 'done3' }),
  }

  it('without force the in-space tracks are skipped — the case force exists for', async () => {
    const deps = makeDeps(tracks, { filterOutOfSpace: split })
    const out = await rebuildObjectEmbeddings(deps)
    expect(deps.embedded).toEqual(['new1'])
    expect(out.alreadyInSpace).toBe(3)
    expect(out.forcedInSpace).toBe(0)
  })

  it('with force ONLY the in-space tracks are re-embedded, bounded by maxTracks, and named', async () => {
    const deps = makeDeps(tracks, { filterOutOfSpace: split })
    const out = await rebuildObjectEmbeddings(deps, { force: true, maxTracks: 2 })
    expect(deps.embedded).toEqual(['done1', 'done2'])
    expect(out.forcedInSpace).toBe(2)
    expect(out.skippedOutOfSpace).toBe(1)
    expect(out.alreadyInSpace).toBe(0)
    expect(out.complete).toBe(false)
  })
})

describe('rebuild listing — audio and sensor tracks are not walked (D664)', () => {
  it('excludes audio and sensor, and nothing else', () => {
    expect([...REBUILD_EXCLUDED_SOURCES].sort()).toEqual(['audio', 'sensor'])
  })

  it('the page query carries the exclusion', () => {
    const q = rebuildTrackPageQuery({ deviceIds: [101], since: 5, cursor: 'c1', limit: 50 })
    expect(q).toEqual({
      deviceIds: [101],
      since: 5,
      cursor: 'c1',
      limit: 50,
      excludeSources: ['audio', 'sensor'],
    })
  })
})
