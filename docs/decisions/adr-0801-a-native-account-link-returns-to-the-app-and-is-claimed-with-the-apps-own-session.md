---
id: D801
title: A native account link returns to the app under a one-time code and is claimed with the app's own session
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/types/src/auth/app-callback.ts
  - server/backend/src/auth/native-link-completions.ts
  - server/backend/src/auth/native-return.ts
  - server/backend/src/auth/sso-finish.ts
  - server/backend/src/api/core/auth.router.ts
  - server/backend/src/main.ts
  - packages/addon-admin-ui/src/lib/login-redirect.ts
  - packages/addon-admin-ui/src/contexts/auth-context.tsx
---

## Context

Amends D782 for the native viewer. D782 binds a link to the user who asked by
requiring that the browser finishing the IdP round trip still holds THAT
user's hub session cookie. The native app runs the round trip in the system
browser (an auth session sheet), which holds no hub session: every link
started from a phone ended `linkError=session`. The sheet also cannot return
to the profile page — the app is waiting on its custom scheme.

Dropping the check, or handing the cookie to the system browser, was the
first idea and the wrong one: the cookie IS the binding, and copying a session
into a browser to satisfy a check defeats the check.

The same gap blocks passkey enrolment: a passkey is created by a browser's
WebAuthn ceremony at the hub's origin, and the app's system browser is not
signed in there.

## Decision

A link started with `returnTo` — one of `APP_AUTH_CALLBACK_URLS`, the single
allowlist the admin-ui login handoff reads too — finishes WITHOUT the cookie
check: the SSO finish parks the verified `(intent user, identity, issuer)`
under a one-time code (60 s, single-use, hashed at rest) and 302s to
`<returnTo>?link=<code>` (or `?linkError=<reason>`), never prefixed with the
hub mount. The app claims it with `auth.completeExternalLink({code})` over its
own bearer, and the router links ONLY when `ctx.user.id` is the intent's
user, through the finish's own link step (same conflict rule). A claim by
anyone else spends the code and links nothing. Scoped and share-view
principals are refused.

`auth.createBrowserHandoff` mints a one-time code (60 s, single-use) for the
caller; `GET /api/auth/browser-handoff?code=` turns it into a session carried
in the URL fragment to the account page `/system/my-access` — the route takes
no destination, so the code opens that page and nowhere else.

## Consequences

- The binding moves from a cookie to a bearer: a parked identity reaches an
  account only if the device that finished the IdP login is running the app
  of the user who started the link.
- The browser handoff creates an ordinary session in that browser (bounded by
  the hub's session lifetime). It is not scoped to the one page: the page is
  the only destination, but the session is a session.
- An expired intent cannot name its `returnTo`, so it still lands on the
  profile page with `linkError=expired`; the app sees the sheet dismissed.
- Re-authentication before linking (security plan §3.3) is not part of this
  record; when `auth.reauthenticate` lands, `beginExternalLink` gates both
  forms alike.

## Enforcement

`auth-router-native-link.spec.ts` (allowlist, user binding, single use,
scoped refusal, handoff destination), `sso-finish.spec.ts` (park, no cookie,
no popup wrapping), `native-return.spec.ts` (no mount prefix on a scheme,
fixed handoff destination), `app-callback.spec.ts` (one allowlist).
