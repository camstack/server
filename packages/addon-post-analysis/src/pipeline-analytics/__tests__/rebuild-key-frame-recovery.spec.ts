/**
 * R3 in the rebuild: a track that never got a key frame is re-embedded from a
 * frame decoded out of the recording.
 *
 * The number this exists for is 790 of 3 633 tracks over seven days (21.7%)
 * with no key frame, and the sentence next to it — "the pixels are gone, and
 * there cannot be a backfill". These tests pin the three things that make that
 * sentence false without making anything else worse:
 *
 *  1. recovery is reached ONLY when there are no pixels already (a track with a
 *     key frame must not pay a GOP decode);
 *  2. a recovered track is counted separately from a captured one, because they
 *     answer different questions about the capture path's health;
 *  3. a recovery that cannot help leaves the old behaviour exactly as it was.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  type RebuildDeps,
  type RebuildSource,
  rebuildObjectEmbeddings,
} from '../embedding-rebuild.js'

const silent = { info: () => undefined, warn: () => undefined }

const EMBEDDING_B64 = Buffer.from(Float32Array.from([1, 0, 0, 0]).buffer).toString('base64')

function source(overrides: Partial<RebuildSource> = {}): RebuildSource {
  return {
    trackId: 't1',
    deviceId: 101,
    timestamp: 1_700_000_000_000,
    className: 'person',
    confidence: 0.9,
    keyFrame: Buffer.from('captured-key-frame'),
    bbox: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
    boxSource: { kind: 'subjectBox' },
    ...overrides,
  }
}

function makeDeps(
  sources: Record<string, RebuildSource | null>,
  overrides: Partial<RebuildDeps> = {},
): RebuildDeps & { embedded: RebuildSource[] } {
  const embedded: RebuildSource[] = []
  return {
    embedded,
    listTrackIdPage: async () => ({ trackIds: Object.keys(sources), nextCursor: null }),
    canDispatch: () => true,
    loadSource: async (trackId: string) => sources[trackId] ?? null,
    embed: async (s: RebuildSource) => {
      embedded.push(s)
      return { kind: 'embedded' as const, embeddingBase64: EMBEDDING_B64 }
    },
    store: async () => 'persisted' as const,
    pause: async () => undefined,
    logger: silent,
    ...overrides,
  }
}

describe('embedding rebuild — key-frame recovery (R3)', () => {
  it('re-embeds a key-frameless track from the recovered frame, and counts it apart', async () => {
    const recovered = Buffer.from('recovered-from-the-gop')
    const deps = makeDeps(
      { t1: source({ keyFrame: null }) },
      { recoverKeyFrame: async () => recovered },
    )
    const out = await rebuildObjectEmbeddings(deps)
    expect(out.rebuilt).toBe(1)
    expect(out.recoveredKeyFrame).toBe(1)
    expect(out.missingKeyFrame).toBe(0)
    // The pixels the embed actually saw are the recovered ones.
    expect(deps.embedded[0]?.keyFrame).toBe(recovered)
  })

  // The whole cost argument: a GOP decode is hundreds of milliseconds, and a
  // track with pixels already has no reason to pay one.
  it('never recovers for a track that HAS a key frame', async () => {
    const recover = vi.fn()
    const deps = makeDeps({ t1: source() }, { recoverKeyFrame: recover })
    const out = await rebuildObjectEmbeddings(deps)
    expect(recover).not.toHaveBeenCalled()
    expect(out.rebuilt).toBe(1)
    expect(out.recoveredKeyFrame).toBe(0)
  })

  it('falls back to the old counting when recovery finds nothing', async () => {
    const deps = makeDeps({ t1: source({ keyFrame: null }) }, { recoverKeyFrame: async () => null })
    const out = await rebuildObjectEmbeddings(deps)
    expect(out.missingKeyFrame).toBe(1)
    expect(out.recoveredKeyFrame).toBe(0)
    expect(out.rebuilt).toBe(0)
  })

  it('behaves exactly as before when recovery is not wired at all', async () => {
    const deps = makeDeps({ t1: source({ keyFrame: null }) })
    const out = await rebuildObjectEmbeddings(deps)
    expect(out.missingKeyFrame).toBe(1)
    expect(out.recoveredKeyFrame).toBe(0)
  })

  it('recovers at the track’s own peak instant, per camera', async () => {
    const seen: Array<{ deviceId: number; timestamp: number }> = []
    const deps = makeDeps(
      {
        t1: source({ trackId: 't1', deviceId: 101, timestamp: 111, keyFrame: null }),
        t2: source({ trackId: 't2', deviceId: 102, timestamp: 222, keyFrame: null }),
      },
      {
        recoverKeyFrame: async (s) => {
          seen.push({ deviceId: s.deviceId, timestamp: s.timestamp })
          return Buffer.from('x')
        },
      },
    )
    await rebuildObjectEmbeddings(deps)
    expect(seen).toEqual([
      { deviceId: 101, timestamp: 111 },
      { deviceId: 102, timestamp: 222 },
    ])
  })

  // A maintenance pass walks thousands of tracks. One camera whose footage was
  // pruned must not end it.
  it('carries on past a track whose recovery fails, and still counts the ones that worked', async () => {
    const deps = makeDeps(
      {
        t1: source({ trackId: 't1', keyFrame: null }),
        t2: source({ trackId: 't2', keyFrame: null }),
      },
      {
        recoverKeyFrame: async (s) => (s.trackId === 't1' ? null : Buffer.from('ok')),
      },
    )
    const out = await rebuildObjectEmbeddings(deps)
    expect(out.scanned).toBe(2)
    expect(out.missingKeyFrame).toBe(1)
    expect(out.recoveredKeyFrame).toBe(1)
    expect(out.rebuilt).toBe(1)
  })

  it('still refuses a recovered frame with no usable box — pixels are not the only input', async () => {
    const deps = makeDeps(
      { t1: source({ keyFrame: null, bbox: null }) },
      { recoverKeyFrame: async () => Buffer.from('ok') },
    )
    const out = await rebuildObjectEmbeddings(deps)
    expect(out.missingBbox).toBe(1)
    expect(out.rebuilt).toBe(0)
  })
})
