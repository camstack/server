---
id: D816
title: An ops script acts as admin only through an admin token — created by an admin with re-authentication, expiring within 90 days, audited on every use
status: superseded
date: 2026-10-09
supersedes:
applies-to:
  - server/backend/src/core/auth/credential-token.service.ts
  - packages/system/src/auth/auth-audit-log.ts
  - server/backend/src/api/core/auth-tokens.procedures.ts
  - server/backend/src/api/trpc/trpc.context.ts
  - scripts/hub/hub.mjs
  - scripts/ops/keychain-migrate-hub.mjs
---

## Context

Scoped tokens (`cst_`) are always non-admin, so a script needing admin (the
keychain migration, a release's `applyServerUpdate`) needed a human login
(D797's ordering note) — or a long-lived admin JWT, which is exactly the
credential `createServiceToken` used to mint for nobody.

## Decision

An admin token (`csa_…`) is the one admin-capable credential that is not a
person's session:

- created only through `auth.createAdminToken` by an admin, in a real
  signed-in session (a token cannot mint a token), after re-authentication
  (D813);
- expiry mandatory, 1–90 days (default 7); shown once; stored as a SHA-256
  hash, like `cst_`;
- resolved at the tRPC boundary to an ADMIN principal attributed to its
  creator; every use is written to the auth audit log (path, client address);
- dead once revoked, expired, or its creator is deleted or no longer admin;
- not a JWT and not a session, so a signing-key change leaves it working; it
  cannot mint handoff codes or manage sessions.

`cst_` tokens stay non-admin. `scripts/hub/hub.mjs` and the keychain ops script
take `--token-file`.

## Consequences

- Admin tokens authenticate tRPC only, not addon routes or uploads; the
  developer `camstack deploy` flow keeps its addon-scoped `cst_`.
- The audit log grows one row per admin-token request; it keeps 90 days.

## Enforcement

`admin-token-manager.spec.ts`, `auth-audit-log.spec.ts`,
`auth-router-admin-tokens.spec.ts` (admin + re-auth + real session to create,
≤ 90 days, audited use, revoked and demoted-creator tokens refused, a token
cannot mint a token or a session), the admin-token case in
`credential-lifecycle.spec.ts`.
