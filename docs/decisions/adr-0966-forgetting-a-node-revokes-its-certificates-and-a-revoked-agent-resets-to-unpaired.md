---
id: D966
title: Forgetting a node revokes its certificates; a revoked agent resets to unpaired
status: accepted
date: 2026-10-29
supersedes:
applies-to:
  - server/backend/src/core/agent/agent-registry.service.ts
  - server/backend/src/core/agent/forgotten-node-revoker.ts
  - server/backend/src/api/mesh-membership-routes.ts
  - server/backend/src/agent/agent-membership-watch.ts
  - server/backend/src/agent/hub-membership-client.ts
  - packages/system/src/kernel/moleculer/mesh-mtls/mesh-membership.ts
  - packages/system/src/kernel/moleculer/mesh-mtls/tls-tcp-transporter.ts
---

## Context

An agent node was forgotten from the admin UI, powered on later, and was
admitted again with no pairing. `forgetClusterNode` removed the history row and
the Moleculer registry entry but never touched the node's mesh certificates, and
a node's identity is its certificate (D857): the old leaf still chained to the
mesh CA, so `verifiedPeer` accepted it. Forget did not restart the flow from
scratch, and the agent was never told it had been removed.

## Decision

Forgetting a node, ONLINE or offline, revokes every certificate the hub issued to it
(reason `forgotten`) through `revokeMeshCertificate`, which writes the CRL and
cuts live sockets; the transporter reads the CRL on every check, so no restart
is needed. The forget result carries a typed `certificates` outcome
(`revoked | registry-unavailable | failed | not-attempted`): an unloaded registry
or a throwing revoke is reported and logged with `tags: { nodeId }`, never shown
as "0 revoked" (D393).

A revoked peer is refused at the mesh and logged once per node per minute with
reason `revoked` (D391).

The refused agent finds out through a membership query. The hub issues a
single-use nonce; the agent signs it with its leaf private key; the hub answers
`member | revoked(+reason) | unknown` as a JWS signed by the mesh CA key and bound to the
nonce and the leaf fingerprint. The agent verifies it against the CA pinned at
pairing, so a forged "revoked" is impossible and an unauthenticated caller
learns nothing. Only after TWO consecutive CA-signed `revoked` answers
(D49: a fallible read never destroys) does the agent reset to unpaired
through the existing `forgetHubNow`. `unknown`, an unreachable hub or any doubt
changes nothing.

The reset removes the pairing from `agent.json` (`meshTls`, `meshTlsPrevious`,
`meshSwap`, `hubAddress`, `hubUrl`) and the agent's HTTPS bundle files. It keeps
the node id, name, log level, recordings, media and addons, and the agent then
advertises as pairable.

Amendment 2026-10-29: forget works while the node is online. The earlier refusal
(`node-online`) rested on "a live node re-registers at once", which stopped being true once the
leaf is on the CRL. The order is revoke (which closes the node's sockets, the CRL being read only
at a handshake), `NodeCatalog.disconnected` (services unregistered, pending calls rejected with
`RequestRejectedError`; later pinned calls fail with `ServiceNotFoundError`, never hang), then the
catalog delete and the rest of the cleanup. A bare `nodes.delete` on a live node would leave its
services registered and its calls waiting for the timeout. The agent needs no new signal: its
socket is cut, the reconnect is refused, and the membership watch above resets it (about two
minutes). `stillListed` is read back after the removal, so a revocation that failed and a node that
came straight back are reported, not asserted away.

## Consequences

Forgetting is final until the operator pairs the node again with the six-digit
flow. The hub exposes two unauthenticated, rate-limited routes under
`/api/mesh/membership`. An agent paired before this change has no stored
`hubUrl`; it derives it from `hubAddress`.

## Enforcement

Specs: `forget-cluster-node.spec.ts` (revoke called, outcomes distinct),
`revoked-leaf-refused.spec.ts` (refused with no restart, logged once),
`mesh-membership.spec.ts` (impostor, replay, forged CA),
`agent-membership-watch.spec.ts` (two reads, end to end). Removing the revoke
call in `forgetClusterNode` turns eight forget specs red. `forget-online-node.spec.ts` runs a real
mutual-TLS transporter (live socket closed, revoked leaf refused) and real Moleculer brokers
(in-flight call rejected typed); removing the `disconnected` step makes it hang until timeout.
