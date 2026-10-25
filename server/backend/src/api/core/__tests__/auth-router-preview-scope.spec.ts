/* eslint-disable @typescript-eslint/no-unsafe-assignment -- mock factories cross typed boundaries */
/**
 * `auth.previewScope` — the Access panel's "what will this actually grant"
 * answer, through the REAL auth router.
 *
 * The contract that matters is not "it returns a summary" — it is that the
 * preview and the ENFORCEMENT are the same derivation. `auth.me` summarises
 * the caller's own scopes; `previewScope` summarises a PROPOSED set. Both go
 * through `summarizeEffectiveScope` against the same `ctx.deviceFleet()`, so
 * a preview cannot drift from what the matcher will do — which is the whole
 * reason the panel gets to show a number before saving.
 *
 * Neutralisation: point the handler at a second summariser (or a hard-coded
 * fleet) and the parity test below fails.
 */

import type { DeviceMetaLike, TokenScope } from '@camstack/types'
import { buildRoleScopes, DeviceType } from '@camstack/types'
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
    isAdmin: true,
    permissions: { isAdmin: true, allowedProviders: '*', allowedDevices: {} },
    isApiKey: false,
    interactive: true,
    userDelegated: true,
    scopes: ['*'],
    ...overrides,
  }
}

const router = createAuthRouter(
  new AuthService(makeConfig() as never, undefined, staticJwtSigningKey('unit-test-secret')),
  null,
  null,
)

function caller(user: AuthenticatedAgent = makeUser()) {
  const ctx: TrpcContext = { user, deviceFleet: () => FLEET }
  return router.createCaller(ctx)
}

describe('auth.previewScope', () => {
  it('resolves a proposed grant set against the LIVE fleet', async () => {
    const res = await caller()?.previewScope({
      scopes: buildRoleScopes({
        roleId: 'viewer',
        selector: { kind: 'types', types: [DeviceType.Camera] },
        includeLinked: true,
      }),
      isAdmin: false,
    })
    // cameras 5 + 7, plus siren 51 via the parent link; light 20 excluded.
    expect(res.viewableDeviceCount).toBe(3)
    expect(res.allDevicesViewable).toBe(false)
    expect(res.system).toEqual(['view'])
  })

  it('reports ZERO for the empty grant set a new non-admin is born with', async () => {
    const res = await caller()?.previewScope({ scopes: [], isAdmin: false })
    expect(res.isAdmin).toBe(false)
    expect(res.viewableDeviceCount).toBe(0)
    expect(res.device.create.deviceCount).toBe(0)
    expect(res.device.delete.deviceCount).toBe(0)
    expect(res.system).toEqual([])
  })

  it('previews the admin bypass without needing a grant', async () => {
    const res = await caller()?.previewScope({ scopes: [], isAdmin: true })
    expect(res.isAdmin).toBe(true)
    expect(res.allDevicesViewable).toBe(true)
    expect(res.viewableDeviceCount).toBe(FLEET.length)
  })

  it('honours includeLinked exactly as the matcher does', async () => {
    const off = await caller()?.previewScope({
      scopes: buildRoleScopes({
        roleId: 'operator',
        selector: { kind: 'ids', ids: [5] },
        includeLinked: false,
      }),
      isAdmin: false,
    })
    const on = await caller()?.previewScope({
      scopes: buildRoleScopes({
        roleId: 'operator',
        selector: { kind: 'ids', ids: [5] },
        includeLinked: true,
      }),
      isAdmin: false,
    })
    // The panel's hint claims the toggle is what lets an operator actuate a
    // camera-linked siren. If that stops being true, this fails.
    expect(off.device.create.deviceCount).toBe(1)
    expect(on.device.create.deviceCount).toBe(2)
  })

  it('is byte-identical to what `auth.me` reports for the same scopes', async () => {
    const scopes: TokenScope[] = buildRoleScopes({
      roleId: 'manager',
      selector: { kind: 'locations', locations: ['Garden'] },
      includeLinked: false,
    })
    const preview = await caller()?.previewScope({ scopes, isAdmin: false })
    const me = await caller(makeUser({ isAdmin: false, scopes }))?.me()
    expect(preview).toEqual(me?.scope)
  })
})
