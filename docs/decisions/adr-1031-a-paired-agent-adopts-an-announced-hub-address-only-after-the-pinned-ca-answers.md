---
id: D1031
title: A paired agent adopts an announced hub address only after the pinned CA answers
status: accepted
date: 2026-11-10
supersedes:
applies-to:
  - server/backend/src/agent/agent-hub-rediscovery.ts
  - server/backend/src/agent/agent-membership-watch.ts
  - server/backend/src/agent/agent-boot-mode.ts
  - packages/system/src/kernel/hub-identity.ts
  - packages/system/src/kernel/moleculer/mesh-mtls/mesh-membership.ts
  - docs/architecture/transport.md
---

## Context

D838 advertises the hub over mDNS and states that finding a hub grants nothing.
D843 stopped the agent from dialling whatever UDP announced. Pairing then
started recording the hub's public `hubId` so an agent that lost its address
could browse for that id (#494). The first implementation saved the first
announcement whose TXT `hubId` matched. The id is public, so a host on the LAN
can announce it and the agent would dial that host forever.

The id file was also written at the data root, outside `tls/`, so a system
backup of the mesh CA did not keep it. Agents paired before the id existed had
nothing to match on, and the log told the operator to set an address the agent
page shows read-only.

## Decision

Amends D838 and D843. Finding a hub still grants nothing.

- An agent persists an mDNS address for its recorded `hubId` only after that
  URL answers a membership query whose token verifies against the CA pinned at
  pairing. Every matching announcement is tried; one that does not authenticate
  is skipped and logged.
- The hub id file lives at `<dataDir>/tls/hub-identity.json`, with the mesh CA
  a backup of `tls/` already keeps. A file still at the data root is read once
  and copied there, never overwritten.
- A membership answer signed by that CA carries the hub id. An agent that has
  none records it, including while the mesh is up. It does not replace an id
  already stored. Until then, `no-hub-id` is logged once and again only if a
  later browse saw an id and then lost it.
- A paired agent with no address relaunches when an address is saved, so the
  addons that never started can boot (D5). An unpaired agent does not: pairing
  relaunches on its own, and a restart only replaces the transport.
- The operator is told to re-pair from the hub's Nodes page. The address on the
  agent page is read-only.

## Consequences

A rogue announcement with the right `hubId` and a different CA is never saved.
An agent paired before hub ids existed learns one from the next CA-signed
membership answer, then can browse. A backup and restore of `tls/` keeps the id.
An agent with neither an address nor an id still cannot find its hub; the
warning does not repeat every minute.

## Enforcement

`agent-hub-rediscovery.spec.ts` (a candidate that fails the pinned-CA check is
not saved; the genuine one after it is; `no-hub-id` is warned once).
`hub-identity.spec.ts` (a root file is copied under `tls/`).
`system-backup.service.spec.ts` (backup then restore keeps `tls/hub-identity.json`).
`agent-hub-id-backfill.spec.ts` and `agent-membership-watch.spec.ts` (the id is
recorded from a verified answer only when missing, including while connected).
`agent-boot-mode.spec.ts` (only `awaiting-hub` relaunches on a new address).
---
