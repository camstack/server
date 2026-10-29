---
id: D971
title: The desktop app and its node talk through data-dir files
status: accepted
date: 2026-10-29
supersedes:
applies-to:
  - packages/node-root/src/desktop-app-channel.ts
  - packages/desktop/src/desktop-state-file.ts
  - packages/desktop/src/desktop-install-request.ts
  - packages/types/src/capabilities/server-management.cap.ts
---

## Context

The hub could see a node's closure version but not the native app (Electron)
around it: which app version, whether an update was downloaded, and there was no
way to say "install it and restart". The obvious channels are env vars and
`process.send`, and both assume the node is Electron's child. With the Windows
service it is not: the service starts the node, and the app is just another
process on the machine. Env is also forbidden for state (root `AGENTS.md`).

## Decision

The app and its node exchange two files in the node's data dir, under
`server-root/`, each written atomically (tmp + rename), one direction each.
`desktop-app-state.json` (app to node) carries the app version and updater
state, rewritten on every updater transition and on a 5-minute heartbeat; the
node serves it as `desktopApp` on `getServerPackageStatus`, marking it
`stale` once it is older than 15 minutes, because a stale record is not "no
update". `desktop-install-request.json` (node to app) is written by
`server-management.installDesktopUpdate` and consumed once by the app (read +
delete); a request older than 60 s is dropped, and the app acts only when its
own update is downloaded. The node refuses, with a named reason, when it is not
inside the desktop app, the state is absent or stale, or nothing is downloaded.

## Consequences

The layout and both halves of the read/write live in `@camstack/node-root`
(`desktop-app-channel.ts`), used by node and app alike. `accepted: true` means
the request was written, not that the app restarted; the restart is seen on
`desktopApp.version`. Open limit: the Windows service data dir is ACL-locked to
Administrators/SYSTEM, so the user's app cannot write there; until a dedicated
user-writable channel directory is granted by the service installer, the hub
reads that node's desktop state as absent or stale.

## Enforcement

Specs: `root-update-desktop-app.spec.ts` (node-root), `desktop-data-dir-channel.test.ts`
(desktop), `server-management-desktop-update.spec.ts` (backend). Nothing else.
