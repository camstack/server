/* eslint-disable @typescript-eslint/no-unsafe-assignment -- mock factories cross typed boundaries */
/**
 * `auth.me` effective-scope contract (scope model v3, F1 #5) — through the
 * REAL auth router + a real TrpcContext carrying a fleet-backed
 * `deviceFleet()`. This is the shape the viewer (F3/F4) reads to HIDE
 * out-of-scope surfaces, so it is pinned here end-to-end, not just at the
 * pure `summarizeEffectiveScope` unit.
 *
 * Neutralisation: drop the `scope` enrichment in the `me` handler (return
 * `ctx.user`) and every assertion on `res.scope` fails.
 */

import type { DeviceMetaLike } from '@camstack/types'
import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { AuthService } from '../../../core/auth/auth.service.js'
import type { AuthenticatedAgent, TrpcContext } from '../../trpc/trpc.context.js'
import { createAuthRouter } from '../auth.router.js'
import { staticJwtSigningKey } from '@camstack/system'

function makeConfig(): { get<T>(p: string): T; update(): void } {
  const store: Record<string, unknown> = {}
  return {
    get<T>(path: string): T {
      return store[path] as T
    },
    update(): void {},
  }
}

const FLEET: readonly DeviceMetaLike[] = [
  { id: 5, type: DeviceType.Camera, location: 'Front', parentDeviceId: null },
  { id: 51, type: DeviceType.Siren, location: null, parentDeviceId: 5 },
  { id: 7, type: DeviceType.Camera, location: 'Garden', parentDeviceId: null },
  { id: 20, type: DeviceType.Light, location: 'Garden', parentDeviceId: null },
]

function makeUser(overrides: Partial<AuthenticatedAgent> = {}): AuthenticatedAgent {
  return {
    id: 'u-1',
    username: 'alice',
    isAdmin: false,
    permissions: { isAdmin: false, allowedProviders: '*', allowedDevices: {} },
    isApiKey: false,
    interactive: true,
    userDelegated: true,
    scopes: [],
    ...overrides,
  }
}

const router = createAuthRouter(
  new AuthService(makeConfig() as never, undefined, staticJwtSigningKey('unit-test-secret')),
  null,
  null,
)

function caller(user: AuthenticatedAgent) {
  const ctx: TrpcContext = { user, deviceFleet: () => FLEET }
  return router.createCaller(ctx)
}

describe('auth.me — effective scope (v3)', () => {
  it('an admin reports omnipotence with fleet-sized counts', async () => {
    const res = await caller(makeUser({ isAdmin: true }))?.me()
    expect(res?.scope?.isAdmin).toBe(true)
    expect(res?.scope?.allDevicesViewable).toBe(true)
    expect(res?.scope?.viewableDeviceCount).toBe(FLEET.length)
  })

  it('a zero-scope non-admin is born with no access', async () => {
    const res = await caller(makeUser())?.me()
    expect(res?.scope?.isAdmin).toBe(false)
    expect(res?.scope?.allDevicesViewable).toBe(false)
    expect(res?.scope?.viewableDeviceCount).toBe(0)
    expect(res?.scope?.device.create.deviceCount).toBe(0)
  })

  it('a types:[camera] viewer resolves to counts (cameras + accessories), not id lists', async () => {
    const res = await caller(
      makeUser({
        scopes: [
          {
            type: 'device',
            selector: { kind: 'types', types: [DeviceType.Camera] },
            access: ['view'],
          },
        ],
      }),
    )?.me()
    // cameras 5, 7 + accessory 51 (via inheritance) = 3; light 20 excluded
    expect(res?.scope?.viewableDeviceCount).toBe(3)
    expect(res?.scope?.allDevicesViewable).toBe(false)
    expect(res?.scope?.device.view.deviceCount).toBe(3)
  })

  it('surfaces capability + addon grants and category:system access', async () => {
    const res = await caller(
      makeUser({
        scopes: [
          { type: 'category', target: 'system', access: ['view'] },
          { type: 'capability', target: 'addons', access: ['view', 'create'] },
          { type: 'addon', target: 'homeassistant', access: ['view'] },
        ],
      }),
    )?.me()
    expect(res?.scope?.system).toEqual(['view'])
    expect(res?.scope?.capabilities).toEqual([{ name: 'addons', access: ['view', 'create'] }])
    expect(res?.scope?.addons).toEqual([{ name: 'homeassistant', access: ['view'] }])
  })
})
