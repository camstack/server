/**
 * Runtime cap-router builder (BIG PLAN 2).
 *
 * Builds the per-capability tRPC routers DYNAMICALLY at hub boot by
 * iterating `ALL_CAPABILITY_DEFINITIONS`, instead of importing the
 * statically codegen'd `createCapRouter_<Cap>` value functions baked into
 * `@camstack/server`. Moving the CONSTRUCTION here means a capability
 * update ships via the framework plugin (`@camstack/types` +
 * `@camstack/system`, live-updated together) WITHOUT a `@camstack/server`
 * image rebuild.
 *
 * Type vs value split:
 *   - The runtime VALUE is built here, generically.
 *   - The static AppRouter TYPE stays codegen'd into `@camstack/types`
 *     (`generated/addon-api.ts`) via the `generated-cap-routers.ts`
 *     per-cap router factory TYPES. The server delegation site assigns
 *     this builder's output to that static type at the single documented
 *     boundary, so the SDK keeps full procedure inference.
 *
 * The per-method procedure shape is mechanically derived from each
 * `cap.methods.*` (input zod schema + kind) + the auto-injected
 * `getStatus` / 3 settings-contribution methods (via `expandCapMethods`).
 * Provider resolution is derived from the declarative `mount` hint
 * (`resolveCapMount`) — the same decision the codegen
 * `generate-cap-mounts.ts` baked in.
 *
 * OUTPUT PASS-THROUGH (2026-07-11): unlike the historical codegen, the
 * builder deliberately does NOT apply `.output(schema)`. Re-validating an
 * output the hub does not own against the hub's OWN (framework-versioned,
 * therefore potentially stale) copy of the cap def silently STRIPS fields
 * a fresher addon added (a self-contained addon bundles its own newer
 * `@camstack/types`; the hub-closure copy lags). That is exactly how
 * `models[].group.resolution` vanished from `pipelineExecutor.getSchema`.
 * Cap dispatch is structural (CLAUDE.md invariant): the owning provider is
 * typed to return a complete `z.infer<output>` and is the SOLE authority
 * for the payload shape, so the hub forwards it verbatim. Input validation
 * is retained (`.input(...)`) — the hub still guards the client boundary.
 *
 * This module owns NO tRPC primitives of its own: `@camstack/system`
 * cannot import the server's `TrpcContext`-bound procedures. The server
 * passes them in via {@link CapRouterPrimitives} (the `t` half of the
 * `buildCapRouters(t, services)` contract), keeping the kernel free of any
 * backend coupling (self-sufficiency invariant).
 */

import {
  ALL_CAPABILITY_DEFINITIONS,
  type CapabilityDefinition,
  type CapabilityMethodSchema,
  type CapabilityMountKind,
  type CapCaller,
  expandCapMethods,
  extractNestedAddonId,
  isArrayOutputSchema,
  isObjectInput,
  isVoidInput,
  kebabToCamel,
  looseSchema,
  CALLER_STAMPED_CAPABILITIES,
  withoutCallerStamp,
  objectInputDeclaresAddonId,
  objectInputDeclaresRequiredDeviceId,
  procedureAuthKey,
  resolveCapMount,
  resolveMethodAuth,
} from '@camstack/types'
import { z } from 'zod'

/**
 * A tRPC-procedure-like builder. Mirrors the chainable surface the
 * codegen emits (`procedure.input(...).output(...).query(...)`), kept
 * structural so the server can pass its real `protectedProcedure` /
 * `adminProcedure` / `publicProcedure` without this module importing
 * `@trpc/server` context types.
 */
export interface ProcedureBuilder {
  input(schema: unknown): ProcedureBuilder
  output(schema: unknown): ProcedureBuilder
  query(resolver: (opts: ProcedureResolverArgs) => unknown): unknown
  mutation(resolver: (opts: ProcedureResolverArgs) => unknown): unknown
  subscription(resolver: (opts: ProcedureResolverArgs) => unknown): unknown
}

/** Args object tRPC hands a procedure resolver (input + ctx). */
export interface ProcedureResolverArgs {
  readonly input: unknown
  readonly ctx: unknown
}

/** The `t`-half of `buildCapRouters(t, services)`: tRPC primitives the server owns. */
export interface CapRouterPrimitives {
  /** `t.router` — assembles a `Record<methodName, procedure>` into a router. */
  readonly router: (procedures: Record<string, unknown>) => unknown
  /** Map of auth level → base procedure (`public`/`protected`/`admin`). */
  readonly procedures: Readonly<Record<'public' | 'protected' | 'admin', ProcedureBuilder>>
  /**
   * Wrap a push-based subscription into the async-generator tRPC v11
   * expects. Identical to the server's `iterableSubscription`.
   */
  readonly iterableSubscription: <T>(
    subscribe: (push: (value: T) => void) => () => void,
  ) => AsyncGenerator<T>
}

/** A method the runtime can call on a resolved provider object. */
type ProviderMethod = (input?: unknown, push?: (value: unknown) => void) => unknown
type ResolvedProvider = Readonly<Record<string, ProviderMethod>>

/**
 * Per-cap provider getter. `addonId` is only consulted for collection
 * caps (selects a specific provider within the local collection); the
 * server's `services`-backed resolution lives behind this closure so the
 * builder never touches the registry or backend services directly.
 */
export type CapProviderGetter = (ctx: unknown, addonId?: string) => ResolvedProvider | null

/** Cross-node proxy factory — Moleculer-bridged provider for a remote node. */
export type RemoteProxyFactory = (capName: string, nodeId: string) => ResolvedProvider | null

/**
 * Everything the builder needs from the server to resolve a cap's
 * provider object. The server supplies these closures; the builder owns
 * the procedure shape + routing decision.
 */
export interface CapRouterServices {
  /**
   * Resolve the LOCAL provider for a cap given the effective mount kind.
   * Returns null on miss (the procedure surfaces PRECONDITION_FAILED).
   * For `server-provided` caps this calls the server-supplied service
   * provider factory; for `singleton` / `device-native` / `collection`
   * it goes through the registry.
   */
  readonly getLocalProvider: (
    capName: string,
    mountKind: CapabilityMountKind,
    ctx: unknown,
    addonId?: string,
  ) => ResolvedProvider | null
  /** Cross-node Moleculer-bridged proxy. */
  readonly remoteProxy: RemoteProxyFactory
  /** Raise the canonical "no provider" tRPC error (server owns TRPCError). */
  readonly noProvider: (capName: string, nodeId?: string) => never
  /** Raise the canonical "node routing unavailable" tRPC error. */
  readonly noNodeRouting: (capName: string) => never
  /** Raise the canonical "bad request: missing field" error. */
  readonly badRequest: (message: string) => never
  /**
   * Raise the canonical UNAUTHORIZED error — used by `caller: 'required'`
   * methods when the context carries no authenticated user. OPTIONAL for
   * framework-live-update version skew (an older server may hand a
   * services object without it to a newer builder); the builder falls
   * back to `badRequest` in that case so the call still fails closed.
   */
  readonly unauthorized?: (message: string) => never
  /**
   * Called when an EXPLICIT top-level `{ addonId }` collection pin resolved to
   * no local provider, BEFORE the hub-proxy fallthrough. Implementations throw
   * (naming the id and enumerating the valid ones) when the cap has providers
   * registered and none of them matches; they return normally when the cap has
   * no local providers at all, which is the legitimate "the cap lives in a
   * forked hub worker" case the fallthrough exists for.
   *
   * Why: without this the pin was simply DROPPED. `getLocalProvider` returned
   * null for an unknown addonId, which reads identically to "not resident on
   * the hub root", so the call fell through to `remoteProxy(cap, 'hub')` and
   * the Moleculer prefix lookup answered from the FIRST hub-side provider.
   * `deviceExport.getStatus { addonId: 'questo-non-esiste-affatto' }` returned
   * Alexa's `linked / 3` — the caller could not tell it had been misrouted
   * (2026-08-09). OPTIONAL for framework-live-update version skew: an older
   * server hands a services object without it and the builder keeps the old
   * fallthrough rather than crashing.
   */
  readonly rejectUnresolvedAddonPin?: (capName: string, addonId: string) => void
  /**
   * When a collection cap call has no top-level `{ addonId }` pin (and nested
   * recovery did not apply), the server may infer the owning provider from the
   * method payload — e.g. `device-adoption` maps `integrationId` → addon via the
   * integrations store, or `camDeviceId` → addon via the device registry for
   * `resync`. Return `undefined` to keep the cap's default collection routing;
   * implementations that cannot infer MUST throw via {@link badRequest}.
   */
  readonly inferCollectionAddonPin?: (
    capName: string,
    methodName: string,
    methodInput: Record<string, unknown>,
  ) => string | undefined | Promise<string | undefined>
  /**
   * Raise the canonical error for a resolved provider that does NOT
   * implement `method` (Task 7.5d). Before this existed the router called
   * `provider[method.name]?.(payload)` — an optional call that let a missing
   * method answer `undefined`, which tRPC serializes as a 200. The UDS child
   * dispatcher (`child-cap-dispatch.ts`) hits the SAME condition (a provider
   * missing a method) and THROWS; two authorities disagreeing about the same
   * defect is worse than either alone, and the hub's silence is the one a
   * caller cannot detect. OPTIONAL for framework-live-update version skew: an
   * older server hands a services object without it; the builder falls back
   * to `badRequest` so the call still fails closed instead of answering 200.
   */
  readonly methodNotFound?: (capName: string, method: string) => never
}

/** A method-schema with the routing flags the builder reads. */
interface BuiltMethod {
  readonly name: string
  readonly kind: 'query' | 'mutation' | 'subscription'
  readonly auth: string
  readonly schema: CapabilityMethodSchema
  readonly isVoid: boolean
  readonly isObject: boolean
  /** D-1: `caller: 'required'` — inject the authenticated caller identity. */
  readonly callerRequired: boolean
  /**
   * Task 7.5d: true when this method's output is array-shaped — the same
   * predicate `resolveCollectionProvider`/`concatArrayMethod` use to decide
   * which collection methods get fanned across every provider. Combined with
   * the cap's `isCollection`, this is the ONE exception to "a missing
   * provider method fails loud": a collection cap's array method degrades to
   * `[]` instead of throwing, mirroring `child-cap-dispatch.ts`'s
   * `isCollectionListMethod` graceful skip.
   */
  readonly isArrayOutput: boolean
}

/**
 * The mount kind a `systemOnly` method resolves through — the cap's
 * SYSTEM/wrapper provider, keyed off the cap's `mode` (singleton or
 * collection), NEVER the per-device native.
 *
 * A `systemOnly` method (declared via the `systemMethod()` factory) belongs
 * to the cap's hub-resident system/wrapper provider — e.g. a device-scoped
 * (`device-native`) cap exposing a batch/metadata call that takes `deviceIds`
 * (an ARRAY) rather than a single `deviceId`. Routing it through the cap's
 * `device-native` mount would push it into `requireDeviceScoped`, whose
 * dispatcher demands a numeric `deviceId` on EVERY method call and rejects a
 * deviceId-less input with `input must carry numeric "deviceId"`. Resolving it
 * as the cap's mode-appropriate system provider instead keeps it reachable.
 */
function systemMountKindFor(def: CapabilityDefinition): CapabilityMountKind {
  return def.mode === 'collection' ? 'collection' : 'singleton'
}

/**
 * The mount kind ONE method resolves through — the cap's mount, except where
 * the method cannot be dispatched per device.
 *
 * Two ways a method leaves a per-device mount for the cap's SYSTEM provider:
 *
 *  - `systemOnly: true` — declared via the `systemMethod()` factory. The
 *    author said so; it wins everywhere, including on a `device-native` cap
 *    (`snapshot.getSnapshotOverview`).
 *  - a `device-scoped` cap's method whose input declares no top-level REQUIRED
 *    numeric `deviceId`. The per-device dispatcher demands one on every call
 *    (`requireDeviceScoped`), so such a method would answer BAD_REQUEST
 *    "input must carry numeric deviceId" for every caller — unreachable. It
 *    names no device, so there is no per-device provider to resolve: the cap's
 *    hub-resident system/wrapper provider is the only honest destination, and
 *    it is where that method already resolved before the mount was fixed.
 *
 * NOT applied to `device-native`, deliberately: there the native IS the device
 * and a deviceId-less method is a definition error the author must resolve
 * with `systemMethod()` — which is what `snapshot` does. This rule exists for
 * the mount kind that was DERIVED under caps that never opted in, where a
 * silent 400 would be a regression introduced by the derivation itself.
 */
function methodMountKindFor(
  def: CapabilityDefinition,
  mountKind: CapabilityMountKind,
  method: BuiltMethod,
): CapabilityMountKind {
  if (method.schema.systemOnly === true) return systemMountKindFor(def)
  if (mountKind !== 'device-scoped') return mountKind
  if (objectInputDeclaresRequiredDeviceId(method.schema.input)) return mountKind
  return systemMountKindFor(def)
}

function methodsFor(def: CapabilityDefinition): readonly BuiltMethod[] {
  const effective = expandCapMethods(def)
  return Object.entries(effective).map(([name, schema]) => {
    const m = schema as CapabilityMethodSchema
    return {
      name,
      kind: m.kind ?? 'query',
      // Task 7.5c floor: an `internal: true` cap's un-annotated method
      // resolves to `'admin'`, not `'protected'` — see `resolveMethodAuth`.
      auth: resolveMethodAuth(def, m),
      schema: m,
      isVoid: isVoidInput(m.input),
      isObject: isObjectInput(m.input),
      callerRequired: m.caller === 'required',
      isArrayOutput: m.kind !== 'subscription' && isArrayOutputSchema(m.output),
    }
  })
}

/**
 * Invoke `method.name` on a resolved provider, raising the canonical
 * "method not found" error (Task 7.5d) when the provider does not implement
 * it — the naive `provider[method.name]?.(payload)` optional call let a
 * missing method answer `undefined` (200 to the caller). EXCEPTION, mirrored
 * from `child-cap-dispatch.ts`'s `isCollectionListMethod` graceful skip: a
 * COLLECTION cap's array-output method degrades to `[]` — the hub fans that
 * method across every registered provider
 * (`resolveCollectionProvider`/`concatArrayMethod`), so ONE provider not
 * implementing it is a graceful skip, not an error. Every other missing
 * method (singleton, device-native, or a collection's SCALAR method) is a
 * real implementation gap and fails loud.
 */
function invokeCapMethod(
  provider: ResolvedProvider,
  method: BuiltMethod,
  payload: unknown,
  capName: string,
  isCollection: boolean,
  services: CapRouterServices,
): unknown {
  const fn = provider[method.name]
  if (typeof fn === 'function') return fn(payload)
  if (isCollection && method.isArrayOutput) return []
  const raise =
    services.methodNotFound ??
    ((cap: string, m: string): never =>
      services.badRequest(`Capability "${cap}" has no method "${m}"`))
  return raise(capName, method.name)
}

// ── Caller-identity injection (D-1, notification-center P0) ─────────────
//
// A method declared with `caller: 'required'` receives a server-derived
// `caller: { userId, isAdmin }` on its input object. The identity comes
// EXCLUSIVELY from the authenticated tRPC session (`ctx.user`) — the hub
// router is the only layer that holds the session, so injection happens
// here; the enriched input then travels the normal link chain
// (in-process / UDS / Moleculer) unchanged (cap dispatch is structural —
// no leg re-validates the input against the wire schema). Any
// client-supplied `caller` key is DISCARDED by the overwrite below, so
// the value is spoof-proof by construction.

/**
 * Extract the authenticated caller identity from the (structurally
 * unknown) tRPC context. The builder cannot import the server's
 * `TrpcContext`, so the read is narrowing-based: `ctx.user.id` (string)
 * + `ctx.user.isAdmin` (boolean) — the stable `AuthenticatedUser` core
 * every context factory produces. Returns null when no authenticated
 * user is present (the caller then fails the call — a fabricated
 * identity is never injected).
 */
function extractCallerIdentity(ctx: unknown): CapCaller | null {
  if (ctx === null || typeof ctx !== 'object' || !('user' in ctx)) return null
  const user: unknown = ctx.user
  if (user === null || typeof user !== 'object') return null
  if (!('id' in user) || !('isAdmin' in user)) return null
  const id: unknown = user.id
  const isAdmin: unknown = user.isAdmin
  if (typeof id !== 'string' || id.length === 0 || typeof isAdmin !== 'boolean') return null
  return { userId: id, isAdmin }
}

/**
 * Return a NEW input object carrying the server-derived `caller`. The
 * spread-then-set ordering guarantees any client-supplied `caller` key
 * (which survives the `.loose()` wire parse) is overwritten. Raises
 * UNAUTHORIZED (or `badRequest` on a skewed services object without the
 * `unauthorized` raiser) when the context has no authenticated user.
 */
function injectCaller(
  rest: Record<string, unknown>,
  ctx: unknown,
  capName: string,
  methodName: string,
  services: CapRouterServices,
): Record<string, unknown> {
  const caller = extractCallerIdentity(ctx)
  if (caller === null) {
    const raise = services.unauthorized ?? services.badRequest
    return raise(`Capability "${capName}.${methodName}" requires an authenticated caller`)
  }
  return { ...rest, caller }
}

/** Strip a set of selector keys from an input object, returning a NEW object. */
function stripKeys(
  input: unknown,
  keys: readonly string[],
): { rest: Record<string, unknown>; picked: Record<string, unknown> } {
  const src = (input ?? {}) as Record<string, unknown>
  const rest: Record<string, unknown> = {}
  const picked: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(src)) {
    if (keys.includes(k)) picked[k] = v
    else rest[k] = v
  }
  return { rest, picked }
}

/**
 * Resolve the provider object for a NON-void/object method call, applying
 * the same local-first → remote-proxy routing the codegen's
 * `resolveProvider` does. `nodeId` undefined / `'hub'` resolves the local
 * provider; otherwise it crosses to the named node via the proxy.
 *
 * `pinnedAddonId` is the EXPLICIT top-level `{ addonId }` collection selector
 * (never the one recovered from a nested mutation payload). When it is set and
 * the local lookup misses, {@link CapRouterServices.rejectUnresolvedAddonPin}
 * gets to refuse before the hub-proxy fallthrough turns a wrong id into
 * another provider's answer.
 */
function resolveProviderForCall(
  capName: string,
  nodeId: string | undefined,
  getLocal: () => ResolvedProvider | null,
  services: CapRouterServices,
  pinnedAddonId?: string,
): ResolvedProvider {
  if (!nodeId || nodeId === 'hub') {
    const local = getLocal()
    if (local !== null && local !== undefined) return local
    if (pinnedAddonId !== undefined) {
      services.rejectUnresolvedAddonPin?.(capName, pinnedAddonId)
    }
    const proxy = services.remoteProxy(capName, 'hub')
    if (proxy) return proxy
    return services.noProvider(capName)
  }
  const proxy = services.remoteProxy(capName, nodeId)
  if (!proxy) return services.noProvider(capName, nodeId)
  return proxy
}

/** Require a local provider (singleton-style, no node routing) or raise. */
function requireLocal(
  capName: string,
  getLocal: () => ResolvedProvider | null,
  services: CapRouterServices,
): ResolvedProvider {
  const p = getLocal()
  if (p === null || p === undefined) return services.noProvider(capName)
  return p
}

/**
 * Build a single capability's router (the runtime equivalent of one
 * codegen'd `createCapRouter_<Cap>`). Each method becomes a typed
 * procedure with the SAME routing branch the codegen emits.
 *
 * Exported for the caller-injection spec (which drives it with synthetic
 * cap defs) — production callers go through {@link buildCapRouters}.
 */
export function buildOneCapRouter(
  def: CapabilityDefinition,
  primitives: CapRouterPrimitives,
  services: CapRouterServices,
): unknown {
  const capName = def.name
  const mount = resolveCapMount(def)
  const nodeIdData = def.nodeIdMode === 'data'
  const procedures: Record<string, unknown> = {}

  for (const method of methodsFor(def)) {
    // D-1 build-time guard: caller injection needs an OBJECT input to live
    // on and a query/mutation procedure. Any other shape is a definition
    // error — fail the router build (caught by CI/tests immediately)
    // instead of silently skipping injection at call time.
    if (method.callerRequired && (method.kind === 'subscription' || !method.isObject)) {
      throw new Error(
        `Cap "${capName}" method "${method.name}": caller: 'required' is only ` +
          `supported on query/mutation methods with an object input schema`,
      )
    }
    // A method that cannot be dispatched per device resolves through the
    // cap's hub-resident SYSTEM/wrapper provider — `systemOnly` says so
    // explicitly, and a `device-scoped` cap's deviceId-less method says so
    // structurally. See {@link methodMountKindFor}.
    const effectiveMountKind = methodMountKindFor(def, mount.kind, method)
    const isCollection = effectiveMountKind === 'collection'
    const getLocal = (ctx: unknown, addonId?: string): ResolvedProvider | null =>
      services.getLocalProvider(capName, effectiveMountKind, ctx, addonId)

    const base = primitives.procedures[procedureAuthKey(method.auth)]
    const inputSchema = method.schema.input as z.ZodType

    if (method.kind === 'subscription') {
      // Subscriptions never node-route (they need a persistent connection),
      // mirroring the codegen's subscription branch.
      procedures[method.name] = base.input(inputSchema).subscription(({ input, ctx }) => {
        const provider = requireLocal(capName, () => getLocal(ctx), services)
        return primitives.iterableSubscription<unknown>((push) => {
          const fn = provider[method.name]
          const unsub = fn?.(input, push)
          return typeof unsub === 'function' ? (unsub as () => void) : () => {}
        })
      })
      continue
    }

    const procKind: 'query' | 'mutation' = method.kind === 'mutation' ? 'mutation' : 'query'

    if (method.isVoid) {
      // Void input → REPLACE the cap's `z.void()` with a `{ nodeId?,
      // addonId? }` optional selector object (the codegen does the same so
      // the router can carry out-of-band routing keys). `nodeIdMode:'data'`
      // and void methods carry no routing payload → resolve local directly.
      const voidSelector = isCollection
        ? z.object({ nodeId: z.string().optional(), addonId: z.string().optional() }).optional()
        : z.object({ nodeId: z.string().optional() }).optional()
      procedures[method.name] = base.input(voidSelector)[procKind](({ input, ctx }) => {
        const sel = (input ?? {}) as { nodeId?: string; addonId?: string }
        const provider = nodeIdData
          ? requireLocal(
              capName,
              () => getLocal(ctx, isCollection ? sel.addonId : undefined),
              services,
            )
          : resolveProviderForCall(
              capName,
              sel.nodeId,
              () => getLocal(ctx, isCollection ? sel.addonId : undefined),
              services,
              isCollection ? sel.addonId : undefined,
            )
        return invokeCapMethod(provider, method, undefined, capName, isCollection, services)
      })
      continue
    }

    if (method.isObject) {
      const stampedCap = CALLER_STAMPED_CAPABILITIES.includes(capName)
      const schema = nodeIdData ? inputSchema : looseSchema(inputSchema)
      procedures[method.name] = base.input(schema)[procKind](({ input: wireInput, ctx }) => {
        // HTTP/WS mounts: strip a session-supplied stamp (spoof). Mesh / $core-caps have no `req`.
        const hasHttpReq =
          typeof ctx === 'object' &&
          ctx !== null &&
          'req' in ctx &&
          (ctx as { req?: unknown }).req !== undefined
        const input = stampedCap && hasHttpReq ? withoutCallerStamp(wireInput) : wireInput
        if (nodeIdData) {
          // Provider dispatches `nodeId` internally — forward intact.
          // (`stripKeys(input, [])` is a plain shallow copy so the D-1
          // caller injection never mutates the parsed input.)
          const provider = requireLocal(capName, () => getLocal(ctx), services)
          const payload = method.callerRequired
            ? injectCaller(stripKeys(input, []).rest, ctx, capName, method.name, services)
            : input
          return invokeCapMethod(provider, method, payload, capName, isCollection, services)
        }
        if (isCollection) {
          const { rest, picked } = stripKeys(input, ['nodeId', 'addonId'])
          const nodeId = typeof picked.nodeId === 'string' ? picked.nodeId : undefined
          const topLevelAddonId = typeof picked.addonId === 'string' ? picked.addonId : undefined
          // Route a single-object (non-array) collection method to its OWNING
          // provider. Prefer the explicit top-level `{ addonId }` selector; when
          // it is absent, recover the routing addonId the mutation payload
          // already carries (e.g. `upsertTarget({ target: { addonId } })`)
          // instead of blindly hitting the first-registered provider — which
          // misroutes across providers (a HA target upserted into the notifiers
          // store) or hard-crashes on a partial provider. ARRAY methods are
          // never rerouted: their contract is a fan-out UNION across every
          // provider (`concatArrayMethod`), so their addonId stays undefined.
          // Nor is a method whose input DECLARES a top-level `addonId` selector
          // (`llm.generate`): it routes via that field, so an incidental nested
          // `addonId` (e.g. inside a free-form `jsonSchema`) must not hijack it.
          const canRecoverNestedAddonId =
            !isArrayOutputSchema(method.schema.output) &&
            !objectInputDeclaresAddonId(method.schema.input)
          let addonId =
            topLevelAddonId ?? (canRecoverNestedAddonId ? extractNestedAddonId(rest) : undefined)
          // Explicit top-level `{ addonId }` is always refusable. Nested
          // `extractNestedAddonId` recovery is NOT (domain payload heuristic —
          // keep first-provider if that nested id is not a provider). Cap-owned
          // `inferCollectionAddonPin` (device-adoption via integrationId /
          // camDeviceId) IS refusable: an inferred owner that is not registered
          // must 400, never fall through to another provider (D886).
          const resolveAndInvoke = async (): Promise<unknown> => {
            let refusePin = topLevelAddonId
            if (
              addonId === undefined &&
              !method.isArrayOutput &&
              services.inferCollectionAddonPin
            ) {
              addonId = await Promise.resolve(
                services.inferCollectionAddonPin(capName, method.name, rest),
              )
              if (addonId !== undefined) refusePin = addonId
            }
            const provider = resolveProviderForCall(
              capName,
              nodeId,
              () => getLocal(ctx, addonId),
              services,
              refusePin,
            )
            const payload = method.callerRequired
              ? injectCaller(rest, ctx, capName, method.name, services)
              : rest
            return invokeCapMethod(provider, method, payload, capName, isCollection, services)
          }
          return resolveAndInvoke()
        }
        const { rest, picked } = stripKeys(input, ['nodeId'])
        const nodeId = typeof picked.nodeId === 'string' ? picked.nodeId : undefined
        const provider = resolveProviderForCall(capName, nodeId, () => getLocal(ctx), services)
        const payload = method.callerRequired
          ? injectCaller(rest, ctx, capName, method.name, services)
          : rest
        return invokeCapMethod(provider, method, payload, capName, isCollection, services)
      })
      continue
    }

    // Non-object, non-void input (z.record / z.string / z.array): no nodeId
    // injection, always local — mirrors the codegen's final branch.
    procedures[method.name] = base.input(inputSchema)[procKind](({ input, ctx }) => {
      const provider = requireLocal(capName, () => getLocal(ctx), services)
      return invokeCapMethod(provider, method, input, capName, isCollection, services)
    })
  }

  return primitives.router(procedures)
}

/**
 * Mount kinds the runtime builder constructs. Everything EXCEPT `skip` is
 * built. `server-provided` IS built (the server supplies the provider via
 * `getLocalProvider`'s server-factory map); `skip` is never mounted (legacy
 * provider shapes). `hub-only` is built but its remote leg is `null` — handled
 * by the server's `remoteProxy` returning null for that cap.
 */
function isBuilderMounted(kind: CapabilityMountKind): boolean {
  return kind !== 'skip'
}

/**
 * Build the runtime cap-router map: `{ <camelCapName>: <router> }` for
 * every capability the builder owns. Caps with `mount.kind` `custom` /
 * `skip` are omitted (the server overrides / never mounts them). The
 * server spreads this BEFORE its hand-written overrides + core routers so
 * override-by-spread precedence is preserved.
 */
export function buildCapRouters(
  primitives: CapRouterPrimitives,
  services: CapRouterServices,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const def of ALL_CAPABILITY_DEFINITIONS) {
    const mount = resolveCapMount(def)
    if (!isBuilderMounted(mount.kind)) continue
    const effective = expandCapMethods(def)
    if (Object.keys(effective).length === 0) continue
    out[kebabToCamel(def.name)] = buildOneCapRouter(def, primitives, services)
  }
  return out
}

/** The set of cap camelNames the builder owns (for drift checks / tests). */
export function builderMountedCapNames(): readonly string[] {
  const names: string[] = []
  for (const def of ALL_CAPABILITY_DEFINITIONS) {
    const mount = resolveCapMount(def)
    if (!isBuilderMounted(mount.kind)) continue
    if (Object.keys(expandCapMethods(def)).length === 0) continue
    names.push(kebabToCamel(def.name))
  }
  return names
}
