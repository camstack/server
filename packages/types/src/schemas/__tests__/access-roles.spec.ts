/**
 * Pure role ↔ grant composition (the two questions the Access panel asks).
 *
 * The risky half of the operator-facing scope UI is NOT the rendering — it is
 * the round trip: a role + a selector must compose to grants the enforcement
 * matcher reads the way the operator was shown, and re-reading those grants
 * must recover the SAME role (otherwise re-opening the panel silently demotes
 * the user to "custom" and the next save writes something else).
 */
import { describe, expect, it } from 'vitest'
import { DeviceType } from '../../device/device-type.js'
import type { TokenScope } from '../auth-records.js'
import {
  ACCESS_ROLES,
  buildRoleScopes,
  detectAccessRole,
  roleSpec,
  type AccessRoleAssignment,
} from '../access-roles.js'
import { resolveViewableDeviceIds, type DeviceMetaLike } from '../device-selector.js'

const FLEET: readonly DeviceMetaLike[] = [
  { id: 5, type: DeviceType.Camera, location: 'Front door', parentDeviceId: null },
  { id: 51, type: DeviceType.Siren, location: null, parentDeviceId: 5 },
  { id: 52, type: DeviceType.Light, location: null, parentDeviceId: 5 },
  { id: 7, type: DeviceType.Camera, location: 'Garden', parentDeviceId: null },
  { id: 20, type: DeviceType.Light, location: 'Garden', parentDeviceId: null },
]

describe('ACCESS_ROLES catalogue', () => {
  it('exposes exactly the three operator-facing roles, widening monotonically', () => {
    expect(ACCESS_ROLES.map((r) => r.id)).toEqual(['viewer', 'operator', 'manager'])
    expect(roleSpec('viewer').deviceAccess).toEqual(['view'])
    expect(roleSpec('operator').deviceAccess).toEqual(['view', 'create'])
    expect(roleSpec('manager').deviceAccess).toEqual(['view', 'create', 'delete'])
  })

  it('every role carries a label and a description for the radio group', () => {
    for (const role of ACCESS_ROLES) {
      expect(role.label.length).toBeGreaterThan(0)
      expect(role.description.length).toBeGreaterThan(0)
    }
  })
})

describe('buildRoleScopes', () => {
  it('emits ONE device grant carrying the selector plus one category:system row', () => {
    const scopes = buildRoleScopes({
      roleId: 'operator',
      selector: { kind: 'types', types: [DeviceType.Camera] },
      includeLinked: true,
    })
    expect(scopes).toEqual([
      {
        type: 'device',
        selector: { kind: 'types', types: [DeviceType.Camera] },
        access: ['view', 'create'],
        includeLinked: true,
      },
      { type: 'category', target: 'system', access: ['view', 'create'] },
    ])
  })

  it('never emits a category:device row — that would ignore the selector', () => {
    for (const role of ACCESS_ROLES) {
      const scopes = buildRoleScopes({
        roleId: role.id,
        selector: { kind: 'ids', ids: [5] },
        includeLinked: false,
      })
      expect(scopes.some((s) => s.type === 'category' && s.target === 'device')).toBe(false)
    }
  })

  it('writes includeLinked EXPLICITLY, both ways', () => {
    const on = buildRoleScopes({
      roleId: 'viewer',
      selector: { kind: 'all' },
      includeLinked: true,
    })
    const off = buildRoleScopes({
      roleId: 'viewer',
      selector: { kind: 'all' },
      includeLinked: false,
    })
    expect(on[0]).toMatchObject({ includeLinked: true })
    // `false` must survive: absent would let the matcher DERIVE inheritance
    // for `view` and silently re-grant the accessories the operator excluded.
    expect(off[0]).toMatchObject({ includeLinked: false })
  })
})

describe('detectAccessRole — the round trip', () => {
  const assignments: readonly AccessRoleAssignment[] = [
    { roleId: 'viewer', selector: { kind: 'all' }, includeLinked: true },
    { roleId: 'viewer', selector: { kind: 'ids', ids: [5, 7] }, includeLinked: false },
    {
      roleId: 'operator',
      selector: { kind: 'types', types: [DeviceType.Camera, DeviceType.Light] },
      includeLinked: true,
    },
    {
      roleId: 'manager',
      selector: { kind: 'locations', locations: ['Garden'] },
      includeLinked: false,
    },
  ]

  it('recovers every assignment it built', () => {
    for (const assignment of assignments) {
      expect(detectAccessRole(buildRoleScopes(assignment))).toEqual(assignment)
    }
  })

  it('is order-insensitive on both the rows and the access arrays', () => {
    const scopes: TokenScope[] = [
      { type: 'category', target: 'system', access: ['create', 'view'] },
      {
        type: 'device',
        selector: { kind: 'all' },
        access: ['create', 'view'],
        includeLinked: true,
      },
    ]
    expect(detectAccessRole(scopes)).toEqual({
      roleId: 'operator',
      selector: { kind: 'all' },
      includeLinked: true,
    })
  })

  it('returns null for a grant set the panel did not author', () => {
    // No access at all — a fresh non-admin user.
    expect(detectAccessRole([])).toBeNull()
    // A hand-rolled capability grant.
    expect(
      detectAccessRole([{ type: 'capability', target: 'addons', access: ['view'] }]),
    ).toBeNull()
    // Device + system rows that disagree on access — not a role.
    expect(
      detectAccessRole([
        { type: 'device', selector: { kind: 'all' }, access: ['view'], includeLinked: true },
        { type: 'category', target: 'system', access: ['view', 'delete'] },
      ]),
    ).toBeNull()
    // The device row alone, with no system row.
    expect(
      detectAccessRole([
        { type: 'device', selector: { kind: 'all' }, access: ['view'], includeLinked: true },
      ]),
    ).toBeNull()
    // An extra row beyond the two the panel writes.
    expect(
      detectAccessRole([
        ...buildRoleScopes({ roleId: 'viewer', selector: { kind: 'all' }, includeLinked: true }),
        { type: 'addon', target: 'admin-ui', access: ['view'] },
      ]),
    ).toBeNull()
  })

  it('a device row with an IMPLICIT includeLinked is not a panel role', () => {
    // Absent `includeLinked` means the matcher derives it. The panel always
    // writes it, so an absent one came from somewhere else and must land in
    // Advanced rather than be shown under a toggle that misreports it.
    expect(
      detectAccessRole([
        { type: 'device', selector: { kind: 'all' }, access: ['view'] },
        { type: 'category', target: 'system', access: ['view'] },
      ]),
    ).toBeNull()
  })
})

describe('composed grants against the real resolver', () => {
  it('a viewer scoped to one camera reaches its accessories only with includeLinked', () => {
    const linked = buildRoleScopes({
      roleId: 'viewer',
      selector: { kind: 'ids', ids: [5] },
      includeLinked: true,
    })
    expect([...resolveViewableDeviceIds(linked, FLEET, 'view')].toSorted((a, b) => a - b)).toEqual([
      5, 51, 52,
    ])

    const unlinked = buildRoleScopes({
      roleId: 'viewer',
      selector: { kind: 'ids', ids: [5] },
      includeLinked: false,
    })
    expect([...resolveViewableDeviceIds(unlinked, FLEET, 'view')]).toEqual([5])
  })

  it('an operator WITHOUT includeLinked cannot actuate the camera-linked siren', () => {
    // This is the restriction the panel's hint has to explain: `create` does
    // not inherit by default, so the toggle is the only thing that lets an
    // operator fire a siren bound to a camera they were granted.
    const off = buildRoleScopes({
      roleId: 'operator',
      selector: { kind: 'types', types: [DeviceType.Camera] },
      includeLinked: false,
    })
    expect([...resolveViewableDeviceIds(off, FLEET, 'create')].toSorted((a, b) => a - b)).toEqual([
      5, 7,
    ])

    const on = buildRoleScopes({
      roleId: 'operator',
      selector: { kind: 'types', types: [DeviceType.Camera] },
      includeLinked: true,
    })
    expect([...resolveViewableDeviceIds(on, FLEET, 'create')].toSorted((a, b) => a - b)).toEqual([
      5, 7, 51, 52,
    ])
  })

  it('a location role covers only devices carrying that label', () => {
    const scopes = buildRoleScopes({
      roleId: 'viewer',
      selector: { kind: 'locations', locations: ['Garden'] },
      includeLinked: false,
    })
    expect([...resolveViewableDeviceIds(scopes, FLEET, 'view')].toSorted((a, b) => a - b)).toEqual([
      7, 20,
    ])
  })
})
