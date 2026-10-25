/**
 * Server-side glue for the runtime cap-router builder (BIG PLAN 2).
 *
 * `@camstack/system` `buildCapRouters(primitives, services)` owns the
 * per-cap router CONSTRUCTION (procedure shapes + node routing), but it
 * holds no tRPC primitives and no backend services. This module supplies
 * both:
 *
 *   - `primitives` — the `t`-half: `trpcRouter`, the auth procedures, and
 *     `iterableSubscription`, taken from `trpc.middleware`.
 *   - `services`   — the provider-resolution half: `getLocalProvider`
 *     (mirrors the codegen `generate-cap-mounts.ts` decision per mount
 *     kind), the cross-node `remoteProxy`, and the canonical tRPC error
 *     raisers (the server owns `TRPCError`).
 *
 * The result is spread into the AppRouter alongside the hand-written core
 * (non-cap) routers. Every cap is built here from the live def; the server
 * supplies `server-provided` provider factories (incl. webrtc-session) via the
 * `serverProviders` map — no hand-written cap-router override remains.
 */

import {
  ALL_CAPABILITY_DEFINITIONS,
  buildCapRouters,
  type CapabilityRegistry,
  type CapRouterPrimitives,
  type CapRouterServices,
  isArrayOutputSchema,
  type ProcedureBuilder,
} from '@camstack/system'
import {
  type CapabilityDefinition,
  type CapabilityMethodSchema,
  type CapabilityMountKind,
  type IScopedLogger,
  PROVIDER_PIN_FIELD,
  resolveCapMount,
} from '@camstack/types'
import { TRPCError } from '@trpc/server'
import { requireDeviceScoped } from './cap-mount-helpers.js'
import { requireDeviceCollection } from './device-collection-dispatch.js'
import {
  adminProcedure,
  iterableSubscription,
  protectedProcedure,
  publicProcedure,
  trpcRouter,
} from './trpc.middleware.js'

/** A resolved provider as the builder sees it — structural method bag. */
type ResolvedProvider = Readonly<Record<string, (input?: unknown) => unknown>>

/**
 * Per-request provider factory for a `server-provided` cap. The provider is
 * composed from backend services (not the registry); the server owns the
 * factory and passes the map in so `@camstack/system` never touches a
 * backend service (self-sufficiency invariant). `ctx` is forwarded so
 * caps like `toast` / `addons` can read the request context.
 */
export type ServerProviderFactory = (ctx: unknown) => ResolvedProvider | null

/**
 * Pre-computed set of capName → array-output method names for collection
 * caps, derived once from the cap defs at module init. Mirrors
 * `generate-cap-mounts.ts` `isArrayOutputSchema` so the runtime collection
 * resolver fans the SAME methods the codegen used to.
 */
export const COLLECTION_ARRAY_METHODS: ReadonlyMap<string, readonly string[]> =
  computeArrayMethods()

function computeArrayMethods(): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, readonly string[]>()
  for (const def of ALL_CAPABILITY_DEFINITIONS) {
    // The effective MOUNT, never `mode`: a device-scoped wrapper collection
    // (`videoclips`, D554) fans over ONE DEVICE's sources through the
    // per-device dispatcher, and must never be fanned globally here.
    if (resolveCapMount(def).kind !== 'collection') continue
    const names: string[] = []
    for (const [name, schema] of Object.entries(def.methods)) {
      const m = schema as CapabilityMethodSchema
      if (m.kind === 'subscription') continue
      if (isArrayOutputSchema(m.output)) names.push(name)
    }
    if (names.length > 0) out.set(def.name, names)
  }
  return out
}

/**
 * Is this cap served by the GLOBAL collection mount — every registered
 * provider, for every caller?
 *
 * `mode: 'collection'` alone does not answer it any more: a device-scoped
 * wrapper collection keeps the per-device mount (D554,
 * `device-collection-dispatch.ts`), and fanning it globally here would answer
 * one camera with another camera's sources on the `ctx.api` path while the
 * tRPC path resolved per device — two authorities disagreeing about the same
 * call, which is exactly what {@link aggregateCollectionCall} exists to
 * prevent.
 */
function isGlobalCollection(reg: CapabilityRegistry, capName: string): boolean {
  const def = reg.getDefinition(capName)
  return def !== undefined && resolveCapMount(def).kind === 'collection'
}

/**
 * Resolve a collection cap's provider exactly as the codegen-emitted
 * mount did:
 *   - `addonId` set → that addon's provider directly (bypasses the
 *     enabled/disabled filter — an explicit addonId must always hit that
 *     exact provider).
 *   - else, for caps with array-output methods → an AGGREGATE provider
 *     whose array methods are `concatCollection`-fanned across every
 *     ENABLED provider; non-array methods fall through to the first.
 *   - else → the first enabled provider.
 */
function resolveCollectionProvider(
  reg: CapabilityRegistry | null,
  capName: string,
  addonId: string | undefined,
): ResolvedProvider | null {
  if (!reg) return null
  if (addonId !== undefined) {
    return reg.getProviderByAddonId<ResolvedProvider>(capName, addonId)
  }
  const entries = reg.getCollectionEntries<ResolvedProvider>(capName)
  if (entries.length === 0) return null
  const providers = entries.map(([, p]) => p)
  const first = providers[0]
  if (first === undefined) return null
  const arrayMethods = COLLECTION_ARRAY_METHODS.get(capName)
  if (!arrayMethods || arrayMethods.length === 0) return first
  const aggregate: Record<string, (input?: unknown) => unknown> = { ...first }
  for (const method of arrayMethods) {
    aggregate[method] = concatArrayMethod(providers, method)
  }
  return aggregate
}

/**
 * The collection UNION for a cap call arriving OUTSIDE the tRPC router — a
 * forked addon's `ctx.api.<cap>.<method>` reaching the parent's
 * `onUnownedCall`. Returns `null` when `(capName, method)` is not an
 * aggregated collection array-method, so the caller routes normally.
 *
 * Exists because routing resolves ONE provider while this router fans array
 * methods across ALL of them: the two answers disagreed, and for
 * `notification-output` the routed one was empty — which the Notification
 * Center read as "target deleted" and turned into permanent dead-letters for
 * every notification it ever produced (2026-07-30). Sharing
 * {@link resolveCollectionProvider} keeps the two paths from drifting again.
 *
 * `null` on zero providers too: that is the empty-collection fast-path's job
 * (it answers `[]` without routing), not this one's.
 */
export async function aggregateCollectionCall(
  reg: CapabilityRegistry | null,
  capName: string,
  method: string,
  args: unknown,
): Promise<readonly unknown[] | null> {
  if (!reg) return null
  if (!isGlobalCollection(reg, capName)) return null
  if (!COLLECTION_ARRAY_METHODS.get(capName)?.includes(method)) return null
  if (reg.getCollectionEntries(capName).length === 0) return null
  const aggregate = resolveCollectionProvider(reg, capName, undefined)
  const fn = aggregate?.[method]
  if (typeof fn !== 'function') return null
  const out: unknown = await fn(args)
  return Array.isArray(out) ? out : null
}

/**
 * A DEVICE collection cap — several providers PER DEVICE, mounted per device.
 *
 * `videoclips` is the one: `resolveCapMount` checks `scope: 'device' + kind:
 * 'wrapper'` BEFORE `mode: 'collection'` and answers `device-scoped`, so
 * {@link isGlobalCollection} is false for it and the `{ addonId }` pin above
 * does not apply. Its pin is `provider`, read by
 * `device-collection-dispatch.ts` on the tRPC path.
 */
function isDeviceCollection(reg: CapabilityRegistry, capName: string): boolean {
  const def = reg.getDefinition(capName)
  if (def === undefined) return false
  return def.mode === 'collection' && resolveCapMount(def).kind === 'device-scoped'
}

/**
 * The `{ provider }` a DEVICE-collection call pins to, or `null`.
 *
 * The device twin of {@link addonPinOf}, and it exists because the same defect
 * was found a THIRD time. `videoclips` has three providers on the operator's
 * hub; the clip byte read named `provider-reolink` every time and was answered
 * by the recorder, then — after a redeploy in a different order — by
 * export-hap ("was not minted by the HomeKit source"), which is what a
 * first-wins resolution looks like from outside.
 *
 * Two earlier fixes were each correct and each missed this path:
 *   - D592 fixed the tRPC MOUNT, which a forked addon never reaches.
 *   - D593 fixed the Moleculer transport link — but a hub-local runner is a
 *     broker-less UDS child whose link chain is `[localProviderLink,
 *     ipcParentLink]` with no `brokerTransportLink` at all
 *     (`addon-context-factory.ts`), so it never ran there either.
 *
 * The call lands on the parent's `onUnownedCall`, where routing discards the
 * selector by construction — `resolveCapRoute` takes only `nodeId`/`deviceId`
 * — and `cap-child-index.ts` answers "first child wins".
 *
 * Unlike the global pin this DOES apply to array methods: naming the provider
 * is required on `listClips` too (D554), and the narrowing happens inside
 * `requireDeviceCollection`, which then decides fan-out vs scalar itself.
 */
export function devicePinOf(
  reg: CapabilityRegistry | null,
  capName: string,
  args: unknown,
): string | null {
  if (!reg) return null
  if (!isDeviceCollection(reg, capName)) return null
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null
  const rec = args as Record<string, unknown>
  if (typeof rec['deviceId'] !== 'number') return null
  const pin = rec[PROVIDER_PIN_FIELD]
  return typeof pin === 'string' && pin.length > 0 ? pin : null
}

/**
 * Run a pinned DEVICE-collection call through the SAME dispatcher the tRPC
 * mount uses, so the two paths cannot answer differently.
 *
 * Nothing is re-implemented here on purpose: `requireDeviceCollection` already
 * narrows to the pinned provider, refuses a pin the device is not bound to BY
 * NAME (D552's rule), and picks fan-out or scalar afterwards. Re-deriving any
 * of that here would be the fourth authority on one question.
 *
 * Boxed like {@link pinnedCollectionCall}: a device-collection method may
 * legitimately answer `null`, which a bare return could not tell from "not
 * handled".
 */
export async function pinnedDeviceCollectionCall(
  reg: CapabilityRegistry | null,
  capName: string,
  method: string,
  args: unknown,
): Promise<{ readonly value: unknown } | null> {
  if (devicePinOf(reg, capName, args) === null) return null
  const dispatcher = requireDeviceCollection(reg, capName)
  if (dispatcher === null) return null
  const fn = (dispatcher as Record<string, unknown>)[method]
  if (typeof fn !== 'function') return null
  const call = fn as (input: unknown) => Promise<unknown>
  return { value: await call(args) }
}

/**
 * The `{ addonId }` a call PINS to, or `null` when the call is not an
 * addon-pinned collection call and must route normally.
 *
 * ONE definition, because there are two places that must agree about it and
 * they are in different packages. `LocalChildRegistry` decides whether to
 * short-circuit a child's egress to a local sibling — and that decision happens
 * BEFORE `onUnownedCall` runs, so a pin honoured only there is honoured never.
 * That is precisely how the first attempt at this fix failed on the live hub:
 * the handler was correct and unreachable, and the probe that proved it was a
 * DELIBERATELY BOGUS addonId — refused if the selector routes, answered `null`
 * if it is discarded. It came back `null`.
 *
 * Not an array method (that contract is the union) and not a non-collection cap
 * (there `addonId` is provider DATA: `addons.getLogs({addonId})` names the addon
 * whose logs you want, it does not name a provider).
 */
export function addonPinOf(
  reg: CapabilityRegistry | null,
  capName: string,
  method: string,
  args: unknown,
): string | null {
  if (!reg) return null
  if (!isGlobalCollection(reg, capName)) return null
  if (COLLECTION_ARRAY_METHODS.get(capName)?.includes(method) === true) return null
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null
  const addonId = (args as Record<string, unknown>)['addonId']
  return typeof addonId === 'string' && addonId.length > 0 ? addonId : null
}

/**
 * The `{ addonId }` PIN for a cap call arriving OUTSIDE the tRPC router — a
 * forked addon's `ctx.api.<cap>.<method>` reaching the parent's
 * `onUnownedCall`. The scalar twin of {@link aggregateCollectionCall}, and it
 * exists for the same reason: the two paths answered differently and only the
 * tRPC one was ever measured.
 *
 * `addonId` is not provider data on a system-scoped collection cap — the
 * codegen INJECTS it as the `{nodeId?, addonId?}` selector on every method
 * (`GetInputSchema` for `broker.getBrokerConfig` declares only `{ id }`), and
 * `cap-router-builder.ts` routes the tRPC call by it. The child→parent path
 * lifted only `nodeId` and `deviceId` out of a child's args, so the selector
 * was DISCARDED IN SILENCE and the call landed on whichever provider registered
 * first. Measured on the live hub 2026-08-09:
 *
 *     hub,   getBrokerConfig {id:'ha_001'}                       → null
 *     hub,   getBrokerConfig {id:'ha_001', addonId:'provider-…'} → the config
 *     addon, getBrokerConfig {id:'ha_001', addonId:'provider-…'} → null
 *
 * The third row is the bug: from an addon the pinned call returned exactly the
 * UNPINNED answer — Homematic's `null` for a broker it does not own, which the
 * Home Assistant export could not tell from "no such broker". It could not open
 * a link, ever, and every write-up of the pin had measured only the first two
 * rows.
 *
 * Mirrors the tRPC branch exactly, including what it does NOT do:
 *   - ARRAY methods are never rerouted — their contract is the fan-out union
 *     ({@link aggregateCollectionCall}), and a pin that turns a provider's
 *     absence into a throw is what took `broker.list` from "fewer rows" to
 *     `BAD_REQUEST` and the operator from "one instance" to "no instance".
 *   - Only the EXPLICIT top-level selector routes. No nested recovery here:
 *     that heuristic reads a domain payload, and this path has no schema.
 *
 * A pin naming a non-provider REFUSES with the valid ids spelled out rather
 * than degrading to another provider's answer — the whole point of pinning.
 *
 * Returns a `{ value }` box, never the bare result: `getBrokerConfig` answers
 * `null` legitimately, so a bare `null` could not be told from "not handled".
 */
export async function pinnedCollectionCall(
  reg: CapabilityRegistry | null,
  capName: string,
  method: string,
  args: unknown,
): Promise<{ readonly value: unknown } | null> {
  const addonId = addonPinOf(reg, capName, method, args)
  if (addonId === null) return null

  const provider = reg?.getProviderByAddonId<ResolvedProvider>(capName, addonId) ?? null
  if (provider === null) {
    const valid = reg?.getProviderAddonIds(capName) ?? []
    throw new Error(
      `Capability "${capName}" has no provider with addonId "${addonId}". ` +
        `Registered: ${valid.length > 0 ? valid.join(', ') : '(none)'}`,
    )
  }
  const fn = provider[method]
  // Args pass through unchanged, exactly as the `nodeId` pin on this path
  // already does: a provider destructures the fields it needs and ignores the
  // selector. Stripping it here would diverge from that for no gain.
  return { value: typeof fn === 'function' ? await fn(args) : undefined }
}

/**
 * Fan an array-returning method across every provider and flatten the
 * results — the runtime equivalent of `concatCollection` for the
 * structural `ResolvedProvider` shape (which a string method key can't
 * satisfy `concatCollection`'s `ArrayReturningMethodKey<T>` constraint).
 * Behaviour matches `concatCollection`: non-function / non-array results
 * contribute nothing.
 */
function concatArrayMethod(
  providers: readonly ResolvedProvider[],
  method: string,
): (input?: unknown) => Promise<readonly unknown[]> {
  return async (input?: unknown): Promise<readonly unknown[]> => {
    const results = await Promise.all(
      providers.map(async (p): Promise<readonly unknown[]> => {
        const fn = p[method]
        if (typeof fn !== 'function') return []
        const out: unknown = await fn(input)
        return Array.isArray(out) ? (out as readonly unknown[]) : []
      }),
    )
    return results.flat()
  }
}

/** Build the `primitives` half of `buildCapRouters(primitives, services)`. */
export function createCapRouterPrimitives(): CapRouterPrimitives {
  const procedures: Readonly<Record<'public' | 'protected' | 'admin', ProcedureBuilder>> = {
    public: publicProcedure as ProcedureBuilder,
    protected: protectedProcedure as ProcedureBuilder,
    admin: adminProcedure as ProcedureBuilder,
  }
  return {
    // Documented type boundary: the builder hands a record of REAL tRPC
    // procedures typed structurally as `unknown` (it can't see the
    // server's procedure types). `trpcRouter` (`t.router`) expects
    // `CreateRouterOptions`; the runtime values satisfy it. Narrow at this
    // single seam so the rest of the builder stays free of `@trpc/server`
    // internal types — mirrors the existing `remoteCapProxy` cast pattern.
    router: (procs) => trpcRouter(procs as Parameters<typeof trpcRouter>[0]),
    procedures,
    iterableSubscription,
  }
}

/**
 * The ONLY `MoleculerService` surface the cap-router runtime consumes.
 * Structural on purpose: `MoleculerService` satisfies it, and a spec can drive
 * the real resolution logic without standing up a broker.
 */
export interface CapProxyProvider {
  createCapabilityProxy(
    capabilityName: string,
    nodeId: string,
  ): Record<string, (params: unknown) => Promise<unknown>> | null
}

/** Inputs the server provides to resolve every mount kind. */
export interface CapRouterRuntimeDeps {
  readonly capabilityRegistry: CapabilityRegistry | null
  readonly moleculer: CapProxyProvider
  /** capName → per-request provider factory for `server-provided` caps. */
  readonly serverProviders: Readonly<Record<string, ServerProviderFactory>>
  /** Used to log a refused `{ addonId }` pin — a dropped call is never silent. */
  readonly logger?: IScopedLogger
  /** Map an integrations row id → owning addon id (hub integrations store). */
  readonly resolveIntegrationAddonId?: (
    integrationId: string,
  ) => Promise<string | null> | string | null
  /** Map a CamStack device id → owning addon id (hub device registry). */
  readonly resolveDeviceAddonId?: (camDeviceId: number) => Promise<string | null> | string | null
}

/**
 * `device-adoption` is collection-scoped: without an explicit `{ addonId }`
 * pin the router must NOT fall through to the first registered provider.
 * Resolve the owning addon from `integrationId` (most methods) or
 * `camDeviceId` (`resync` only).
 */
async function inferDeviceAdoptionCollectionAddonPin(
  methodName: string,
  input: Record<string, unknown>,
  deps: CapRouterRuntimeDeps,
): Promise<string> {
  const integrationId =
    typeof input.integrationId === 'string' && input.integrationId.length > 0
      ? input.integrationId
      : undefined
  const camDeviceId =
    typeof input.camDeviceId === 'number' && Number.isInteger(input.camDeviceId)
      ? input.camDeviceId
      : undefined

  if (methodName === 'resync' || (camDeviceId !== undefined && integrationId === undefined)) {
    if (camDeviceId === undefined) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          'deviceAdoption.resync requires camDeviceId (owning addon is resolved from it) or an explicit addonId pin.',
      })
    }
    const resolved = deps.resolveDeviceAddonId
      ? await Promise.resolve(deps.resolveDeviceAddonId(camDeviceId))
      : null
    if (resolved === null || resolved === '') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `deviceAdoption.${methodName}: device ${camDeviceId} not found — pass addonId explicitly.`,
      })
    }
    return resolved
  }

  if (integrationId !== undefined) {
    const resolved = deps.resolveIntegrationAddonId
      ? await Promise.resolve(deps.resolveIntegrationAddonId(integrationId))
      : null
    if (resolved === null || resolved === '') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `deviceAdoption.${methodName}: unknown integrationId "${integrationId}" — pass addonId explicitly.`,
      })
    }
    return resolved
  }

  throw new TRPCError({
    code: 'BAD_REQUEST',
    message: `deviceAdoption.${methodName} requires addonId (top-level pin) or integrationId to resolve the owning provider.`,
  })
}

/** Build the `services` half of `buildCapRouters(primitives, services)`. */
export function createCapRouterServices(deps: CapRouterRuntimeDeps): CapRouterServices {
  const reg = deps.capabilityRegistry
  const remoteProxy: CapRouterServices['remoteProxy'] = (capName, nodeId) =>
    deps.moleculer.createCapabilityProxy(capName, nodeId) as ResolvedProvider | null

  const getLocalProvider: CapRouterServices['getLocalProvider'] = (
    capName,
    mountKind: CapabilityMountKind,
    ctx,
    addonId,
  ) => {
    switch (mountKind) {
      // `service-backed` is the pre-SP1 name for `server-provided`; accept both
      // so a framework-live-update version skew (old types on new server, or a
      // future rollback) can't drop these caps into the singleton `default`.
      case 'service-backed':
      case 'server-provided': {
        const factory = deps.serverProviders[capName]
        return factory ? factory(ctx) : null
      }
      // Both per-device mounts go through the SAME dispatcher. It resolves
      // `getNativeProvider` first (the provider IS the device) and falls
      // through to the D13 resolver `getProviderForDevice` — which is what a
      // `device-scoped` WRAPPER needs: the per-device binding
      // (`setWrapperActive` → `setDeviceOverride`) when there is one, the
      // global active provider when there is not. No second resolver.
      case 'device-native':
      case 'device-scoped': {
        // A device-scoped cap whose mode is `collection` has SEVERAL providers
        // per device — sources listed beside each other (D549 decision 2,
        // D554). `requireDeviceScoped` resolves exactly one of them, and on a
        // collection cap `getProviderForDevice` answers with whichever addon
        // registered FIRST: every camera served by one source, silently. The
        // collection twin fans the array methods over the device's sources and
        // routes the scalar ones by the source inside the id.
        if (reg?.getMode(capName) === 'collection') {
          return requireDeviceCollection(reg, capName, deps.logger)
        }
        return requireDeviceScoped(reg, capName)
      }
      case 'collection':
        return resolveCollectionProvider(reg, capName, addonId)
      // singleton / per-node / hub-only resolve the active singleton.
      default:
        return reg?.getSingleton<ResolvedProvider>(capName) ?? null
    }
  }

  /**
   * An explicit `{ addonId }` collection pin that no registered provider owns
   * must REFUSE — never degrade into another provider's answer.
   *
   * The hole this closes: `getProviderByAddonId` returns null for an unknown
   * id, which the router could not tell apart from "this cap is resident in a
   * forked hub worker", so it fell through to `remoteProxy(cap, 'hub')` and
   * answered from the FIRST hub-side provider. Measured live: a fabricated
   * `addonId` on `deviceExport.getStatus` returned Alexa's `linked / 3`. The
   * Home Assistant component pins `homeassistant-export` precisely to avoid
   * the merged aggregate — one missing/renamed/undeployed addon and it would
   * have silently imported Alexa's devices while looking like success.
   *
   * Refuses ONLY when the cap has providers and none matches: with zero local
   * providers the fallthrough is the legitimate forked-worker route and stays.
   */
  const rejectUnresolvedAddonPin: NonNullable<CapRouterServices['rejectUnresolvedAddonPin']> = (
    capName,
    addonId,
  ) => {
    if (!reg) return
    const known = reg.getProviderAddonIds(capName)
    if (known.length === 0) return
    deps.logger?.warn('Refusing cap call: pinned addonId is not a provider of this capability', {
      tags: { addonId },
      meta: { capability: capName, validAddonIds: [...known] },
    })
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        `Capability "${capName}" has no provider with addonId "${addonId}". ` +
        `Valid addonId(s): ${known.join(', ')}. ` +
        `An unresolvable addonId is refused rather than answered by another provider.`,
    })
  }

  const inferCollectionAddonPin: NonNullable<CapRouterServices['inferCollectionAddonPin']> = (
    capName,
    methodName,
    methodInput,
  ) => {
    if (capName !== 'device-adoption') return undefined
    return inferDeviceAdoptionCollectionAddonPin(methodName, methodInput, deps)
  }

  return {
    getLocalProvider,
    remoteProxy,
    rejectUnresolvedAddonPin,
    inferCollectionAddonPin,
    noProvider: (capName, nodeId): never => {
      if (nodeId !== undefined && nodeId !== 'hub') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Capability "${capName}" not available on node "${nodeId}"`,
        })
      }
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: `Capability "${capName}" provider not available`,
      })
    },
    noNodeRouting: (capName): never => {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Node routing not available for "${capName}"`,
      })
    },
    badRequest: (message): never => {
      throw new TRPCError({ code: 'BAD_REQUEST', message })
    },
    // D-1 caller-identity injection: a `caller: 'required'` method whose
    // context carries no authenticated user fails closed — the builder
    // never fabricates an identity.
    unauthorized: (message): never => {
      throw new TRPCError({ code: 'UNAUTHORIZED', message })
    },
    // Task 7.5d: a resolved provider that does not implement `method` must
    // fail, not answer `undefined` (200). NOT_IMPLEMENTED mirrors what
    // `child-cap-dispatch.ts` does on the identical condition on the UDS
    // child plane — the hub previously answered silently where the child
    // already throws.
    methodNotFound: (capName, method): never => {
      throw new TRPCError({
        code: 'NOT_IMPLEMENTED',
        message: `Capability "${capName}" has no method "${method}"`,
      })
    },
  }
}

/**
 * Build the runtime cap-router map (the dynamic value). Returns
 * `Record<string, unknown>` — the caller assigns it to the static
 * `ReturnType<typeof mountAllCaps>` type at the single documented
 * boundary so the AppRouter TYPE stays codegen-derived while the VALUE is
 * built at runtime from `ALL_CAPABILITY_DEFINITIONS`.
 */
export function buildRuntimeCapRouters(deps: CapRouterRuntimeDeps): Record<string, unknown> {
  return buildCapRouters(createCapRouterPrimitives(), createCapRouterServices(deps))
}

/** Re-exported for the unused-import guard / future drift checks. */
export type { CapabilityDefinition }
