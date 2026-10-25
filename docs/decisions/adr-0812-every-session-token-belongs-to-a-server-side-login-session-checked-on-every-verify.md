---
id: D812
title: Every session token belongs to a server-side login session, checked on every verify; access tokens are short and refreshed
status: accepted
date: 2026-10-09
supersedes:
applies-to:
  - packages/system/src/auth/login-session-manager.ts
  - packages/system/src/builtins/local-auth/local-auth.addon.ts
  - server/backend/src/core/auth/auth.service.ts
  - server/backend/src/auth/hub-sessions.ts
  - server/backend/src/auth/session-mint.ts
  - server/backend/src/auth/session-lifetimes.ts
  - server/backend/src/api/core/auth-sessions.procedures.ts
  - server/backend/src/api/core/auth.router.ts
  - server/backend/src/api/trpc/trpc.context.ts
  - server/backend/src/api/trpc/trpc.middleware.ts
  - server/backend/src/core/auth/handoff-code.service.ts
  - packages/sdk/src/session-keeper.ts
  - packages/addon-admin-ui/src/lib/admin-session.ts
---

## Context

A session was a self-contained 30-day JWT. Nothing on the hub knew it existed:
`auth.logout` did nothing server-side, a password change left every other
device signed in, a deleted user's sessions and `cst_` tokens lived on (the
tokens until the next restart). The only way to end a session was to rotate
the signing key — which ended all of them. Reachable from the internet through
the tunnel, that was the plan's second-highest risk.

## Decision

Every login opens a row in `local-auth`'s `login_sessions` table and the token
carries its id (`sid`). `AuthService.verifyToken` asks that row on EVERY verify
of a session-grade token, so a revocation applies at once on every surface
(tRPC, addon routes, the session cookie, OAuth authorize, uploads, health); an
open WebSocket re-checks it on every call.

- A refreshing client (`refreshable: true` at login) gets an access token of
  `auth.accessTokenExpiry` (default 2 h) and an opaque `csr_` refresh token,
  stored hashed. `auth.refreshSession` rotates it and slides the session's
  expiry to `auth.tokenExpiry` (default 30 days, "Session lifetime"). A
  rotated-out refresh token presented after a 30 s grace revokes the session.
- `logout` revokes the session (`everywhere` — all of the user's). A password
  change ends the user's other sessions; an admin password reset, all of them;
  deleting a user ends its sessions, scoped tokens, OAuth links, admin tokens,
  TOTP row and sign-in links in the same call. A `cst_` token whose owner is
  gone is refused.
- A token minted before sessions existed (no `sid`) is accepted until the
  user's cutoff: any revoke-all moves it.
- For one release, a login WITHOUT `refreshable` gets one access token for the
  whole session (still `sid`-bound), and the installed viewer's renewal
  (`createHandoffCode` + `redeemHandoffCode`, purpose `renew` by default)
  continues the same session. `purpose: 'new-session'` (native sign-in, browser
  handoff) opens a separate one.

## Consequences

- A signing-key rotation no longer ends refreshing sessions: their refresh
  tokens are opaque and mint new access tokens under the new key. Ending
  sessions is now revocation (logout everywhere, an admin's revoke).
- `local-auth` must be up for any session to verify (fail closed).
- Next release: drop the legacy branch (refuse logins without `refreshable`
  and `sid`-less tokens, make `renew` handoffs opt-in).

## Enforcement

`login-session-manager.spec.ts` (rotation, theft, grace, restart),
`credential-lifecycle.spec.ts` (delete, reset, change, orphan `cst_`),
`hub-sessions.spec.ts`, `auth-router-sessions.spec.ts` (refresh, logout,
everywhere, password change, legacy renewal, open WebSocket),
`session-lifetimes.spec.ts`, `session-keeper.spec.ts`, `admin-session.spec.ts`,
`scripts/check-session-jwt-single-mint.ts`.
