---
id: D839
title: The agent finds hubs the way the CLI does — one shared mDNS browse in @camstack/develop
status: accepted
date: 2026-10-13
supersedes:
applies-to:
  - packages/develop/src/hub-discovery/**
  - server/backend/src/agent/hubs-found.ts
  - packages/addon-agent-ui/src/paired-hub.tsx
---

## Context

The agent UI's "searching / discovered nodes" mode was fed by Moleculer UDP
discovery. Since D826 a hub never announces over UDP, so against a current hub
the page searched forever and could only ever find a pre-D826 hub. D838 gave
clients a real way to find a hub (mDNS of its HTTPS endpoint) but only the CLI
used it.

## Decision

- The mDNS browse, the https reachability probe and the host:port merge live
  once, in `@camstack/develop/hub-discovery`. The CLI and the agent backend both
  import it; `multicast-dns` is declared by `develop`, the owner. `develop` was
  chosen over `@camstack/system` (the CLI would depend on, or bundle from, the
  whole framework package) and `@camstack/types` (shipped to the viewer; a
  socket library does not belong in a types barrel).
- The agent exposes `GET /api/agent/hubs-found` (cached) and
  `POST /api/agent/hubs-found/refresh` (a bounded browse, shared between
  concurrent callers and rate-limited), both on the pairing surface. The list is
  the mDNS hubs plus the configured hub address, each probed on https, the
  unreachable dropped. The status poll never scans.
- The agent UI lists them in a select that fills the hub-address field. Joining
  still takes a join token minted on that hub: finding a hub grants nothing.
- The UDP discovery UI and its status fields (`discoveryMode`, the `searching`
  state, now `unconfigured`) are removed. The mesh-level UDP fallback in
  `broker-factory` is removed by D843.

## Consequences

- An agent in Docker bridge mode sees no mDNS answers (same limit as D838); the
  picker then says nothing was found and the address is typed.
- `@camstack/server` now depends on `@camstack/develop`; both must be published
  for an agent to carry this.
