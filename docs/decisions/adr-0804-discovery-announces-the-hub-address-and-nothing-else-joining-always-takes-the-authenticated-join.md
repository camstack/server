---
id: D804
title: Discovery announces the hub's address and nothing else — joining always takes the authenticated join
status: accepted
date: 2026-10-09
supersedes:
applies-to:
  - packages/system/src/kernel/moleculer/broker-factory.ts
---

## Context

The operator asked whether agents still find the hub automatically. They do:
Moleculer's TCP transporter runs UDP discovery on port 4445. Until D797 the
announcement carried the cluster secret as the Moleculer namespace, in clear,
every 5 s. Since D797 the namespace is empty, so the hub's packet is
`|hub|6000`. But an agent without a `hubAddress` ALSO announced itself every
5 s, forever — nothing needs that: the hub learns an agent from the agent's
TCP handshake once the agent has dialed the address it heard.

## Decision

- The hub keeps announcing `<namespace>|hub|<tcpPort>` (namespace empty) so an
  agent without an address finds it.
- An agent in discovery mode sends at most 3 announcements at start
  (`udpMaxDiscovery: 3`) and then only listens; an agent with a `hubAddress`
  uses no UDP at all.
- Nothing secret is ever part of a discovery packet, and finding the hub
  grants nothing: every node must pass the D802 join before the hub serves it.

## Consequences

- An agent started before its hub connects on the hub's next announcement
  (≤ 5 s) rather than its own. Measured 2026-10-09 with a probe on two real
  brokers: an agent whose single announcement went out 3 s before the hub
  started found the hub within one hub period, the hub learned the agent from
  the TCP handshake, and calls worked both ways.
- An attacker on the LAN still learns the hub's address and port from the
  announcement, and the hub's service catalog from Moleculer's INFO packet once
  connected. Firewalling 6000/tcp and 4445/udp to the agents' addresses is the
  operator's control (public docs: Agents → Network and firewall). Mutual TLS
  turns discovery off on the hub altogether (the join token carries the
  address).

## Enforcement

`broker-factory.spec.ts`: the hub announces with an empty namespace and no
limit; an agent in discovery mode is limited to 3 packets; an agent with an
address has UDP off.
