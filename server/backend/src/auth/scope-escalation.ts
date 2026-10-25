/**
 * A mint can never hand out more than its caller holds (D892).
 *
 * `scopesWithin(requested, held)` is the one escalation check for every
 * mint (`auth.mintToken`, the only one since D895):
 *
 *   - `'*'` held → anything may be minted (the procedures still ask a fresh
 *     re-authentication before minting `'*'`);
 *   - `'*'` requested → only by a holder of `'*'`;
 *   - a share-view grant → every device must be viewable by the caller, and
 *     talk-back (`talk: true`) needs the caller to hold talk-back on each;
 *   - `addon-routes` → ADMIN only: it is every addon's own routes at once (the
 *     D103 reach), so a non-admin names the addon it wants (`addon:<id>`);
 *   - `preferences-self` → the caller holds it (a token so minted reaches its
 *     SUBJECT's own preferences, never anyone else's, D894);
 *   - a capability grant → the caller holds the SAME grant (type, target or
 *     selector, linked-device rule) with every flavour asked. Narrowing a
 *     selector is not inferred: a caller who wants a narrower device grant
 *     mints a share-view, or asks an admin.
 *
 * Conservative on purpose: a refused legitimate mint costs a sentence in the
 * error; an accepted escalation costs the hub.
 */
import type { CredentialScope, MethodAccess, ShareViewGrant, UserScope } from '@camstack/types'
import { ADMIN_SCOPE, capabilityScopesOf, scopesGrantAdmin } from '@camstack/types'
import { filterViewableDeviceIds } from '../api/trpc/principal-visibility.js'
import { checkScopeAccess, type DeviceScopeLookup } from '../api/trpc/scope-access.js'

/**
 * The method a share link's talk-back opens first. Holding it on a device is
 * what lets a caller hand talk-back on that device to whoever holds the link.
 */
const TALK_BACK_PATH = 'intercom.startSession'

/** May the holder of `held` talk back on every device of `grant`? */
function canTalkOn(
  held: readonly UserScope[],
  deviceIds: readonly number[],
  lookup: DeviceScopeLookup | undefined,
): boolean {
  return deviceIds.every(
    (deviceId) => checkScopeAccess(held, TALK_BACK_PATH, { deviceId }, lookup).ok,
  )
}

export type EscalationVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

function accessCovered(asked: readonly MethodAccess[], held: readonly MethodAccess[]): boolean {
  return asked.every((a) => held.includes(a))
}

/** The grant without its access list, as a comparable key. */
function grantKey(scope: UserScope): string {
  // A viewer row (D921) is compared WHOLE: its lists and features are the
  // grant, there is no access flavour to cut.
  if (scope.type === 'viewer') return JSON.stringify(scope)
  if (scope.type === 'device') {
    return JSON.stringify({
      type: scope.type,
      selector: scope.selector,
      includeLinked: scope.includeLinked ?? null,
    })
  }
  return JSON.stringify({ type: scope.type, target: scope.target })
}

function describe(scope: CredentialScope): string {
  if (scope === ADMIN_SCOPE) return "'*'"
  if (scope.type === 'share-view') return `share-view:${scope.grant.kind}`
  if (scope.type === 'addon-routes') return `addon-routes[${scope.access.join(',')}]`
  if (scope.type === 'preferences-self') return 'preferences-self'
  if (scope.type === 'viewer') return 'viewer'
  if (scope.type === 'device') return `device[${scope.access.join(',')}]`
  return `${scope.type}:${scope.target}[${scope.access.join(',')}]`
}

export function scopesWithin(
  requested: readonly CredentialScope[],
  held: readonly CredentialScope[],
  lookup?: DeviceScopeLookup,
): EscalationVerdict {
  if (scopesGrantAdmin(held)) return { ok: true }
  const heldCapability = capabilityScopesOf(held)
  for (const scope of requested) {
    if (scope === ADMIN_SCOPE) {
      return { ok: false, reason: "only an admin can mint '*'" }
    }
    if (scope.type === 'share-view') {
      const viewable = filterViewableDeviceIds(heldCapability, scope.grant.deviceIds, lookup)
      if (viewable.length !== scope.grant.deviceIds.length) {
        return { ok: false, reason: 'a share-view grant names a device you cannot view' }
      }
      if (scope.grant.talk === true && !canTalkOn(heldCapability, scope.grant.deviceIds, lookup)) {
        return {
          ok: false,
          reason: 'a share-view grant asks talk-back on a device you cannot talk on',
        }
      }
      continue
    }
    if (scope.type === 'preferences-self') {
      const covered = held.some((h) => h !== ADMIN_SCOPE && h.type === 'preferences-self')
      if (!covered) return { ok: false, reason: `you do not hold ${describe(scope)}` }
      continue
    }
    if (scope.type === 'addon-routes') {
      return {
        ok: false,
        reason: `only an admin can mint ${describe(scope)} — name the addon instead (addon:<id>)`,
      }
    }
    const key = grantKey(scope)
    if (scope.type === 'viewer') {
      // Only the SAME viewer grant the caller holds — a viewer mints a token
      // for itself, never a wider (or differently shaped) one.
      if (!heldCapability.some((h) => grantKey(h) === key)) {
        return {
          ok: false,
          reason: `you do not hold ${describe(scope)} with these devices and features`,
        }
      }
      continue
    }
    const covered = heldCapability.some(
      (h) => h.type !== 'viewer' && grantKey(h) === key && accessCovered(scope.access, h.access),
    )
    if (!covered) return { ok: false, reason: `you do not hold ${describe(scope)}` }
  }
  return { ok: true }
}

/** A share-view grant cut down to what `held` may still see (and talk on). `null` = nothing left. */
function narrowShareGrant(
  grant: ShareViewGrant,
  held: readonly UserScope[],
  lookup: DeviceScopeLookup | undefined,
): ShareViewGrant | null {
  const deviceIds = filterViewableDeviceIds(held, grant.deviceIds, lookup)
  if (deviceIds.length === 0) return null
  const talk = grant.talk === true && canTalkOn(held, deviceIds, lookup)
  return {
    kind: grant.kind,
    deviceIds,
    ...(grant.talk !== undefined ? { talk } : {}),
  }
}

/**
 * `token`'s scopes cut down to what `held` — its non-admin subject's scopes
 * NOW — still covers (security review 2026-10-21): an admin who narrows a user
 * narrows every token that user minted, at the next verify, rather than
 * leaving the token the reach the user no longer has.
 *
 *   - a capability grant keeps the flavours the subject still holds on the
 *     SAME grant, and goes when none is left;
 *   - a share-view grant keeps the devices the subject can still view (and
 *     talk-back only where it can still talk);
 *   - `'*'` and `addon-routes` are admin-only and never survive here.
 *
 * Never widens: every output scope is covered by an input scope.
 */
export function intersectScopes(
  token: readonly CredentialScope[],
  held: readonly UserScope[],
  lookup?: DeviceScopeLookup,
): CredentialScope[] {
  const out: CredentialScope[] = []
  for (const scope of token) {
    if (scope === ADMIN_SCOPE || scope.type === 'addon-routes') continue
    if (scope.type === 'share-view') {
      const grant = narrowShareGrant(scope.grant, held, lookup)
      if (grant !== null) out.push({ type: 'share-view', grant })
      continue
    }
    // The subject's OWN preferences (D894): every person holds it, so a live
    // subject never loses it — except on a share link. A share-view grant cut
    // to nothing must not leave a preferences token behind.
    if (scope.type === 'preferences-self') {
      if (!token.some((s) => s !== ADMIN_SCOPE && s.type === 'share-view')) out.push(scope)
      continue
    }
    const key = grantKey(scope)
    if (scope.type === 'viewer') {
      // Kept only while the subject still holds the identical viewer grant:
      // an admin who edits a viewer's devices or features ends that viewer's
      // tokens rather than letting them keep (or gain) another reach.
      if (held.some((h) => grantKey(h) === key)) out.push(scope)
      continue
    }
    const heldAccess = new Set(
      held.flatMap((h) => (h.type !== 'viewer' && grantKey(h) === key ? [...h.access] : [])),
    )
    const access = scope.access.filter((a) => heldAccess.has(a))
    if (access.length > 0) out.push({ ...scope, access })
  }
  return out
}
