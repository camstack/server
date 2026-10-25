/**
 * Shared cap-router predicates — the SINGLE source for the structural Zod-shape
 * checks + naming used by BOTH the runtime cap-router builder
 * (`@camstack/system` `cap-router-builder.ts` + the server's
 * `cap-router-runtime.ts`) AND the codegen scripts (`scripts/generate-cap-*.ts`).
 *
 * These used to be independently reimplemented on each side, held in sync only
 * by "must stay byte-identical" comments — a live drift risk. Consolidating them
 * here (next to `resolveCapMount` / `expandCapMethods`, the other shared model)
 * makes the two paths provably agree. Each predicate accepts both Zod 4
 * (`_def.type`) and legacy Zod 3 (`_def.typeName` / `constructor.name`) shapes.
 */

import type { CapabilityDefinition, CapabilityMethodAuth } from './capability-definition.js'
import { expandCapMethods, resolveCapMount } from './capability-definition.js'

/**
 * True when a cap's generated router carries the COLLECTION `addonId`
 * selector — "which provider of this collection answers".
 *
 * `resolveCapMount` is the authority, not `mode`: since D554 a device-scoped
 * wrapper that is a collection (`videoclips`) keeps the PER-DEVICE mount, and
 * its sources are resolved from the device, never picked by an addonId the
 * caller supplies. Emitting the selector for it would advertise a routing key
 * the runtime builder does not read — the exact type/runtime disagreement
 * D552 removed from `generate-cap-mounts.ts`.
 *
 * The one exception is preserved deliberately, and it is the same one
 * `generate-cap-mounts.ts` documents: a cap declaring `mount: { kind: 'skip' }`
 * keeps its mode-derived shape. The builder never mounts it, so the emitted
 * value is never called — four inert caps (`log-channels`, `login-method`,
 * `load-contribution`, `failure-contribution`) that would otherwise change
 * shape inside a slice that is about something else.
 */
export function emitsCollectionSelector(def: CapabilityDefinition): boolean {
  const kind = resolveCapMount(def).kind
  if (kind === 'collection') return true
  return kind === 'skip' && def.mode === 'collection'
}

/** `z.void()` — input carries no data. */
export function isVoidInput(schema: unknown): boolean {
  const def = (schema as { _def?: { type?: string; typeName?: string } })._def
  const ctor = (schema as { constructor?: { name?: string } }).constructor?.name
  return ctor === 'ZodVoid' || def?.type === 'void' || def?.typeName === 'ZodVoid'
}

/** `z.object()` — supports `.loose()` for out-of-band `nodeId`/`addonId` keys. */
export function isObjectInput(schema: unknown): boolean {
  const def = (schema as { _def?: { type?: string; typeName?: string } })._def
  const ctor = (schema as { constructor?: { name?: string } }).constructor?.name
  return ctor === 'ZodObject' || def?.type === 'object' || def?.typeName === 'ZodObject'
}

/**
 * Structural "is this Zod schema an array output" check — bottoms out at
 * `ZodArray` through the canonical Zod 4 wrappers (readonly/optional/nullable/
 * default). Bounded unwrap guards against a malformed/cyclic schema.
 */
export function isArrayOutputSchema(schema: unknown): boolean {
  let cur: unknown = schema
  for (let depth = 0; depth < 8 && cur != null; depth += 1) {
    const def = (cur as { _def?: { type?: string; innerType?: unknown } })._def
    const ctor = (cur as { constructor?: { name?: string } }).constructor?.name
    if (ctor === 'ZodArray' || def?.type === 'array') return true
    const wraps =
      ctor === 'ZodReadonly' ||
      def?.type === 'readonly' ||
      ctor === 'ZodOptional' ||
      def?.type === 'optional' ||
      ctor === 'ZodNullable' ||
      def?.type === 'nullable' ||
      ctor === 'ZodDefault' ||
      def?.type === 'default'
    if (!wraps || def?.innerType == null) return false
    cur = def.innerType
  }
  return false
}

/**
 * True when `method` on cap `def` is a COLLECTION cap's array-returning
 * (non-subscription) method — the methods whose contract is "union the result
 * across every registered provider" (`listTargets`, `listTargetKinds`,
 * `discoverTargets`, `listEndpoints`, …).
 *
 * Such a method is aggregated at the hub via `concatCollection` / the runtime
 * `concatArrayMethod`, both of which SKIP a provider that doesn't implement it
 * (contributes `[]`). That local skip is invisible across the UDS boundary — a
 * hub-side per-provider proxy fabricates a callable for every property, so the
 * call reaches the child's real (possibly partial) provider. This predicate lets
 * the child-side dispatcher reproduce the same graceful skip: a missing method
 * here yields `[]`, not a "method not found" error. Singleton caps and non-array
 * methods return `false` so a genuinely missing method still surfaces as a bug.
 */
export function isCollectionArrayMethod(
  def: CapabilityDefinition | undefined,
  method: string,
): boolean {
  if (def === undefined || def.mode !== 'collection') return false
  const m = expandCapMethods(def)[method]
  return m !== undefined && m.kind !== 'subscription' && isArrayOutputSchema(m.output)
}

/**
 * Apply `.loose()` to an object input schema when available (Zod 4) so the
 * router accepts the out-of-band `nodeId`/`addonId` selector keys without
 * stripping them. Falls back to the schema unchanged when `.loose()` is absent.
 */
export function looseSchema(schema: unknown): unknown {
  const loose = (schema as { loose?: () => unknown }).loose
  return typeof loose === 'function' ? loose.call(schema) : schema
}

/**
 * Derive a COLLECTION-cap routing `addonId` from a NON-array mutation input
 * when the caller did NOT supply the top-level `{ addonId }` selector.
 *
 * Background: a `scope:'system', mode:'collection'` cap fans its ARRAY methods
 * (`listTargets`, `listTargetKinds`, …) across every provider, but routes each
 * single-object method (`send` / CRUD) to ONE provider. The runtime router
 * strips a TOP-LEVEL `addonId` selector and routes it via
 * `getProviderByAddonId`; absent that selector it falls through to the FIRST
 * registered provider — which misroutes (or hard-crashes on a partial provider)
 * when the target is owned by a DIFFERENT provider. See
 * `notification-output.cap.ts` (`Target.addonId` / `TargetKind.addonId` are
 * "stamped by each provider so the concat-fanned catalog stays routable").
 *
 * That routing `addonId` is ALREADY carried inside the mutation payload the
 * caller sends — e.g. `upsertTarget({ target: { …, addonId } })`. This helper
 * recovers it: it scans the input's DIRECT child object properties (bounded to
 * one level, first match wins) for a string `addonId`. Mirrors the child-side
 * `extractArgsAddonId` fallback in `child-cap-dispatch.ts`, which reads a
 * top-level `addonId` off the raw args; this covers the one-level-nested case
 * the top-level scan misses.
 *
 * Only used for non-array collection methods (array fan-out is never rerouted),
 * so it can never collapse a catalog aggregation onto a single provider. `null`
 * / non-object inputs yield `undefined` (fall back to the first provider,
 * preserving single-provider and id-only-payload back-compat).
 */
export function extractNestedAddonId(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object') return undefined
  for (const value of Object.values(input as Record<string, unknown>)) {
    if (value !== null && typeof value === 'object') {
      const nested: unknown = (value as Record<string, unknown>).addonId
      if (typeof nested === 'string') return nested
    }
  }
  return undefined
}

/**
 * True when an OBJECT input schema declares a top-level `addonId` field.
 *
 * Such a cap method routes explicitly via the top-level `{ addonId }` selector
 * (the `llm.generate` / `deleteProfile` posture). The runtime router therefore
 * MUST NOT also fall back to {@link extractNestedAddonId} for it — that would
 * let an incidental nested `addonId` (e.g. a key inside a free-form `jsonSchema`
 * record) hijack routing. Nested recovery is reserved for methods whose input
 * carries NO top-level selector but embeds the owning `addonId` inside a domain
 * entity (`upsertTarget({ target: { addonId } })`, `upsertProfile({ profile })`).
 *
 * Accepts both Zod 4 (`.shape` / `_def.shape`) and legacy shapes; returns false
 * for non-object schemas.
 */
export function objectInputDeclaresAddonId(schema: unknown): boolean {
  if (schema === null || (typeof schema !== 'object' && typeof schema !== 'function')) {
    return false
  }
  const direct = (schema as { shape?: unknown }).shape
  const shape =
    direct !== undefined && direct !== null
      ? direct
      : resolveDefShape((schema as { _def?: { shape?: unknown } })._def?.shape)
  return (
    shape !== undefined &&
    shape !== null &&
    typeof shape === 'object' &&
    Object.prototype.hasOwnProperty.call(shape, 'addonId')
  )
}

/**
 * True when an OBJECT input schema declares a top-level, REQUIRED, numeric
 * `deviceId` — i.e. the method names exactly one device on every call.
 *
 * This is the question the per-device dispatcher asks at runtime
 * (`requireDeviceScoped`: `typeof input.deviceId !== 'number'` → BAD_REQUEST),
 * asked once at build time instead. A `device-scoped` cap's method that cannot
 * answer it has no device to resolve for and therefore resolves through the
 * cap's SYSTEM provider (`cap-router-builder.ts`) — the same destination
 * `systemOnly` names explicitly. Without this, flipping the mount would 400
 * every batch (`deviceIds`), fleet-wide (`z.void()`) and job-keyed method on
 * the eight device-scoped wrapper caps.
 *
 * Structural, never a name heuristic over source text: the field must resolve
 * to `z.number()` and must NOT be wrapped in `optional` / `nullable` /
 * `default` — an absent value is exactly the input the dispatcher rejects.
 */
export function objectInputDeclaresRequiredDeviceId(schema: unknown): boolean {
  if (schema === null || (typeof schema !== 'object' && typeof schema !== 'function')) {
    return false
  }
  const direct = (schema as { shape?: unknown }).shape
  const shape =
    direct !== undefined && direct !== null
      ? direct
      : resolveDefShape((schema as { _def?: { shape?: unknown } })._def?.shape)
  if (shape === undefined || shape === null || typeof shape !== 'object') return false
  const field: unknown = (shape as Record<string, unknown>)['deviceId']
  if (field === undefined || field === null) return false
  const def = (field as { _def?: { type?: string; typeName?: string } })._def
  const ctor = (field as { constructor?: { name?: string } }).constructor?.name
  return ctor === 'ZodNumber' || def?.type === 'number' || def?.typeName === 'ZodNumber'
}

/** `_def.shape` may be a thunk (Zod defers object-shape evaluation) or a plain record. */
function resolveDefShape(defShape: unknown): unknown {
  return typeof defShape === 'function' ? (defShape as () => unknown)() : defShape
}

/**
 * Effective auth for a cap method — the `internal: true` floor (Task 7.5c).
 *
 * `internal: true` on a cap def is a DECLARATION that its methods are for
 * in-process (`ctx.api`) consumption only. Nothing enforced that:
 * `resolveCapMount` never reads `internal` (an internal cap still gets a
 * full tRPC router), and a method that omitted an explicit `auth` used to
 * default — permanently, at `method()`-call time — to `'protected'`,
 * reachable by any authenticated session regardless of `internal`. That
 * silent default is how 45 procedures across 13 internal caps ended up
 * exposed, including `ssoBridge.signBridgeToken`: it accepted
 * caller-supplied claims (including `isAdmin`), was reachable by any
 * authenticated session, and its token is redeemed at
 * `/api/auth/sso/finish` to mint a session — a full privilege escalation.
 * See `docs/decisions/adr-0240-an-internal-cap-floors-its-unannotated-methods-to-admin.md`
 * (D240) for the record.
 *
 * The floor, exactly: an `internal` cap's method with NO explicit `auth`
 * resolves to `'admin'` instead of `'protected'`. A method that DELIBERATELY
 * declares an explicit `auth` — public, protected, or admin — keeps it
 * unconditionally; the author already said what they meant, and an
 * annotation that happens to agree with the floor is documentation, not
 * redundancy. A non-`internal` cap's un-annotated method is unaffected
 * (still `'protected'`). This is a FLOOR, not a hard `mount: 'skip'` — that
 * would also override a deliberate `auth: 'public'`/`'protected'` choice,
 * which is not the defect being closed.
 *
 * `method()` (`capability-definition.ts`) deliberately leaves `auth`
 * UNSET when the caller omits it (rather than defaulting there) so the
 * "was this explicit" bit survives to this single resolution point. Single
 * source of truth shared by the runtime builder (`cap-router-builder.ts`)
 * and the codegen (`generate-cap-routers.ts`, `gen-api-reference.ts`) — the
 * two must never disagree, a documented failure mode in this repo.
 */
export function resolveMethodAuth(
  def: Pick<CapabilityDefinition, 'internal'>,
  method: { readonly auth?: CapabilityMethodAuth },
): CapabilityMethodAuth {
  if (method.auth !== undefined) return method.auth
  return def.internal === true ? 'admin' : 'protected'
}

/** Auth level → base-procedure key. `superAdmin` collapses to `admin`. */
export function procedureAuthKey(auth: string): 'public' | 'protected' | 'admin' {
  if (auth === 'public') return 'public'
  if (auth === 'admin' || auth === 'superAdmin') return 'admin'
  return 'protected'
}

/** kebab-case cap name → camelCase router-map key. */
export function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}
