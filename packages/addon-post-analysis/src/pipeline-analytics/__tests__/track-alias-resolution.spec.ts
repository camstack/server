/**
 * Spec §6.6: every read that takes a track id resolves an absorbed id to its
 * survivor — derived from the caps' own method schemas, so a method added
 * later is covered without a list to maintain (review M8, L11).
 *
 * Disarms (each alone, restored):
 *  - return an empty set from `trackIdTakingMethods`: "finds every method…" and
 *    "the three caps the addon provides are covered" fail;
 *  - leave `trackIds` arrays alone: "resolves each id of a trackIds array" fails.
 *
 * Fix round 1 (review H1/H2/M1) disarms, each alone, restored:
 *  - narrow `isSingularTrackIdKey` to the literal `'trackId'` only (drop the
 *    `*TrackId` suffix match): both "resolves `otherTrackId` too" and
 *    "generalizes by suffix" fail.
 *  - drop the try/catch in `safeResolveOne`/`safeResolveMany` (let `resolve`/
 *    `resolveMany` reject straight through): every test in "an alias-store
 *    failure degrades..." fails (they'd see a thrown rejection instead of a
 *    fallback id).
 *  - make `resolvingTrackIds` always use `resolveManyViaResolve(resolve)`
 *    (ignore `options?.resolveMany`): "uses resolveMany once for the whole
 *    array, never the single-id resolve" fails.
 */
import {
  faceGalleryCapability,
  pipelineAnalyticsCapability,
  plateGalleryCapability,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AliasResolveFailure } from '../track-alias-resolution.js'
import {
  resolveMediaOwnerId,
  resolveTrackOwnerIds,
  resolvingTrackIds,
  sampledOnce,
  trackIdTakingMethods,
} from '../track-alias-resolution.js'

describe('alias resolution at the cap boundary', () => {
  it('finds every method whose input has a trackId or trackIds', () => {
    const methods = {
      getTrack: { input: z.object({ deviceId: z.number(), trackId: z.string() }) },
      listTracks: { input: z.object({ deviceId: z.number() }) },
      deleteTracks: { input: z.object({ deviceId: z.number(), trackIds: z.array(z.string()) }) },
    }
    expect([...trackIdTakingMethods(methods)].sort()).toEqual(['deleteTracks', 'getTrack'])
  })

  it('the three caps the addon provides are covered', () => {
    expect(trackIdTakingMethods(pipelineAnalyticsCapability.methods).has('getTrack')).toBe(true)
    expect(trackIdTakingMethods(pipelineAnalyticsCapability.methods).has('deleteTracks')).toBe(true)
    expect(trackIdTakingMethods(faceGalleryCapability.methods).has('getFaceByTrack')).toBe(true)
    expect(trackIdTakingMethods(plateGalleryCapability.methods).has('getPlateByTrack')).toBe(true)
  })

  it('rewrites the id before the implementation sees it', async () => {
    const seen: string[] = []
    const impl = {
      getTrack: async (input: { deviceId: number; trackId: string }) => {
        seen.push(input.trackId)
        return { trackId: input.trackId }
      },
      listTracks: async () => [],
    }
    const wrapped = resolvingTrackIds(impl, new Set(['getTrack']), async (id) =>
      id === 'B' ? 'A' : null,
    )
    expect(await wrapped.getTrack({ deviceId: 1, trackId: 'B' })).toEqual({ trackId: 'A' })
    expect(await wrapped.getTrack({ deviceId: 1, trackId: 'C' })).toEqual({ trackId: 'C' })
    expect(seen).toEqual(['A', 'C'])
  })

  it('resolves each id of a trackIds array, once per survivor', async () => {
    const seen: string[][] = []
    const impl = {
      deleteTracks: async (input: { deviceId: number; trackIds: readonly string[] }) => {
        seen.push([...input.trackIds])
      },
    }
    const wrapped = resolvingTrackIds(impl, new Set(['deleteTracks']), async (id) =>
      id === 'B' ? 'A' : null,
    )
    await wrapped.deleteTracks({ deviceId: 1, trackIds: ['A', 'B', 'C'] })
    expect(seen).toEqual([['A', 'C']])
  })
})

/**
 * Carried obligation from the Task 18 review (M4): the Notification Center
 * reads media IN-PROCESS by `track:<absorbedId>`
 * (notification-center/dispatcher.ts's `resolveAttachment`, reached via
 * pipeline-analytics/index.ts's `getMediaForOwner`). That call never crosses
 * a cap boundary, so `resolvingTrackIds` above does not cover it — a
 * delivery that resolves after the fusion re-point (recognition wait, outbox
 * retry, AI narration) would otherwise lose its scene stills.
 *
 * Disarm: make `resolveMediaOwnerId` return `ownerId` unconditionally (skip
 * the resolve call) — "a fused track owner resolves to its survivor" fails.
 */
describe('alias resolution on the in-process media read (NC dispatcher)', () => {
  it('a fused track owner resolves to its survivor', async () => {
    const resolved = await resolveMediaOwnerId('track', 'B', async (id) =>
      id === 'B' ? 'A' : null,
    )
    expect(resolved).toBe('A')
  })

  it('an unfused track owner is returned unchanged', async () => {
    const resolved = await resolveMediaOwnerId('track', 'C', async (id) =>
      id === 'B' ? 'A' : null,
    )
    expect(resolved).toBe('C')
  })

  it('an object owner is never resolved — only a track id can be fused', async () => {
    const resolve = async (_id: string): Promise<string | null> => {
      throw new Error('resolve must not be called for an object owner')
    }
    const resolved = await resolveMediaOwnerId('object', 'evt-1', resolve)
    expect(resolved).toBe('evt-1')
  })
})

/**
 * Review H1: `setTrackRelation`/`clearTrackRelation` carry a SECOND track
 * reference (`otherTrackId`) alongside `trackId`. The wrapper swept both
 * methods into scope on their `trackId` field alone and left `otherTrackId`
 * untouched — this generalizes `resolveInput` to resolve every
 * `trackId`-SHAPED key by suffix, not a hard-coded two-key list, so a future
 * third reference needs no review to catch it.
 */
describe('a second track reference on the same input resolves too (review H1)', () => {
  it('resolves otherTrackId — the real setTrackRelation/clearTrackRelation shape', async () => {
    const seen: Array<{ trackId: string; otherTrackId: string }> = []
    const impl = {
      setTrackRelation: async (input: {
        deviceId: number
        trackId: string
        otherTrackId: string
        relation: string
      }) => {
        seen.push({ trackId: input.trackId, otherTrackId: input.otherTrackId })
        return { cleared: false }
      },
    }
    const wrapped = resolvingTrackIds(impl, new Set(['setTrackRelation']), async (id) =>
      id === 'B' ? 'A' : null,
    )
    await wrapped.setTrackRelation({
      deviceId: 1,
      trackId: 'B',
      otherTrackId: 'B',
      relation: 'same-subject',
    })
    expect(seen).toEqual([{ trackId: 'A', otherTrackId: 'A' }])
  })

  it('generalizes by suffix, not a hard-coded field name — a hypothetical secondTrackId resolves too', async () => {
    const seen: string[] = []
    const impl = {
      mergeTracks: async (input: { trackId: string; secondTrackId: string }) => {
        seen.push(input.secondTrackId)
      },
    }
    const wrapped = resolvingTrackIds(impl, new Set(['mergeTracks']), async (id) =>
      id === 'B' ? 'A' : null,
    )
    await wrapped.mergeTracks({ trackId: 'X', secondTrackId: 'B' })
    expect(seen).toEqual(['A'])
  })

  it('the real caps still sweep setTrackRelation/clearTrackRelation into scope', () => {
    expect(trackIdTakingMethods(pipelineAnalyticsCapability.methods).has('setTrackRelation')).toBe(
      true,
    )
    expect(
      trackIdTakingMethods(pipelineAnalyticsCapability.methods).has('clearTrackRelation'),
    ).toBe(true)
  })
})

/**
 * Review H2 (D315): an alias-store lookup failure must never turn a read
 * that used to succeed into a thrown error. Every path falls back to the id
 * as asked, and reports the failure once via `onFailure` rather than
 * silently swallowing it.
 */
describe('an alias-store failure degrades to "treat the id as its own" (review H2)', () => {
  it('resolvingTrackIds: a rejecting resolve does not throw, and falls back to the asked id', async () => {
    const impl = {
      getTrack: async (input: { deviceId: number; trackId: string }) => input,
    }
    const failures: AliasResolveFailure[] = []
    const wrapped = resolvingTrackIds(
      impl,
      new Set(['getTrack']),
      async (): Promise<string | null> => {
        throw new Error('store unavailable')
      },
      { onFailure: (f) => failures.push(f) },
    )
    const out = await wrapped.getTrack({ deviceId: 101, trackId: 'B' })
    expect(out).toEqual({ deviceId: 101, trackId: 'B' })
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ method: 'getTrack', id: 'B', deviceId: 101 })
  })

  it('resolvingTrackIds: omits deviceId from the failure when the input carries none', async () => {
    const impl = { getTrack: async (input: { trackId: string }) => input }
    const failures: AliasResolveFailure[] = []
    const wrapped = resolvingTrackIds(
      impl,
      new Set(['getTrack']),
      async (): Promise<string | null> => {
        throw new Error('store unavailable')
      },
      { onFailure: (f) => failures.push(f) },
    )
    await wrapped.getTrack({ trackId: 'B' })
    expect(failures[0]?.deviceId).toBeUndefined()
  })

  it('resolveMediaOwnerId: a rejecting resolve does not throw, and falls back to the asked id', async () => {
    const failures: AliasResolveFailure[] = []
    const resolved = await resolveMediaOwnerId(
      'track',
      'B',
      async (): Promise<string | null> => {
        throw new Error('store unavailable')
      },
      (f) => failures.push(f),
      'readOwnerThumbnail',
    )
    expect(resolved).toBe('B')
    expect(failures).toEqual([{ method: 'readOwnerThumbnail', id: 'B', error: expect.anything() }])
  })

  it('resolvingTrackIds: a rejecting resolveMany does not throw, and falls back to every asked id', async () => {
    const impl = {
      deleteTracks: async (input: { deviceId: number; trackIds: readonly string[] }) => input,
    }
    const failures: string[] = []
    const wrapped = resolvingTrackIds(impl, new Set(['deleteTracks']), async () => null, {
      resolveMany: async (): Promise<ReadonlyMap<string, string>> => {
        throw new Error('store unavailable')
      },
      onFailure: (f) => failures.push(f.id),
    })
    const out = await wrapped.deleteTracks({ deviceId: 1, trackIds: ['A', 'B'] })
    expect(out).toEqual({ deviceId: 1, trackIds: ['A', 'B'] })
    expect(failures.sort()).toEqual(['A', 'B'])
  })
})

/**
 * Review M1: a `trackIds` array must batch through ONE `resolveMany` round
 * trip, not one `resolve` call per id — `TrackAliasStore.resolveMany`'s own
 * doc comment warns against reintroducing exactly this N+1.
 */
describe('trackIds arrays batch through resolveMany (review M1)', () => {
  it('uses resolveMany once for the whole array, never the single-id resolve', async () => {
    let resolveCalls = 0
    let resolveManyCalls = 0
    const impl = {
      deleteTracks: async (input: { deviceId: number; trackIds: readonly string[] }) => input,
    }
    const wrapped = resolvingTrackIds(
      impl,
      new Set(['deleteTracks']),
      async (): Promise<string | null> => {
        resolveCalls += 1
        return null
      },
      {
        resolveMany: async (ids) => {
          resolveManyCalls += 1
          return new Map(ids.filter((id) => id === 'B').map((id): [string, string] => [id, 'A']))
        },
      },
    )
    const out = await wrapped.deleteTracks({ deviceId: 1, trackIds: ['A', 'B', 'C'] })
    expect(out).toEqual({ deviceId: 1, trackIds: ['A', 'C'] })
    expect(resolveManyCalls).toBe(1)
    expect(resolveCalls).toBe(0)
  })

  it('falls back to per-id resolve when the caller supplies no resolveMany (back-compat)', async () => {
    const impl = {
      deleteTracks: async (input: { deviceId: number; trackIds: readonly string[] }) => input,
    }
    const wrapped = resolvingTrackIds(impl, new Set(['deleteTracks']), async (id) =>
      id === 'B' ? 'A' : null,
    )
    const out = await wrapped.deleteTracks({ deviceId: 1, trackIds: ['A', 'B', 'C'] })
    expect(out).toEqual({ deviceId: 1, trackIds: ['A', 'C'] })
  })
})

describe('sampledOnce — a bounded-memo WARN sample (review H2)', () => {
  it('reports the same (method, id) failure only once', () => {
    const seen: AliasResolveFailure[] = []
    const report = sampledOnce(10, (f) => seen.push(f))
    const failure: AliasResolveFailure = { method: 'getTrack', id: 'B', error: new Error('x') }
    report(failure)
    report(failure)
    report(failure)
    expect(seen).toHaveLength(1)
  })

  it('reports a DIFFERENT id, or a different method on the same id, separately', () => {
    const seen: AliasResolveFailure[] = []
    const report = sampledOnce(10, (f) => seen.push(f))
    report({ method: 'getTrack', id: 'B', error: new Error('x') })
    report({ method: 'getTrack', id: 'C', error: new Error('x') })
    report({ method: 'setTrackFlags', id: 'B', error: new Error('x') })
    expect(seen).toHaveLength(3)
  })

  it('clears the memo once it reaches max, so a later failure reports again', () => {
    const seen: AliasResolveFailure[] = []
    const report = sampledOnce(1, (f) => seen.push(f))
    report({ method: 'getTrack', id: 'B', error: new Error('x') })
    report({ method: 'getTrack', id: 'C', error: new Error('x') })
    expect(seen).toHaveLength(2)
  })
})

/**
 * Fix round 2: `ownersWithMedia`'s `ownerIds` is a track id only when its
 * sibling `ownerKind === 'track'` — a discriminated field the generic
 * trackId/otherTrackId-SUFFIX sweep above cannot see (there is no sibling
 * `ownerKind` visible from a key name alone), so it gets its own declared
 * resolver rather than a taught heuristic. The answer must come back keyed
 * by the id the caller ASKED with, never the resolved survivor — the real
 * caller (`videoclips-provider.ts`'s `resolveVouchedEvents`) looks the
 * answer up by `event.trackId`, the pre-resolution id.
 *
 * Disarm: make `resolveTrackOwnerIds` return `new Map(askedIds.map((id) =>
 * [id, id]))` (skip the resolve call) — "maps an absorbed asked id to its
 * survivor" fails.
 */
describe('resolveTrackOwnerIds — the ownersWithMedia track branch (review fix round 2)', () => {
  it('maps an absorbed asked id to its survivor', async () => {
    const resolved = await resolveTrackOwnerIds(
      ['B', 'C'],
      async (ids) =>
        new Map(ids.filter((id) => id === 'B').map((id): [string, string] => [id, 'A'])),
    )
    expect(resolved.get('B')).toBe('A')
    expect(resolved.get('C')).toBe('C')
  })

  it('every asked id is present in the result, even one resolveMany never answered for', async () => {
    const resolved = await resolveTrackOwnerIds(['B', 'C'], async () => new Map())
    expect([...resolved.keys()].sort()).toEqual(['B', 'C'])
  })

  it('a rejecting resolveMany does not throw — every asked id falls back to itself (review H2)', async () => {
    const failures: AliasResolveFailure[] = []
    const resolved = await resolveTrackOwnerIds(
      ['B', 'C'],
      async (): Promise<ReadonlyMap<string, string>> => {
        throw new Error('store unavailable')
      },
      (f) => failures.push(f),
    )
    expect(resolved.get('B')).toBe('B')
    expect(resolved.get('C')).toBe('C')
    expect(failures.map((f) => f.method)).toEqual(['ownersWithMedia', 'ownersWithMedia'])
  })
})
