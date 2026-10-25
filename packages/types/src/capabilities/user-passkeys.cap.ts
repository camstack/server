import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

/**
 * `user-passkeys` — per-user WebAuthn (passkey) enrollment + assertion.
 *
 * Implemented by the webauthn addon in `@camstack/addon-auth` (collection of one
 * for now; the cap is collection-mode for forward compat with
 * provider-specific passkey stores).
 *
 * Lifecycle:
 *   1. Enrollment (admin or self):
 *      a. `beginRegistration({userId, username})` → server returns
 *         PublicKeyCredentialCreationOptions (challenge, rp, user, …).
 *         The browser passes this to `navigator.credentials.create()`.
 *      b. `finishRegistration({userId, response, label})` →
 *         server verifies attestation, persists the credential
 *         (publicKey + counter + transports + label).
 *
 *   2. Authentication (during login):
 *      a. `beginAuthentication({userId?})` → server returns
 *         PublicKeyCredentialRequestOptions (challenge, allowCredentials).
 *         The browser passes this to `navigator.credentials.get()`.
 *      b. `finishAuthentication({userId, response})` → server verifies
 *         the assertion, bumps the credential counter, returns ok.
 *
 *   2b. Usernameless (discoverable-credential) authentication — the
 *       passkey IS the primary factor, no password leg:
 *       a. `beginDiscoverableAuthentication({})` → assertion options with
 *          EMPTY `allowCredentials` (the browser offers every resident
 *          passkey it holds for this RP) + `userVerification: 'required'`
 *          (the passkey replaces both factors, so UV is mandatory).
 *          The challenge is stored server-side, NOT bound to any user.
 *       b. `finishDiscoverableAuthentication({response})` → the provider
 *          resolves the credential by the response's credential id,
 *          verifies the assertion against the stored challenge + that
 *          credential's public key/counter, and returns the OWNING
 *          `userId` — the caller (core auth router) mints the session.
 *
 *   3. Management:
 *      - `listPasskeys({userId})` — enumerate user's enrolled credentials.
 *      - `removePasskey({userId, credentialId})` — revoke one credential.
 *
 *   4. Second-factor preference (opt-in, default OFF):
 *      Enrolling a passkey only enables passkey-FIRST sign-in. It is
 *      demanded as a second factor after a password login ONLY when the
 *      user explicitly opts in via `setSecondFactorPreference`.
 *      - `getSecondFactorPreference({userId})` → `{ enabled }` (missing
 *        row ⇒ `enabled: false`).
 *      - `setSecondFactorPreference({userId, enabled})` — persisted by
 *        the providing addon beside its credentials.
 *
 * Challenges are short-lived (5 min, in-memory). The cap is internal —
 * the admin-ui composes the begin/finish round-trip and never exposes
 * the cap to non-admins.
 */

const PasskeySummarySchema = z.object({
  credentialId: z.string(),
  label: z.string(),
  createdAt: z.number(),
  lastUsedAt: z.number().nullable(),
  transports: z.array(z.string()).default([]),
})

export type PasskeySummary = z.infer<typeof PasskeySummarySchema>

export const userPasskeysCapability = {
  name: 'user-passkeys',
  scope: 'system',
  mode: 'collection',
  internal: true,
  methods: {
    beginRegistration: method(
      z.object({ userId: z.string(), username: z.string() }),
      // PublicKeyCredentialCreationOptionsJSON — opaque JSON shape from
      // @simplewebauthn. The browser passes it straight to credentials.create().
      z.object({ optionsJSON: z.record(z.string(), z.unknown()) }),
      { kind: 'mutation', auth: 'admin', access: 'create' },
    ),
    finishRegistration: method(
      z.object({
        userId: z.string(),
        /** RegistrationResponseJSON from the browser. */
        response: z.record(z.string(), z.unknown()),
        /** Operator-visible label (e.g. "MacBook Touch ID"). */
        label: z.string(),
      }),
      z.object({ success: z.literal(true), credentialId: z.string() }),
      { kind: 'mutation', auth: 'admin', access: 'create' },
    ),
    /**
     * The four methods below had NO `auth` override — `internal: true` did
     * not gate the mount (see the 2026-08-26 note on `data-store-provider`),
     * so they were reachable on the AppRouter at the default
     * `auth: 'protected'` (any authenticated session), inconsistent with
     * every other method on this cap (all already `auth: 'admin'`).
     *
     * ⚠ Checked before gating: these are also the PRE-AUTH login-ceremony
     * methods, so admin-gating them here must not break login for an
     * unauthenticated principal. It doesn't — the real login path is the
     * PUBLIC `auth.beginAuthentication` / `auth.finishAuthentication` /
     * `auth.beginDiscoverableAuthentication` / `auth.finishDiscoverableAuthentication`
     * procedures in `server/backend/src/api/core/auth.router.ts`, which call
     * `provider.beginAuthentication(...)` etc. directly against the
     * capability-registry-resolved provider — never through this cap's own
     * tRPC route. `auth: 'admin'` here only closes a redundant, unused
     * second entry point onto the same ceremony.
     */
    beginAuthentication: method(
      // userId optional — when absent, the addon emits a "passkey discovery"
      // (`allowCredentials: []`) so the browser shows every available
      // credential. When present, only the user's credentials are allowed.
      z.object({ userId: z.string().optional() }),
      z.object({ optionsJSON: z.record(z.string(), z.unknown()) }),
      { kind: 'mutation', access: 'view', auth: 'admin' },
    ),
    finishAuthentication: method(
      z.object({
        /** Required — the user the assertion belongs to (verified). */
        userId: z.string(),
        /** AuthenticationResponseJSON from the browser. */
        response: z.record(z.string(), z.unknown()),
      }),
      z.object({ verified: z.boolean() }),
      { kind: 'mutation', access: 'view', auth: 'admin' },
    ),
    beginDiscoverableAuthentication: method(
      // No input — the challenge is deliberately NOT bound to a user.
      // The browser's discoverable-credential picker chooses the passkey;
      // `finishDiscoverableAuthentication` resolves the owning user from
      // the asserted credential id.
      z.object({}),
      z.object({ optionsJSON: z.record(z.string(), z.unknown()) }),
      { kind: 'mutation', access: 'view', auth: 'admin' },
    ),
    finishDiscoverableAuthentication: method(
      z.object({
        /** AuthenticationResponseJSON from the browser. */
        response: z.record(z.string(), z.unknown()),
      }),
      // `userId` is the OWNER of the asserted credential — set only when
      // `verified: true`, `null` otherwise. The core auth router mints
      // the session for exactly this user.
      z.object({ verified: z.boolean(), userId: z.string().nullable() }),
      { kind: 'mutation', access: 'view', auth: 'admin' },
    ),
    listPasskeys: method(z.object({ userId: z.string() }), z.array(PasskeySummarySchema), {
      auth: 'admin',
    }),
    removePasskey: method(
      z.object({ userId: z.string(), credentialId: z.string() }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin', access: 'delete' },
    ),
    getSecondFactorPreference: method(
      z.object({ userId: z.string() }),
      z.object({ enabled: z.boolean() }),
      { auth: 'admin' },
    ),
    setSecondFactorPreference: method(
      z.object({ userId: z.string(), enabled: z.boolean() }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin', access: 'create' },
    ),
  },
} as const satisfies CapabilityDefinition

export type IUserPasskeysProvider = InferProvider<typeof userPasskeysCapability>
export { PasskeySummarySchema }
