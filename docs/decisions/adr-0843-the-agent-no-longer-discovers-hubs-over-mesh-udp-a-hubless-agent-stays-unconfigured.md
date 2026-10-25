---
id: D843
title: The agent no longer discovers hubs over mesh UDP; a hubless agent stays unconfigured
status: accepted
date: 2026-10-13
supersedes:
applies-to:
  - packages/system/src/kernel/moleculer/broker-factory.ts
  - server/backend/src/agent/main.ts
  - server/backend/src/agent/derive-hub-url.ts
---

## Context

D826 turned the hub's UDP announcement off, so the agent's "no `hubAddress` ⇒
listen for the announcement" branch could only ever find a pre-D826 hub, and
joining a current hub needs a join token (mutual TLS) anyway. D838/D839 gave
clients and the agent UI a real way to find a hub (mDNS).

## Decision

The agent branch of `createBroker` never enables UDP discovery: with a hub
address it dials it, without one it dials nobody. The registry-derived
`CAMSTACK_HUB_URL` for UDP mode, the agent's discovery-mode wording, the
`udpPort` broker option and `CAMSTACK_HUB_UDP_PORT`, the Dockerfile
`EXPOSE 4445/udp` and the desktop setup's "Auto (UDP discovery)" are removed. An
agent without an address is `unconfigured`; the agent UI picks a hub (mDNS) and
takes a join token.

## Consequences

- A pre-D826 hub that still announced over UDP is no longer joined by an agent
  without an address: set the address once.
- Mirror by hand (D717, D822): Unraid templates, the Proxmox install script and
  the public Docker docs must stop publishing or mentioning 4445/udp.
