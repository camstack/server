/**
 * Behaviour tests for the `device` scope type (model v3) — the operator's main
 * lever for "this user can manage cameras 5 and 7 only".
 *
 * Coverage matrix:
 *  - Selector match: `ids` / `types` / `locations` / `all` each resolve
 *    against the live device metadata (id, type, location).
 *  - Accessory inheritance (parent → children ONLY): a VIEW grant on a Reolink
 *    parent (deviceId=5) transparently covers its child accessories
 *    (siren=51, floodlight=52, PIR=53); a CREATE/DELETE grant does NOT inherit
 *    by default — that requires an explicit `includeLinked: true`.
 *  - Negative path: devices NOT in the grant — including unrelated siblings
 *    AND accessories of un-granted parents — are denied.
 *  - Access tier: a `view`-only grant doesn't permit `create`-flavoured
 *    methods on the same device.
 *  - Decoupling: device scopes don't bleed into system-scope caps.
 *  - JWT staleness: a child adopted AFTER the grant is still covered on VIEW
 *    (the matcher walks the live persisted mirror, not a frozen JWT snapshot).
 *
 * This spec exercises `checkScopeAccess` with an INJECTED lookup, so it proves
 * the matcher's selector + inheritance logic — NOT that the real lookup
 * resolves a forked device (that wiring is `ancestor-lookup-context.spec.ts`).
 *
 * Fixture (Reolink topology from CLAUDE.md + a standalone Garden light):
 *   - device 5 (Reolink camera, "Front door")
 *     ├── device 51 (siren accessory)
 *     ├── device 52 (floodlight/light accessory)
 *     └── device 53 (PIR/sensor accessory)
 *   - device 7 (Hikvision camera, "Garden")
 *     └── device 71 (siren accessory)
 *   - device 9 (RTSP camera, NO accessories, NOT granted, no location)
 *   - device 20 (standalone Light in "Garden", NOT granted)
 */

import type { DeviceSelector, MethodAccess, TokenScope } from '@camstack/types'
import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { checkScopeAccess, type DeviceScopeLookup } from '../scope-access.js'

// ── Fixtures ────────────────────────────────────────────────────────

interface DeviceNode {
  readonly id: number
  readonly parentDeviceId: number | null
  readonly type: DeviceType
  readonly location: string | null
}

const TREE: readonly DeviceNode[] = [
  {
    id: 5,
    parentDeviceId: null,
    type: DeviceType.Camera,
    location: 'Front door',
  },
  { id: 51, parentDeviceId: 5, type: DeviceType.Siren, location: null },
  { id: 52, parentDeviceId: 5, type: DeviceType.Light, location: null },
  { id: 53, parentDeviceId: 5, type: DeviceType.Sensor, location: null },
  { id: 7, parentDeviceId: null, type: DeviceType.Camera, location: 'Garden' },
  { id: 71, parentDeviceId: 7, type: DeviceType.Siren, location: null },
  { id: 9, parentDeviceId: null, type: DeviceType.Camera, location: null },
  { id: 20, parentDeviceId: null, type: DeviceType.Light, location: 'Garden' },
]

/** Lookup mirroring `AddonRegistryService`'s persisted mirror (F0.6). */
const lookup: DeviceScopeLookup = {
  getAncestors: (deviceId) => {
    const out: number[] = []
    let current = TREE.find((d) => d.id === deviceId)
    for (let hop = 0; hop < 8 && current?.parentDeviceId != null; hop++) {
      out.push(current.parentDeviceId)
      current = TREE.find((d) => d.id === current?.parentDeviceId)
    }
    return out
  },
  getType: (deviceId) => TREE.find((d) => d.id === deviceId)?.type ?? null,
  getLocation: (deviceId) => TREE.find((d) => d.id === deviceId)?.location ?? null,
}

function deviceScope(
  selector: DeviceSelector,
  access: readonly MethodAccess[],
  includeLinked?: boolean,
): TokenScope {
  return {
    type: 'device',
    selector,
    access: [...access],
    ...(includeLinked !== undefined ? { includeLinked } : {}),
  }
}

const ids = (...list: number[]): DeviceSelector => ({ kind: 'ids', ids: list })

const VIEW_METHODS = [
  'webrtcSession.listStreams',
  'cameraStreams.getCameraStreams',
  'audioMetrics.getCurrentSnapshot',
] as const

const CREATE_METHODS = ['webrtcSession.createSession', 'switch.setState', 'reboot.reboot'] as const

// ── Direct match — granted device ───────────────────────────────────

describe('checkScopeAccess — device scope, direct grant', () => {
  it('admits every view-flavoured device cap on the granted deviceId', () => {
    const scopes = [deviceScope(ids(5), ['view'])]
    for (const path of VIEW_METHODS) {
      const result = checkScopeAccess(scopes, path, { deviceId: 5 }, lookup)
      expect(result.ok, `${path} should be allowed for view-granted device`).toBe(true)
    }
  })

  it('admits create-flavoured methods when the grant includes `create`', () => {
    const scopes = [deviceScope(ids(5), ['view', 'create'])]
    for (const path of CREATE_METHODS) {
      const result = checkScopeAccess(scopes, path, { deviceId: 5 }, lookup)
      expect(result.ok, `${path} should be allowed for create-granted device`).toBe(true)
    }
  })

  it('admits multiple deviceIds listed in a single ids selector', () => {
    const scopes = [deviceScope(ids(5, 7), ['view'])]
    for (const id of [5, 7]) {
      const result = checkScopeAccess(scopes, 'webrtcSession.listStreams', { deviceId: id }, lookup)
      expect(result.ok, `device ${id} should be allowed`).toBe(true)
    }
  })
})

// ── v3 selectors — types / locations / all ──────────────────────────

describe('checkScopeAccess — device scope, v3 selectors', () => {
  it('types:[camera] covers every camera (dynamic), not accessories directly', () => {
    const scopes = [deviceScope({ kind: 'types', types: [DeviceType.Camera] }, ['view'])]
    for (const cam of [5, 7, 9]) {
      expect(
        checkScopeAccess(scopes, 'cameraStreams.getCameraStreams', { deviceId: cam }, lookup).ok,
      ).toBe(true)
    }
    // Standalone light 20 is not a camera → denied.
    expect(
      checkScopeAccess(scopes, 'cameraStreams.getCameraStreams', { deviceId: 20 }, lookup).ok,
    ).toBe(false)
  })

  it('types:[camera] on VIEW covers accessories via parent inheritance', () => {
    const scopes = [deviceScope({ kind: 'types', types: [DeviceType.Camera] }, ['view'])]
    // 51 is a siren but its parent 5 is a camera → covered on view.
    expect(
      checkScopeAccess(scopes, 'cameraStreams.getCameraStreams', { deviceId: 51 }, lookup).ok,
    ).toBe(true)
  })

  it('locations:[Garden] covers devices in that location', () => {
    const scopes = [deviceScope({ kind: 'locations', locations: ['Garden'] }, ['view'], false)]
    expect(
      checkScopeAccess(scopes, 'cameraStreams.getCameraStreams', { deviceId: 7 }, lookup).ok,
    ).toBe(true)
    expect(
      checkScopeAccess(scopes, 'cameraStreams.getCameraStreams', { deviceId: 20 }, lookup).ok,
    ).toBe(true)
    // Front-door camera 5 is a different location → denied.
    expect(
      checkScopeAccess(scopes, 'cameraStreams.getCameraStreams', { deviceId: 5 }, lookup).ok,
    ).toBe(false)
  })

  it('all selector covers every device', () => {
    const scopes = [deviceScope({ kind: 'all' }, ['view'])]
    for (const id of [5, 7, 9, 20, 51, 71]) {
      expect(
        checkScopeAccess(scopes, 'cameraStreams.getCameraStreams', { deviceId: id }, lookup).ok,
      ).toBe(true)
    }
  })
})

// ── Accessory inheritance — view inherits, create/delete do not ──────

describe('checkScopeAccess — device scope, accessory inheritance', () => {
  it('VIEW grant on parent 5 covers reading children 51/52/53', () => {
    const scopes = [deviceScope(ids(5), ['view'])]
    for (const child of [51, 52, 53]) {
      const result = checkScopeAccess(
        scopes,
        'cameraStreams.getCameraStreams',
        { deviceId: child },
        lookup,
      )
      expect(result.ok, `child ${child} should inherit VIEW from parent 5`).toBe(true)
    }
  })

  it('CREATE grant on parent 5 does NOT inherit to a child by default', () => {
    const scopes = [deviceScope(ids(5), ['view', 'create'])]
    const result = checkScopeAccess(scopes, 'switch.setState', { deviceId: 51 }, lookup)
    expect(result.ok, 'create on child must NOT inherit without includeLinked').toBe(false)
  })

  it('includeLinked:true opts a CREATE grant into child inheritance', () => {
    const scopes = [deviceScope(ids(5), ['view', 'create'], true)]
    const result = checkScopeAccess(scopes, 'switch.setState', { deviceId: 51 }, lookup)
    expect(result.ok).toBe(true)
  })

  it('includeLinked:false suppresses inheritance even on VIEW', () => {
    const scopes = [deviceScope(ids(5), ['view'], false)]
    const parent = checkScopeAccess(
      scopes,
      'cameraStreams.getCameraStreams',
      { deviceId: 5 },
      lookup,
    )
    const child = checkScopeAccess(
      scopes,
      'cameraStreams.getCameraStreams',
      { deviceId: 51 },
      lookup,
    )
    expect(parent.ok).toBe(true)
    expect(child.ok).toBe(false)
  })

  it('grant on parent 5 does NOT cover Hikvision parent 7 nor its siren 71', () => {
    const scopes = [deviceScope(ids(5), ['view', 'create'])]
    for (const orphanId of [7, 71]) {
      const result = checkScopeAccess(
        scopes,
        'webrtcSession.listStreams',
        { deviceId: orphanId },
        lookup,
      )
      expect(result.ok, `device ${orphanId} should NOT be allowed`).toBe(false)
    }
  })
})

// ── Negative paths ──────────────────────────────────────────────────

describe('checkScopeAccess — device scope, denial cases', () => {
  it('denies access to a sibling device not in the grant', () => {
    const scopes = [deviceScope(ids(5), ['view'])]
    const result = checkScopeAccess(scopes, 'webrtcSession.listStreams', { deviceId: 9 }, lookup)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('device=9')
  })

  it('denies create-flavoured methods when the grant is view-only', () => {
    const scopes = [deviceScope(ids(5), ['view'])]
    const result = checkScopeAccess(scopes, 'webrtcSession.createSession', { deviceId: 5 }, lookup)
    expect(result.ok).toBe(false)
  })

  it('denies a create on an accessory whose parent is NOT in the grant', () => {
    const scopes = [deviceScope(ids(7), ['view', 'create'], true)]
    const result = checkScopeAccess(scopes, 'switch.setState', { deviceId: 51 }, lookup)
    expect(result.ok).toBe(false)
  })

  it('denies when the user has no scopes at all', () => {
    const result = checkScopeAccess([], 'webrtcSession.listStreams', { deviceId: 5 }, lookup)
    expect(result.ok).toBe(false)
  })

  it("does not leak across system-scope caps — device grant doesn't cover `addons.list`", () => {
    const scopes = [deviceScope({ kind: 'all' }, ['view', 'create', 'delete'])]
    const result = checkScopeAccess(scopes, 'addons.list')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('system-scope cap')
  })
})

// ── Composition with other scope types ──────────────────────────────

describe('checkScopeAccess — device scope mixed with other types', () => {
  it('a `category:device [view]` grant is open across all devices', () => {
    const scopes: TokenScope[] = [{ type: 'category', target: 'device', access: ['view'] }]
    for (const id of [5, 7, 9, 51, 71]) {
      const result = checkScopeAccess(
        scopes,
        'cameraStreams.getCameraStreams',
        { deviceId: id },
        lookup,
      )
      expect(result.ok, `category grant should cover device ${id}`).toBe(true)
    }
  })

  it('disjunction — device grant + capability grant compose by union', () => {
    const scopes: TokenScope[] = [
      deviceScope(ids(5), ['view', 'create']),
      { type: 'capability', target: 'camera-streams', access: ['view'] },
    ]
    const streamRead = checkScopeAccess(
      scopes,
      'cameraStreams.getCameraStreams',
      { deviceId: 9 },
      lookup,
    )
    expect(streamRead.ok).toBe(true)
    const ptzMove = checkScopeAccess(scopes, 'webrtcSession.createSession', { deviceId: 9 }, lookup)
    expect(ptzMove.ok).toBe(false)
  })
})

// ── Edge cases ──────────────────────────────────────────────────────

describe('checkScopeAccess — device scope, edge cases', () => {
  it('denies when the input has no deviceId (device-scope cap requires one)', () => {
    const scopes = [deviceScope(ids(5), ['view'])]
    const result = checkScopeAccess(scopes, 'webrtcSession.listStreams', {}, lookup)
    expect(result.ok).toBe(false)
  })

  it('works without a lookup — direct ids match only, no inheritance', () => {
    const scopes = [deviceScope(ids(5), ['view'])]
    const directHit = checkScopeAccess(scopes, 'webrtcSession.listStreams', {
      deviceId: 5,
    })
    expect(directHit.ok).toBe(true)
    const childMiss = checkScopeAccess(scopes, 'webrtcSession.listStreams', {
      deviceId: 51,
    })
    expect(childMiss.ok).toBe(false)
  })
})

// ── Auto-injected `getStatus` methods ───────────────────────────────

/**
 * `getStatus` is not declared in a `*.cap.ts` — `expandCapMethods` folds it in
 * for every cap with a status schema. `METHOD_DEVICE_SELECTORS` used to be built
 * from the DECLARED surface, so these paths had no selector, `referencedDeviceIds`
 * returned [] and no device grant could ever match (FORBIDDEN for a non-admin
 * holding `device:all[view]`).
 */
const AUTO_STATUS_METHODS = [
  'battery.getStatus',
  'motion.getStatus',
  'networkLink.getStatus',
] as const

describe('checkScopeAccess — device scope, auto-injected getStatus', () => {
  it('admits a `device:all[view]` grant on every auto-injected getStatus', () => {
    const scopes = [deviceScope({ kind: 'all' }, ['view'])]
    for (const path of AUTO_STATUS_METHODS) {
      const result = checkScopeAccess(scopes, path, { deviceId: 5 }, lookup)
      expect(result.ok, `${path} should be allowed for device:all[view]`).toBe(true)
    }
  })

  it('admits an ids grant on the granted device and denies an uncovered one', () => {
    const scopes = [deviceScope(ids(5), ['view'])]
    for (const path of AUTO_STATUS_METHODS) {
      expect(checkScopeAccess(scopes, path, { deviceId: 5 }, lookup).ok, `${path} on 5`).toBe(true)
      expect(checkScopeAccess(scopes, path, { deviceId: 9 }, lookup).ok, `${path} on 9`).toBe(false)
    }
  })
})
