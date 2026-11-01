---
id: D988
title: A terminal with no TTY signs in by an approval the operator gives in the admin UI
status: accepted
date: 2026-11-01
supersedes:
applies-to:
  - server/backend/src/core/auth/cli-approval.service.ts
  - server/backend/src/api/core/auth-cli-login.procedures.ts
  - packages/cli/src/commands/login-approval.ts
  - packages/cli/src/mcp/setup-login.ts
  - packages/cli/src/commands/mcp-update.ts
  - packages/addon-admin-ui/src/pages/Approve.tsx
---

## Context

An assistant's shell has no TTY, so `camstack login` could not prompt, and the
only non-interactive route was a token file the operator had to mint and place
by hand. Typing a password into an assistant is refused (D783, D797), and a
sign-in URL that carries the code lets whoever reads the transcript approve it.

## Decision

`camstack login <host>` with no TTY (or `--browser`) starts a device-flow
request: the hub returns a short code (8 Crockford characters) and a device
secret held only in the CLI's memory. The operator opens `/approve` in the
admin UI where they are already signed in, types the code and approves. The
URL never carries the code and the page never prefills it. Approval needs a
fresh authentication (`assertFreshAuthentication`). The CLI polls with the
secret and receives a normal refreshable session minted through the one mint
(`method: 'cli-approval'`); it is saved 0600. Secrets and codes are stored
hashed, single use, five minutes, bounded. The assistant tools `setup_login`
and `setup_login_wait` return only the URL, the code and a status, never a
session.

`camstack mcp update <version>|--latest` and `mcp rollback` switch only the
installer's managed layout: stage, run `mcp doctor --json`, then move `current`
by an atomic symlink rename, keeping `previous`. `~/.camstack` is never touched.

## Consequences

A terminal sign-in appears in "Pending terminal sign-ins" with a "Not me"
button, so an unexpected request is visible and deniable. A denied or expired
request leaves nothing on disk. The poll uses the ceremony limiter (30/min), not
the credential one.

## Enforcement

`check-session-jwt-single-mint` (the one mint), specs for the service, the
router (fresh auth, mint once, 401 after), the CLI (no code in the URL, 0600,
no secret in a tool result) and `mcp-update` (a failing doctor leaves `current`).
