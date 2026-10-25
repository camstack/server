---
id: D895
title: There is one token and no other bearer format; a share link is a token, and only a login session becomes a session
status: accepted
date: 2026-10-21
supersedes: D892
applies-to:
  - server/backend/src/auth/credential-verifier.ts
  - server/backend/src/auth/scope-escalation.ts
  - server/backend/src/auth/embed-auth-route.ts
  - server/backend/src/auth/live-user.ts
  - server/backend/src/api/core/auth-tokens.procedures.ts
  - server/backend/src/api/core/auth-revoke-credentials.procedures.ts
  - server/backend/src/api/oauth2/oauth2-routes.ts
  - server/backend/src/api/upload-auth.ts
  - server/backend/src/api/auth-whoami.ts
  - server/backend/src/core/auth/credential-token.service.ts
  - packages/system/src/auth/auth-manager.ts
  - packages/types/src/auth/credential-scope.ts
  - packages/addon-admin-ui/src/components/access/TokensSection.tsx
  - packages/addon-admin-ui/src/components/access/CreateTokenModal.tsx
  - scripts/check-no-legacy-token-prefix.ts
---

## Context

D892 unified every bearer into one principal and one token format, and kept
the three pre-D892 opaque formats (admin, scoped, share-view) alive as
ADAPTERS inside the verifier, with a removal date no earlier than 2027-01-19
and a re-issue pass as its precondition. It also kept the share-link routes
(`auth.createShareToken`, `extendShareToken`, `revokeShareToken`,
`listShareTokens`) and the admin-token routes as thin wrappers.

The operator ruled on 2026-10-21 to remove the legacy formats outright — no
adapters, no clock — and to delete the share-link layer rather than wrap it.
Two facts made the adapters worse than a flag day:

- Every adapter is a second door. The same day a security review found the
  doors D892 had left open next to them: the OAuth consent page and
  `/api/embed-auth` accepted ANY JWT this hub signs through the raw verify. A
  share link — a minted token with no `exp`, even a revoked one — set as the
  session cookie reached `consent=allow` and came back with a code for a
  fleet-wide device grant and a never-expiring refresh, for `userId: ''`.
- A wrapper keeps the vocabulary alive: clients kept classifying tokens by
  kind (admin / scoped / share), and the admin UI kept three sections for one
  thing.

## Decision

**One token, minted one way, verified one way; nothing else is a bearer.**

- A token is the JWT `auth.mintToken` issues, signed with its own audience
  (`camstack:credential`) and backed by a `core-auth` `credential-tokens`
  row. What it may do is its scopes. An admin token is a token holding `'*'`;
  a share link is a token whose only scope is a share-view grant.
- `createCredentialVerifier` accepts exactly: a login-session JWT, an
  `oauth-access` account link of an existing user, a minted token (through
  its own door, `verifyCredentialToken`). Any other bearer — the old opaque
  formats included — authenticates nobody: 401 everywhere.
- The surface is `auth.mintToken` (an admin may name a `subjectId`; an
  account link may mint a lone share-view grant), `auth.listTokens` (with a
  `label` filter, how a client finds the token it minted), `auth.extendToken`
  (renew in place), `auth.revokeToken` and `auth.revokeCredentials` (by id).
  There is no share-link route and no admin-token route.
- Only a person's LIVE login session becomes a session: the raw session
  verify (`AuthManager.verifyToken`) refuses a minted token, and the OAuth
  consent page and `/api/embed-auth` additionally require a session-grade JWT
  naming a user that exists.
- A token never outgrows its subject: a non-admin's token is cut to the
  subject's live scopes at every verify; `addon-routes` is admin-only to
  mint; share-view talk-back needs talk-back on every camera.
- Lifetimes: every token at most 90 days; `'never'` only for a lone
  share-view grant. The exception stands because a view link pinned to a wall
  display or a Home Assistant dashboard is deliberately permanent, restricted
  to a fixed perimeter of cameras, and revocation is its kill switch.
- The legacy rows stay on disk, their kinds declared so the storage layout is
  unchanged; nothing reads them. The operator drops them by hand.

## Consequences

- Every legacy token stops working at once and must be re-issued with
  `auth.mintToken`: scripts holding an admin token, integrations holding a
  scoped token, every share link already handed out (the viewer's grid and
  events share, Home Assistant's embed cache).
- The viewer's share dialogs and the Home Assistant component must move from
  the share-link routes to `mintToken` / `listTokens({ label })` /
  `extendToken` / `revokeToken`. Until they do, sharing from them fails.
- Tokens minted between D892 and D895 (no audience) are refused and must be
  re-minted.
- A minted token can never be replayed as a person's session on any surface
  that reads one: cookie, consent page, health, backups.

## Enforcement

`legacy-bearer-refused.spec.ts` (each old format × tRPC, addon route and data
plane, uploads, whoami → 401, with the old rows still live),
`auth-router-mint-token.spec.ts` (the one mint, extendToken, the account-link
rule, the routes that are gone), `credential-verifier-subject.spec.ts`,
`oauth2-authorize-login-session-only.spec.ts`, `embed-auth-route.spec.ts`,
`upload-auth-admin-only.spec.ts`, `credential-token-touch.spec.ts`,
`credential-principals.spec.ts`, `addon-route-authorization.spec.ts`. The
guard `scripts/check-no-legacy-token-prefix.ts` refuses the old prefixes in
any tracked source, comments included, with an empty allowlist.
