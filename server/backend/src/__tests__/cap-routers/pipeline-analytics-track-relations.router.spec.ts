/**
 * The four ground-truth methods (D681) reach the provider VERBATIM and are
 * `protected`: the viewer marks tracks from an authenticated non-admin
 * session, exactly like `setTrackFlags`. The hub strips keys it does not
 * know, so a field lost here degrades marking silently — assert on what the
 * provider RECEIVED.
 *
 * Disarm: give `setTrackRelation` `{ auth: 'admin' }` in the cap and re-run
 * codegen — the auth-matrix test must fail.
 */
import { describe, expect, it } from 'vitest'
import { buildCapRouterForTest, checkAuthMatrix, invokeProcedure, makeCtx } from './harness.js'

const RELATION = {
  id: 'r1',
  deviceId: 101,
  leftTrackId: 'a',
  rightTrackId: 'b',
  leftSide: null,
  rightSide: 'after',
  relation: 'same-subject',
  presence: 'continuous',
  leftStartedAt: 1,
  rightStartedAt: 2,
  createdAt: 3,
  updatedAt: 3,
  author: null,
}

function provider(seen: unknown[]): Record<string, (input: unknown) => Promise<unknown>> {
  return {
    setTrackRelation: async (input) => {
      seen.push(input)
      return RELATION
    },
    clearTrackRelation: async (input) => {
      seen.push(input)
      return { cleared: true }
    },
    setTrackPurity: async (input) => {
      seen.push(input)
      return { purity: null }
    },
    listTrackRelations: async (input) => {
      seen.push(input)
      return { relations: [RELATION], purities: [], truncated: false }
    },
  }
}

describe('pipelineAnalytics ground-truth methods', () => {
  it('forwards setTrackRelation verbatim, sides and presence included', async () => {
    const seen: unknown[] = []
    const router = buildCapRouterForTest('pipeline-analytics', () => provider(seen))
    const input = {
      deviceId: 101,
      trackId: 'b',
      otherTrackId: 'a',
      relation: 'same-subject',
      presence: 'continuous',
      trackSide: 'after',
      otherSide: 'before',
    }
    const out = await invokeProcedure(router, 'setTrackRelation', makeCtx('user'), input)
    expect(out.ok).toBe(true)
    expect(seen).toEqual([input])
  })

  it('forwards setTrackPurity and listTrackRelations verbatim', async () => {
    const seen: unknown[] = []
    const router = buildCapRouterForTest('pipeline-analytics', () => provider(seen))
    await invokeProcedure(router, 'setTrackPurity', makeCtx('user'), {
      deviceId: 101,
      trackId: 'a',
      purity: 'mixed',
      switchAtMs: 5,
    })
    await invokeProcedure(router, 'listTrackRelations', makeCtx('user'), {
      deviceId: 101,
      trackId: 'a',
      since: 1,
      until: 9,
      limit: 10,
    })
    expect(seen).toEqual([
      { deviceId: 101, trackId: 'a', purity: 'mixed', switchAtMs: 5 },
      { deviceId: 101, trackId: 'a', since: 1, until: 9, limit: 10 },
    ])
  })

  it.each([
    'setTrackRelation',
    'clearTrackRelation',
    'setTrackPurity',
    'listTrackRelations',
  ])('%s is protected', async (method) => {
    const router = buildCapRouterForTest('pipeline-analytics', () => provider([]))
    const input =
      method === 'setTrackPurity'
        ? { deviceId: 101, trackId: 'a', purity: 'pure' }
        : method === 'listTrackRelations'
          ? { deviceId: 101 }
          : { deviceId: 101, trackId: 'a', otherTrackId: 'b', relation: 'same-subject' }
    for (const row of await checkAuthMatrix(router, method, 'protected', input)) {
      expect(row.outcome.ok).toBe(row.allowed)
    }
  })
})
