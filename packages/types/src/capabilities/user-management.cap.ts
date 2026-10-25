import { z } from 'zod'
// Canonical schemas — the local enum/scope duplicates that lived here got the
// cap-router types out of sync with `auth-records` once already. One source
// of truth, imported.
import { TokenScopeSchema, UserScopeSchema } from '../schemas/auth-records.js'
import {
  RawSecretMigrationInputSchema,
  RawSecretMigrationReportSchema,
} from './raw-secret-migration.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

const UserSummarySchema = z.object({
  id: z.string(),
  username: z.string(),
  isAdmin: z.boolean().default(false),
  allowedProviders: z.union([z.array(z.string()), z.literal('*')]),
  allowedDevices: z.record(z.string(), z.union([z.array(z.string()), z.literal('*')])),
  /** Capability rows, or ONE viewer row (D921) — see `UserScopeSchema`. */
  scopes: z.array(UserScopeSchema).default([]),
  /**
   * True iff this user has a CONFIRMED TOTP enrollment. Surfaced on
   * `listUsers` so the admin Users page can render the "Remove 2FA"
   * action conditionally without firing one `getTotpStatus` query per
   * row. Self-service enrollment lives on the user's profile page.
   */
  totpEnabled: z.boolean().default(false),
  createdAt: z.number(),
  updatedAt: z.number(),
})

const CreateUserInputSchema = z.object({
  username: z.string(),
  password: z.string().min(6),
  isAdmin: z.boolean().default(false),
  allowedProviders: z.union([z.array(z.string()), z.literal('*')]).optional(),
  allowedDevices: z.record(z.string(), z.union([z.array(z.string()), z.literal('*')])).optional(),
  scopes: z.array(UserScopeSchema).optional(),
})

const UpdateUserInputSchema = z.object({
  id: z.string(),
  isAdmin: z.boolean().optional(),
  allowedProviders: z.union([z.array(z.string()), z.literal('*')]).optional(),
  allowedDevices: z.record(z.string(), z.union([z.array(z.string()), z.literal('*')])).optional(),
  scopes: z.array(UserScopeSchema).optional(),
})

const OauthSessionSummarySchema = z.object({
  id: z.string(),
  userId: z.string(),
  username: z.string(),
  integrationId: z.string(),
  scopes: z.array(TokenScopeSchema),
  createdAt: z.number(),
  lastUsedAt: z.number(),
  revokedAt: z.number().nullable(),
})

// ── TOTP / 2FA schemas ────────────────────────────────────────────────
//
// Setup returns the operator-visible secret (for manual entry) plus an
// `otpauth://` URL that authenticator apps consume as a QR-code payload.
// Recovery codes are deferred to a follow-up phase — the user record
// would need a separate `recovery_codes` collection.

const TotpSetupResultSchema = z.object({
  secret: z.string(),
  otpauthUrl: z.string(),
})

const TotpStatusSchema = z.object({
  /** True iff `confirmedAt != null` — a pending half-enrollment is reported as `enabled: false`. */
  enabled: z.boolean(),
  /** Null when no row exists OR the row is still pending confirmation. */
  confirmedAt: z.number().nullable(),
})

/**
 * user-management — singleton capability for user accounts.
 *
 * v2 model: every method gated by `auth: 'admin'`. Admin-only delegation
 * — the subset check on `setUserScopes` is moot
 * because non-admins never reach these. If/when we open non-admin
 * delegation, structural caller-scope subset check goes inside the
 * provider.
 */
// ── External sign-in identities (D782) ────────────────────────────────
//
// An OIDC identity — `(provider, subject)`, e.g. (`auth-oidc/authentik`,
// the IdP's `sub`) — explicitly linked by its owner to ONE existing user.
// An OIDC login mints a session for the linked user and nobody else: there
// is no auto-creation, no email matching and no group mapping. One
// `(provider, subject)` maps to one user; a user may hold several.

const ExternalIdentitySchema = z.object({
  /** Login-method id of the provider instance, e.g. `auth-oidc/authentik`. */
  provider: z.string(),
  /** The IdP's stable subject (`sub`) for this account. */
  subject: z.string(),
  /** The verified `iss` of the IdP the identity was linked under — `sub` is unique only per issuer. */
  issuer: z.string(),
  userId: z.string(),
  /** What the IdP called the account at link time (username / email) — display only. */
  label: z.string().optional(),
  linkedAt: z.number(),
})

const ExternalIdentityKeySchema = z.object({
  provider: z.string().min(1),
  subject: z.string().min(1),
})

export const userManagementCapability = {
  name: 'user-management',
  scope: 'system',
  mode: 'singleton',
  methods: {
    listUsers: method(z.void(), z.array(UserSummarySchema), { auth: 'admin' }),
    createUser: method(CreateUserInputSchema, UserSummarySchema, {
      kind: 'mutation',
      auth: 'admin',
      access: 'create',
    }),
    updateUser: method(UpdateUserInputSchema, z.object({ success: z.literal(true) }), {
      kind: 'mutation',
      auth: 'admin',
      access: 'create',
    }),
    deleteUser: method(z.object({ id: z.string() }), z.object({ success: z.literal(true) }), {
      kind: 'mutation',
      auth: 'admin',
      access: 'delete',
    }),
    resetPassword: method(
      z.object({ id: z.string(), newPassword: z.string().min(6) }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin', access: 'create' },
    ),
    setUserScopes: method(
      z.object({ userId: z.string(), scopes: z.array(UserScopeSchema) }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin', access: 'create' },
    ),
    validateCredentials: method(
      z.object({ username: z.string(), password: z.string() }),
      UserSummarySchema.extend({ passwordHash: z.string() }).nullable(),
      { kind: 'mutation', access: 'view' },
    ),

    // Scoped tokens are tokens (`auth.mintToken`, D892); the pre-D892
    // `createScopedToken` / `validateScopedToken` / `listScopedTokens` /
    // `revokeScopedToken` are gone with their format (D895).

    // ── TOTP / 2FA ─────────────────────────────────────────────────
    //
    // Setup → Confirm → (Verify on login) → Disable.
    //
    // Admin-only for now: operator enrolls TOTP on a user's behalf by
    // pairing their authenticator with the returned QR. Self-service
    // enrollment is a follow-up (needs the cap framework to expose the
    // caller's identity to the provider so the provider can enforce
    // self-or-admin).
    setupTotp: method(z.object({ userId: z.string() }), TotpSetupResultSchema, {
      kind: 'mutation',
      auth: 'admin',
      access: 'create',
    }),
    confirmTotp: method(
      z.object({ userId: z.string(), code: z.string() }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin', access: 'create' },
    ),
    disableTotp: method(z.object({ userId: z.string() }), z.object({ success: z.literal(true) }), {
      kind: 'mutation',
      auth: 'admin',
      access: 'delete',
    }),
    getTotpStatus: method(z.object({ userId: z.string() }), TotpStatusSchema, { auth: 'admin' }),
    /**
     * D878: move every TOTP seed stored in plaintext into the keychain (owner
     * `system`), leaving a marker in the row. Dry run unless `apply`;
     * idempotent; counts only.
     */
    migrateRawSecrets: method(RawSecretMigrationInputSchema, RawSecretMigrationReportSchema, {
      kind: 'mutation',
      auth: 'admin',
      access: 'create',
    }),
    // Public (no `auth`) — used by the login flow's second-step
    // challenge endpoint. The userId comes from the password-validation
    // step (signed bridge token), so this method is not a free oracle.
    verifyTotp: method(
      z.object({ userId: z.string(), code: z.string() }),
      z.object({ valid: z.boolean() }),
      { kind: 'mutation', access: 'view' },
    ),

    // ── OAuth account-linking grant ────────────────────────────────
    //
    // Core's /oauth2/* endpoints delegate here. Tokens are sso-bridge
    // JWTs (kinds oauth-code / oauth-access / oauth-refresh) and ALWAYS
    // carry isAdmin:false — the operator login proves hub control; the
    // issued token is minimal (device scope only).
    oauthIssueCode: method(
      z.object({
        integrationId: z.string(),
        userId: z.string(),
        username: z.string(),
        scopes: z.array(TokenScopeSchema),
        redirectUri: z.string(),
        hubUrl: z.string(),
        /** PKCE (RFC 7636) S256 challenge. Baked into the signed code; a code
         *  that carries one can ONLY be exchanged with the matching verifier. */
        codeChallenge: z.string().optional(),
        /** The integration's declared refresh lifetime — seconds, or `'never'`.
         *  From `OauthIntegrationDescriptor.refreshTokenTtlSec`. Baked into the
         *  code so the link carries its own lifetime; omit for the 30-day
         *  default. */
        refreshTtlSec: z.union([z.number().int().positive(), z.literal('never')]).optional(),
      }),
      z.object({ code: z.string() }),
      { kind: 'mutation', access: 'create' },
    ),
    oauthExchangeCode: method(
      z.object({
        code: z.string(),
        redirectUri: z.string(),
        /** PKCE verifier. REQUIRED when the code carries a challenge. */
        codeVerifier: z.string().optional(),
      }),
      z
        .object({
          accessToken: z.string(),
          refreshToken: z.string(),
          expiresIn: z.number(),
        })
        .nullable(),
      { kind: 'mutation', access: 'view' },
    ),
    oauthRefresh: method(
      z.object({ refreshToken: z.string() }),
      z
        .object({
          accessToken: z.string(),
          refreshToken: z.string(),
          expiresIn: z.number(),
        })
        .nullable(),
      { kind: 'mutation', access: 'view' },
    ),
    oauthVerifyAccessToken: method(
      z.object({ token: z.string() }),
      z
        .object({
          userId: z.string(),
          username: z.string(),
          scopes: z.array(TokenScopeSchema),
        })
        .nullable(),
      { access: 'view' },
    ),

    // ── OAuth linked-session management (Phase D) ──────────────────
    //
    // The admin UI lists active account-linking sessions and revokes
    // them; revocation makes the linked integration's tokens fail
    // verification immediately.
    // ── External sign-in identities (D782) ─────────────────────────
    //
    // Self-service linking runs through the hub's `auth.*` procedures,
    // which bind the link to the signed-in session; these are the store
    // surface (admin on the wire, called in-process by the hub).
    listExternalIdentities: method(
      z.object({ userId: z.string() }),
      z.array(ExternalIdentitySchema),
      { auth: 'admin' },
    ),
    /** The user an identity is linked to, or `null`. */
    findUserByExternalIdentity: method(
      ExternalIdentityKeySchema,
      z.object({ userId: z.string(), issuer: z.string() }).nullable(),
      { auth: 'admin' },
    ),
    // Creating a link is NOT on the cap: it is hub-internal
    // (`UserManagementInternal.linkExternalIdentity` in @camstack/system),
    // reached only by the SSO finish in the hub process. No wire — tRPC,
    // mesh or `ctx.api` — can plant a link.
    /** Remove one link of `userId`. `success: false` when it was not linked to that user. */
    unlinkExternalIdentity: method(
      ExternalIdentityKeySchema.extend({ userId: z.string() }),
      z.object({ success: z.boolean() }),
      { kind: 'mutation', auth: 'admin', access: 'delete' },
    ),

    listOauthSessions: method(z.void(), z.array(OauthSessionSummarySchema), { auth: 'admin' }),
    revokeOauthSession: method(z.object({ id: z.string() }), z.object({ success: z.boolean() }), {
      kind: 'mutation',
      auth: 'admin',
      access: 'delete',
    }),
  },
} as const satisfies CapabilityDefinition

export type IUserManagementProvider = InferProvider<typeof userManagementCapability>

export {
  CreateUserInputSchema,
  ExternalIdentityKeySchema,
  ExternalIdentitySchema,
  OauthSessionSummarySchema,
  UpdateUserInputSchema,
  UserSummarySchema,
}
