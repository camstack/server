import type { OauthIntegrationDescriptor } from '@camstack/types'

/**
 * The `export-google` OAuth client — the descriptor behind
 * `/api/oauth2/authorize?integration=export-google`.
 *
 * Shaped exactly like `packages/addon-export-alexa/src/oauth-integration.ts`
 * and `packages/addon-provider-homeassistant/src/ha-export/oauth-integration.ts`,
 * which is the claim that file already makes and this one tests: a third
 * integration is CONFIGURATION, not framework work
 * ([D101](../../../docs/decisions/adr-0101.md)). Nothing in the kernel learned
 * the word "Google".
 */

/**
 * Where Google lands after consent. Both origins are fixed and public and both
 * are needed: `oauth-redirect` is production, `oauth-redirect-sandbox` is what
 * the Actions console uses while the Action is in test mode — which is the ONLY
 * mode a self-hosted hub will ever be in, since publishing an Action requires
 * Google certification the operator cannot obtain for a private integration.
 *
 * Google appends the project id (`.../r/<project-id>`), so these stay prefixes.
 */
const GOOGLE_REDIRECT_PREFIXES = [
  'https://oauth-redirect.googleusercontent.com/r/',
  'https://oauth-redirect-sandbox.googleusercontent.com/r/',
] as const

/**
 * What a linked Google Home NEEDS — the single meaning `requestedScopes`
 * carries everywhere (see `oauth-integration.cap.ts`).
 *
 * `category:device [view, create]`, and each half is consumed by a named check
 * in `fulfillment-router.ts`: `view` gates SYNC and QUERY, `create` gates
 * EXECUTE. It is a category rather than a `capability:` list because the trait
 * catalog is meant to grow, and a new trait row must not force every operator
 * to re-link.
 *
 * **No `addon:` grant, and that is measured rather than assumed.** The single
 * hub-side entry point, `POST /addon/export-google/fulfillment`, is
 * `access: 'public'` and authenticates the token itself via
 * `oauthVerifyAccessToken`, so it never passes through the
 * `access: 'authenticated'` gate that [D103](../../../docs/decisions/adr-0103.md)
 * checks an `addon:` grant on. Same field, same meaning, different routes.
 *
 * Google's smart-home account linking is a CONFIDENTIAL client — the client id
 * and secret live in the Actions console, which is why there is no
 * `requiresPkce` here. Note that the hub does not verify that secret either
 * ([D92](../../../docs/decisions/adr-0092.md)); the security of the link rests
 * on the authorization code and the redirect-prefix allow-list above.
 */
export function buildGoogleOauthIntegration(): OauthIntegrationDescriptor {
  return {
    integrationId: 'export-google',
    displayName: 'Google Home',
    requestedScopes: [{ type: 'category', target: 'device', access: ['view', 'create'] }],
    allowedRedirectPrefixes: [...GOOGLE_REDIRECT_PREFIXES],
    /**
     * No expiry, for the reason Alexa's descriptor spells out at length: a
     * smart-home link is meant to last until the user unlinks it, there is no
     * unattended re-link, and a 30-day refresh silently kills the integration a
     * month after setup.
     *
     * What bounds a leaked refresh token is revocation, not time — and for THIS
     * integration revocation bites on the very next call, because the one entry
     * point (`/fulfillment`) calls `oauthVerifyAccessToken` before doing any
     * work, and that refuses once the session carries `revokedAt`.
     *
     * Google also has its own severing path: `action.devices.DISCONNECT`, which
     * `fulfillment-router.ts` handles by dropping the linked-account record so
     * `getStatus` stops claiming the export is live.
     */
    refreshTokenTtlSec: 'never',
    /**
     * No `hubUrl` claim, unlike Alexa. Alexa needs one because a single shared
     * Lambda must learn which hub to route back to; Google calls the
     * fulfillment URL the operator pasted into the Actions console, directly.
     * There is no router in the middle to inform.
     */
  }
}
