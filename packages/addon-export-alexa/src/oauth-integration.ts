import type { OauthIntegrationDescriptor } from '@camstack/types'

/**
 * The `export-alexa` OAuth client — the descriptor behind
 * `/api/oauth2/authorize?integration=export-alexa`.
 *
 * Shaped deliberately like
 * `packages/addon-provider-homeassistant/src/ha-export/oauth-integration.ts`:
 * one named `OauthIntegrationDescriptor` per integration, in its own module,
 * registered from the addon's `onInitialize` through `oauthIntegrationCapability`
 * ([D101](../../../docs/decisions/adr-0101.md)). The two integrations differ
 * only in the FIELDS below, never in how they are declared — which is the whole
 * claim being made: a third one is configuration, not framework work.
 *
 * Typed rather than inlined, and that is not cosmetic. As an untyped object
 * literal this needed three `as const` assertions to satisfy the schema and was
 * checked for the first time at `/authorize`, i.e. in front of an operator
 * mid-link. The annotation moves that to compile time.
 *
 * @see docs/decisions/adr-0092.md — why `client_secret` is never checked here.
 */

/**
 * Where Alexa lands after consent — Amazon's three regional account-linking
 * origins, fixed and public. Contrast Home Assistant, whose callback is on the
 * operator's own LAN and needs `allowedPrivateHostPaths`; that difference is
 * the external platforms' contracts, not a divergence in this repo.
 */
const ALEXA_REDIRECT_PREFIXES = [
  'https://layla.amazon.com/',
  'https://pitangui.amazon.com/',
  'https://alexa.amazon.co.jp/',
] as const

/**
 * What a linked Alexa NEEDS to function — the single meaning `requestedScopes`
 * carries everywhere (see `oauth-integration.cap.ts`).
 *
 * `category:device [view, create]` and nothing else, and each half is consumed
 * by a named check: `assertDeviceScope` in `directive-router.ts` demands `view`
 * before ANY directive dispatches, and `requireDeviceScope(scopes, 'create')`
 * gates every control directive (power, brightness, PTZ). It is a category
 * rather than a list of `capability:` entries because every directive Alexa
 * sends resolves to a per-camera cap, and a new one should reach the skill
 * without forcing a re-link.
 *
 * **No `addon:` grant, and that is measured rather than assumed.** Alexa's two
 * hub-side entry points — `POST /addon/export-alexa/directive` and
 * `POST /addon/export-alexa/oauth/lwa-tokens` — are both `access: 'public'`
 * and authenticate the token THEMSELVES via `oauthVerifyAccessToken`, so
 * neither passes through the `access: 'authenticated'` gate that D103 now
 * checks an `addon:` grant on. Home Assistant declares one because its
 * `/command` route does. Same field, same meaning, different routes.
 *
 * Alexa is a CONFIDENTIAL client — the `client_id`/`client_secret` pair lives in
 * the operator's Lambda and is checked there — so unlike Home Assistant there is
 * no `requiresPkce` here. That is a property of the two clients, expressed
 * through the same descriptor field.
 */
export function buildAlexaOauthIntegration(
  /** The operator-selected external-access endpoint, when one is configured.
   *  Baked into issued codes/tokens as the `hubUrl` claim so the cloud Lambda
   *  routes the token exchange and directives back to a reachable public URL
   *  instead of the hub-global `publicHubUrl()` fallback — which is localhost
   *  in dev, and was the cause of "linking fails after consent". Home Assistant
   *  sets no `hubUrl`: it redirects to itself on the LAN. */
  publicHubUrl: string | undefined,
): OauthIntegrationDescriptor {
  return {
    integrationId: 'export-alexa',
    displayName: 'Alexa Smart Home',
    requestedScopes: [{ type: 'category', target: 'device', access: ['view', 'create'] }],
    allowedRedirectPrefixes: [...ALEXA_REDIRECT_PREFIXES],
    /**
     * No expiry — the refresh token is minted with no `exp` claim.
     *
     * Amazon account linking is meant to last until the user unlinks it, and
     * there is no unattended re-link: a 30-day refresh meant the skill went
     * dead a month after setup with nothing to explain it but an
     * `INVALID_AUTHORIZATION_CREDENTIAL` in a Lambda log. Operator decision,
     * 2026-08-09.
     *
     * The trade, stated rather than buried: a leaked refresh token is
     * permanent access. What bounds it is revocation, not time — and for THIS
     * integration revocation bites immediately on every path, not just on
     * refresh. `oauthRefresh` re-reads the oauth session and refuses once
     * `revokedAt` is set, and so does `oauthVerifyAccessToken`, which is what
     * both of Alexa's hub-side entry points call before doing any work
     * (`handleDirective` in `http-server.ts`, `resolveCaller` in
     * `handlers/lwa-tokens-callback.ts`). So a revoked session fails the very
     * next directive; there is no remaining-hour window here. That is the
     * whole guarantee, and it is why neither session check may become
     * optional.
     *
     * Because nothing expires, revocation is also the ONLY way to sever the
     * link. Severing it is a two-part operation — the session AND the Amazon
     * push grant this addon stores — which is what the settings form's
     * "Unlink Amazon account" button does; see `unlinkAlexaAccounts`.
     */
    refreshTokenTtlSec: 'never',
    ...(publicHubUrl ? { hubUrl: publicHubUrl } : {}),
  }
}
