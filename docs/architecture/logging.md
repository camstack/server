---
title: Logging — where a line goes, and how history is read back
last-verified: 2026-10-21
applies-to:
  - packages/system/src/logging/log-manager.ts
  - packages/system/src/logging/log-read-filter.ts
  - packages/system/src/builtins/winston-logging/log-file-index.ts
  - packages/system/src/builtins/winston-logging/log-file-reader.ts
  - packages/system/src/builtins/loki-logging/loki-read.ts
  - server/backend/src/core/logging/log-history.ts
  - server/backend/src/api/core/logs.router.ts
covers:
  - packages/system/src/logging/**
  - packages/system/src/builtins/winston-logging/**
  - packages/system/src/builtins/loki-logging/**
  - packages/system/src/builtins/console-logging/**
  - packages/system/src/builtins/hub-forwarder/**
  - packages/types/src/capabilities/log-destination.cap.ts
  - server/backend/src/core/logging/**
  - packages/ui-library/src/composites/log-stream.tsx
  - packages/ui-library/src/hooks/use-log-history.ts
---

# Logging

## Where a line goes

Every line enters a process's `LogManager` (`createLogger` → `ScopedLogger`).
The manager redacts it, stamps its **id** (`<bootId>.<seq>`, D898) and hands
the same object to three places:

1. the in-memory buffer (`PartitionedLogBuffer`, per-addon rings);
2. every `log-destination` provider the operator has enabled — `console-logging`
   (stdout), `winston-logging` (rotated files), `loki-logging` (push to Loki),
   `hub-forwarder` (agents only);
3. live subscribers (`logs.subscribe`).

An agent forwards every line to the hub (`hub-forwarder`), where it is
re-emitted through the hub's own `LogManager` (`writeFromWorker`) and gets a
hub id. So **the hub's files hold the whole cluster's log**, and nothing on an
agent needs to be read.

## The files

`winston-logging` writes `<nodeDataDir>/logs/camstack-YYYY-MM-DD.log`: one JSON
object per line, keys sorted by `format.json()`, so the top-level `timestamp`
is always the last key. Retention is the addon's `retentionDays` (30), level
floor its `level` (info).

Next to each file the reader keeps a **sidecar index**, `<file>.idx`
(`log-file-index.ts`): JSON lines, a header (`v`, the file's inode, the block
size) then one line per completed ~1 MiB block — byte range, time range, the
device ids / bare addon ids / origin nodes seen in it (each a superset, read off
the raw text by pattern; more than 256 distinct values ⇒ `null`, "anything"),
and the highest level. The open block is never written. A sidecar whose inode
does not match, or whose blocks do not tile the file from byte 0, is rebuilt;
it is a cache, never a source of truth.

## Reading history

`logs.query` (admin) reads ONE page from the source the client picks
(`source`, default `winston-logging`; `ring` = the tail only) and returns
`{ entries (newest first), nextBefore, nextAfter, scannedBytes, done, source }`.
`logs.sources` lists every hub-local destination with `describeRead()`; the
UI offers the readable ones.

- **The contract is the cap's** (`log-destination`: `describeRead`, `read`,
  `cancelRead`, all `optionalMethod`). A destination without them ships only.
  The filter fields are `deviceId`, `fromAddonId`, `fromNodeId` (not
  `addonId`/`nodeId`, which a cap router reads as provider routing), `tags`,
  `level` (floor), `text`, `since`/`until`.
- **One filter definition** — `lineMatches` in `log-read-filter.ts`, used by
  the file reader, the Loki reader and the hub tail.
- **A read is a bounded slice.** It stops at `budgetMs` (default 1 s) or on
  `cancelRead`, at a line boundary, and returns the cursor it reached:
  `done: false` with a short page means "still searching". The client keeps
  asking with `before: nextBefore` and shows the bytes scanned; aborting the
  request makes the router call `cancelRead`.
- **Files** (`log-file-reader.ts`), in a worker thread
  (`dist/log-file-read-worker.js`): newest file first, newest block first; a
  block the index rules out is never read; inside a block a raw byte search
  for the device / addon finds the candidate lines and only those are
  decoded and parsed. The cursor is `{file, byte offset}` — stable while the
  file grows. On the hub the thread starts at boot and indexes every file in
  the background (newest first, every 60 s); a read never waits for a large
  unindexed gap, it scans it unskipped.
- **Loki** (`loki-read.ts`): `query_range` backward in 6 h windows over 30
  days; labels `job`/`node`/`level` select, `|=` / `|~` line filters narrow,
  `lineMatches` decides. The cursor is the oldest nanosecond returned plus the
  hashes of the lines already returned at it (siblings share a millisecond).

## The tail

Once `winston-logging` has registered on the hub — and received the boot
replay, so the file starts with the first boot line — the hub's buffer shrinks
to a **tail** of 2000 entries (`eventBus.logTailSize`; info and below pruned
first). It serves the instant first page (merged with the file page by id, so
the lines the file stream has not flushed yet still show) and replays to a
destination that registers late. A hub without winston keeps the larger buffer.

## Measured (synthetic 1 GB day, 3.47 M lines, warm page cache, M-series Mac)

| | |
| --- | --- |
| index build, once per file, in the thread | 10.4 s; sidecar 327 KB |
| first page, busy device | 19 ms (1.2 MB read) |
| first page, rare device (21 lines in the day), indexed | 59 ms (22 MB read) |
| the same, no index | 1.7 s (1.07 GB read) |
| text search, one 1 s slice | ~500 MB scanned |

`CAMSTACK_HEAVY_SPECS=1 npx vitest run packages/system/src/builtins/winston-logging/__tests__/log-file-reader-1gb.heavy.spec.ts`
reproduces it.
