/**
 * The two questions the operator-facing Access panel asks, as pure logic.
 *
 *   1. WHAT can this user do?      → an {@link AccessRoleId}
 *   2. On WHICH devices?           → a {@link DeviceSelector} + `includeLinked`
 *
 * and the composition of those two answers into the `TokenScope[]` the v3
 * enforcement matcher actually reads.
 *
 * Why this is not a {@link SCOPE_PRESETS} entry: a preset is a frozen list of
 * rows an operator drops into the raw picker. A ROLE is only half a grant set
 * — its device row carries the selector chosen in question 2 — so it cannot be
 * pre-baked. The two coexist: `SCOPE_PRESETS` fills the Advanced picker,
 * `ACCESS_ROLES` drives the simple panel.
 *
 * The one rule that makes the pairing work: a role NEVER emits a
 * `category:device` row. That row is unrestricted device reach
 * (`hasUnrestrictedDeviceReach` in `device-selector.ts` / `scope-access.ts`)
 * and would silently discard the operator's device choice — the panel would
 * show "3 cameras" over a grant that reaches all of them. The device row is
 * always `{type:'device', selector}` so question 2 is load-bearing; a
 * selector of `{kind:'all'}` is the deliberate way to say "everything", and
 * the matcher treats it as the same unrestricted reach.
 *
 * The `category:system` row is what makes a role USEFUL: recordings, the
 * events feed, faces and playback manifests live on system-scope caps, so a
 * device grant alone reaches almost nothing a viewer wants. It is safe at
 * these tiers because (a) admin-tier methods are refused by the auth gate
 * regardless of scope, and (b) every system-scope method that NAMES a device
 * is cut back to the role's own device set by the F1 #3 device-reference gate.
 *
 * Lives in `@camstack/types` next to `device-selector.ts` for the same reason
 * that file does: the admin UI composes these and the backend resolves them,
 * and a hand-copied second derivation drifts (D103).
 */
import type { DeviceSelector, MethodAccess, TokenScope } from './auth-records.js'

/** The three answers to "what can this user do". */
export type AccessRoleId = 'viewer' | 'operator' | 'manager'

export interface AccessRoleSpec {
  readonly id: AccessRoleId
  /** Radio-button label. */
  readonly label: string
  /** One sentence saying what the role can do — shown under the label. */
  readonly description: string
  /** Access flavours carried by the role's `device` grant. */
  readonly deviceAccess: readonly MethodAccess[]
  /** Access flavours carried by the role's `category:system` grant. */
  readonly systemAccess: readonly MethodAccess[]
}

/**
 * Ordered widest-last — the panel renders them top to bottom and the operator
 * reads the list as an escalation.
 */
export const ACCESS_ROLES: readonly AccessRoleSpec[] = [
  {
    id: 'viewer',
    label: 'View',
    description:
      'Watch live and recorded video, browse events and read device state. Cannot change anything.',
    deviceAccess: ['view'],
    systemAccess: ['view'],
  },
  {
    id: 'operator',
    label: 'Operate',
    description:
      'Everything View does, plus acting on a device: PTZ, lights, sirens, locks, and snoozing notifications. Cannot delete.',
    deviceAccess: ['view', 'create'],
    systemAccess: ['view', 'create'],
  },
  {
    id: 'manager',
    label: 'Full management',
    description:
      'Everything Operate does, plus deleting devices, recordings and events. Short of admin — no user or cluster administration.',
    deviceAccess: ['view', 'create', 'delete'],
    systemAccess: ['view', 'create', 'delete'],
  },
] as const

/** Look a role up by id. Throws on an unknown id — the union makes that
 *  unreachable from typed callers, and a silent fallback would grant the
 *  wrong thing. */
export function roleSpec(id: AccessRoleId): AccessRoleSpec {
  const found = ACCESS_ROLES.find((r) => r.id === id)
  if (!found) throw new Error(`Unknown access role '${id}'`)
  return found
}

/** A complete answer to both panel questions. */
export interface AccessRoleAssignment {
  readonly roleId: AccessRoleId
  readonly selector: DeviceSelector
  /**
   * Whether a grant on a parent device covers its accessory children.
   * ALWAYS written explicitly — see {@link buildRoleScopes}.
   */
  readonly includeLinked: boolean
}

/**
 * Compose an assignment into the grants the matcher reads.
 *
 * `includeLinked` is written explicitly in BOTH directions on purpose. Absent,
 * the matcher derives it from the access flavour (`view` inherits, `create` /
 * `delete` do not), so an omitted `false` would silently re-grant the
 * accessories the operator just excluded, and the panel would be lying about
 * its own toggle.
 */
export function buildRoleScopes(assignment: AccessRoleAssignment): TokenScope[] {
  const spec = roleSpec(assignment.roleId)
  return [
    {
      type: 'device',
      selector: assignment.selector,
      access: [...spec.deviceAccess],
      includeLinked: assignment.includeLinked,
    },
    { type: 'category', target: 'system', access: [...spec.systemAccess] },
  ]
}

/** Set equality over access arrays — grants round-trip through JSON and Zod
 *  with no order guarantee. */
function sameAccess(a: readonly MethodAccess[], b: readonly MethodAccess[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((x) => set.has(x))
}

/**
 * Recover the assignment behind a grant set, or `null` when the grants are
 * not something this panel authored.
 *
 * `null` is not an error — it is the "Advanced" case, and the panel MUST show
 * it as such rather than defaulting the radio to a role the user does not
 * have. Silently rendering an unrecognised grant set as "View" would make the
 * next save a downgrade nobody asked for.
 *
 * Strict by design: exactly the two rows `buildRoleScopes` writes, an
 * explicit `includeLinked`, and device/system access that agree on a single
 * role. Anything else belongs in the raw editor.
 */
export function detectAccessRole(scopes: readonly TokenScope[]): AccessRoleAssignment | null {
  if (scopes.length !== 2) return null
  const deviceRows = scopes.filter((s) => s.type === 'device')
  const systemRows = scopes.filter((s) => s.type === 'category' && s.target === 'system')
  if (deviceRows.length !== 1 || systemRows.length !== 1) return null
  const [deviceRow] = deviceRows
  const [systemRow] = systemRows
  if (deviceRow === undefined || systemRow === undefined) return null
  if (deviceRow.type !== 'device') return null
  if (deviceRow.includeLinked === undefined) return null
  const spec = ACCESS_ROLES.find(
    (r) =>
      sameAccess(r.deviceAccess, deviceRow.access) && sameAccess(r.systemAccess, systemRow.access),
  )
  if (!spec) return null
  return {
    roleId: spec.id,
    selector: deviceRow.selector,
    includeLinked: deviceRow.includeLinked,
  }
}
