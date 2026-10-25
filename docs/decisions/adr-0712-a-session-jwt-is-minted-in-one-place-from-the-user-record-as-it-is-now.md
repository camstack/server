---
id: D712
title: A session JWT is minted in one place, from the user record as it is now; SSO finish swaps only a login bridge
status: accepted
date: 2026-10-06
supersedes:
applies-to:
  - server/backend/src/auth/session-mint.ts
  - server/backend/src/auth/sso-finish.ts
  - server/backend/src/api/core/auth.router.ts
  - scripts/check-session-jwt-single-mint.ts
---

## Context

Every login leg in `auth.router.ts` (TOTP / passkey second factor,
passkey-first, session exchange, handoff code) ended in one tail,
`mintSessionForUserId`, which re-reads the user from `user-management` and
signs from that record. `/api/auth/sso/finish` did not. It signed its own
session from the `sso-bridge` claims: the bridge's `isAdmin`,
`allowedDevices: {}`, and no `scopes` at all.

A magic-link bridge lives up to its configured TTL. A user deleted, or demoted
from admin, after the link was mailed still got a session — an admin one if the
bridge said so. The live scope refresh in `trpc.context.ts` was the supposed
safety net, and it does not cover this: it refreshes the scopes of a NON-admin
session only, falls back to the JWT's copy when the user is missing (so a
deleted user is not refused), and never re-reads `isAdmin` or `allowedDevices`.

The same endpoint had a second hole. The `sso-bridge` family also carries the
OAuth account-link tokens (`oauth-code`, `oauth-access`, `oauth-refresh`, D103),
which verify under the same secret. Any of them — `oauth-code` travels in a
browser redirect URL — was exchangeable at `/sso/finish` for a full browser
session of the linking user, outside the grant the operator consented to.

## Decision

**A session JWT is signed only by the session mint**
(`createSessionMinter`, `server/backend/src/auth/session-mint.ts`). It signs
from a `user-management` record read at mint time; the password login passes
the record `validateCredentials` just returned, every other leg passes a user
id and the mint re-reads it.

**`/api/auth/sso/finish` swaps only a LOGIN bridge** — `provider` is
`auth-magic-link`, or `auth-oidc/<instance>` with an `oidc:` user id — and
mints through the same mint (`server/backend/src/auth/sso-finish.ts`):

- a user with a record is minted from the record (a missing magic-link user is
  `401 User no longer exists`; the bridge's `isAdmin` is ignored);
- an `auth-oidc` identity with NO record is federated: `auth-oidc` does not
  provision users, the IdP vouched for the identity and the instance's
  `defaultRole` decided `isAdmin`. It is minted with no store grants
  (`scopes: []`, `allowedDevices: {}`), which is what it effectively had before.

## Consequences

- A magic-link, or an OIDC identity an operator has given a record, is refused
  or demoted at the next sign-in, not at the session's expiry.
- An OIDC identity without a record cannot be "deleted" — revoking it is the
  IdP's or the instance config's job. That is unchanged, and now stated.
- A new SSO provider must be added to `isLoginBridge`; until it is, its bridges
  are refused. Fail closed.
- Out of scope, and still true: a session ALREADY issued to a user who is then
  deleted keeps working until it expires — the context's live refresh does not
  revoke. Closing that is a separate change to `trpc.context.ts`.

## Enforcement

- `scripts/check-session-jwt-single-mint.ts` (CI `checks.yml`): `.signToken(`
  appears only in the session mint, `jwt.sign(` only in `AuthManager`.
- `server/backend/src/auth/__tests__/sso-finish.spec.ts`: a deleted
  magic-link user is 401, a demoted one is not admin, scopes and allowedDevices
  come from the record, a federated OIDC identity carries no grants, and every
  OAuth account-link token is refused. Reverting `sso-finish.ts` to the
  claims-based mint fails 7 of its 9 cases.
