/**
 * The viewer role (D921): the ONE non-admin role a person can hold.
 *
 * A viewer reaches:
 *   - every cap method labelled `viewer` (the baseline a normal user of the
 *     viewer app needs: live, grids, recordings, events, device status and
 *     actuation, PTZ moves, talk-back, snoozing);
 *   - every method labelled `feature:<id>` for a feature the admin granted
 *     them (the {@link VIEWER_FEATURES} catalog);
 *   - nothing labelled `admin`;
 * and only on the devices its two lists admit: `allow` (`'*'` = every device)
 * minus `block`. A device is admitted through itself or any ancestor, so a
 * camera's children follow it in both lists.
 *
 * A method's label is resolved by {@link resolveMethodRole} from the cap
 * definition — an explicit `role` on the method, else on the cap, else derived
 * from its `auth` tier and the cap's scope. Codegen writes it into
 * `METHOD_ACCESS_MAP[path].role`, the one table the matcher reads.
 *
 * Adding a feature: one {@link VIEWER_FEATURES} entry, then `role: { feature }`
 * on the methods it unlocks (cap- or method-level), then `npm run codegen`.
 * `scripts/check-method-roles.ts` refuses an id outside the catalog and a
 * catalog entry no method carries.
 *
 * Pure: no I/O.
 */
import { z } from 'zod'

/** The feature ids an admin can grant a viewer. Grown one entry at a time. */
export const VIEWER_FEATURE_IDS = [
  'face-assignment',
  'plate-assignment',
  'retrain',
  'scenes',
] as const

export const ViewerFeatureIdSchema = z.enum(VIEWER_FEATURE_IDS)
export type ViewerFeatureId = z.infer<typeof ViewerFeatureIdSchema>

/** One catalog entry, as the admin UI renders it. */
export interface ViewerFeatureSpec {
  readonly id: ViewerFeatureId
  readonly label: string
  readonly description: string
  /** The viewer-app Library sections the feature reveals. */
  readonly viewerSections: readonly string[]
}

export const VIEWER_FEATURES: readonly ViewerFeatureSpec[] = [
  {
    id: 'face-assignment',
    label: 'Faces',
    description: 'See recognised people and assign, rename, merge or delete faces.',
    viewerSections: ['review'],
  },
  {
    id: 'plate-assignment',
    label: 'License plates',
    description: 'See plates and vehicles, correct plate text, assign or delete plates.',
    viewerSections: ['plates'],
  },
  {
    id: 'retrain',
    label: 'Training data',
    description: 'Pick and annotate frames for retraining and manage their collections.',
    viewerSections: ['retrain'],
  },
  {
    id: 'scenes',
    label: 'Scenes',
    description: 'Create, check and reset monitored scenes.',
    viewerSections: ['scenes'],
  },
] as const

/** Which devices a viewer reaches: `allow` minus `block`. */
export const ViewerDeviceAllowSchema = z.union([
  z.literal('*'),
  z.array(z.number().int().nonnegative()),
])
export type ViewerDeviceAllow = z.infer<typeof ViewerDeviceAllowSchema>

/**
 * The viewer grant, stored as ONE row of a user's `scopes`. A principal that
 * holds it is decided by the viewer rules ALONE — any other row it carries is
 * ignored, so a viewer can never be widened by a leftover grant.
 */
export const ViewerTokenScopeSchema = z.object({
  type: z.literal('viewer'),
  allow: ViewerDeviceAllowSchema,
  block: z.array(z.number().int().nonnegative()),
  features: z.array(ViewerFeatureIdSchema),
})
export type ViewerTokenScope = z.infer<typeof ViewerTokenScopeSchema>

/** The grant a new viewer starts with: every device, nothing blocked, no feature. */
export const DEFAULT_VIEWER_SCOPE: ViewerTokenScope = {
  type: 'viewer',
  allow: '*',
  block: [],
  features: [],
}

/** What a method is, for a viewer. `feature:<id>` is a granted extra. */
export type MethodRole = 'public' | 'viewer' | 'admin' | `feature:${ViewerFeatureId}`

/** The explicit label a cap author writes (method- or cap-level). */
export type MethodRoleDecl = 'viewer' | 'admin' | { readonly feature: ViewerFeatureId }

/** Render a declaration as its map value. */
export function methodRoleOf(decl: MethodRoleDecl): MethodRole {
  return typeof decl === 'string' ? decl : `feature:${decl.feature}`
}

/** The feature a role names, or `null` for a non-feature role. */
export function featureOfRole(role: MethodRole): ViewerFeatureId | null {
  if (!role.startsWith('feature:')) return null
  const parsed = ViewerFeatureIdSchema.safeParse(role.slice('feature:'.length))
  return parsed.success ? parsed.data : null
}

/** The inputs {@link resolveMethodRole} reads. */
export interface MethodRoleSource {
  readonly capScope: 'device' | 'system'
  readonly capRole: MethodRoleDecl | undefined
  readonly methodRole: MethodRoleDecl | undefined
  readonly auth: string
}

/**
 * The label of one method. Explicit wins (method, then cap). Otherwise:
 * `public` stays public, `admin` stays admin, a `protected` method of a DEVICE
 * cap is viewer baseline (it is a read or an actuation of one device, and the
 * device lists still bound it), and a `protected` method of a SYSTEM cap is
 * admin until someone labels it `viewer` — a system method reaches the whole
 * installation, so it joins the baseline only by a reviewed decision.
 */
export function resolveMethodRole(src: MethodRoleSource): MethodRole {
  if (src.methodRole !== undefined) return methodRoleOf(src.methodRole)
  if (src.capRole !== undefined) return methodRoleOf(src.capRole)
  if (src.auth === 'public') return 'public'
  if (src.auth === 'admin' || src.auth === 'superAdmin') return 'admin'
  return src.capScope === 'device' ? 'viewer' : 'admin'
}

/**
 * Resolves a device to its ancestors (parent, grandparent, …), or `null` when
 * the device is UNKNOWN to the persisted mirror — "no parent" and "we cannot
 * tell" are different answers here.
 */
export type ViewerAncestorLookup = (deviceId: number) => readonly number[] | null

/**
 * Is `deviceId` admitted by the viewer's lists? The device and its ancestors
 * form one chain: it is admitted when `allow` is `'*'` or names a link, and no
 * link is in `block`. So a camera's children follow it in both lists.
 *
 * Unknown parentage fails closed. A device the mirror does not know (or no
 * lookup at all) is admitted only when that cannot hide a block: under `'*'`
 * only while `block` is empty, under a list only when the list names the
 * device itself and it is not blocked.
 */
export function viewerAdmitsDevice(
  scope: ViewerTokenScope,
  deviceId: number,
  ancestors: ViewerAncestorLookup | undefined,
): boolean {
  const known = ancestors?.(deviceId) ?? null
  if (known === null) {
    if (scope.block.includes(deviceId)) return false
    if (scope.allow === '*') return scope.block.length === 0
    return scope.allow.includes(deviceId)
  }
  const chain = [deviceId, ...known]
  if (chain.some((id) => scope.block.includes(id))) return false
  if (scope.allow === '*') return true
  const allow = scope.allow
  return chain.some((id) => allow.includes(id))
}

/** Does the viewer hold the feature a role requires (or need none)? */
export function viewerHoldsRole(scope: ViewerTokenScope, role: MethodRole): boolean {
  if (role === 'public' || role === 'viewer') return true
  if (role === 'admin') return false
  const feature = featureOfRole(role)
  return feature !== null && scope.features.includes(feature)
}
