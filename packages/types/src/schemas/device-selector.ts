/**
 * Pure DeviceSelector semantics — scope model v3 (2026-08-12).
 *
 * One derivation of "does this grant cover this device", reused by:
 *   - the enforcement matcher (`server/backend/.../scope-access.ts`), per
 *     request, against a single deviceId + its ancestors;
 *   - response projection + `auth.me`, against the WHOLE fleet, to compute
 *     the viewable device set and the effective-scope summary the UI reads.
 *
 * Lives in `@camstack/types` (framework, train-bound) because BOTH the
 * backend enforcement path and any addon/UI need the same rule — the F0.x
 * lesson that a hand-copied scope check drifts (D103).
 *
 * No I/O, no registry — the fleet + parentage are passed in.
 */
import type {
  DeviceSelector,
  DeviceTokenScope,
  MethodAccess,
  TokenScope,
  UserScope,
} from './auth-records.js'
import { UserScopeSchema } from './auth-records.js'
import {
  type ViewerFeatureId,
  type ViewerTokenScope,
  viewerAdmitsDevice,
} from '../auth/viewer-access.js'

/**
 * The viewer grant that decides this principal, or `null`. A set holding one
 * is decided by it ALONE (D921): the first viewer row wins, the rest of the
 * set is ignored, so a leftover grant can never widen a viewer.
 */
export function viewerScopeOf(scopes: readonly UserScope[]): ViewerTokenScope | null {
  for (const s of scopes) if (s.type === 'viewer') return s
  return null
}

/** The devices a viewer is admitted to, resolved against the whole fleet. */
function viewerAdmittedIds(
  viewer: ViewerTokenScope,
  fleet: readonly DeviceMetaLike[],
): Set<number> {
  const byId = new Map<number, DeviceMetaLike>()
  for (const d of fleet) byId.set(d.id, d)
  const out = new Set<number>()
  for (const d of fleet) {
    if (viewerAdmitsDevice(viewer, d.id, (id) => (byId.has(id) ? ancestorsOf(id, byId) : null))) {
      out.add(d.id)
    }
  }
  return out
}

/** Ancestor-walk bound — defence-in-depth against a corrupt parentage cycle. */
const MAX_ANCESTOR_HOPS = 8

/** The minimal device shape selectors resolve against. */
export interface DeviceMetaLike {
  readonly id: number
  /** `DeviceType` string value (e.g. `'camera'`). */
  readonly type: string
  /** Operator-assigned location label; `null` when unset. */
  readonly location: string | null
  readonly parentDeviceId: number | null
}

/**
 * Does `selector` cover `device` DIRECTLY (no inheritance)? Inheritance is
 * layered on by the resolver/matcher, which tests this against a device's
 * ancestors too.
 */
export function deviceSelectorMatches(selector: DeviceSelector, device: DeviceMetaLike): boolean {
  switch (selector.kind) {
    case 'all':
      return true
    case 'ids':
      return selector.ids.includes(device.id)
    case 'types':
      // Compare stringwise so the enum-typed selector matches the mirror's
      // string `type` without a cast.
      return selector.types.some((t) => String(t) === device.type)
    case 'locations':
      return device.location !== null && selector.locations.includes(device.location)
  }
}

/** Whether a `category:device` grant covers `access` (the broad lever). */
function hasBroadDeviceGrant(scopes: readonly TokenScope[], access: MethodAccess): boolean {
  return scopes.some(
    (s) => s.type === 'category' && s.target === 'device' && s.access.includes(access),
  )
}

/** The `device`-typed scopes granting `access`. */
function deviceScopesFor(
  scopes: readonly TokenScope[],
  access: MethodAccess,
): readonly DeviceTokenScope[] {
  return scopes.filter(
    (s): s is DeviceTokenScope => s.type === 'device' && s.access.includes(access),
  )
}

/** Whether inheritance applies for a grant at `access` (view inherits, others
 *  don't, unless the grant overrides via `includeLinked`). */
export function scopeInherits(scope: DeviceTokenScope, access: MethodAccess): boolean {
  return scope.includeLinked ?? access === 'view'
}

/** Ancestors (parent, grandparent, …) of `deviceId` within a fleet map. */
function ancestorsOf(deviceId: number, byId: ReadonlyMap<number, DeviceMetaLike>): number[] {
  const out: number[] = []
  let current: number | null = deviceId
  for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop++) {
    const parent: number | null =
      current === null ? null : (byId.get(current)?.parentDeviceId ?? null)
    if (parent === null || parent === current) break
    out.push(parent)
    current = parent
  }
  return out
}

/**
 * Resolve the set of deviceIds the caller may reach at `access`, expanded
 * against the live `fleet`. A `category:device` grant returns the whole
 * fleet. Device selectors are matched per device — directly, or (when the
 * grant inherits) against an ancestor, so a parent grant covers its
 * accessories.
 */
export function resolveViewableDeviceIds(
  scopes: readonly UserScope[],
  fleet: readonly DeviceMetaLike[],
  access: MethodAccess,
): Set<number> {
  // A viewer reaches its admitted devices at every flavour; what it may DO
  // there is the method's role, decided by the matcher.
  const viewer = viewerScopeOf(scopes)
  if (viewer !== null) return viewerAdmittedIds(viewer, fleet)
  return resolveGrantDeviceIds(grantRowsOf(scopes), fleet, access)
}

/**
 * The capability rows of a set — a viewer row (D921) dropped. For surfaces
 * that edit or display capability rows and have no meaning for a viewer row.
 */
export function grantRowsOf(scopes: readonly UserScope[]): TokenScope[] {
  const out: TokenScope[] = []
  for (const s of scopes) if (s.type !== 'viewer') out.push(s)
  return out
}

function resolveGrantDeviceIds(
  scopes: readonly TokenScope[],
  fleet: readonly DeviceMetaLike[],
  access: MethodAccess,
): Set<number> {
  if (hasBroadDeviceGrant(scopes, access)) {
    return new Set(fleet.map((d) => d.id))
  }
  const byId = new Map<number, DeviceMetaLike>()
  for (const d of fleet) byId.set(d.id, d)
  const grants = deviceScopesFor(scopes, access)
  const out = new Set<number>()
  for (const d of fleet) {
    for (const grant of grants) {
      if (deviceSelectorMatches(grant.selector, d)) {
        out.add(d.id)
        break
      }
      if (scopeInherits(grant, access)) {
        const covered = ancestorsOf(d.id, byId).some((ancestorId) => {
          const ancestor = byId.get(ancestorId)
          return ancestor !== undefined && deviceSelectorMatches(grant.selector, ancestor)
        })
        if (covered) {
          out.add(d.id)
          break
        }
      }
    }
  }
  return out
}

// ── Runtime migration boundary ─────────────────────────────────────────

/**
 * Normalise a raw scope array read off a JWT payload or a stored record into
 * validated v3 `TokenScope`s, migrating any v2 `device:targets` grant on the
 * way (via {@link TokenScopeSchema}'s preprocess). Applied at the request
 * boundary (`resolveUser`) so the enforcement matcher only ever sees v3.
 *
 * Per-ITEM parse (not whole-array) so a single malformed scope is dropped
 * without discarding the caller's valid grants — losing a good grant reads as
 * a lockout, and a lockout reads as broken. A non-array input yields `[]`
 * (fail closed).
 */
export function normalizeTokenScopes(raw: unknown): UserScope[] {
  if (!Array.isArray(raw)) return []
  const out: UserScope[] = []
  for (const item of raw) {
    // A viewer row (D921) survives this boundary too — dropping it would
    // lock a viewer out of everything with no word why.
    const parsed = UserScopeSchema.safeParse(item)
    if (parsed.success) out.push(parsed.data)
  }
  return out
}

// ── auth.me effective-scope summary ────────────────────────────────────

/** A capability/addon grant flattened for the UI. */
export interface ScopeGrantSummary {
  readonly name: string
  readonly access: readonly MethodAccess[]
}

/** Per-access device reach — a COUNT and the "everything" flag, never the id
 *  list (the UI hides surfaces from counts; it never needs the ids). */
export interface DeviceReachSummary {
  readonly all: boolean
  readonly deviceCount: number
}

/**
 * The resolved, effective scope the caller actually has — what `auth.me`
 * returns so the viewer (F3/F4) can HIDE out-of-scope surfaces. Selectors are
 * expanded to counts/flags against the live fleet, never to raw id lists.
 */
export interface EffectiveScope {
  readonly isAdmin: boolean
  /**
   * `admin`, `viewer` (D921), or `scoped` — a legacy grant set decided by the
   * pre-D921 matcher until the operator converts it.
   */
  readonly role: 'admin' | 'viewer' | 'scoped'
  /** The features granted to a viewer; empty for every other role. */
  readonly features: readonly ViewerFeatureId[]
  /** true iff every device is viewable (admin, `category:device[view]`, or a
   *  device grant with an `all` selector). */
  readonly allDevicesViewable: boolean
  /** How many devices the caller may VIEW right now. */
  readonly viewableDeviceCount: number
  /** Device reach per access flavour. */
  readonly device: Readonly<Record<MethodAccess, DeviceReachSummary>>
  /** `category:system` access flavours held. */
  readonly system: readonly MethodAccess[]
  /** `capability:<name>` grants. */
  readonly capabilities: readonly ScopeGrantSummary[]
  /** `addon:<id>` grants. */
  readonly addons: readonly ScopeGrantSummary[]
}

const ALL_ACCESS: readonly MethodAccess[] = ['view', 'create', 'delete']

function deviceReach(
  scopes: readonly UserScope[],
  fleet: readonly DeviceMetaLike[],
  access: MethodAccess,
  isAdmin: boolean,
): DeviceReachSummary {
  if (isAdmin) return { all: true, deviceCount: fleet.length }
  const viewer = viewerScopeOf(scopes)
  if (viewer !== null) {
    const admitted = viewerAdmittedIds(viewer, fleet)
    return { all: admitted.size === fleet.length, deviceCount: admitted.size }
  }
  const rows = grantRowsOf(scopes)
  const all =
    hasBroadDeviceGrant(rows, access) ||
    deviceScopesFor(rows, access).some((s) => s.selector.kind === 'all')
  const ids = resolveViewableDeviceIds(scopes, fleet, access)
  return { all, deviceCount: ids.size }
}

function capabilityGrants(scopes: readonly UserScope[]): ScopeGrantSummary[] {
  const out: ScopeGrantSummary[] = []
  for (const s of scopes) {
    if (s.type === 'capability') out.push({ name: s.target, access: s.access })
  }
  return out
}

function addonGrants(scopes: readonly UserScope[]): ScopeGrantSummary[] {
  const out: ScopeGrantSummary[] = []
  for (const s of scopes) {
    if (s.type === 'addon') out.push({ name: s.target, access: s.access })
  }
  return out
}

/** Build the {@link EffectiveScope} for a caller from their scopes + the fleet. */
export function summarizeEffectiveScope(
  scopes: readonly UserScope[],
  fleet: readonly DeviceMetaLike[],
  isAdmin: boolean,
): EffectiveScope {
  const device: Record<MethodAccess, DeviceReachSummary> = {
    view: deviceReach(scopes, fleet, 'view', isAdmin),
    create: deviceReach(scopes, fleet, 'create', isAdmin),
    delete: deviceReach(scopes, fleet, 'delete', isAdmin),
  }
  const system = isAdmin
    ? ALL_ACCESS
    : ALL_ACCESS.filter((a) =>
        scopes.some((s) => s.type === 'category' && s.target === 'system' && s.access.includes(a)),
      )
  const viewer = isAdmin ? null : viewerScopeOf(scopes)
  return {
    isAdmin,
    role: isAdmin ? 'admin' : viewer !== null ? 'viewer' : 'scoped',
    features: viewer?.features ?? [],
    allDevicesViewable: device.view.all,
    viewableDeviceCount: device.view.deviceCount,
    device,
    system,
    capabilities: capabilityGrants(scopes),
    addons: addonGrants(scopes),
  }
}
