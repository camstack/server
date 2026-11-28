---
id: D1082
title: Wake-on-LAN is a helper sent from the caller's own node, not a capability
status: accepted
date: 2026-11-22
supersedes:
applies-to:
  - packages/types/src/network/wake-on-lan.ts
  - packages/types/src/network/wake-on-lan-node.ts
---

## Context

Waking a machine is one UDP datagram on its own broadcast domain. A capability would route the call to a provider, possibly on another node, which cannot reach that segment.

## Decision

The packet builder is pure and lives in `@dominevo/types`; the sender is in `@dominevo/types/node` and is called by the addon on the node that is on the machine's network. Refusals are typed (malformed MAC, no usable target, send failure). Success means the packet was sent, never that the machine is awake.

## Consequences

No capability, no router and no per-device setting is added. Verifying that the machine woke is the caller's job (a ping or a state read).

## Enforcement

`packages/types/src/network/__tests__/wake-on-lan.spec.ts` and `wake-on-lan-node.spec.ts`; the root barrel stays free of `node:` imports (the types build and the tree-shake canary).
