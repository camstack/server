/**
 * Custom-action contracts — a mechanism for addons to expose system-level
 * extensibility endpoints (e.g. benchmark addon API) through a single
 * generic `api.addons.custom` tRPC endpoint.
 *
 * The contract shape mirrors `method()` from capability-definition.ts —
 * input/output Zod schemas, kind, auth — plus a `scope` discriminated union
 * (today only 'system' is runtime-supported; 'device' is typed for forward
 * compat).
 */

import type { z } from 'zod'
import type { DeviceType } from '../device/device-type.js'
import type { CapabilityMethodAuth } from './capability-definition.js'

/** Scope of a custom action. Today only `system` is supported by the runtime. */
export type CustomActionScope =
  | { readonly kind: 'system' }
  | { readonly kind: 'device'; readonly deviceTypes?: readonly DeviceType[] }

/**
 * Authenticated caller forwarded to a `caller:'required'` custom action.
 *
 * The dispatcher derives this server-side from the request principal — an
 * action NEVER reads the caller's identity from its own input. `userId` is
 * the stable user id (`ctx.user.id`); `isAdmin` mirrors the auth flag.
 */
export interface CustomActionCaller {
  readonly userId: string
  readonly isAdmin: boolean
}

export interface CustomActionSpec<
  TIn extends z.ZodType = z.ZodType,
  TOut extends z.ZodType = z.ZodType,
  TKind extends 'query' | 'mutation' | 'subscription' = 'query' | 'mutation' | 'subscription',
  TAuth extends CapabilityMethodAuth = CapabilityMethodAuth,
  TScope extends CustomActionScope = CustomActionScope,
> {
  readonly input: TIn
  readonly output: TOut
  readonly kind: TKind
  readonly auth: TAuth
  readonly scope: TScope
  /**
   * When `'required'`, the dispatcher forwards the authenticated caller
   * (server-derived) as the handler's optional second argument. Absent =
   * the handler is invoked with input only (legacy behavior).
   */
  readonly caller?: 'required'
}

export type CustomActionsSpec = Record<string, CustomActionSpec>

/**
 * Identity — preserves literal types for downstream inference.
 *
 * The constraint is `Record<string, unknown>` (not `CustomActionsSpec`) so
 * TypeScript does not widen each entry's literal `kind`/`auth` fields to
 * the broader unions declared on `CustomActionSpec`'s default generics.
 * Shape validity is enforced separately by the `customAction(...)` helper
 * whose return type is already a `CustomActionSpec<...>`.
 */
export function defineCustomActions<T extends Record<string, unknown>>(spec: T): T {
  return spec
}

export interface CustomActionOptions<
  TKind extends 'query' | 'mutation' | 'subscription' = 'query',
  TAuth extends CapabilityMethodAuth = 'protected',
> {
  readonly kind?: TKind
  readonly auth?: TAuth
  readonly scope?: CustomActionScope
  /** When `'required'`, the dispatcher forwards the authenticated caller. */
  readonly caller?: 'required'
}

export function customAction<
  TIn extends z.ZodType,
  TOut extends z.ZodType,
  TKind extends 'query' | 'mutation' | 'subscription' = 'query',
  TAuth extends CapabilityMethodAuth = 'protected',
>(
  input: TIn,
  output: TOut,
  options?: CustomActionOptions<TKind, TAuth>,
): CustomActionSpec<TIn, TOut, TKind, TAuth, { readonly kind: 'system' }> {
  return {
    input,
    output,
    kind: (options?.kind ?? 'query') as TKind,
    auth: (options?.auth ?? 'protected') as TAuth,
    scope: (options?.scope ?? { kind: 'system' as const }) as { readonly kind: 'system' },
    ...(options?.caller ? { caller: 'required' as const } : {}),
  }
}

export function deviceCustomAction<
  TIn extends z.ZodType,
  TOut extends z.ZodType,
  TKind extends 'query' | 'mutation' | 'subscription' = 'query',
  TAuth extends CapabilityMethodAuth = 'protected',
>(
  input: TIn,
  output: TOut,
  options?: Omit<CustomActionOptions<TKind, TAuth>, 'scope'> & {
    readonly deviceTypes?: readonly DeviceType[]
  },
): CustomActionSpec<
  TIn,
  TOut,
  TKind,
  TAuth,
  { readonly kind: 'device'; readonly deviceTypes?: readonly DeviceType[] }
> {
  return {
    input,
    output,
    kind: (options?.kind ?? 'query') as TKind,
    auth: (options?.auth ?? 'protected') as TAuth,
    scope: {
      kind: 'device' as const,
      ...(options?.deviceTypes ? { deviceTypes: options.deviceTypes } : {}),
    },
  }
}

/**
 * A custom action as it crosses a PROCESS boundary: everything the hub needs
 * to route and gate the action, and nothing it cannot carry.
 *
 * `CustomActionSpec` holds two Zod schemas, and MsgPack (the UDS frame codec)
 * cannot encode a schema. Until D444 the hub worked around that by EVALUATING
 * the forked addon's whole bundle inside hub-main to read the schemas — 9 MB
 * per deploy, module-scope state pinned per evaluation, ten times in one
 * process life. The descriptor is what actually travels: the schemas stay in
 * the process that owns the addon, which is also the one that validates.
 */
export interface CustomActionDescriptor {
  readonly kind: 'query' | 'mutation' | 'subscription'
  readonly auth: CapabilityMethodAuth
  readonly scope: CustomActionScope
  /** See {@link CustomActionSpec.caller}. */
  readonly caller?: 'required'
}

/** One addon's catalog, schemas stripped. Keyed by action name. */
export type CustomActionCatalogDescriptor = Readonly<Record<string, CustomActionDescriptor>>

/**
 * Every hosted addon's catalog, keyed by addon id — a group runner hosts
 * several addons in one child, so a child describes all of them at once. An
 * addon that declares no actions is present with an EMPTY catalog: absence
 * must never be ambiguous between "none" and "not described yet".
 */
export type ChildCustomActionCatalogs = Readonly<Record<string, CustomActionCatalogDescriptor>>

/** Strip a catalog to what crosses the wire. Pure; the schemas are not touched. */
export function describeCustomActions(catalog: CustomActionsSpec): CustomActionCatalogDescriptor {
  const out: Record<string, CustomActionDescriptor> = {}
  for (const [name, spec] of Object.entries(catalog)) {
    out[name] = {
      kind: spec.kind,
      auth: spec.auth,
      scope: spec.scope,
      ...(spec.caller === 'required' ? { caller: 'required' as const } : {}),
    }
  }
  return out
}
