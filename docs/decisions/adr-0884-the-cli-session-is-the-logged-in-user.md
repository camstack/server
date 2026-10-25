---
id: D884
title: The CLI session is the logged-in user
status: superseded
date: 2026-10-19
supersedes:
applies-to:
  - packages/cli/src/commands/auth.ts
  - packages/cli/src/cli.ts
  - packages/develop/src/hub/credentials.ts
  - packages/develop/src/hub/session-store.ts
  - packages/develop/src/hub/session-refresh.ts
  - packages/develop/src/hub/login-hints.ts
  - packages/mcp-dev/src/ops/hub.ts
  - packages/mcp-dev/src/ops/query-gate.ts
  - scripts/hub/hub.mjs
---

## Context

The CLI minted a narrow `cst_` scoped token after every login and treated
admin deploy/update as a separate `camstack login --admin` path that wrote a
`csa_` file the credential chain auto-loaded. Operators had two credentials,
two mental models, and MCP gates that only recognised `csa_` as admin tier
even when the login JWT already carried `isAdmin: true`.

## Decision

`camstack login` caches the login JWT from `auth.login` (including after TOTP).
Whether deploy and server update are allowed follows the logged-in user. The
credential chain is `--token`, `--token-file`, `$CAMSTACK_TOKEN`, then the
cached session — never an auto-read admin-token file. Local tier hints treat
`csa_` (when explicitly presented), JWT `isAdmin`, and `isAdmin` on the session
file as admin; `cst_` stays protected. `--admin` / `--admin-days` are accepted
and ignored (muscle memory); they must never fail the login.

This retires only the CLI operator path that minted a separate admin token and
auto-loaded `~/.camstack/<host>.admin-token` files. Server-side validation of
`csa_` tokens (D816) is unchanged — tokens already issued remain valid when
presented explicitly.

## Consequences

Legacy `~/.camstack/<host>.admin-token` files are ignored: not used for
authentication, and (since 2026-10-21) not even for hub discovery. Operators run
`camstack login <host>` with an admin account once; the session is refreshed
automatically and every tool uses it.

## Enforcement

Tests in `packages/develop/src/hub/__tests__/session-refresh.spec.ts` and
`packages/mcp-dev/src/__tests__/ops-admin-hint.spec.ts`; `camstack login --admin`
must error in `packages/cli/src/cli.ts`.
