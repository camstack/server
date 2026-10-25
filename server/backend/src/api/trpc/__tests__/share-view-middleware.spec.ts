/* eslint-disable @typescript-eslint/no-unsafe-assignment -- test router callers cross typed boundaries */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AuthenticatedAgent, TrpcContext } from '../trpc.context.js'
import { protectedProcedure, trpcRouter } from '../trpc.middleware.js'

/**
 * protectedProcedure × share-view principals — integration of the
 * fail-closed allowlist gate at the middleware level, exercised through a
 * miniature router whose paths mirror the real embed surface names.
 *
 * Verifies:
 *   • share principal → allowlisted method + in-scope device passes;
 *   • share principal → out-of-scope device is FORBIDDEN;
 *   • share principal → non-allowlisted method is FORBIDDEN, including
 *     hand-written core routes that ordinary non-admin callers CAN reach;
 *   • ordinary users are unaffected by the new branch.
 */

const testRouter = trpcRouter({
  auth: trpcRouter({
    me: protectedProcedure.input(z.void()).query(({ ctx }) => ({ id: ctx.user.id })),
    // Hand-written core route NOT on the share allowlist — ordinary
    // authenticated users pass through, share principals must not.
    logout: protectedProcedure.input(z.void()).mutation(() => ({ success: true as const })),
  }),
  snapshot: trpcRouter({
    getSnapshot: protectedProcedure
      .input(z.object({ deviceId: z.number() }))
      .query(({ input }) => ({ deviceId: input.deviceId, base64: 'zzz' })),
  }),
  webrtcSession: trpcRouter({
    createSession: protectedProcedure
      .input(z.object({ deviceId: z.number() }))
      .mutation(({ input }) => ({ sessionId: `s-${input.deviceId}` })),
  }),
  // The events surface. Each provider deliberately answers rows for devices
  // the caller did NOT ask about (and, for the search, for the whole
  // deployment) — that is the situation the response projection exists for,
  // and a provider that pre-filtered would test nothing.
  pipelineAnalytics: trpcRouter({
    listRecentTracks: protectedProcedure
      .input(z.object({ deviceIds: z.array(z.number()) }))
      .query(() => ({
        tracks: [
          { trackId: 't5', deviceId: 5 },
          { trackId: 't42', deviceId: 42 },
          { trackId: 't7', deviceId: 7 },
        ],
        nextCursor: 'cur-1',
      })),
    listEventKindsBatch: protectedProcedure
      .input(z.object({ deviceIds: z.array(z.number()) }))
      .query(() => [
        { deviceId: 5, kinds: [] },
        { deviceId: 42, kinds: [] },
      ]),
    searchObjectEvents: protectedProcedure
      .input(z.object({ text: z.string(), deviceId: z.number().optional() }))
      .query(() => [
        { id: 'e1', deviceId: 5 },
        { id: 'e2', deviceId: 42 },
        { id: 'e3', deviceId: 99 },
      ]),
    deleteTracks: protectedProcedure
      .input(z.object({ deviceId: z.number() }))
      .mutation(() => ({ deleted: 1 })),
  }),
})

function makeShareUser(
  deviceIds: number[],
  kind: 'grid-view' | 'events-view' = 'grid-view',
): AuthenticatedAgent {
  return {
    id: 'u-owner',
    username: 'token:share grid-view',
    isAdmin: false,
    permissions: { isAdmin: false, allowedProviders: '*', allowedDevices: {} },
    isApiKey: true,
    scopes: [{ type: 'share-view', grant: { kind, deviceIds } }],
  }
}

function makeRegularUser(): AuthenticatedAgent {
  return {
    id: 'u-2',
    username: 'bob',
    isAdmin: false,
    permissions: { isAdmin: false, allowedProviders: '*', allowedDevices: {} },
    isApiKey: false,
    scopes: [],
  }
}

function makeAdminUser(): AuthenticatedAgent {
  return {
    id: 'u-admin',
    username: 'root',
    isAdmin: true,
    permissions: { isAdmin: true, allowedProviders: '*', allowedDevices: {} },
    isApiKey: false,
    scopes: ['*'],
  }
}

function makeCaller(user: AuthenticatedAgent | null) {
  const ctx: TrpcContext = { user }
  return testRouter.createCaller(ctx)
}

describe('protectedProcedure — share-view gate', () => {
  it('rejects unauthenticated callers outright (UNAUTHORIZED)', async () => {
    const caller = makeCaller(null)
    await expect(caller.auth.me()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  describe('share-view principal', () => {
    it('can call an allowlisted open method (auth.me)', async () => {
      const caller = makeCaller(makeShareUser([5]))
      await expect(caller.auth.me()).resolves.toEqual({ id: 'u-owner' })
    })

    it('can call a device method for an IN-scope device', async () => {
      const caller = makeCaller(makeShareUser([5, 7]))
      await expect(caller.snapshot.getSnapshot({ deviceId: 5 })).resolves.toEqual({
        deviceId: 5,
        base64: 'zzz',
      })
      await expect(caller.webrtcSession.createSession({ deviceId: 7 })).resolves.toEqual({
        sessionId: 's-7',
      })
    })

    it('is FORBIDDEN on a device method for an OUT-of-scope device', async () => {
      const caller = makeCaller(makeShareUser([5]))
      await expect(caller.snapshot.getSnapshot({ deviceId: 42 })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      })
      await expect(caller.webrtcSession.createSession({ deviceId: 42 })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      })
    })

    it('is FORBIDDEN on a non-allowlisted hand-written core route', async () => {
      const caller = makeCaller(makeShareUser([5]))
      await expect(caller.auth.logout()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    })
  })

  describe('events-view principal', () => {
    it('lists tracks, and the response carries ONLY in-scope devices', async () => {
      const caller = makeCaller(makeShareUser([5, 7], 'events-view'))
      const page = await caller.pipelineAnalytics.listRecentTracks({ deviceIds: [5, 7] })
      expect(page.tracks.map((t) => t.deviceId)).toEqual([5, 7])
      // The cursor survives — dropping it would end a shared page's infinite
      // scroll at page one.
      expect(page.nextCursor).toBe('cur-1')
    })

    it('a PARTIALLY in-scope request is filtered, not refused', async () => {
      const caller = makeCaller(makeShareUser([5], 'events-view'))
      const page = await caller.pipelineAnalytics.listRecentTracks({ deviceIds: [5, 42] })
      expect(page.tracks.map((t) => t.trackId)).toEqual(['t5'])
    })

    it('a FULLY disjoint request is FORBIDDEN, not an empty page', async () => {
      const caller = makeCaller(makeShareUser([5], 'events-view'))
      await expect(
        caller.pipelineAnalytics.listRecentTracks({ deviceIds: [42] }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    })

    it('scopes the taxonomy batch too', async () => {
      const caller = makeCaller(makeShareUser([5], 'events-view'))
      const kinds = await caller.pipelineAnalytics.listEventKindsBatch({ deviceIds: [5, 42] })
      expect(kinds.map((k) => k.deviceId)).toEqual([5])
    })

    it('a CLIP search with NO deviceId searches everywhere and is cut to the scope', async () => {
      // The one that matters: the provider answered for 5, 42 and 99. The
      // caller never scoped the query — the server did.
      const caller = makeCaller(makeShareUser([5], 'events-view'))
      const hits = await caller.pipelineAnalytics.searchObjectEvents({ text: 'car' })
      expect(hits.map((h) => h.deviceId)).toEqual([5])
    })

    it('is FORBIDDEN on a CLIP search pinned to an out-of-scope camera', async () => {
      const caller = makeCaller(makeShareUser([5], 'events-view'))
      await expect(
        caller.pipelineAnalytics.searchObjectEvents({ text: 'car', deviceId: 42 }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    })

    it('cannot open a camera wall — an events link is not a grid link', async () => {
      const caller = makeCaller(makeShareUser([5], 'events-view'))
      await expect(caller.snapshot.getSnapshot({ deviceId: 5 })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      })
      await expect(caller.webrtcSession.createSession({ deviceId: 5 })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      })
    })

    it('cannot MUTATE anything', async () => {
      const caller = makeCaller(makeShareUser([5], 'events-view'))
      await expect(caller.pipelineAnalytics.deleteTracks({ deviceId: 5 })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      })
    })
  })

  describe('an existing GRID token gains nothing (no retroactive widening)', () => {
    it('still cannot list tracks', async () => {
      const caller = makeCaller(makeShareUser([5, 7], 'grid-view'))
      await expect(
        caller.pipelineAnalytics.listRecentTracks({ deviceIds: [5] }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(
        caller.pipelineAnalytics.searchObjectEvents({ text: 'car', deviceId: 5 }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    })

    it('keeps the camera wall it was minted for', async () => {
      const caller = makeCaller(makeShareUser([5], 'grid-view'))
      await expect(caller.snapshot.getSnapshot({ deviceId: 5 })).resolves.toMatchObject({
        deviceId: 5,
      })
    })
  })

  describe('ordinary authenticated user (regression guard)', () => {
    it('still passes hand-written core routes untouched by the share gate', async () => {
      const caller = makeCaller(makeRegularUser())
      await expect(caller.auth.me()).resolves.toEqual({ id: 'u-2' })
      await expect(caller.auth.logout()).resolves.toEqual({ success: true })
    })

    it('a scopeless non-admin is still gated by the SCOPE matcher, not by this', async () => {
      // Unchanged behaviour, asserted so the new branch cannot be blamed for
      // it later: `pipelineAnalytics` is a device-scope cap and this user holds
      // no grants.
      const caller = makeCaller(makeRegularUser())
      await expect(
        caller.pipelineAnalytics.listRecentTracks({ deviceIds: [5] }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    })

    it('an ADMIN is NOT device-filtered — the projection is share-principals only', async () => {
      // The new branch must never start cutting rows for a real session. An
      // admin takes the bypass above it, so the provider's full answer must
      // arrive intact — all three devices, including the two no share link
      // could see.
      const caller = makeCaller(makeAdminUser())
      const page = await caller.pipelineAnalytics.listRecentTracks({ deviceIds: [5] })
      expect(page.tracks).toHaveLength(3)
      const hits = await caller.pipelineAnalytics.searchObjectEvents({ text: 'car' })
      expect(hits.map((h) => h.deviceId)).toEqual([5, 42, 99])
    })
  })
})
