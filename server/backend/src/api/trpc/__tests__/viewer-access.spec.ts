/**
 * The viewer role through the ONE matcher (D921): role × method label ×
 * device admitted / blocked × child of a blocked or allowed camera × unknown
 * parentage × feature on/off — and a legacy grant set beside it, unchanged.
 *
 * `checkScopeAccess` is what `protectedProcedure`, the event firehose filter,
 * share-link minting and the enumeration projection all ask, so the matrix is
 * asserted there; one router-level case proves the refusal reaches the caller
 * as FORBIDDEN with the matcher's reason.
 */
import type { UserScope, ViewerTokenScope } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { checkScopeAccess, type DeviceScopeLookup } from '../scope-access.js'
import { isBroadEventViewer, projectListAllForPrincipal } from '../principal-visibility.js'
import { intersectScopes, scopesWithin } from '../../../auth/scope-escalation.js'

const CAMERA = 3628
const SIREN = 3630 // child of CAMERA
const OTHER_CAMERA = 5000
const OTHER_SIREN = 5001 // child of OTHER_CAMERA
const UNKNOWN = 9999 // not in the persisted mirror

const PARENT: ReadonlyMap<number, number> = new Map([
  [SIREN, CAMERA],
  [OTHER_SIREN, OTHER_CAMERA],
])
const KNOWN: ReadonlySet<number> = new Set([CAMERA, SIREN, OTHER_CAMERA, OTHER_SIREN])

const lookup: DeviceScopeLookup = {
  getAncestors: (id) => {
    const p = PARENT.get(id)
    return p === undefined ? [] : [p]
  },
  getType: (id) => (KNOWN.has(id) ? (PARENT.has(id) ? 'siren' : 'camera') : null),
  getLocation: () => null,
}

function viewer(over: Partial<ViewerTokenScope> = {}): readonly UserScope[] {
  return [{ type: 'viewer', allow: '*', block: [], features: [], ...over }]
}

function ok(scopes: readonly UserScope[], path: string, input?: unknown): boolean {
  return checkScopeAccess(scopes, path, input, lookup).ok
}

describe('viewer: method role', () => {
  it('reaches a viewer-labelled device method (actuation, status) and system method', () => {
    const s = viewer()
    expect(ok(s, 'switch.setState', { deviceId: SIREN, on: true })).toBe(true)
    expect(ok(s, 'motionTrigger.setMotionTrigger', { deviceId: SIREN, enabled: true })).toBe(true)
    expect(ok(s, 'snapshot.getSnapshot', { deviceId: CAMERA })).toBe(true)
    expect(ok(s, 'deviceManager.listAll', {})).toBe(true)
  })

  it('is refused an admin-labelled method, with the reason', () => {
    const r = checkScopeAccess(viewer(), 'alerts.list', {}, lookup)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('for administrators')
    expect(ok(viewer(), 'deviceState.getAllSnapshots', {})).toBe(false)
  })

  it('reaches a feature method only with the feature', () => {
    const path = 'faceGallery.listRecentFaces'
    const r = checkScopeAccess(viewer(), path, {}, lookup)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("'face-assignment' feature")
    expect(ok(viewer({ features: ['face-assignment'] }), path, {})).toBe(true)
    expect(ok(viewer({ features: ['plate-assignment'] }), path, {})).toBe(false)
  })
})

describe('viewer: names in events are shown to everyone who sees the event', () => {
  it('the face and plate of a track resolve without any feature', () => {
    const s = viewer()
    expect(ok(s, 'faceGallery.getFaceByTrack', { deviceId: CAMERA, trackId: 't' })).toBe(true)
    expect(ok(s, 'faceGallery.listIdentities', {})).toBe(true)
    expect(ok(s, 'plateGallery.getPlateByTrack', { deviceId: CAMERA, trackId: 't' })).toBe(true)
  })

  it('but only on an admitted camera', () => {
    const s = viewer({ block: [CAMERA] })
    expect(ok(s, 'faceGallery.getFaceByTrack', { deviceId: CAMERA, trackId: 't' })).toBe(false)
  })
})

describe('viewer: devices (allow minus block, children follow the parent)', () => {
  const set = (deviceId: number) => ({ deviceId, on: true })

  it('a blocked camera blocks itself and its children, never another camera', () => {
    const s = viewer({ block: [CAMERA] })
    expect(ok(s, 'snapshot.getSnapshot', { deviceId: CAMERA })).toBe(false)
    expect(ok(s, 'switch.setState', set(SIREN))).toBe(false)
    expect(ok(s, 'switch.setState', set(OTHER_SIREN))).toBe(true)
  })

  it('an allowed camera admits its children; everything else is out', () => {
    const s = viewer({ allow: [CAMERA] })
    expect(ok(s, 'switch.setState', set(SIREN))).toBe(true)
    expect(ok(s, 'switch.setState', set(OTHER_SIREN))).toBe(false)
    expect(ok(s, 'snapshot.getSnapshot', { deviceId: OTHER_CAMERA })).toBe(false)
  })

  it('block wins over allow', () => {
    const s = viewer({ allow: [CAMERA], block: [SIREN] })
    expect(ok(s, 'snapshot.getSnapshot', { deviceId: CAMERA })).toBe(true)
    expect(ok(s, 'switch.setState', set(SIREN))).toBe(false)
  })

  it('a system method naming a device is cut the same way', () => {
    const s = viewer({ block: [CAMERA] })
    expect(ok(s, 'recordingArchive.getDeviceConfig', { deviceId: CAMERA })).toBe(false)
    expect(ok(s, 'recordingArchive.getDeviceConfig', { deviceId: OTHER_CAMERA })).toBe(true)
  })

  it('unknown parentage fails closed', () => {
    expect(ok(viewer(), 'switch.setState', set(UNKNOWN))).toBe(true)
    expect(ok(viewer({ block: [CAMERA] }), 'switch.setState', set(UNKNOWN))).toBe(false)
    expect(ok(viewer({ allow: [CAMERA] }), 'switch.setState', set(UNKNOWN))).toBe(false)
  })

  it('a viewer row is decided ALONE: a leftover broad grant beside it widens nothing', () => {
    const s: readonly UserScope[] = [
      ...viewer({ block: [CAMERA] }),
      { type: 'category', target: 'device', access: ['view', 'create', 'delete'] },
      { type: 'category', target: 'system', access: ['view', 'create', 'delete'] },
    ]
    expect(ok(s, 'switch.setState', set(SIREN))).toBe(false)
    expect(ok(s, 'alerts.list', {})).toBe(false)
  })
})

describe('viewer: enumeration and the event firehose', () => {
  const fleet = [
    { id: CAMERA, type: 'camera', location: null, parentDeviceId: null },
    { id: SIREN, type: 'siren', location: null, parentDeviceId: CAMERA },
    { id: OTHER_CAMERA, type: 'camera', location: null, parentDeviceId: null },
  ]
  const rows = fleet.map((d) => ({ id: d.id, name: `d${d.id}`, type: d.type }))

  it('listAll is cut to the admitted devices', () => {
    const out = projectListAllForPrincipal(rows, false, viewer({ block: [CAMERA] }), fleet)
    expect(Array.isArray(out) ? out.map((r) => Reflect.get(r, 'id')) : out).toEqual([OTHER_CAMERA])
  })

  it('the firehose is unfiltered only with every device admitted', () => {
    expect(isBroadEventViewer(viewer())).toBe(true)
    expect(isBroadEventViewer(viewer({ block: [CAMERA] }))).toBe(false)
    expect(isBroadEventViewer(viewer({ allow: [CAMERA] }))).toBe(false)
  })
})

describe('legacy grants are decided exactly as before', () => {
  it('a category:system[view] user still reaches a protected system method', () => {
    const s: readonly UserScope[] = [{ type: 'category', target: 'system', access: ['view'] }]
    expect(ok(s, 'alerts.list', {})).toBe(true)
  })
})

describe('viewer: minting', () => {
  const held = viewer({ block: [CAMERA], features: ['scenes'] })

  it('a viewer mints its own identical grant, never a wider one', () => {
    expect(scopesWithin(held, held, lookup).ok).toBe(true)
    expect(scopesWithin(viewer({ features: ['scenes'] }), held, lookup).ok).toBe(false)
    expect(
      scopesWithin(viewer({ block: [CAMERA], features: ['scenes', 'retrain'] }), held, lookup).ok,
    ).toBe(false)
  })

  it('a viewer mints a share link only over devices it is admitted to', () => {
    const share = (deviceIds: number[]) => [
      { type: 'share-view' as const, grant: { kind: 'grid-view' as const, deviceIds } },
    ]
    expect(scopesWithin(share([OTHER_CAMERA]), held, lookup).ok).toBe(true)
    expect(scopesWithin(share([CAMERA]), held, lookup).ok).toBe(false)
  })

  it("a token's viewer grant dies when the admin edits the subject's grant", () => {
    expect(intersectScopes(held, held, lookup)).toEqual(held)
    expect(intersectScopes(held, viewer({ block: [CAMERA] }), lookup)).toEqual([])
  })
})
