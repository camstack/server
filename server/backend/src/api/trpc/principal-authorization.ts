/**
 * The ONE scope matcher (D892): every authorization decision about a verified
 * principal is a function of `principal.scopes`, here. It answers for a tRPC
 * procedure and for an addon's own HTTP surface (routes and data planes);
 * neither asks what kind of credential the principal came from.
 *
 * Order, the same on both surfaces:
 *   1. a `share-view` grant RESTRICTS the principal to its fail-closed
 *      perimeter — nothing else it holds is honoured;
 *   2. `'*'` passes;
 *   3. the capability / addon grants decide.
 */
import { METHOD_ACCESS_MAP } from '@camstack/system'
import type {
  CredentialScope,
  RouteAccess,
  ShareViewGrant,
  ShareViewKind,
  UserScope,
} from '@camstack/types'
import {
  capabilityScopesOf,
  methodAccessForHttpMethod,
  scopesAllowAddon,
  scopesAllowAddonRoutes,
  scopesGrantAdmin,
  shareViewGrantOf,
  viewerHoldsRole,
  viewerScopeOf,
} from '@camstack/types'
import { SHARE_DEVICES_HEADER, SHARE_KIND_HEADER } from '../../auth/addon-route-share-gate.js'
import { checkScopeAccess, type DeviceScopeLookup } from './scope-access.js'
import { checkShareViewAccess } from './share-view-access.js'

export type ProcedureVerdict =
  | { readonly ok: false; readonly reason: string }
  /** `'*'`: no further gate. */
  | { readonly ok: true; readonly mode: 'all' }
  /** Restricted to one share perimeter; the caller projects the answer to it. */
  | { readonly ok: true; readonly mode: 'share'; readonly grant: ShareViewGrant }
  /** Allowed by capability grants; the caller projects device enumerations to them. */
  | { readonly ok: true; readonly mode: 'scoped'; readonly scopes: readonly UserScope[] }

/**
 * May a principal holding `scopes` call the tRPC procedure at `path`?
 *
 * A hand-written core route (`auth.me`, `system.info`) has no cap entry: the
 * authentication already passed, and an explicit `adminProcedure` on top of it
 * gates what is destructive. A share-view principal never reaches that
 * pass-through — its allowlist is enumerated.
 */
export function authorizeProcedure(
  scopes: readonly CredentialScope[],
  path: string,
  rawInput: unknown,
  lookup?: DeviceScopeLookup,
): ProcedureVerdict {
  const grant = shareViewGrantOf(scopes)
  if (grant !== null) {
    const result = checkShareViewAccess(grant, path, rawInput)
    return result.ok ? { ok: true, mode: 'share', grant } : { ok: false, reason: result.reason }
  }
  if (scopesGrantAdmin(scopes)) return { ok: true, mode: 'all' }
  const capability = capabilityScopesOf(scopes)
  if (path in METHOD_ACCESS_MAP) {
    const result = checkScopeAccess(capability, path, rawInput, lookup)
    if (!result.ok) return { ok: false, reason: result.reason }
  }
  return { ok: true, mode: 'scoped', scopes: capability }
}

/**
 * May a VIEWER (D921) pass the admin tier of the cap method at `path`? Only
 * when the method's role is a feature the viewer was granted (or explicitly
 * `viewer`). `adminProcedure` asks this AFTER `protectedProcedure` ran the
 * matcher, which already required the role and every named device; a
 * hand-written admin route has no cap entry and is never passed.
 */
export function viewerPassesAdminTier(scopes: readonly CredentialScope[], path: string): boolean {
  const viewer = viewerScopeOf(capabilityScopesOf(scopes))
  if (viewer === null) return false
  const meta = METHOD_ACCESS_MAP[path]
  if (meta === undefined || meta.role === 'admin') return false
  return viewerHoldsRole(viewer, meta.role)
}

export interface AddonRouteTarget {
  readonly addonId: string
  /** The request's HTTP verb — maps onto the `MethodAccess` vocabulary. */
  readonly method: string
  /** The route's / data plane's declared access. Never `'public'`. */
  readonly access: Exclude<RouteAccess, 'public'>
  /** The share kinds a data plane opted in to. Absent for a control route: no share link reaches one. */
  readonly share?: readonly ShareViewKind[]
}

export type AddonRouteVerdict =
  | {
      readonly ok: true
      /** For a share principal: the scope the HUB forwards to the plane, in headers it alone writes. */
      readonly shareHeaders: Readonly<Record<string, string>> | null
    }
  | {
      readonly ok: false
      readonly status: 403
      readonly error: string
      /** Why, for the refusal's log line. */
      readonly reason: string
    }

/** May a principal holding `scopes` reach `/addon/<addonId>/…` with this verb? */
export function authorizeAddonRoute(
  scopes: readonly CredentialScope[],
  target: AddonRouteTarget,
): AddonRouteVerdict {
  const grant = shareViewGrantOf(scopes)
  if (grant !== null) {
    if (!(target.share ?? []).includes(grant.kind)) {
      return {
        ok: false,
        status: 403,
        error: 'Share token not accepted here',
        reason: `share-view ${grant.kind} not accepted by ${target.addonId}`,
      }
    }
    return {
      ok: true,
      shareHeaders: {
        [SHARE_KIND_HEADER]: grant.kind,
        [SHARE_DEVICES_HEADER]: grant.deviceIds.join(','),
      },
    }
  }
  if (scopesGrantAdmin(scopes)) return { ok: true, shareHeaders: null }
  if (target.access === 'admin') {
    return { ok: false, status: 403, error: 'Admin required', reason: 'admin route' }
  }
  const access = methodAccessForHttpMethod(target.method)
  if (
    scopesAllowAddonRoutes(scopes, access) ||
    scopesAllowAddon(
      capabilityScopesOf(scopes).flatMap((s) => (s.type === 'viewer' ? [] : [s])),
      target.addonId,
      access,
    )
  ) {
    return { ok: true, shareHeaders: null }
  }
  return {
    ok: false,
    status: 403,
    error: 'Token scope mismatch',
    reason: `holds no addon:${target.addonId}[${access}] grant`,
  }
}
