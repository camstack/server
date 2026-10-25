---
id: D892
title: One token format; permissions are scopes, and one verifier and one matcher decide every request
status: superseded
superseded-by:
  - D895
date: 2026-10-21
supersedes: D816, D884
applies-to:
  - packages/types/src/auth/credential-scope.ts
  - server/backend/src/auth/credential-verifier.ts
  - server/backend/src/api/trpc/principal-authorization.ts
  - server/backend/src/api/trpc/trpc.context.ts
  - server/backend/src/api/trpc/trpc.middleware.ts
  - server/backend/src/auth/addon-route-auth.ts
  - server/backend/src/core/auth/credential-token.service.ts
  - server/backend/src/auth/scope-escalation.ts
  - server/backend/src/api/core/auth-tokens.procedures.ts
  - server/backend/src/api/core/auth-revoke-credentials.procedures.ts
  - server/backend/src/api/auth-whoami.ts
  - server/backend/src/api/upload-auth.ts
---

## Context

The hub accepted five bearer formats — the session JWT, the `csr_` refresh
token, the `csa_` admin token (D816), the `cst_` scoped token and the `csv_`
share link — and every surface branched on WHICH one arrived. The tRPC context
built a different principal per prefix (`isScoped`, `shareView`,
`adminTokenId`, `isApiKey`), `main.ts` re-implemented its own prefix chain for
addon routes and data planes (a `cst_` with `addon:X` reached X's ADMIN routes
there; a `csa_` was refused there as "not a JWT"), the upload gate and
`/api/auth/whoami` had a third and fourth copy (whoami answered 401 for a
`csa_` and a `csv_`), and revocation needed the caller to name the kind. Two
answers to "may this bearer do this" disagreed with each other, and the CLI
had to classify tokens by prefix to know what it held (D884).

## Decision

**One verifier, one matcher, one mint.**

- `createCredentialVerifier` turns every bearer into a `Principal { subjectId,
  scopes: CredentialScope[], isAdmin, credentialId, auditTag }`. `isAdmin`
  means `scopes` holds `'*'`. The vocabulary is the v3 `TokenScope` plus
  `'*'`, `share-view` (one fail-closed embed perimeter, restricting its holder)
  and `addon-routes` (what a person's session has always reached on addons'
  own routes).
- Authorization everywhere — `protectedProcedure`, the share-view allowlist,
  `/addon/:addonId/*` routes and data planes, uploads — goes through
  `authorizeProcedure` / `authorizeAddonRoute` on `principal.scopes`. The kind
  of credential is never read: `auditTag` is attribution only. Minting,
  re-authentication and session management read the credential's PROVENANCE
  (`interactive` = a login session; `userDelegated` = a session or an account
  link), never its kind: a token still cannot mint a token.
- There is ONE token format: `auth.mintToken({ scopes, expiresIn, label })`
  issues a JWT `{ kind: 'credential', sub, jti, scopes }` (the `kind` names the
  family so every older gate refuses it; it never names a permission) and a
  `core-auth` `credential-tokens` row: SHA-256 of the `jti`, label, scopes, the
  ONE expiry, last use, revoked. The verifier reads the row by `jti` on every
  request; the JWT carries no `exp`, so the row is the only expiry authority
  and a share link's expiry can slide (`extendShareToken`). A mint never
  exceeds the caller (`scopesWithin`, refused, never trimmed); `'*'` needs an
  admin and a fresh re-authentication (D813); every lifetime is at most 90
  days, `'never'` only for a lone share-view grant. `createAdminToken` and
  `createShareToken` stay one release as thin wrappers minting this format.
- Revocation is by credential id (`auth.revokeCredentials` without `kind`,
  `auth.revokeToken`); the audit records the id.
- The legacy formats are ADAPTERS inside the verifier, with the permissions
  they had: `csa_` → `'*'`; `cst_` → its scopes; `csv_` → one share-view grant;
  a session JWT → `'*'` for an admin, else the user's live scopes plus
  `addon-routes`; an `oauth-access` link → its grant.

**Removal of the adapters.** A legacy token is valid until it expires or is
revoked. `csa_` lives at most 90 days and `csv_` at most 30 days (or `never`);
`cst_` may be non-expiring. The adapters go when BOTH hold:

1. 90 days have passed since the release that stopped minting EVERY legacy
   format. Admin tokens and share links stop with this change; `cst_` is still
   minted by `userManagement.createScopedToken` (local-auth) until that cap
   method mints the unified format. If that ships in the same release as this
   record, on 2026-10-21, the earliest removal date is **2027-01-19**
   (2026-10-21 + 90 d: 10 d left in October, + 30 November = 40, + 31
   December = 71, + 19 January = 90).
2. A re-issue pass has replaced every non-expiring `cst_` and every
   `never` `csv_` with a unified token, and `auth.listTokens` (legacy rows
   flagged `legacy: true`) shows none left.

## Consequences

- A `cst_` with `addon:X` no longer reaches X's admin routes, and its grant's
  access flavour now applies on addon routes (it passed on the target alone).
  A `csa_` reaches addon routes as the admin it already was on tRPC.
- A unified token is signed with the session signing key: a key rotation ends
  every unified token (a `csa_` survived one). Ending tokens is revocation, so
  a rotation is now also a revocation of every minted token.
- Deleting a user does not cascade into `credential-tokens` (the rows live in
  `core-auth`, not local-auth); the verifier refuses a token whose subject is
  gone, and a `'*'` token whose subject is no longer admin.
- `GET /api/auth/whoami` answers from the principal for every credential:
  `{ ok, kind: 'jwt'|'scoped', userId, username, isAdmin, scopes,
  credentialId, credential, legacy }`.

## Enforcement

`credential-adapters.spec.ts` (every format × admin / hand-written / cap /
share-allowlisted procedure, the same permissions as before),
`addon-route-authorization.spec.ts` (the same table on addon routes and data
planes), `auth-router-mint-token.spec.ts` (escalation refused, `'*'` needs
re-auth, a token cannot mint, a revoked `jti` is refused, the wrappers mint the
unified format), `auth-router-revoke-by-id.spec.ts`,
`auth-whoami-unified.spec.ts`, `auth-login-refresh-contract.spec.ts`. No guard
yet forbids a new prefix check outside the verifier.
