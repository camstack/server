---
id: D848
title: An enrolled agent talks to the hub only — no agent-to-agent mesh link, its events go to the hub, and what the hub sends before the join is held
status: accepted (§3, holding the hub's traffic until a join settles, is gone since D857: the hub is recognised by its certificate from its first packet; the rest stands)
date: 2026-10-13
supersedes:
applies-to:
  - packages/system/src/kernel/moleculer/agent-event-scope.ts
  - packages/system/src/kernel/moleculer/mesh-access-middleware.ts
  - packages/system/src/kernel/moleculer/mesh-mtls/tls-tcp-transporter.ts
  - packages/system/src/kernel/moleculer/broker-factory.ts
  - server/backend/src/agent/agent-mesh-gate.ts
---

## Context

Extends D826 (the hub mesh is mutual-TLS only). D826 closed the hub's clear
port but left every agent with a clear Moleculer TCP reader on its derived port
(20000–29999), and Moleculer's TCP gossip told each agent about every other
agent. Measured on 1.2.542 (2026-10-13):

- every node's `$event-bus` subscribes to `camstack.evt.**`, so each agent
  broadcast all its telemetry (~3,000 events/min: `pipeline.inference-result`,
  `pipeline.trace`, `motion.*`) to every peer agent, in clear text, where the
  peer's inbound gate (`AgentMeshAuthenticator`, D802 `enforced`) refused every
  packet by design. On a local 3-node cluster: 1,000 events from one agent
  wrote 1,000 EVENT packets to the hub AND 1,000 to the peer, plus 200 other
  packets (gossip, hello) to it;
- at boot, the hub's events and calls that reached an agent before its mutual
  join settled (`[mesh-join] authenticated to the hub (mutual)`) were refused —
  a one-shot event lost to a connect-time race (D49).

What agent↔agent traffic is legitimately needed was answered from the code, not
assumed: an agent has no `CapRouteResolver`; every cap call a forked child cannot
serve locally goes to the hub's `$hub-cap-fwd` (`agent/main.ts`), and agent
runners are UDS-only, so no agent ever calls another agent's action by design.
An audit of the bus subscriptions on agent-runnable code found consumers that
COULD hear a peer's category (the recorder hearing analyzer `motion.*`, a
post-processing agent's `pipeline-analytics` hearing another agent's
`pipeline.inference-result`, `storage.locations-changed`, …), but none of them
has received a peer's event since D802 went `enforced` on 2026-10-09: the peer
gate refused them all. Stopping them at the source changes nothing any consumer
receives.

Rejected:
- **Agents TLS-only to each other** (keep agent↔agent links, on mTLS). Every
  such link exists only to carry packets the receiving gate refuses; TLS would
  have made the waste encrypted, not gone.
- **Scope the subscription** (agents subscribe to a hub-only topic). Moleculer
  subscriptions cannot tell senders apart, and a new topic needs hub and agents
  updated together — the outbound gate below works with every hub version.
- **Hub sends only after a join ack** (an ordering fix for §3). The agent checks
  the hub's proof asynchronously, after the answer that carries it, so an event
  the hub writes strictly after its answer can still be decoded first; and it is
  a protocol change on both ends. The hold is agent-local.

## Decision

1. **An agent's events go to the hub only.** Every agent broker carries an
   outbound `transitPublish` gate (`agent-event-scope.ts`, wired by
   `createAgentMeshJoin`): an EVENT packet addressed to any node but the hub is
   not written. Counted per peer, logged once per peer.
2. **An enrolled agent has no mesh peer but the hub** (`hubOnlyPeers` on
   `TlsTcpTransporter`, set by `createBroker` whenever the agent has a mesh
   leaf). No clear TCP reader (bound, then closed, as the hub's; not
   re-openable); its TLS listener accepts only the hub's certificate (another
   agent's leaf, same CA, is refused after the handshake); its writer dials the
   hub only; nodes in the hub's gossip other than the hub are not adopted, so it
   never learns, dials or broadcasts to another agent. The TLS-only hub dials
   every peer on mTLS (no clear hub→agent leg). A TLS-listening node advertises
   its listen port in its gossip HELLO (`meshTlsPort`); a peer dials it there,
   else on 6443 — so two nodes can share a host.
3. **What the hub sends before the join settles is held, then decided.** The
   agent's inbound gate answers `hold` for the hub while a join is in flight
   (`mesh-join-hold.ts`): delivered in arrival order when the join proves the
   hub; refused — and said so with counts — when the join fails, after 15 s
   from the first held item, or past 1,000 held items. One line per decision:
   `[mesh-join] N hub event(s) and M hub call(s) held X ms before the mesh join
   settled: delivered | REFUSED (join <state>)`.

## Consequences

- A cluster's agent-side mesh is a star. An agent configured as the
  post-processing node does not hear another agent's telemetry — as it has not
  since 2026-10-09; making that work means the HUB relaying, a separate
  decision.
- Rollout: agent-only for §1 and §3, and for §2's agent side. The hub side of
  §2 (always dial mTLS, read the HELLO port) is compatible both ways: an older
  agent listens for TLS on 6443, which is the hub's fallback; an older hub
  dials 6443, which is a new agent's default. No lockstep; hub first is fine.
- An agent without a mesh leaf keeps clear TCP; it can join only a pre-D826 hub.
- Container contract: an enrolled agent no longer listens on its derived clear
  port (20000–29999), only on 6443/tcp (TLS), which the hub must reach. The
  image's `EXPOSE` lists 6443 instead of the retired 6000 (D717/D822: the
  Unraid templates, the Proxmox script and the public Docker docs are mirrored
  by hand).
- A clear-text (unenrolled) agent's hold can deliver a request a LAN host sent
  as `hub` before the join, once the real hub authenticates — the same residual
  D802 already names for clear text after the join. An enrolled agent binds the
  sender to the certificate CN, so only the hub can be held.
- The agent's own events to the hub before the HUB has authenticated it are
  still dropped by the hub gate (D802 consequence), not held. Not closed here.
- **Amended 2026-10-14 — a rollout leaves agents online and capless unless the
  registration follows the join.** Rolled out one agent at a time, an updated
  agent no longer talks to the older ones, which then gossip it offline to the
  hub. Moleculer on the hub believes them: `$node.disconnected` on the HUB
  only — the agent's own link never breaks — every 2–6 s for ~35 min
  (agent-a ~270 hub-side disconnects, the Mac ~140, on 1.2.544,
  2026-10-14 01:02–01:36 local, ending when agent-b, the last old agent,
  was updated).
  Each flap dropped the agent's registration and join on the hub; the agent
  re-joined when a call came back "not authenticated" but re-registered only
  on ITS `$node.connected`, and its one registration in the window was refused
  as "cluster secret mismatch" (what `admitRegistration` answers an
  unauthenticated node in `enforced`) and not retried. Both agents stayed
  `isOnline: true` with zero capabilities until restarted. Fixed without
  touching this decision: the agent re-sends its full manifest on every
  settled join and re-joins on that refusal when its own join proved the
  secret (`agent-hub-registration.ts`); the hub asks every (re)connected agent
  (`$agent.requestRegistration`, `agent-registration-request.ts`) and reports
  an online agent it holds no registration for (`nodes.topology`
  `capabilitiesRegistered: false`, a WARN for an agent too old to be asked).
  Proven in `agent-registration-rejoin.cluster.spec.ts`. The gossip flap
  itself ends when the last pre-D848 agent is updated; any disconnect only the
  hub sees (a failed write, a late heartbeat) is now recovered the same way.

## Enforcement

- `agent-event-scope.spec.ts` (real brokers): the hub gets every event, a peer
  none; calls untouched. Disarmed (gate passes everything): the peer receives
  50/50.
- `agent-hub-only-peers.spec.ts`: no clear listener and no switch back; the
  hub's certificate accepted, another agent's refused; dialling a peer refused;
  gossip filter; HELLO port.
- `agent-mesh-authenticator.spec.ts`, `agent-mesh-access.integration.spec.ts`:
  hold → deliver in order / refuse on failure / bound / overflow. Disarmed (never
  hold): 7 fail.
- `agent-mesh-isolation.cluster.spec.ts` (`test:cluster`, server/backend): a real
  hub + 2 enrolled agents on mTLS — the hub's connect-time event delivered after
  the join; 1,000 events/agent → 1,000 to the hub, 0 EVENT and 0 packets of any
  kind to the peer; no clear listener; agents know only the hub; no TRANSIT or
  TRANSPORTER log line. Disarmed §1+§2: 1,000 EVENT and 1,200 packets to the
  peer; §2 alone: the clear port answers; §3: the connect-time event is lost.
