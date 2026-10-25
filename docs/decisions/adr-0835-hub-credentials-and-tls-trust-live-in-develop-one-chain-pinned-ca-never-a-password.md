---
id: D835
title: Hub credentials and TLS trust live in @camstack/develop — one chain for the CLI, hub.mjs and the ops MCP; a pinned CA, never a password or a certificate bypass
status: accepted
date: 2026-10-13
supersedes:
applies-to:
  - packages/develop/src/hub/credentials.ts
  - packages/develop/src/hub/session-store.ts
  - packages/develop/src/hub/hub-url.ts
  - packages/develop/src/hub/hub-tls.ts
  - packages/develop/src/hub/hub-client.ts
  - packages/mcp-dev/src/ops/hub.ts
  - packages/mcp-dev/src/ops/query-gate.ts
  - scripts/hub/hub.mjs
---

## Context

Three programs talked to the hub with three credential stories: the `camstack`
CLI (flag, token file, `$CAMSTACK_TOKEN`, cached session), `scripts/hub/hub.mjs`
(a password in a gitignored file, a cached JWT, `NODE_TLS_REJECT_UNAUTHORIZED=0`
process-wide) and the track audit script (a hard-coded address, a token file,
the same TLS switch). The developer MCP (plan `2026-10-09-developer-mcp-plan.md`,
P2) needed a fourth. Copying the CLI chain would have made four; extending
`hub.mjs` would have kept a password and a certificate bypass in the tooling that
the repo's own rules forbid (D797, D816).

Two homes were possible for the shared code: `@camstack/sdk/node` and
`@camstack/develop`. The CLI already depends on `@camstack/develop` and the MCP
does too; `@camstack/sdk` is a framework package that ships inside the server
closure and would have needed a new dependency from the CLI, whose point is to
stay near zero dependencies.

## Decision

Hub access is one module set in `@camstack/develop` (`packages/develop/src/hub`):

- **Update (2026-10-21): one token format.** The admin-token file and
  `$CAMSTACK_ADMIN_TOKEN_FILE` are gone from the chain, and the tier no longer comes
  from a `csa_` prefix: the chain is `--token`/`--token-file` (explicit overrides),
  `$CAMSTACK_TOKEN`, then the `camstack login` session, which is refreshed
  automatically (`auth.refreshSession`; a 401 refreshes once and retries once). The
  tier is read from the token's claims, or from `whoami` for an opaque token. Run
  `camstack login <host>` once; every tool uses that session. The text below is the
  original decision.
- **One credential chain**, first hit wins: `--token-file`, then the admin token
  file (a `csa_` token, D816, `~/.camstack/<host>.admin-token` or the path in
  `$CAMSTACK_ADMIN_TOKEN_FILE`), then (CLI only) `$CAMSTACK_TOKEN`, then the
  `camstack login` session in `~/.camstack/<host>.json`. **There is no password
  input anywhere in the chain.** The MCP passes an environment without
  `$CAMSTACK_TOKEN`: no secret travels through the environment (D783).
- **The credential carries a tier**: `admin` only for a `csa_` token, otherwise
  `protected`. The MCP refuses an admin-tier method client-side with a protected
  credential; the hub still decides on every call.
- **The hub address is never in code**: `--server`, `$CAMSTACK_HUB_URL` /
  `$CAMSTACK_SERVER`, the gitignored `scratchpad/.hub-url`, then the session.
- **TLS verification is never switched off.** A private certificate is trusted
  by a PEM — the hub's own certificate when self-signed, or the CA that issued it
  — saved as `~/.camstack/<host>.ca.pem` or named in `$CAMSTACK_HUB_CA_FILE`.
  Standard verification (chain, expiry, host name) runs against it. A leaf issued
  by a CA cannot be pinned alone: Node accepts no partial chain.
- **The ops MCP is read-only by construction**: its hub object exposes `query`
  and nothing else, and the gate admits only methods the generator marks
  `kind: query` in `docs/reference/api.md`, never a secret-bearing method.

`scripts/hub/hub.mjs` becomes a thin caller of this chain; `login` is gone.

## Consequences

- The CLI imports its chain from `@camstack/develop`; `packages/cli` no longer
  owns `credentials.ts` or the session cache. A breaking change to the chain is
  now a `@camstack/develop` release.
- A `camstack login` session is scoped to the addons capability
  (`capability:addons[view,create]`), so it reads only `addons.*` routes
  (measured against the live hub on 2026-10-13: `addons.listCapabilityProviders`
  answered, `system.info` was refused). Anything else a diagnostic needs wants an
  admin token. This is the real boundary of "the cached session for protected
  reads"; widening the login scope is a separate decision.
- `hub.mjs` needs `@camstack/develop` built once. Skills that said `hub.mjs
  login` now say to save an admin token.
- Other scripts that read `scratchpad/.tok` themselves (`bench-detector-latency-column`,
  `pause-restore`, two evaluators, the keychain migration) still skip TLS
  verification on their own; they are follow-ups, not part of this record.

## Enforcement

`packages/develop/src/hub/__tests__/{credentials,session-refresh,hub-access}.spec.ts`
(chain order, tier, no password input, session store, address resolution, pinned
CA, tRPC envelope), `packages/mcp-dev/src/__tests__/ops-gate.spec.ts` (query-only,
admin tier, secret-bearing methods, env ignored, redaction, truncation) and
`ops-mcp.spec.ts` (every ops tool annotated read-only over MCP).
