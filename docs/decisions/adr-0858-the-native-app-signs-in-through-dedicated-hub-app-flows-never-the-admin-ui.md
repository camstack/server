---
id: D858
title: The native app signs in through dedicated hub app flows, never through the admin UI
status: accepted
date: 2026-10-16
supersedes:
applies-to:
  - packages/types/src/auth/app-flow.ts
  - packages/types/src/capabilities/login-method.cap.ts
  - packages/types/src/capabilities/sso-bridge.cap.ts
  - packages/addon-auth/src/oidc/auth-oidc.addon.ts
  - packages/system/src/auth/auth-manager.ts
  - server/backend/src/auth/sso-finish-app.ts
  - server/backend/src/auth/sso-finish.ts
  - server/backend/src/auth/sso-routes.ts
  - server/backend/src/auth/app-passkey-page.ts
  - server/backend/src/auth/app-passkey-routes.ts
  - server/backend/src/api/core/auth.router.ts
  - server/backend/src/core/auth/handoff-code.service.ts
  - packages/addon-admin-ui/src/pages/Login.tsx
  - server/backend/src/auth/app-confirm-routes.ts
  - server/backend/src/auth/app-confirm-page.ts
  - server/backend/src/auth/app-confirmations.ts
  - packages/addon-auth/src/webauthn/auth-webauthn.addon.ts
---

## Context

D855 let the viewer sign in by opening the hub's WEB login in an
`ASWebAuthenticationSession` with `redirect=camstack://auth-callback` plus PKCE,
`state` and `purpose`; the admin-ui login page forwarded them after its own
login leg. For OIDC that broke on the way back: the IdP lands on
`/api/auth/sso/finish`, which sets a WEB session and returns to the admin UI
(`/login#token=…`) - the app's PKCE challenge, `state` and `purpose` were never
part of the OIDC round trip, so the browser stayed on the admin login and the
user had to tap three times. The flaw is structural, not a bug in one page: a
native flow that rides on the admin UI inherits every web-only decision made
there (a cookie session, an in-page redirect, a popup completion page).

## Decision

**The viewer's login never goes through the admin UI.** The hub serves two
dedicated app flows; both end at the app's custom scheme with a one-shot
handoff code (the existing D855 `HandoffCodeService`) and neither sets a web
session or cookie.

1. **OIDC app flow.** `GET /addon/auth-oidc/<id>/start?app=1&code_challenge=<S256>
   &code_challenge_method=S256&state=<app state>&purpose=new-session|step-up
   [&redirect=camstack.dev://auth-callback]`. All of it is validated before
   anything is stored (`parseAppFlowRequest` in `@camstack/types`); a refusal is
   a plain page that says why. The app parameters live in the addon's
   server-side pending state (single use, 5 minute TTL, bound to the D810 state
   cookie hash), are never sent to the IdP, and travel to the hub inside the
   HMAC-signed login bridge as `claims.app`. The IdP `state` of an app flow
   carries the prefix `a.` so that an expired or replayed state can still be
   answered AT THE APP (fixed default callback) and not on a hub error page.
   The callback redirects to **`/api/auth/sso/finish-app`**, which verifies the
   bridge exactly like `/sso/finish` (login bridge, provider enabled, state
   cookie binding, `jti` single use, LINKED identity only - D782, D810), then
   mints the handoff code bound to the app's `code_challenge`, `state` and
   `purpose`, and 302s to `camstack://auth-callback?code=…&state=…`. Every
   refusal is a 302 to the app with `error=<code>` (and the state once the
   bridge is trusted): `invalid-bridge`, `not-app-flow`, `link-not-supported`,
   `provider-disabled`, `sso-state`, `sso-not-linked`, `second-factor-required`,
   `user-gone`, `failed`; from the callback also `idp-error`, `idp-failed`,
   `state-expired`, `provider-mismatch`. `/sso/finish` REFUSES a bridge that
   carries `app` (and `finish-app` refuses one that does not), so an app bridge
   can never become a web session. The web flow is otherwise unchanged.
2. **Passkey app page.** `GET /auth/app/passkey?code_challenge=…&state=…&purpose=…
   [&redirect=…]`: a standalone page served by the backend (not the admin-ui
   bundle): plain HTML, one inline script, no third-party asset, "Sign in with a
   passkey" and a Cancel link. CSP: `default-src 'none'`, the script and style by
   SHA-256 hash, `connect-src 'self'`, `frame-ancestors 'none'`. The script runs
   the usernameless assertion against `POST /auth/app/passkey/begin` and
   `POST /auth/app/passkey/finish` (same origin, so the relying party is the
   hub's domain and the app needs no entitlement). The finish verifies the
   assertion through the `user-passkeys` provider (the ceremony of
   `auth.passkeyLoginFinish`), then mints the same handoff code and answers
   `{ location }` at the app; failure answers `{ location }` with `error=`.
3. **`auth.listLoginMethods` says how a native app starts each arm**, in a new
   `app` field: `{ kind: 'native' }` (the app runs it itself - the
   device-certificate arm; a password has no arm and is always native),
   `{ kind: 'browser', startPath }` (OIDC: `/addon/auth-oidc/<id>/start`,
   declared by the addon; the primary passkey arm: `/auth/app/passkey`, set by
   the hub because the page is the hub's), or `null` when there is no app path
   (a second-factor passkey, a widget; also an older addon that does not declare
   it). The viewer hides `null` arms and opens `startPath` on the hub origin with
   the app flow query.
4. **Security rules.** PKCE is mandatory and S256 only (a 43-character
   base64url challenge); `state` is `[A-Za-z0-9._~-]{1,256}` and echoed exactly;
   the return URL is one of `APP_AUTH_CALLBACK_URLS` after canonicalisation
   (no query, fragment or other scheme) and is checked again at the finish,
   never trusted from the bridge; there is no `returnTo` and no open redirect;
   the app parameters are never logged (refusals log the code only); a code is
   single use and every redeem attempt burns it; the rate limits are the web
   flow's (30/min per real client address, shared bucket).
5. **How a step-up is proven.** `purpose=step-up` mints a handoff code of that
   purpose, redeemable only at `auth.deviceEnrollProofFromHandoff`, by a session
   of the SAME user, with the verifier and the state, and it yields a proof
   (D855), never a session. The authentication is the IdP login (or the passkey
   assertion) that JUST ran in the request chain that mints the code: neither
   finish reads a web session cookie other than the state-binding cookie, so an
   existing session can never launder a proof. The grant records
   `authMethod` (`sso` | `passkey`). A user who still owes a second factor
   (TOTP) is NOT signed in by these browser legs (`second-factor-required`) -
   neither page can ask for the factor; the app uses its in-app password login
   for that user. This is deliberate and fail-closed.

What the viewer must do: call `listLoginMethods`, render the methods whose
`app` is not `null`, run `native` ones itself, and for `browser` ones open
`<hub origin><startPath>?<app query>` in the system auth session (`app=1` for
OIDC; the passkey page ignores it) with its own PKCE verifier and state; on the
callback verify `state`, show a message for `error`, otherwise redeem `code`
with `codeVerifier` and `state` at `auth.redeemHandoffCode` (`new-session`) or
`auth.deviceEnrollProofFromHandoff` (`step-up`). It never opens the admin-ui
login for a sign-in.

**Legacy path, live bug (2026-10-16).** Installed viewers still open the admin-ui
login with `purpose=step-up`. When the in-app browser already held an OLD web
session, `Login.tsx` skipped the form and `auth.createHandoffCode` was refused
(`Sign in again first: the sign-in is too old`), leaving a "retry" that could
never succeed. The page now treats that refusal as "needs a fresh sign-in":
it shows the form (handoff params stay parked) and the fresh sign-in mints the
code. A session that just signed in (an SSO return) still mints directly.

## Security review amendments (2026-10-16)

1. **The code is minted only after the person confirms.** A custom URL scheme
   (`camstack://`) can be claimed by ANY app on the phone, and Universal/App
   Links are not viable here (LAN hubs, a local CA, no public association
   file). An app could therefore start the flow itself with its own PKCE
   challenge and, with a live IdP session in the system browser, receive a
   `new-session` code silently. Both browser legs (OIDC `finish-app`, passkey
   `finish`) now end at **`/auth/app/confirm`**, a hub-rendered page "Sign in
   the CamStack app as <username>?" (same CSP discipline as the passkey page:
   script and style by hash, same-origin only). The finished ceremony parks an
   `AppConfirmations` entry under a one-shot token (120 s, in memory, bounded)
   bound to the browser by an HttpOnly cookie (`camstack_app_confirm`, only its
   hash is kept). **Continue** POSTs the token; the first attempt burns it
   whatever the outcome; only a matching cookie yields the handoff code, minted
   then and 302-ed (by the page) to the app. **Cancel** is a plain link to
   `error=cancelled&state=…`. No handoff code exists before Continue.
   *Residual risk, accepted:* a malicious app can still open the hub's pages in
   its own web view and phish there, but it would need the user's IdP or
   passkey credentials typed into that view; the confirmation page names the
   account, so a user who did not start the sign-in sees whose app is asking.
2. **OIDC step-up is forced fresh.** For `purpose=step-up` the authorize
   request carries `prompt=login&max_age=0`, and the callback refuses an
   id_token whose `auth_time` is missing, non-numeric or more than 60 s older
   than the moment the flow began: `error=step-up-not-fresh`.
3. **Pending-state maps are bounded and refuse rather than evict.** The OIDC
   pending states (expired first, 20 per client key, 1000 total) and the
   WebAuthn challenges (expired first, 1000 total) refuse a new ceremony when
   full, never dropping a live one. The OIDC client key comes from the
   forwarded-address headers (the addon sees only headers; the hub's own 30/min
   per real client address still bounds the rate). An OIDC start refused for
   room is `429` (web) or `error=too-many-requests` at the app.

New error codes at the app callback: `cancelled`, `step-up-not-fresh`,
`too-many-requests`. The passkey finish answers `{ confirm }` (a relative path
the page navigates to) instead of `{ location }` on success.

## Consequences

- `@camstack/types`, `@camstack/system` (the bridge now carries `app`; a
  present-but-malformed claim refuses the token, it is never dropped) and
  `@camstack/server` ship together; `addon-auth` is redeployed for the OIDC
  start/callback change. An older addon-auth against a newer hub still works
  for the web flow and reports no app path for OIDC (`app: null`).
- The D855 browser handoff through the admin-ui login stays for installed
  viewers but the viewer stops using it.
- A hub update is needed before an updated viewer can use OIDC or the passkey
  from the app; the viewer must read `app` and hide what the hub does not offer.

## Enforcement

Specs: `server/backend/src/auth/__tests__/app-sso-flow.spec.ts` (callback ->
finish-app -> 302 with code, redeem with verifier, wrong verifier refused,
step-up yields a proof and no session, unlinked identity and replay and
other-browser error redirects, web finish unchanged and refusing an app
bridge), `app-passkey-routes.spec.ts` (page and CSP, refusals, assertion ->
code, no code without a verified ceremony), `packages/addon-auth/src/oidc/__tests__/auth-oidc.addon.spec.ts`
(start validation, parameters never sent to the IdP, error and replay answered
at the app), `auth-router-login-methods.spec.ts` (the `app` field per arm),
`packages/types/src/auth/__tests__/app-flow.spec.ts`. Disarmed: dropping the
challenge from either mint fails the PKCE specs; removing the finish's redirect
re-check fails the allow-list spec; removing the browser binding or the
verified-assertion check fails the ceremony specs.

### Amendment: the hub pages share one shell

The standalone pages of this flow (passkey, confirmation, refusals) looked like unstyled ad-hoc HTML. They now all render through `server/backend/src/auth/app-page-shell.ts`: the colours, radii, spacing and font stack are generated from the admin theme (`@camstack/ui-library/theme/tokens`, `themeToRootCss`, light default and dark under `prefers-color-scheme`), the card, primary button, cancel link and error line repeat the admin login, and the brand logo is inlined. The one inline stylesheet is hashed into the CSP at module load from the served string, so the hash cannot drift. The OIDC start (an addon, no theme access) no longer renders its own refusal page: it redirects (303) to the hub page `/auth/app/refused?reason=<code>`; only a code travels. The OAuth2 consent screen uses the same shell.

### Amendment: the pages speak English and Italian

The app landing pages were English only. Every word now lives in one module, `server/backend/src/auth/app-page-strings.ts` (typed keys, `en` and `it`; a spec fails on a key in one locale only, on an untranslated Italian leaf, and on an English literal in a page file). The language is `resolveAppPageLang`: the app's optional `lang` query parameter (allow-listed `en` | `it`, parsed by `parseAppFlowRequest` into `AppFlowRequest.lang`) wins; else the first supported tag of `Accept-Language` (by q, `it*` becomes `it`); else English. The raw parameter or header is never reflected. `lang` travels like the other app parameters: the OIDC pending state, the signed bridge claim (`app.lang`), the confirmation token's parked entry, the passkey page's `begin`/`finish` bodies; the OIDC refusal redirect carries it as `&lang=`. The expired-confirmation page has no parked entry and falls back to `Accept-Language`. The text the inline scripts write (errors) is delivered as `data-s-*` attributes on `<body>`, so each script is constant and its CSP hash is per build, not per language. The OAuth2 consent screen speaks the language too (`lang` query or `Accept-Language`); the scope summary it prints stays as the integration declared it.

