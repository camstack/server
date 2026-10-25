/**
 * The hub address an OIDC sign-in STARTED at — so it returns there (D791).
 *
 * The browser must come back to the origin it left from: the session cookie,
 * the admin UI's stored token and a popup's `window.opener` all belong to
 * one origin. Before this the `redirect_uri` was the hub's single browser
 * address (`hubBrowserOrigin`), so a sign-in started on the LAN address
 * (`https://192.168.x.x:4443`) finished on the public tunnel.
 *
 * The origin is read from the `/start` request — `X-Forwarded-Host` /
 * `Host`, `X-Forwarded-Proto` — and is NEVER trusted as such: a forged
 * `Host` would otherwise choose where the IdP sends the authorization code.
 * It is used only when it equals, exactly, an origin the hub advertises
 * itself at (the Network page's addresses: detected, custom, the public
 * endpoint, the app-connection set) or the origin of the operator's
 * configured redirect override. Anything else falls back to the default
 * browser address, exactly as before.
 *
 * The mount prefix (`X-Forwarded-Prefix`, the reverse-proxy relay) is kept on
 * the path when well-formed — it can only move the callback within an
 * allowlisted origin, where the hub serves or 404s it and a strict IdP
 * refuses an unregistered one.
 *
 * The implementation lives in `@camstack/types` (`auth/request-origin.ts`) so the
 * hub's device-certificate challenge binds its nonce to the same advertised
 * origin set; this file re-exports it.
 */
export {
  advertisedHubOrigins,
  claimedRequestOrigins,
  normalizeOrigin,
  pickRequestOrigin,
  type RequestHeaders,
  requestMountPrefix,
} from '@camstack/types'
