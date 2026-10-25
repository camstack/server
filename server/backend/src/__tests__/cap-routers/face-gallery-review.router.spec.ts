/**
 * The `face-gallery` router carries the REVIEW query all the way to the
 * provider.
 *
 * This is not a formality. The hub validates a cap call against ITS OWN
 * compiled Zod and **strips a key it does not know** — which is why every
 * input field on this cap carries a "does not reach the addon until the next
 * train" note. The mirror of that is the failure this spec exists to prevent:
 * a field declared in the `.cap.ts` but dropped on the way through, so the
 * operator's camera filter or sort silently degrades to the default and the
 * page looks merely "wrong-ish" instead of broken.
 *
 * So: assert on what the PROVIDER received, not on what came back.
 */
import { describe, expect, it } from 'vitest'
import type { FaceInfo, IFaceGalleryProvider, ListRecentFacesInput } from '@camstack/types'
import { buildCapRouterForTest, invokeProcedure, makeCtx } from './harness.js'

interface Recorded {
  readonly listRecentFaces: ListRecentFacesInput[]
  readonly suggestFaceClusters: unknown[]
}

function makeRecordingProvider(): {
  readonly provider: Partial<IFaceGalleryProvider>
  readonly seen: Recorded
} {
  const seen: Recorded = { listRecentFaces: [], suggestFaceClusters: [] }
  const provider: Partial<IFaceGalleryProvider> = {
    listIdentities: async () => [],
    createIdentity: async ({ name }) => ({ id: 'id-1', name, sampleCount: 0 }),
    renameIdentity: async () => {},
    deleteIdentity: async () => {},
    listIdentitySamples: async () => [],
    removeSample: async () => {},
    listRecentFaces: async (input) => {
      seen.listRecentFaces.push(input ?? {})
      const face: FaceInfo = {
        faceId: 'f1',
        deviceId: 102,
        trackId: 't1',
        timestamp: 1_000,
        assigned: false,
      }
      return [face]
    },
    getFaceByTrack: async () => null,
    getFaceMedia: async () => [],
    assignFace: async () => {},
    unassignFace: async () => {},
    deleteFace: async () => {},
    assignFaces: async () => ({ assigned: 0, failed: [] }),
    unassignFaces: async () => ({ unassigned: 0, failed: [] }),
    suggestFaceClusters: async (input) => {
      seen.suggestFaceClusters.push(input ?? {})
      return []
    },
  }
  return { provider, seen }
}

describe('faceGallery router — the review query survives the hub', () => {
  it('forwards deviceIds, since/until and the sort to the provider VERBATIM', async () => {
    const { provider, seen } = makeRecordingProvider()
    const router = buildCapRouterForTest('face-gallery', () => provider)

    const outcome = await invokeProcedure(router, 'listRecentFaces', makeCtx('admin'), {
      deviceIds: [101, 102],
      since: 1_000,
      until: 2_000,
      sortBy: 'suggestionConfidence',
      sortDirection: 'asc',
      filter: 'unassigned',
      limit: 100,
    })

    expect(outcome.ok).toBe(true)
    expect(seen.listRecentFaces).toEqual([
      {
        deviceIds: [101, 102],
        since: 1_000,
        until: 2_000,
        sortBy: 'suggestionConfidence',
        sortDirection: 'asc',
        filter: 'unassigned',
        limit: 100,
      },
    ])
  })

  it('forwards an EMPTY deviceIds — the router must not treat [] as absent', async () => {
    const { provider, seen } = makeRecordingProvider()
    const router = buildCapRouterForTest('face-gallery', () => provider)

    await invokeProcedure(router, 'listRecentFaces', makeCtx('admin'), { deviceIds: [] })

    expect(seen.listRecentFaces[0]).toEqual({ deviceIds: [] })
  })

  it('rejects a sort key the cap does not define, instead of silently defaulting', async () => {
    const { provider } = makeRecordingProvider()
    const router = buildCapRouterForTest('face-gallery', () => provider)

    const outcome = await invokeProcedure(router, 'listRecentFaces', makeCtx('admin'), {
      sortBy: 'vibes',
    })
    expect(outcome.ok).toBe(false)
  })

  it('carries BOTH clustering bounds — the pool and the answer are separate keys', async () => {
    const { provider, seen } = makeRecordingProvider()
    const router = buildCapRouterForTest('face-gallery', () => provider)

    await invokeProcedure(router, 'suggestFaceClusters', makeCtx('admin'), {
      threshold: 0.6,
      minClusterSize: 3,
      maxFacesScanned: 250,
      maxClusters: 20,
    })

    expect(seen.suggestFaceClusters[0]).toEqual({
      threshold: 0.6,
      minClusterSize: 3,
      maxFacesScanned: 250,
      maxClusters: 20,
    })
  })

  it('still accepts the deprecated `limit` alias, so an old caller is untouched', async () => {
    const { provider, seen } = makeRecordingProvider()
    const router = buildCapRouterForTest('face-gallery', () => provider)

    await invokeProcedure(router, 'suggestFaceClusters', makeCtx('admin'), { limit: 5 })

    expect(seen.suggestFaceClusters[0]).toEqual({ limit: 5 })
  })
})
