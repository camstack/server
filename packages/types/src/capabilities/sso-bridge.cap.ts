import { z } from 'zod'
import { TokenScopeSchema } from '../schemas/auth-records.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

/**
 * `sso-bridge` — internal hub-only cap that lets SSO-style auth
 * providers (OIDC, SAML, …) mint an HMAC-signed token
 * carrying the post-callback claims before redirecting back to
 * `/api/auth/sso/finish`.
 *
 * Without this, any client could craft a `?isAdmin=1` link to
 * `/sso/finish` and become admin. With it, the endpoint accepts ONLY
 * the signed token and rejects everything else.
 *
 * Backed by `AuthManager.{signSsoBridgeToken,verifySsoBridgeToken}` —
 * see `packages/core/src/auth/auth-manager.ts`. The provider is
 * registered at hub boot in `server/backend/src/main.ts`.
 */
const SsoBridgeClaimsSchema = z.object({
  userId: z.string(),
  username: z.string(),
  isAdmin: z.boolean(),
  provider: z.string(),
  email: z.string().optional(),
  displayName: z.string().optional(),
  /**
   * Public HTTPS URL of the hub that issued this token. Used by
   * cloud-mode OAuth proxies (Alexa Smart Home Lambda, future Google
   * Home Lambda) to route a request back to the originating hub
   * without holding routing state of their own. The Lambda decodes the
   * JWT WITHOUT verifying the signature — the hub re-verifies on every
   * inbound call so trust still rests with the signing hub.
   */
  hubUrl: z.string().optional(),
  /** Permission scopes baked into the token. Set by the OAuth
   *  account-linking grant; absent on ordinary SSO-login tokens. */
  scopes: z.array(TokenScopeSchema).optional(),
  /** OAuth authorization-code binding — set only on `oauth-code` tokens. */
  redirectUri: z.string().optional(),
  integrationId: z.string().optional(),
  /** JWT ID — unique per issued code; consumed-set enforces single-use. */
  jti: z.string().optional(),
  /** PKCE S256 challenge — set only on `oauth-code` tokens issued to a public
   *  client. Its PRESENCE is what makes the verifier mandatory at exchange,
   *  so the requirement travels with the code and not with mutable config. */
  codeChallenge: z.string().optional(),
  /** OAuth session registry id — set on `oauth-access`/`oauth-refresh`
   *  tokens so the verify path can check the session is not revoked. */
  sessionId: z.string().optional(),
  /**
   * The refresh lifetime this LINK was created with, in seconds, or `'never'`.
   * Baked into the code at `/authorize` from the integration's descriptor and
   * carried forward so `oauthRefresh` re-mints with the same lifetime. It rides
   * on the token rather than being re-read from the descriptor on purpose:
   * editing a descriptor must not retroactively extend or shorten a link the
   * operator already consented to.
   */
  refreshTtl: z.union([z.number().int().positive(), z.literal('never')]).optional(),
  /**
   * Opaque handle of a hub-side LINK intent (D782). Set by an OIDC callback
   * that was started from a signed-in user's "Link" button: the finish then
   * links this identity to the intent's user instead of signing anyone in.
   * The handle carries no user id — the hub resolves it, single-use.
   */
  linkIntent: z.string().optional(),
  /**
   * Verified `iss` of the id_token behind an OIDC login bridge (D782). A
   * subject is unique only per issuer, so a link is bound to it.
   */
  issuer: z.string().optional(),
  /**
   * SHA-256 (hex) of the `camstack_sso_state` cookie the IdP `/start` set in
   * the browser that began this sign-in. `/api/auth/sso/finish` requires the
   * request to present the matching cookie — a login bridge is useless in
   * any other browser.
   */
  browserBinding: z.string().optional(),
  /**
   * The native app that started this sign-in (D858): its PKCE challenge,
   * `state`, purpose and allow-listed return URL, copied from the server-side
   * pending OIDC state. A bridge carrying it is finished ONLY at
   * `/api/auth/sso/finish-app` (which mints a handoff code, never a web
   * session); `/api/auth/sso/finish` refuses it.
   */
  app: z
    .object({
      codeChallenge: z.string(),
      state: z.string(),
      purpose: z.enum(['new-session', 'step-up']),
      redirect: z.string(),
      /** The page language the app asked for (D858); the confirm page speaks it. */
      lang: z.enum(['en', 'it']).optional(),
    })
    .optional(),
})

export const ssoBridgeCapability = {
  name: 'sso-bridge',
  scope: 'system',
  mode: 'singleton',
  internal: true,
  methods: {
    /**
     * `internal: true` did not gate the mount (see the 2026-08-26 note on
     * `data-store-provider`) — `signBridgeToken` was reachable on the
     * AppRouter by ANY authenticated session at the default
     * `auth: 'protected'`. The claims (including `isAdmin`) are CALLER-
     * SUPPLIED: an unprivileged session could have minted its own
     * `isAdmin: true` bridge token and redeemed it at
     * `/api/auth/sso/finish` to become admin — a full privilege escalation
     * through the exact surface this cap exists to close (see the module
     * docblock). Every real caller (`oauth-grants.ts`, `main.ts`
     * registration, the OIDC addon) reaches this through
     * `ctx.api` / the in-process registry — never through tRPC — so
     * `auth: 'admin'` costs those callers nothing.
     */
    signBridgeToken: method(
      z.object({
        claims: SsoBridgeClaimsSchema,
        /**
         * Seconds, or `'never'` for a token minted with NO `exp` claim.
         *
         * `'never'` is a literal rather than `undefined`/`0` because omitting
         * this field already means "the 5-minute SSO hand-off default", and
         * `jwt.sign` THROWS on `{ expiresIn: undefined }` — a "no expiry" that
         * went through the numeric path would fail at mint time and break
         * linking rather than produce an eternal token.
         */
        ttlSec: z.union([z.number().int().positive(), z.literal('never')]).optional(),
      }),
      z.object({ token: z.string() }),
      { auth: 'admin' },
    ),
    verifyBridgeToken: method(z.object({ token: z.string() }), SsoBridgeClaimsSchema.nullable(), {
      auth: 'admin',
    }),
  },
} as const satisfies CapabilityDefinition

export type ISsoBridgeProvider = InferProvider<typeof ssoBridgeCapability>
export { SsoBridgeClaimsSchema }
