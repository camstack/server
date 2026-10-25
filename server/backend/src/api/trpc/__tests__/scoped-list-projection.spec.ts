/**
 * F1 #4 — a device-scoped principal ENUMERATES only its own devices.
 *
 * Driven through the REAL `protectedProcedure` middleware (a router built on
 * it, called with a real `TrpcContext`), not against the pure projector: the
 * F0.6 lesson is that a matcher can be green while the wiring does nothing.
 *
 * Two halves, and BOTH must hold or the feature is a leak:
 *   • reachability — a `device` selector grant may call `deviceManager.listAll`
 *     at all (it names no device, so the by-id branch cannot admit it);
 *   • projection — the answer is cut to the caller's viewable set, because
 *     that is the ONLY reason reaching it is safe.
 *
 * Neutralisation: drop the `DEVICE_ENUMERATION_METHODS` projection block in
 * `trpc.middleware.ts` and "returns only the granted camera" fails with the
 * whole fleet — the exact leak the reachability branch would otherwise open.
 */

import type { DeviceMetaLike } from '@camstack/types'
import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AuthenticatedAgent, TrpcContext } from '../trpc.context.js'
import { protectedProcedure, trpcRouter } from '../trpc.middleware.js'

/** Fleet: camera 5 (+ siren child 51), camera 7, light 20 in "Garden". */
const FLEET: readonly DeviceMetaLike[] = [
  { id: 5, type: DeviceType.Camera, location: 'Front', parentDeviceId: null },
  { id: 51, type: DeviceType.Siren, location: null, parentDeviceId: 5 },
  { id: 7, type: DeviceType.Camera, location: 'Garden', parentDeviceId: null },
  { id: 20, type: DeviceType.Light, location: 'Garden', parentDeviceId: null },
]

/** What the real `listAll` returns — including the `config` blob that carries
 *  camera credentials, so the projection's row whitelist is exercised. */
const ROWS = FLEET.map((d) => ({
  id: d.id,
  name: `dev-${d.id}`,
  type: d.type,
  location: d.location,
  online: true,
  isCamera: d.type === DeviceType.Camera,
  disabled: false,
  config: { host: '10.0.0.1', username: 'operator', password: 'PLAINTEXT-SECRET' },
}))

// A router mounted on the REAL protectedProcedure, at the real path.
const testRouter = trpcRouter({
  deviceManager: trpcRouter({
    listAll: protectedProcedure
      .input(z.object({ projection: z.string().optional() }).optional())
      .query(() => ROWS),
  }),
  snapshot: trpcRouter({
    // Real batch shape: rows carrying deviceId, driven by a targets array.
    getSnapshotLinks: protectedProcedure
      .input(
        z.object({
          targets: z.array(z.object({ deviceId: z.number(), width: z.number().optional() })),
        }),
      )
      .query(({ input }) =>
        input.targets.map((t) => ({ deviceId: t.deviceId, url: `/link/${t.deviceId}` })),
      ),
    getSnapshotOverview: protectedProcedure
      .input(z.object({ deviceIds: z.array(z.number()) }))
      .query(({ input }) =>
        input.deviceIds.map((deviceId) => ({ deviceId, lastCapturedAt: 1000 })),
      ),
  }),
  pipelineAnalytics: trpcRouter({
    // The events feed: rows one level down under `tracks`.
    listRecentTracks: protectedProcedure
      .input(z.object({ deviceIds: z.array(z.number()) }))
      .query(({ input }) => ({
        tracks: input.deviceIds.map((deviceId) => ({ deviceId, trackId: `t-${deviceId}` })),
        nextCursor: null,
      })),
    listEventKindsBatch: protectedProcedure
      .input(z.object({ deviceIds: z.array(z.number()) }))
      .query(({ input }) => input.deviceIds.map((deviceId) => ({ deviceId, kinds: [] }))),
  }),
})

function makeUser(scopes: AuthenticatedAgent['scopes'], isAdmin = false): AuthenticatedAgent {
  return {
    id: 'u-1',
    username: 'alice',
    isAdmin,
    permissions: { isAdmin, allowedProviders: '*', allowedDevices: {} },
    isApiKey: true,
    scopes: isAdmin ? ['*'] : scopes,
  }
}

function caller(user: AuthenticatedAgent) {
  const ctx: TrpcContext = {
    user,
    deviceFleet: () => FLEET,
    deviceScopeLookup: {
      getAncestors: (id) => (id === 51 ? [5] : []),
      getType: (id) => FLEET.find((d) => d.id === id)?.type ?? null,
      getLocation: (id) => FLEET.find((d) => d.id === id)?.location ?? null,
    },
  }
  return testRouter.createCaller(ctx)
}

function idsOf(out: unknown): number[] {
  if (!Array.isArray(out)) throw new Error('expected an array payload')
  return out.map((r: unknown) => Number(Reflect.get(r as object, 'id'))).sort((a, b) => a - b)
}

describe('deviceManager.listAll — scoped enumeration (F1 #4)', () => {
  it('a device:[5] grant REACHES listAll at all', async () => {
    const out = await caller(
      makeUser([{ type: 'device', selector: { kind: 'ids', ids: [5] }, access: ['view'] }]),
    ).deviceManager.listAll({})
    expect(Array.isArray(out)).toBe(true)
  })

  it('returns only the granted camera and its accessory — never the fleet', async () => {
    const out = await caller(
      makeUser([{ type: 'device', selector: { kind: 'ids', ids: [5] }, access: ['view'] }]),
    ).deviceManager.listAll({})
    // 5 plus its inherited child 51; cameras 7 and light 20 are INVISIBLE.
    expect(idsOf(out)).toEqual([5, 51])
  })

  it('a types:[camera] grant enumerates cameras (and their accessories) only', async () => {
    const out = await caller(
      makeUser([
        {
          type: 'device',
          selector: { kind: 'types', types: [DeviceType.Camera] },
          access: ['view'],
        },
      ]),
    ).deviceManager.listAll({})
    expect(idsOf(out)).toEqual([5, 7, 51])
  })

  it('the projected rows NEVER carry the device config/credentials', async () => {
    const out = await caller(
      makeUser([{ type: 'device', selector: { kind: 'ids', ids: [5] }, access: ['view'] }]),
    ).deviceManager.listAll({})
    expect(JSON.stringify(out)).not.toContain('PLAINTEXT-SECRET')
    expect(Reflect.get((out as object[])[0] as object, 'config')).toBeUndefined()
  })

  it('an UNRESTRICTED viewer still gets the whole fleet untouched', async () => {
    // `device-manager` is a SYSTEM-scope cap, so reaching `listAll` needs a
    // system grant; the `all` device selector is what makes the reach
    // unrestricted and therefore unprojected.
    const out = await caller(
      makeUser([
        { type: 'category', target: 'system', access: ['view'] },
        { type: 'device', selector: { kind: 'all' }, access: ['view'] },
      ]),
    ).deviceManager.listAll({})
    expect(idsOf(out)).toEqual([5, 7, 20, 51])
    // Unprojected does NOT mean unredacted: the row keeps its `config`, but
    // the F0 secret-redaction layer still strips the credential for a
    // non-admin. The two protections compose rather than replace each other.
    expect(JSON.stringify(out)).not.toContain('PLAINTEXT-SECRET')
    const first = (out as object[])[0] as object
    expect(Reflect.get(first, 'config')).toBeDefined()
  })

  it('an admin is never projected', async () => {
    const out = await caller(makeUser([], true)).deviceManager.listAll({})
    expect(idsOf(out)).toEqual([5, 7, 20, 51])
  })

  it('a category:system-only principal enumerates NOTHING (zero viewable devices)', async () => {
    const out = await caller(
      makeUser([{ type: 'category', target: 'system', access: ['view'] }]),
    ).deviceManager.listAll({})
    expect(idsOf(out)).toEqual([])
  })
})

/**
 * Device batch methods — the viewer's snapshot links/overview and the merged
 * events feed name their devices in ARRAYS (`deviceIds[]`, and one nesting
 * level down, `targets[].deviceId`), which the original single-`deviceId`
 * extractor could not see (2026-08-15: a non-admin viewer with
 * `device:[all]` received no snapshots and no events — every one of these
 * failed closed).
 *
 * The gate is automatic and request-side: the codegen'd
 * `METHOD_DEVICE_SELECTORS` records every reference shape, and the matcher
 * requires EVERY referenced device to be covered — no per-method allowlist,
 * no response projection. A new batch method is gated the moment it is
 * declared.
 */
describe('device batch methods — scoped arrays (snapshots + events feed)', () => {
  const deviceAll = makeUser([
    { type: 'device', selector: { kind: 'all' }, access: ['view', 'create'] },
    { type: 'category', target: 'system', access: ['view', 'create'] },
  ])

  it('a device:[all] viewer reaches snapshot links and overview (the bob report)', async () => {
    const c = caller(deviceAll)
    const links = await c.snapshot.getSnapshotLinks({ targets: [{ deviceId: 5 }, { deviceId: 7 }] })
    expect((links as { deviceId: number }[]).map((r) => r.deviceId).sort()).toEqual([5, 7])
    const overview = await c.snapshot.getSnapshotOverview({ deviceIds: [5, 7] })
    expect((overview as { deviceId: number }[]).map((r) => r.deviceId).sort()).toEqual([5, 7])
  })

  it('a device:[all] viewer reaches the merged events feed', async () => {
    const out = await caller(deviceAll).pipelineAnalytics.listRecentTracks({
      deviceIds: [5, 7, 20],
    })
    expect(
      (out as { tracks: { deviceId: number }[] }).tracks
        .map((t) => t.deviceId)
        .sort((a, b) => a - b),
    ).toEqual([5, 7, 20])
  })

  it('a restricted viewer reaches the batch methods when every reference is covered', async () => {
    const restricted = makeUser([
      { type: 'device', selector: { kind: 'ids', ids: [5] }, access: ['view'] },
    ])
    const c = caller(restricted)

    const links = await c.snapshot.getSnapshotLinks({ targets: [{ deviceId: 5 }] })
    expect((links as { deviceId: number }[]).map((r) => r.deviceId)).toEqual([5])

    const kinds = await c.pipelineAnalytics.listEventKindsBatch({ deviceIds: [5] })
    expect((kinds as { deviceId: number }[]).map((r) => r.deviceId)).toEqual([5])
  })

  it('a single UNCOVERED reference fails the whole call closed — no partial answers', async () => {
    const restricted = makeUser([
      { type: 'device', selector: { kind: 'ids', ids: [5] }, access: ['view'] },
    ])
    const c = caller(restricted)
    await expect(
      c.snapshot.getSnapshotLinks({ targets: [{ deviceId: 5 }, { deviceId: 7 }] }),
    ).rejects.toThrow(/No scope grants/)
    await expect(c.snapshot.getSnapshotOverview({ deviceIds: [5, 7] })).rejects.toThrow(
      /No scope grants/,
    )
    await expect(c.pipelineAnalytics.listRecentTracks({ deviceIds: [5, 7] })).rejects.toThrow(
      /No scope grants/,
    )
  })

  it('inheritance still applies: the parent grant covers the child reference', async () => {
    const parentOnly = makeUser([
      { type: 'device', selector: { kind: 'ids', ids: [5] }, access: ['view'] },
    ])
    const overview = await caller(parentOnly).snapshot.getSnapshotOverview({ deviceIds: [51] })
    expect((overview as { deviceId: number }[]).map((r) => r.deviceId)).toEqual([51])
  })

  it('a principal with NO device grant is still refused', async () => {
    const systemOnly = makeUser([{ type: 'category', target: 'system', access: ['view'] }])
    await expect(
      caller(systemOnly).snapshot.getSnapshotOverview({ deviceIds: [5] }),
    ).rejects.toThrow(/No scope grants/)
  })
})
