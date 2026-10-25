/**
 * Zod schemas for persisted record types.
 *
 * These schemas serve as the single source of truth for types that are
 * stored in the settings-store backend and retrieved via tRPC. They
 * replace the manual TypeScript interfaces with schema-derived types,
 * enabling runtime validation when reading from the backend.
 *
 * Convention: each schema is named `<Type>Schema`, the inferred TS type
 * keeps the original name for backward compatibility.
 */
import { ViewerTokenScopeSchema } from '../auth/viewer-access.js'
import { z } from 'zod'
import { DeviceType } from '../device/device-type.js'

// ── Auth ────────────────────────────────────────────────────────────

/**
 * Auth model (v2 — 2026-05-12 caps-only):
 *
 * Two principals:
 *   - `isAdmin: true`  — full bypass. Admin scope set is ignored.
 *   - `isAdmin: false` — every call gated by `scopes` (see TokenScope).
 *
 * No role enum. There used to be `viewer / agent / scoped` and earlier
 * `super_admin` — collapsed onto the single boolean because every
 * non-admin caller is governed by the same scope-check rules; the
 * distinction was only ever used to route role-specific procedures
 * which we no longer have. CLI / webhook integrations are tokens (`auth.mintToken`)
 * with `isAdmin: false` + an explicit scope list.
 */

/** Per-method access flavour. Materialised on every cap method via codegen. */
export const MethodAccessSchema = z.enum(['view', 'create', 'delete'])
export type MethodAccess = z.infer<typeof MethodAccessSchema>

/**
 * A single scope grant. Three forms — checked in matcher with OR
 * semantics; the first match decides whether the call passes:
 *
 *   - `category` — broadest. `target: 'device' | 'system'` selects every
 *     cap with the matching `scope` declaration. New caps inherit grants
 *     automatically — adding a device cap to the codebase makes it
 *     reachable to every user with `category:device [...]` without a
 *     re-grant. Use this for "family viewer" / "operator" tiers.
 *
 *   - `addon` — every cap that ships inside a given addon id. Niche;
 *     useful when an integration needs to interact with one specific
 *     addon's surface regardless of how many caps it exports.
 *
 *   - `capability` — the most precise form. Single cap name. Use for
 *     integration tokens where you want to grant `addons.installPackage`
 *     and nothing else.
 *
 * `access` is REQUIRED with min 1 element. `admin` bypass is the
 * "give me everything" escape; there is no wildcard scope.
 */
const AllowedProviderSchema = z.union([z.literal('*'), z.array(z.string())])
const AllowedDevicesSchema = z.record(z.string(), z.union([z.literal('*'), z.array(z.string())]))

export const CapScopeSchema = z.enum(['device', 'system'])
export type CapScope = z.infer<typeof CapScopeSchema>

/**
 * DeviceSelector (scope model v3 — 2026-08-12).
 *
 * A `device` grant no longer carries a frozen list of deviceIds. It carries
 * a SELECTOR the matcher resolves against the live fleet, so the grant can be
 * DYNAMIC: a `types:['camera']` selector automatically covers a camera added
 * AFTER the grant was minted — no re-grant, no re-login.
 *
 *   - `all`       — every device in the deployment. The broad viewer/operator
 *     lever without a `category` grant (a `category` grant also covers device
 *     caps that carry no deviceId; `all` is specifically the device set).
 *   - `ids`       — an explicit deviceId list. This is what a v2 `device:[…]`
 *     grant migrates to (see {@link TokenScopeSchema}); STATIC — a new camera
 *     is NOT covered until the grant is edited.
 *   - `types`     — every device of a `DeviceType` (e.g. every `camera`).
 *     DYNAMIC. A device that changes type, or a new device of the type,
 *     re-resolves on the next request.
 *   - `locations` — every device whose operator-assigned `location` label is
 *     in the set (e.g. "Garden", "Front door"). DYNAMIC. A device with a
 *     null/unset location matches NO `locations` selector.
 */
export const DeviceSelectorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }),
  z.object({ kind: z.literal('ids'), ids: z.array(z.number().int()).min(1) }),
  z.object({ kind: z.literal('types'), types: z.array(z.enum(DeviceType)).min(1) }),
  z.object({ kind: z.literal('locations'), locations: z.array(z.string().min(1)).min(1) }),
])
export type DeviceSelector = z.infer<typeof DeviceSelectorSchema>

const DeviceTokenScopeSchema = z.object({
  type: z.literal('device'),
  /** The device SET this grant covers — resolved against the live fleet. */
  selector: DeviceSelectorSchema,
  access: z.array(MethodAccessSchema).min(1),
  /**
   * Whether a grant on a PARENT device transparently covers its accessory
   * CHILDREN (siren / floodlight / PIR) via the persisted-parentage walk.
   * Direction is parent → children ONLY.
   *
   * Absent → the matcher DERIVES it from the access flavour: `view`
   * inherits (a camera viewer sees the camera's accessories), `create` /
   * `delete` do NOT (actuating/removing a child is an explicit act the
   * operator must grant on the child, not inherit from the parent). Set it
   * explicitly to override that default per grant.
   */
  includeLinked: z.boolean().optional(),
})

/**
 * v2 → v3 lazy migration. A pre-v3 `device` grant carried
 * `targets: string[]` (stringified deviceIds); it rewrites to the equivalent
 * `selector: {kind:'ids', ids}`. Applied as a `preprocess` so it runs on
 * EVERY parse path — stored records AND the JWT-carried scope arrays
 * normalised at the request boundary ({@link normalizeTokenScopes} in
 * `device-selector.ts`). Chosen over a one-time DB migration because a
 * migration cannot reach a JWT already in a client's hands; parse-time
 * migration covers both without a flag day. No cast — the raw object is read
 * through `Reflect.get` (its static type is `unknown`).
 */
function migrateLegacyTokenScope(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw
  if (Reflect.get(raw, 'type') !== 'device') return raw
  if (Reflect.get(raw, 'selector') !== undefined) return raw
  const targets = Reflect.get(raw, 'targets')
  if (!Array.isArray(targets)) return raw
  const ids = targets
    .map((t) => (typeof t === 'string' ? Number(t) : t))
    .filter((n): n is number => typeof n === 'number' && Number.isInteger(n))
  return { type: 'device', selector: { kind: 'ids', ids }, access: Reflect.get(raw, 'access') }
}

export const TokenScopeSchema = z.preprocess(
  migrateLegacyTokenScope,
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('category'),
      target: CapScopeSchema,
      access: z.array(MethodAccessSchema).min(1),
    }),
    z.object({
      type: z.literal('capability'),
      target: z.string(),
      access: z.array(MethodAccessSchema).min(1),
    }),
    z.object({
      type: z.literal('addon'),
      target: z.string(),
      access: z.array(MethodAccessSchema).min(1),
    }),
    DeviceTokenScopeSchema,
  ]),
)
export type TokenScope = z.infer<typeof TokenScopeSchema>

/**
 * What a PERSON's grant set holds (D921): the capability rows above (legacy
 * users, integration-style tokens) or the viewer row, which is decided by its
 * own rules alone. Kept apart from {@link TokenScope} so every surface that
 * edits capability rows (the scope picker, token minting) keeps its shape.
 */
export const UserScopeSchema = z.union([ViewerTokenScopeSchema, TokenScopeSchema])
export type UserScope = z.infer<typeof UserScopeSchema>
/** The `device`-typed member of {@link TokenScope}, narrowed for matchers. */
export type DeviceTokenScope = z.infer<typeof DeviceTokenScopeSchema>

export const UserRecordSchema = z.object({
  id: z.string(),
  username: z.string(),
  passwordHash: z.string(),
  /**
   * Admin bypass. When true, the middleware skips the scope-access
   * check entirely. There is no other axis of privilege; the legacy
   * role enum collapsed onto this boolean in v2.
   */
  isAdmin: z.boolean().default(false),
  allowedProviders: AllowedProviderSchema,
  allowedDevices: AllowedDevicesSchema,
  /**
   * Scopes granted to this user. Admins bypass; their `scopes` is
   * ignored. Non-admins without scopes are locked out of every
   * protected call.
   */
  scopes: z.array(UserScopeSchema).default([]),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type UserRecord = z.infer<typeof UserRecordSchema>

// ── Scoped Tokens ───────────────────────────────────────────────────

export const ScopedTokenSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  tokenHash: z.string(),
  tokenPrefix: z.string(),
  scopes: z.array(TokenScopeSchema),
  // SQLite/JSON storage round-trips undefined → null. Use `nullish` so the
  // schema accepts both `null` (read from disk) and `undefined` (in-memory).
  expiresAt: z.number().nullish(),
  lastUsedAt: z.number().nullish(),
  createdAt: z.number(),
})
export type ScopedToken = z.infer<typeof ScopedTokenSchema>
