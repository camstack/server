---
id: D1051
title: A server shell is a separate trust level, off until the node opts in
status: accepted
date: 2026-11-14
supersedes:
applies-to:
  - packages/types/src/capabilities/terminal-session.cap.ts
  - packages/addon-terminal/src/server-shell.ts
  - packages/addon-terminal/src/terminal-session-manager.ts
  - packages/addon-terminal/src/pty.ts
  - packages/addon-admin-ui/src/pages/system/ServerShell.tsx
---

## Context

`terminal-session` only opens allowlisted profiles. `openSession` also accepts
executable, argument, directory and environment overrides, so the allowlist no
longer bounds what an admin can run — the admin tier is the bound. A login
shell on the hub or an agent is a further step: it is the node's own shell, in
the node data directory, not a named monitor binary.

The first design asked for a fresh passkey or TOTP check before the shell
opened. That was rejected. Every method on the capability is already
`auth: 'admin'`, and a second prompt does not name a threat the admin session
does not already have. It would also block the reattach the pty is built for:
the session outlives the tab, and a re-auth gate on every attach would make
that survival useless.

## Decision

A server shell is profile `server-shell` on the existing per-node provider.
It is a new trust level past the allowlisted profiles, and it is held by four
controls:

1. Admin only. The methods stay `auth: 'admin'`. There is no re-authentication step.
2. Off until the node opts in. One boolean, `serverShellEnabled`, default false,
   owned by the provider and edited from the Terminal page. `serverShellOptIn`
   is the only place that boolean is interpreted.
3. Audited. One log line per open, attach, close and idle close, with
   `tags: { nodeId, sessionId, userId }`.
4. Idle timeout. A session with no input and no output for
   `serverShellIdleMinutes` (default 30) is closed and logged as idle.

The child is the login shell (`/bin/bash` in a container, otherwise `$SHELL`
or `/bin/zsh` on macOS). Its working directory is the node data directory.
Its environment is the allowlist `PATH`, `HOME`, `LANG`, `TERM`, `USER` and
nothing else — the process environment is not copied (D783, D797). Caller
overrides of executable, arguments, directory and environment are ignored for
this profile. While the opt-in is off, open is refused with a typed reason
that names the node. The profile is not a camera.

## Consequences

An admin who turns the switch on can run commands as the server user on that
node. The audit line is the record of who did. A node that never opts in
cannot be opened, and the UI shows that reason rather than a blank terminal.
The idle close is the bound on a forgotten tab.

The auth audit trail is not this record. Its actions are authentication
events. The shell audit is the provider's logger, tagged so a node can be
filtered later.

## Enforcement

Specs: refused when the opt-in is off and the error names the node; the spawn
environment carries no name outside the allowlist, including through the pty
`replace` mode; an idle sweep closes the session and logs it; open, attach
and close lines carry `nodeId`. Nothing else checks the trust level.
