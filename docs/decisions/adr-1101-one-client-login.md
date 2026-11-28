---
id: D1101
title: A client tool authenticates to a hub through the dominevo login session and nothing else
status: accepted
date: 2026-11-25
supersedes: D835
applies-to:
  - packages/develop/src/hub/credentials.ts
  - packages/develop/src/hub/session-refresh.ts
  - packages/cli/src/commands/removed-token-flags.ts
  - packages/mcp-develop/src/track-review/config.ts
  - packages/nx-plugin/src/lib/resolve-config.ts
  - scripts/hub/credentials.mjs
  - scripts/hub/hub.mjs
  - scripts/check-single-client-login.ts
---

## Context

D835 gave every client tool one resolver, but kept an override ladder on top of
the session: `--token`, `--token-file`, `$CAMSTACK_TOKEN`, `$CAMSTACK_HUB_TOKEN*`,
the `<host>.admin-token` file, `scratchpad/.tok`, and per-script passwords. Each
step was "an explicit override only", and each one grew callers that decided on
their own which source counted. The failure was the same every time: a stale
file or a leftover variable silently won over the session the operator had just
logged into, a script carried its own password flow beside the real one, and an
MCP refused to start because "an env token needs a named hub". Three guards
(`check-no-token-file-lookup`, the secrets guards, review) each caught a slice.
Keeping `--token-file` for headless use was the argument for the ladder, and it
does not hold: a headless service logs in once, interactively, and the saved
session renews itself.

## Decision

A client tool reaches a hub through the `dominevo login` session
(`~/.camstack/<host>_<port>.json`, renewed by `session-refresh`) and no other
credential. `--token`, `--token-file`, `$CAMSTACK_TOKEN`, `$CAMSTACK_HUB_TOKEN*`,
token files, rc files and a password in a script are removed, and anything that
depended on one is migrated, not exempted. The address (`--server`,
`CAMSTACK_HUB_URL`, `scratchpad/.hub-url`, the session's hub) and the CA stay as
D835 set them; TLS verification is never switched off. A removed flag fails with
a message that says `dominevo login`. An agent does not log in on its own.
The agent JOIN token is a node's identity, not a client login, and is untouched.

## Consequences

A CI box or service logs in once by hand on that machine; there is no long-lived
secret to mint, copy or rotate for it. A script that needs the hub asks
`resolveHubAuth()` or calls `hub.mjs`; shell scripts wrap `dominevo deploy`.
Scripts that spoke to endpoints that no longer exist were deleted rather than
ported. The how-to is one skill, `hub-access`, which the other skills point at.

Rejected: keeping `--token-file` for headless use (a second credential, with
its own lookup rules and staleness, for a case the refreshing session already
covers) and keeping an env token for CI (an environment secret, against D797).

## Enforcement

`scripts/check-single-client-login.ts` (wired into `checks.yml`) refuses an env
token read, a `--token` / `--token-file` option, and an `auth.login` /
`system.login` / `admin.login` call from `scripts/`, in `.sh` files too; the
agent join files are exempt by name. Specs: `single-login.spec.ts` (develop),
`removed-token-flags.spec.ts` (cli), `hub-mjs-single-login.spec.ts` and
`check-single-client-login.spec.ts` (scripts).
