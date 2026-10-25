---
id: D813
title: Linking a sign-in account, disabling TOTP, removing a passkey and creating an admin token need a fresh re-authentication, not just a session
status: accepted
date: 2026-10-09
supersedes:
applies-to:
  - server/backend/src/api/core/auth-reauth.procedures.ts
  - server/backend/src/api/core/auth.router.ts
  - packages/system/src/auth/auth-manager.ts
  - packages/addon-admin-ui/src/components/auth/ReauthDialog.tsx
  - packages/addon-auth/src/webauthn/widgets/PasskeyEnrollment.tsx
---

## Context

D782 left open that a hijacked session can link the attacker's IdP account and
then sign in through it. The same session could also strip the user's second
factors (disable TOTP, remove a passkey) — every step the operator added to
make a stolen password insufficient fell to a stolen session.

## Decision

`auth.reauthenticate` takes the current password, or a passkey assertion from
`auth.reauthBeginPasskey`, and answers a 5-minute proof — a JWT of
`kind: 'reauth'`, never a bearer — bound to the user AND the login session it
was proved in. `beginExternalLink`, `disableOwnTotp`, `removeOwnPasskey` and
`createAdminToken` refuse without one (FORBIDDEN, worded so an older app can
say why). Re-authentication is limited per user and counts against the
account's failure bucket like a login.

## Consequences

- An installed viewer that calls these three without a proof gets the refusal
  until it adds the prompt (the server cannot be backward compatible here
  without leaving the hole open).
- A user with only SSO and a passkey proves it with the passkey.

## Enforcement

`auth-router-reauth.spec.ts` (missing, forged, expired, another user's,
another session's proof; a challenge token is no proof),
`auth-router-admin-tokens.spec.ts`, `ReauthDialog.spec.tsx`,
`LinkedSignIns.spec.tsx`.
