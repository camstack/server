/**
 * The viewer role's pure rules (D921): how a method's label is resolved, and
 * which devices the allow/block lists admit — children follow their parent,
 * unknown parentage fails closed.
 */
import { describe, expect, it } from 'vitest'
import {
  featureOfRole,
  resolveMethodRole,
  type ViewerAncestorLookup,
  viewerAdmitsDevice,
  viewerHoldsRole,
  type ViewerTokenScope,
} from '../viewer-access.js'

const CAMERA = 10
const SIREN = 11 // child of CAMERA
const LIGHT_ON_SIREN = 12 // grandchild
const OTHER = 20
const UNKNOWN = 99

const PARENTS: ReadonlyMap<number, readonly number[]> = new Map([
  [CAMERA, []],
  [SIREN, [CAMERA]],
  [LIGHT_ON_SIREN, [SIREN, CAMERA]],
  [OTHER, []],
])
const lookup: ViewerAncestorLookup = (id) => PARENTS.get(id) ?? null

function viewer(over: Partial<ViewerTokenScope>): ViewerTokenScope {
  return { type: 'viewer', allow: '*', block: [], features: [], ...over }
}

describe('resolveMethodRole', () => {
  const base = { capRole: undefined, methodRole: undefined } as const

  it('derives: admin stays admin, public stays public', () => {
    expect(resolveMethodRole({ ...base, capScope: 'device', auth: 'admin' })).toBe('admin')
    expect(resolveMethodRole({ ...base, capScope: 'system', auth: 'public' })).toBe('public')
  })

  it('derives: protected DEVICE method is viewer, protected SYSTEM method is admin', () => {
    expect(resolveMethodRole({ ...base, capScope: 'device', auth: 'protected' })).toBe('viewer')
    expect(resolveMethodRole({ ...base, capScope: 'system', auth: 'protected' })).toBe('admin')
  })

  it('an explicit method label wins over the cap label, which wins over derivation', () => {
    expect(
      resolveMethodRole({
        capScope: 'system',
        auth: 'admin',
        capRole: { feature: 'face-assignment' },
        methodRole: undefined,
      }),
    ).toBe('feature:face-assignment')
    expect(
      resolveMethodRole({
        capScope: 'system',
        auth: 'protected',
        capRole: { feature: 'face-assignment' },
        methodRole: 'admin',
      }),
    ).toBe('admin')
  })

  it('featureOfRole reads only catalog ids', () => {
    expect(featureOfRole('feature:retrain')).toBe('retrain')
    expect(featureOfRole('viewer')).toBeNull()
  })
})

describe('viewerHoldsRole', () => {
  it('viewer and public always; admin never; a feature only when granted', () => {
    const none = viewer({})
    const faces = viewer({ features: ['face-assignment'] })
    expect(viewerHoldsRole(none, 'viewer')).toBe(true)
    expect(viewerHoldsRole(none, 'public')).toBe(true)
    expect(viewerHoldsRole(faces, 'admin')).toBe(false)
    expect(viewerHoldsRole(none, 'feature:face-assignment')).toBe(false)
    expect(viewerHoldsRole(faces, 'feature:face-assignment')).toBe(true)
    expect(viewerHoldsRole(faces, 'feature:plate-assignment')).toBe(false)
  })
})

describe('viewerAdmitsDevice', () => {
  it("allow '*' admits every known device", () => {
    for (const id of [CAMERA, SIREN, LIGHT_ON_SIREN, OTHER]) {
      expect(viewerAdmitsDevice(viewer({}), id, lookup), `device ${id}`).toBe(true)
    }
  })

  it('a blocked camera blocks its children and grandchildren, not another camera', () => {
    const s = viewer({ block: [CAMERA] })
    expect(viewerAdmitsDevice(s, CAMERA, lookup)).toBe(false)
    expect(viewerAdmitsDevice(s, SIREN, lookup)).toBe(false)
    expect(viewerAdmitsDevice(s, LIGHT_ON_SIREN, lookup)).toBe(false)
    expect(viewerAdmitsDevice(s, OTHER, lookup)).toBe(true)
  })

  it('an allowed camera admits its children; others stay out', () => {
    const s = viewer({ allow: [CAMERA] })
    expect(viewerAdmitsDevice(s, SIREN, lookup)).toBe(true)
    expect(viewerAdmitsDevice(s, LIGHT_ON_SIREN, lookup)).toBe(true)
    expect(viewerAdmitsDevice(s, OTHER, lookup)).toBe(false)
  })

  it('block wins over allow on the same chain', () => {
    const s = viewer({ allow: [CAMERA], block: [SIREN] })
    expect(viewerAdmitsDevice(s, CAMERA, lookup)).toBe(true)
    expect(viewerAdmitsDevice(s, SIREN, lookup)).toBe(false)
    expect(viewerAdmitsDevice(s, LIGHT_ON_SIREN, lookup)).toBe(false)
  })

  it("unknown parentage fails closed: '*' only with an empty block list", () => {
    expect(viewerAdmitsDevice(viewer({}), UNKNOWN, lookup)).toBe(true)
    expect(viewerAdmitsDevice(viewer({ block: [CAMERA] }), UNKNOWN, lookup)).toBe(false)
    expect(viewerAdmitsDevice(viewer({ allow: [CAMERA] }), UNKNOWN, lookup)).toBe(false)
    expect(viewerAdmitsDevice(viewer({ allow: [UNKNOWN] }), UNKNOWN, lookup)).toBe(true)
    expect(viewerAdmitsDevice(viewer({ block: [CAMERA] }), SIREN, undefined)).toBe(false)
  })
})
