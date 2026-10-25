---
id: D180
title: A hand-off token authenticates nothing on `/trpc` either — the classifier gates both surfaces, not one
status: accepted
date: 2026-08-19
supersedes:
applies-to:
  - server/backend/src/api/trpc/trpc.context.ts
---

## Context

[D103](adr-0103.md) built `classifyBearerPrincipal` because every token this hub
mints verifies under the same `auth.jwtSecret`, so `jwt.verify` succeeding means
"we minted this" and never "this is an API credential". It then wired the
classifier into ONE surface — `/addon/:addonId/*`, via `gateAddonJwt` — and its
Consequences section recorded that "`/trpc` held too".

That reading was measured from the wrong end. What held on `/trpc` was the SCOPE
matcher: the probe used in D103 asked for a capability the token's grant did not
name, so it answered `FORBIDDEN … Have: category:device[view,create]`. That is a
refusal ON THE GRANT — it proves the principal was RESOLVED. `resolveUser` ran
the same three-way classification on 2026-08-19 (the Home Assistant scope fix
put `classifyBearerPrincipal` in that function, for the `session`-only live-scope
guard) and did nothing with a `not-a-credential` verdict. So on `/trpc`:

| Bearer | `/addon/*` (since D103) | `/trpc` (before this) |
| --- | --- | --- |
| session JWT | passes | passes |
| `oauth-access` | grant-checked | **passes, with its grant** |
| `oauth-code` (60 s, single-use, redirect URL) | `401 not-a-credential` | **passes, with the code's grant** |
| `oauth-refresh` (30 d, belongs to `/oauth/token`) | `401 not-a-credential` | **passes, with the grant** |
| `oidc` / `magic-link` bridge (`?bridge=`) | `401 not-a-credential` | **passes as its claimed user** |
| `totp-challenge` (login leg 1) | `401 not-a-credential` | **passes as the pre-2FA user** |

The last row is the sharp one: a `totp-challenge` carries `userId`, `username`
and the real `isAdmin`, and NO `scopes`. An admin's challenge token — handed out
by `auth.login` after the PASSWORD leg alone, before any second factor — resolved
to an admin principal on `/trpc`, where `isAdmin` bypasses the scope matcher
entirely. The second factor was a formality for anyone willing to send leg 1's
token as a bearer instead of typing a code. `POST /api/auth/session` had already
been taught to refuse exactly this token (`isSessionGradeJwtPayload`), for
exactly this reason; `/trpc` never was.

An `oauth-code` is worse than a stolen access token in one specific way: it
travels in a **browser redirect URL**, so it lands in history, `Referer` headers
and every proxy log on the path, and it is issued before the user has finished
consenting.

## Decision

**`resolveUser` refuses a `not-a-credential` verdict, and the allowlist is the
two kinds `classifyBearerPrincipal` names — nothing wider.**

- `session` (no `kind` claim) — `auth.login`'s JWT, the session minted by
  `/api/auth/sso/finish`, a `type: 'service'` agent token, a `type: 'api_key'`
  token. Passes exactly as before.
- `integration` (`kind: 'sso-bridge'`, `provider: 'oauth-access'`) — the
  account-link credential a component calls `/trpc` with. Passes, carrying the
  consented grant (D103's rule that the store never gets a vote on a link
  stands).
- everything else — `null`, i.e. `UNAUTHORIZED`, and the reason is LOGGED. The
  context factories therefore take a logger: a bearer refused HERE never reaches
  a procedure, so tRPC's `onError` never fires and the drop would otherwise be
  silent.

**The TOTP login is unaffected by construction, and that is the load-bearing
check, not a hope.** The challenge is a procedure INPUT —
`loginVerifyTotp({ challengeToken, code })`, `loginBeginPasskey`,
`loginVerifyPasskey` — on a PUBLIC rate-limited procedure that reads nothing off
`ctx.user`. Nothing puts it in a header: the SDK's `login()` calls `setToken`
only when `!requiresSecondFactor`, and the admin UI returns it as
`{ kind: 'second-factor', challengeToken }` without touching `localStorage`. The
same is true of every other refused kind — `oauth-code` and `oauth-refresh` are
read from the POST body by `server/backend/src/api/oauth2/oauth2-routes.ts`, and
an SSO bridge from `?bridge=` on `/api/auth/sso/finish`.

## Consequences

- `/trpc` and `/addon/*` now answer the "is this a credential" question from one
  derivation. A new bridge `provider` is refused on BOTH surfaces by default,
  which is the correct direction to fail — but it means adding an API credential
  is an edit to `classifyBearerPrincipal`, not to a call site.
- Revocation is still not immediate for `oauth-access` on `/trpc` (D103's open
  consequence, unchanged): neither surface re-reads the OAuth session per
  request, so a revoked link keeps working for the access token's remaining
  hour. This decision narrows WHICH tokens get that hour; it does not shorten it.
- The context factories gained an optional logger parameter. It defaults to
  `null` so the mesh path and every test that builds a context by hand are
  untouched — which also means a caller that forgets it gets a silent refusal.
  The two production call sites in `main.ts` pass one.
- Nothing changes for `cst_` / `csv_` opaque tokens: both are resolved before
  the JWT branch and never reach the classifier.

## Enforcement

- `server/backend/src/api/trpc/__tests__/non-credential-bearer.spec.ts` — each
  refused kind, each admitted kind, and the login flow end-to-end through the
  REAL `createAuthRouter` + `AuthService`: the challenge resolves to no
  principal, `loginVerifyTotp` still mints the session, and that session then
  authenticates. Deleting the branch in `resolveUser` fails the first three.
- `packages/types/src/__tests__/principal-scope.spec.ts` — the classification
  itself (D103).
