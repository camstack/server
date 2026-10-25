---
id: D810
title: An SSO login bridge is single-use and bound to the browser that started the sign-in
status: accepted
date: 2026-10-09
supersedes:
applies-to:
  - packages/addon-auth/src/oidc/auth-oidc.addon.ts
  - packages/types/src/auth/sso-state.ts
  - packages/types/src/capabilities/sso-bridge.cap.ts
  - packages/system/src/auth/auth-manager.ts
  - server/backend/src/auth/sso-finish.ts
  - server/backend/src/auth/sso-finish-deps.ts
  - server/backend/src/auth/sso-routes.ts
  - server/backend/src/auth/used-bridge-ids.ts
  - packages/types/src/utils/mask-url.ts
  - packages/system/src/logging/log-redactor.ts
---

## Context

D782 left it open: the login bridge was a 5-minute bearer in `?bridge=`,
redeemable more than once and from any browser. Query strings end up in
browser history, proxy and tunnel logs; the log redactor masked only
`token`-like names in absolute URLs, so `bridge=` was logged in clear.

## Decision

The IdP `/start` sets `camstack_sso_state` — random, HttpOnly, SameSite=Lax,
path `/`, 10 minutes, Secure over https — and keeps only its SHA-256 in the
server-side pending state; the callback signs it into the bridge as
`browserBinding`, with a fresh `jti`. `/api/auth/sso/finish` swaps a bridge
only when:

1. the request's state cookie hashes to the bridge's binding (constant-time),
   and THEN
2. the bridge's `jti` was never finished before (recorded in memory for 10
   minutes, bounded).

A bridge without binding or `jti` is refused. The binding is checked before
the `jti` is recorded, so a bridge presented without the cookie is refused
without being burned. Every finish answer clears the cookie and sends
`Referrer-Policy: no-referrer`. `bridge`, `code`, `state`, `challenge` and
`link` are masked in logged URLs, relative ones included.

## Consequences

- A copied bridge URL is useless in another browser and useless a second time.
- Two sign-ins started in two tabs: the second `/start` overwrites the cookie,
  and the first finish is refused (`#error=sso-state`) — start it again.
- The popup flow (D794) and the native link (D801) finish in the browser that
  ran `/start`, so they carry the cookie.
- A hub restart within a bridge's 5 minutes forgets its `jti`; the browser
  binding still stands.
- addon-auth and the hub ship together: an older OIDC addon's bridges carry
  no binding and are refused.

## Enforcement

`sso-finish.spec.ts` (replay, no cookie, another browser's cookie, not burned
by a stolen copy, unbound bridge, link refusals), `used-bridge-ids.spec.ts`,
`sso-routes.spec.ts` (cookie cleared on every answer), `auth-oidc.addon.spec.ts`
(cookie attributes; the bridge carries the hash, never the cookie),
`mask-url.spec.ts`, `log-redactor.spec.ts`.
