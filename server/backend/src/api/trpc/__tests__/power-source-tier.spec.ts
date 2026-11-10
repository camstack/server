/**
 * `powerSource.*` is the intermediate tier (`protected`): whoever may reach a
 * camera may power-cycle it, and nobody else. The tier alone is not the
 * guarantee — the per-device matcher on the top-level `deviceId` is. This pins
 * both for a viewer (allow list) and for a device-scoped grant.
 */

import type { TokenScope, UserScope } from '@camstack/types'
import { DeviceType } from '@camstack/types'
import { METHOD_ACCESS_MAP } from '@camstack/server/system'
import { describe, expect, it } from 'vitest'
import { checkScopeAccess, type DeviceScopeLookup } from '../scope-access.js'

const lookup: DeviceScopeLookup = {
  getAncestors: () => [],
  getType: () => DeviceType.Camera,
  getLocation: () => null,
}

const METHODS = [
  'powerSource.getStatus',
  'powerSource.powerOn',
  'powerSource.powerOff',
  'powerSource.forceRestart',
] as const

describe('powerSource tier', () => {
  it('is a viewer-role device method, not an admin one', () => {
    for (const path of METHODS) expect(METHOD_ACCESS_MAP[path]?.role).toBe('viewer')
  })

  it('a viewer with access to the camera can force a restart; one without is refused', () => {
    const scopes: UserScope[] = [{ type: 'viewer', allow: [5], block: [], features: [] }]
    expect(checkScopeAccess(scopes, 'powerSource.forceRestart', { deviceId: 5 }, lookup).ok).toBe(
      true,
    )
    const refused = checkScopeAccess(scopes, 'powerSource.forceRestart', { deviceId: 7 }, lookup)
    expect(refused.ok).toBe(false)
  })

  it('a device grant with create reaches it on its device only', () => {
    const scopes: TokenScope[] = [
      { type: 'device', selector: { kind: 'ids', ids: [5] }, access: ['view', 'create'] },
    ]
    expect(checkScopeAccess(scopes, 'powerSource.powerOff', { deviceId: 5 }, lookup).ok).toBe(true)
    expect(checkScopeAccess(scopes, 'powerSource.powerOff', { deviceId: 7 }, lookup).ok).toBe(false)
  })
})
