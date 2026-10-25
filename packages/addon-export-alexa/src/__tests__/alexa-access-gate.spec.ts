/**
 * S1 — an Alexa link sees only what the user who linked it may see.
 *
 * Before this, consent issued `category:device[view,create]` to every link and
 * nothing downstream looked at WHO linked: a viewer-only user who linked Alexa
 * got every exposed camera, its PTZ, its siren and the alarm panel. These specs
 * pin the gate that intersects the link with the linking user's LIVE grants.
 */
import type { DeviceMetaLike, IScopedLogger, TokenScope } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  AlexaAccessGate,
  type AlexaUserGrant,
  endpointAccessTarget,
  principalAllowsDevice,
} from '../access/access-gate.js'
import { parseCameraEndpointId } from '../handlers/endpoint-id.js'

const logger: IScopedLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  withTags: () => logger,
  child: () => logger,
}

const FLEET: Readonly<Record<number, DeviceMetaLike>> = {
  10: { id: 10, type: 'camera', location: 'Garden', parentDeviceId: null },
  11: { id: 11, type: 'switch', location: 'Garden', parentDeviceId: 10 },
  20: { id: 20, type: 'camera', location: 'Bedroom', parentDeviceId: null },
  30: { id: 30, type: 'alarm-panel', location: null, parentDeviceId: null },
}

const viewGarden: TokenScope = {
  type: 'device',
  selector: { kind: 'locations', locations: ['Garden'] },
  access: ['view'],
}
const controlCam10: TokenScope = {
  type: 'device',
  selector: { kind: 'ids', ids: [10] },
  access: ['view', 'create'],
}

function makeGate(
  grants: readonly AlexaUserGrant[] | (() => Promise<readonly AlexaUserGrant[]>),
  now: () => number = () => 0,
) {
  const listUserGrants = typeof grants === 'function' ? vi.fn(grants) : vi.fn(async () => grants)
  const getDeviceMeta = vi.fn(async (id: number) => FLEET[id] ?? null)
  const gate = new AlexaAccessGate({ listUserGrants, getDeviceMeta, logger, now })
  return { gate, listUserGrants, getDeviceMeta }
}

describe('principalAllowsDevice', () => {
  it('an admin is allowed every device at every access', () => {
    expect(principalAllowsDevice({ kind: 'admin', userId: 'a' }, [FLEET[20]!], 'create')).toBe(true)
  })

  it('a scoped user is allowed only what its selector covers', () => {
    const p = { kind: 'scoped', userId: 'u', scopes: [viewGarden] } as const
    expect(principalAllowsDevice(p, [FLEET[10]!], 'view')).toBe(true)
    expect(principalAllowsDevice(p, [FLEET[20]!], 'view')).toBe(false)
    expect(principalAllowsDevice(p, [FLEET[10]!], 'create')).toBe(false)
  })

  it('a view grant on the parent covers the child accessory, a create grant does not', () => {
    const viewCam10: TokenScope = {
      type: 'device',
      selector: { kind: 'ids', ids: [10] },
      access: ['view'],
    }
    const viewParent = { kind: 'scoped', userId: 'u', scopes: [viewCam10] } as const
    const chain = [FLEET[11]!, FLEET[10]!]
    expect(principalAllowsDevice(viewParent, chain, 'view')).toBe(true)
    const controlParent = { kind: 'scoped', userId: 'u', scopes: [controlCam10] } as const
    expect(principalAllowsDevice(controlParent, chain, 'create')).toBe(false)
  })

  it('a scoped user with no scopes sees nothing', () => {
    expect(
      principalAllowsDevice({ kind: 'scoped', userId: 'u', scopes: [] }, [FLEET[10]!], 'view'),
    ).toBe(false)
  })
})

describe('AlexaAccessGate', () => {
  it('resolves the linking user from the LIVE user list', async () => {
    const { gate } = makeGate([{ userId: 'u', isAdmin: false, scopes: [viewGarden] }])
    const r = await gate.principal('u')
    expect(r).toEqual({
      kind: 'found',
      principal: { kind: 'scoped', userId: 'u', scopes: [viewGarden] },
    })
  })

  it('an unknown (deleted) user is reported as such, never as admin', async () => {
    const { gate } = makeGate([{ userId: 'other', isAdmin: true, scopes: [] }])
    expect(await gate.principal('gone')).toEqual({ kind: 'unknown-user' })
  })

  it('a failed user read with nothing cached is UNAVAILABLE (fail closed)', async () => {
    const { gate } = makeGate(async () => {
      throw new Error('boom')
    })
    const r = await gate.principal('u')
    expect(r.kind).toBe('unavailable')
  })

  it('a failed refresh keeps the last good read (a failed read changes nothing)', async () => {
    let t = 0
    let fail = false
    const { gate } = makeGate(
      async () => {
        if (fail) throw new Error('boom')
        return [{ userId: 'u', isAdmin: true, scopes: [] }]
      },
      () => t,
    )
    expect((await gate.principal('u')).kind).toBe('found')
    fail = true
    t = 10 * 60_000
    expect(await gate.principal('u')).toEqual({
      kind: 'found',
      principal: { kind: 'admin', userId: 'u' },
    })
  })

  it('re-reads the users after the TTL so a revoked grant applies', async () => {
    let t = 0
    let admin = true
    const { gate, listUserGrants } = makeGate(
      async () => [{ userId: 'u', isAdmin: admin, scopes: [] }],
      () => t,
    )
    expect((await gate.principal('u')).kind).toBe('found')
    admin = false
    t = 31_000
    const r = await gate.principal('u')
    expect(r).toEqual({ kind: 'found', principal: { kind: 'scoped', userId: 'u', scopes: [] } })
    expect(listUserGrants).toHaveBeenCalledTimes(2)
  })

  it('allows() walks ancestors so a parent grant reaches the accessory', async () => {
    const { gate } = makeGate([])
    const p = { kind: 'scoped', userId: 'u', scopes: [viewGarden] } as const
    expect(await gate.allows(p, 11, 'view')).toBe('allowed')
    expect(await gate.allows(p, 20, 'view')).toBe('denied')
  })

  it('a device the registry does not know is UNKNOWN for a scoped user, allowed for an admin', async () => {
    const { gate } = makeGate([])
    const p = { kind: 'scoped', userId: 'u', scopes: [viewGarden] } as const
    expect(await gate.allows(p, 999, 'view')).toBe('unknown')
    expect(await gate.allows({ kind: 'admin', userId: 'a' }, 999, 'view')).toBe('allowed')
  })
})

describe('endpointAccessTarget', () => {
  it('maps every endpoint kind to the device it actuates and the exposed device it lives under', () => {
    expect(endpointAccessTarget(parseCameraEndpointId('10'))).toEqual({
      exposedDeviceId: 10,
      deviceId: 10,
      requiresParent: null,
      ownAccess: 'view',
    })
    expect(endpointAccessTarget(parseCameraEndpointId('10__privacy'))).toEqual({
      exposedDeviceId: 10,
      deviceId: 10,
      requiresParent: null,
      ownAccess: 'create',
    })
    expect(endpointAccessTarget(parseCameraEndpointId('10__11'))).toEqual({
      exposedDeviceId: 10,
      deviceId: 11,
      requiresParent: 10,
      ownAccess: 'create',
    })
    expect(endpointAccessTarget(parseCameraEndpointId('30__alarm'))).toEqual({
      exposedDeviceId: 30,
      deviceId: 30,
      requiresParent: null,
      ownAccess: 'view',
    })
    expect(endpointAccessTarget(parseCameraEndpointId('x'))).toBeNull()
  })
})
