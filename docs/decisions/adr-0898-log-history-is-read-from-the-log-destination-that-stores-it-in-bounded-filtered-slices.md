---
id: D898
title: Log history is read from the log destination that stores it, in bounded, filtered slices
status: accepted
date: 2026-10-21
supersedes:
applies-to:
  - packages/types/src/capabilities/log-destination.cap.ts
  - packages/system/src/logging/log-read-filter.ts
  - packages/system/src/builtins/winston-logging/log-file-reader.ts
  - packages/system/src/builtins/loki-logging/loki-read.ts
  - server/backend/src/api/core/logs.router.ts
---

## Context

The log viewer read only the hub's in-memory buffer (5000 lines per addon,
50k total): minutes of a busy hub. The rotated files held 30 days (~1 GB/day)
and nothing read them — `winston` and `loki` both implemented the cap's
`query` as `return []`. The browser then applied level and text filters AFTER
the server's limit, so a quiet device's lines were unreachable behind a busy
one's, and the RAM buffer was sized for history it could not serve anyway.

Rejected: a bigger buffer (RAM grows with the roster and still covers
minutes); a SQLite log table (a second write of every line, and a live
database the backup must snapshot); reading the files in the hub's main
thread (a 1 GB scan blocks every request).

## Decision

History is read through the `log-destination` cap's read contract
(`describeRead` / `read` / `cancelRead`, optional): every filter is applied
by the provider before the limit, the cursor is the provider's own and
opaque, and a read is a slice bounded by a time budget that returns where it
stopped. `winston-logging` serves it from its daily files with a per-file
sidecar index of ~1 MiB blocks (skip a block whose sets exclude the filter),
in a worker thread; `loki-logging` from `query_range`. `logs.query` routes to
the source the client names (default `winston-logging`), merges the hub's
short in-memory tail by entry id, and the buffer shrinks to that tail once
the file destination holds the history. Every line carries `<bootId>.<seq>`
from the LogManager that accepted it.

## Consequences

- `logs.query` returns a page object, not an array; every caller moved.
- A filter field that names an emitter is `fromAddonId` / `fromNodeId`: a cap
  router reads `addonId` / `nodeId` as provider routing.
- Cancellation granularity is one slice (≤ 1 s by default) plus `cancelRead`.
- Debug lines live only in the tail when winston's level is `info`.
- A cap change: `@camstack/system` and `@camstack/server` must be
  force-published for it to reach a node.

## Enforcement

Specs: `log-file-reader.spec.ts` (a device absent from a block is never read,
paging across days, cursor stability while the file grows, budget resume,
cancel), `loki-read.spec.ts`, `log-tail.spec.ts`, `logs-router-history.spec.ts`.
Nothing checks that a new destination implements the read contract — its
absence is reported by `logs.sources` as "not readable".
