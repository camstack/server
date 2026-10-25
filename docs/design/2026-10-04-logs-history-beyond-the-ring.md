---
title: Logs history beyond the ring
date: 2026-10-04
status: draft
covers:
  - packages/system/src/logging/**
  - packages/ui-library/src/composites/log-stream.tsx
  - packages/addon-admin-ui/src/pages/system/Logs.tsx
---

# Logs history beyond the ring

Roadmap home: [roadmap.md § Logs history](../roadmap.md#logs-history--query-past-the-ring-next-large).

## Problem

Admin **Logs → Viewer** reads only the in-memory ring behind `logs.query`.
Operators already configure Winston / Loki (and peers) as destinations, but
those sinks are write-only from the UI's point of view. Anything older than the
ring requires leaving CamStack.

## Decision (shape)

Extend the **`logs` capability**, not the Admin page with a vendor SDK.

| Piece | Role |
| --- | --- |
| `logs.query` | unchanged — ring, live-tail friendly |
| `logs.queryHistory` (proposed) | time-bounded history from one or more **history backends** |
| History backend | registered by a log-destination addon / builtin that can **read** what it writes |

### `queryHistory` (draft I/O)

```
input: {
  since: number          // ms epoch, required
  until?: number         // default now
  tags?: { nodeId?, addonId?, deviceId?, … }
  level?: string
  text?: string          // substring, same semantics as Viewer filter if any
  cursor?: string        // opaque, backend-specific
  limit: number          // hard-capped server-side
  sources?: string[]     // optional: only these backends; default = all that support history
}
output: {
  entries: LogStreamEntry[]   // same schema as query, plus optional source?: string
  nextCursor?: string
  truncated: boolean          // hit limit or backend refuse mid-range
  sourcesUsed: string[]
}
```

A backend that cannot serve the range **refuses with a named reason**
(`unsupported`, `not-configured`, `range-too-large`) — never an empty success
that looks like "no logs existed".

### Providers (first wave)

1. **Winston** — read rotated files the destination already owns; parse into
   `LogStreamEntry`. Bound file bytes / time window.
2. **Loki** — LogQL query using the same tag vocabulary CamStack already
   ships; map streams → entries. Bound query cost (max streams / max lines).

Further destinations (journald, S3 archives, …) implement the same interface.

### UI

One Viewer tab. When the operator scrolls above the oldest ring line (or clicks
**Load older**), call `queryHistory` with `until = oldestRingTimestamp` and
merge chronologically. Filters stay shared. Destinations tab stays
configuration only — not a second viewer.

## Non-goals

- Replacing the ring for live subscribe
- Hard-coding Loki URLs in `addon-admin-ui`
- Opening live SQLite or shipping log blobs over `peerBytes` for this path
- Auto-tailing remote history (pull on demand only)

## Open points for the implementation plan

- Exact cap method name and whether history backends are a nested provider
  registry vs methods on each `log-destination` provider
- How multi-node history is addressed (hub aggregates vs pin to `nodeId`)
- Retention / max `since` floor so a year-long Loki scan cannot DOS the hub
