---
id: D846
title: The Windows agent service is a pinned WinSW around a supervisor, and never runs user-writable code
status: accepted
date: 2026-10-13
supersedes:
applies-to:
  - packages/desktop/src/windows-service/**
  - packages/desktop/scripts/winsw-bundle.mjs
---

## Context

The desktop app can be an agent node on Windows. Today the node is a child of
the Electron app, so it runs only while a user is logged in (a login item).
The operator wants an opt-in "run as a Windows service" so the agent starts at
boot and survives logout. Two things were tried or weighed before settling:

- `sc create` pointing straight at `node.exe`. Node does not speak the Service
  Control Manager protocol, so the SCM kills it after 30 s (error 1053). A
  service needs a wrapper.
- WinSW alone. It restarts the wrapped process only on an **error** exit. The
  node asks for its own restart — a node/framework update — by exiting 0
  (`agent-update-service`: "exit 0 … the supervisor relaunches"), and a service
  whose process exits 0 is simply stopped. The agent would go offline after its
  first update.

Wrappers evaluated: **node-windows** (an npm package that embeds an old WinSW
binary blob of its own, adds a runtime dependency, little maintained);
**NSSM** (downloaded from a site with no published checksums, unsigned, 2014,
unmaintained); **Task Scheduler** (no binary at all, but not a service: no SCM
semantics, no `Get-Service`, no recovery actions); **WinSW** (MIT, one small
.NET Framework executable, a GitHub release with a fixed URL).

A service is SYSTEM. If it runs a directory a normal user can write — a per-user
NSIS install under `%LOCALAPPDATA%`, or the user's data dir where the node keeps
the addons it executes — then any local user can have SYSTEM run their code.

## Decision

The Windows agent service is **WinSW `WinSW.NET461.exe` v2.12.0, pinned by
SHA-256 and verified at build time** (never downloaded on a user's machine),
shipped in the installer, wrapping a small **supervisor** that runs the bundled
real Node on the shared starter and relaunches it on **any** exit. It is
installed by **one UAC-elevated, encoded PowerShell** whose XML travels inside
the script and that locks the service directory and the service **data
directory** (`%ProgramData%\CamStack\agent-data`, seeded with the user's
`agent.json` only) to Administrators + SYSTEM before writing into them. It is
refused unless the app is installed under `Program Files`. It is opt-in; the
login item remains the default.

## Consequences

- One more pinned binary in the Windows installer (640 KB) and one more
  `.mjs` to re-hash on a version change.
- A per-user install cannot have the service; the operator must reinstall "for
  all users". The refusal says so.
- While the service is on, the setup window edits the user's `agent.json`, not
  the service's; the toggle off/on carries it over.
- Updates: `electron-updater` replacing files a running service holds is not
  handled yet (documented in `docs/architecture/windows-agent.md`).
- The supervisor, not WinSW, owns "relaunch", so WinSW's own failure actions
  only cover the supervisor dying.

## Enforcement

`winsw-bundle.test.ts` pins the hash; `service-script.test.ts` asserts the lock
precedes any write, that the XML is inside the script and that the only
user-owned file read while elevated is `agent.json`; `service-manager.test.ts`
asserts the Program Files refusal; `supervisor.test.ts` asserts a clean exit is
relaunched. None of it has run on a real Windows host.
