---
id: D838
title: Clients find a hub over mDNS of its HTTPS endpoint; mesh discovery stays retired (D826)
status: accepted
date: 2026-10-13
supersedes:
applies-to:
  - packages/system/src/builtins/local-network/hub-mdns.ts
  - packages/system/src/builtins/local-network/hub-mdns-ciao.ts
  - packages/cli/src/discovery/**
  - packages/cli/src/commands/discover.ts
  - packages/cli/src/commands/auth.ts
---

## Context

`camstack login` found a hub by listening to Moleculer's UDP multicast
(`239.0.0.0:4445`, `namespace|nodeID|tcpPort`) and probing `:4443` on the sender.
D826 turned that channel off on every hub on purpose (the mesh listens only on
mutual TLS). From then on the CLI's zero-config discovery could only ever see
pre-D826 hubs: measured on 2026-10-13 it listed 192.0.2.50, a hub still
announcing with clear `:6000` open, and never the current hub 192.0.2.9.

Re-opening the mesh announcement for the CLI's sake was rejected: it is the very
channel D826 retired, and its packet says nothing about the HTTPS port a client
needs.

## Decision

- The hub advertises ONE mDNS service, `_camstack._tcp`, for its HTTPS endpoint:
  port = the advertised listen port, TXT `nodeId`, `version` (when known),
  `role=hub`, `url` (the hub's `internal` address). Nothing secret and no
  namespace: finding a hub grants nothing, every client still signs in.
- The advertised address is the `internal` role of the `local-network` address
  book (`getAddresses().roles.internal`) — the address flagged for LAN clients,
  else the automatic LAN pick. Nothing ranks addresses a second time.
- Clients find a hub from that service UNION the hubs they already know (cached
  sessions, admin-token files, `$CAMSTACK_HUB_URL`, `scratchpad/.hub-url`),
  probed on https and deduped by host:port. None is an error naming `--server`,
  one is used, several get a picker showing each source.
- The CLI no longer listens to the mesh channel. `--namespace` is accepted and
  ignored so old scripts do not break.

## Consequences

- mDNS needs UDP 5353 multicast to reach the LAN: a dedicated container IP
  (macvlan / Unraid br0) or host networking, NOT Docker bridge mode. A hub in
  bridge mode is simply not announced (logins work with `--server` or via a
  known hub); advertising failure never breaks boot. The Unraid templates, the
  Proxmox install script and the public Docker docs must say so (D717, D822).
- `local-network` has a `mdnsAdvertise` switch (default on).
- The browse and the https probe live in `@camstack/develop/hub-discovery`, shared
  by the CLI and the agent backend (D839); the agent's local UI lists the hubs it
  finds and no longer relies on mesh UDP discovery.
- The mesh UDP discovery code on the agent is gone (D843); mDNS is the only way a
  client finds a hub on the LAN.
- The hub's `version` TXT is empty until a version reaches `local-network`.

## Enforcement

`hub-mdns.spec.ts` (the announcement follows the `internal` role and carries no
secret; a role change re-announces; a failing responder never throws out of
`start()`) and `hub-finder.spec.ts` (union, dedupe, unreachable dropped, single
auto-pick, picker with sources, manual-entry validation).
