---
id: D994
title: A debug watch is a hub-held window pushed as interest, never a stored value
status: accepted
date: 2026-11-02
supersedes:
covers:
  - packages/types/src/logging/debug-watch.ts
  - packages/system/src/logging/log-ring-buffer.ts
  - server/backend/src/api/core/logging-settings.ts
  - packages/addon-admin-ui/src/pages/system/LogWatch.tsx
---

## Context

An operator needs to read a device's debug dump live without paying for debug
logging the rest of the time. The existing channel windows (D248) already reach
every process, but they are persisted in the logging document, last up to 30
minutes and are renewed by writing the document: a watch left open would be an
armed window that outlives the page, and a restore would re-arm it.

Two other shapes were rejected. A per-call RPC ("is anyone watching?") puts a
network read on the log path and breaks D49. A debug level on the ordinary
logger would leave the lines in the ring and the thunk running all the time.

## Decision

A `debug.<channel>` line is emitted only through `ctx.debug(channel, deviceId,
thunk)`. The thunk runs only while an in-memory interest mirror, pushed by the
hub through the existing `log-channels` capability, names that (channel,
device). The log ring denies `debug.*` lines without that interest. The hub's
log service holds the watches in memory (`DebugWatchTable`): a 10 minute
window, re-armed by the open page every 4 minutes, never past 60 minutes from
the first start, and a lapsed watch is revived only by an explicit Start.
Watches are pushed as one full set together with the document's windows, and a
debug channel cannot be armed through the document.

## Consequences

A restart ends every watch; that is intended. An addon that uses `ctx.debug`
must declare its channel (`kind: 'debug'`) and run the `log-channels` provider,
or the page cannot list it and the process never receives interest.

## Enforcement

`debug-watch.spec.ts` (thunk, window, re-arm, cap, forked mirror),
`log-ring-debug-deny.spec.ts`, and `debug-watch.service.spec.ts` (push, refusal,
document write keeps the watch).
