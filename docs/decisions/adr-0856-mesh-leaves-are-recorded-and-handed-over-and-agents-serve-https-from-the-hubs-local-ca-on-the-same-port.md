---
id: D856
title: Mesh leaves are recorded and handed over, never swapped blind, and agents serve HTTPS from the hub's local CA on the SAME port
status: accepted
date: 2026-10-15
supersedes:
applies-to:
  - packages/system/src/kernel/moleculer/mesh-mtls/mesh-certificate-registry.ts
  - packages/system/src/kernel/moleculer/mesh-mtls/mesh-renewal.ts
  - packages/system/src/kernel/moleculer/broker-transport-swap.ts
  - packages/system/src/kernel/moleculer/mesh-mtls/tls-tcp-transporter.ts
  - packages/system/src/tls/agent-https.ts
  - packages/types/src/capabilities/node-certificates.cap.ts
  - server/backend/src/agent/agent-node-certificates.ts
  - server/backend/src/agent/agent-sniffing-listener.ts
  - server/backend/src/api/core/certificates.router.ts
---

## Context

D855 shipped the Identity -> Certificates inventory with two honest gaps. The hub
did not record the mesh leaves it issued (a 30-day leaf per agent, and nothing
renewed it: an agent enrolled once and then lived on a certificate nobody could
see expire), and the revocation list was in memory only. Agents served plain HTTP
on their API port, so a device that trusts the hub root could not trust an agent.

Two obvious shortcuts were rejected. Replacing a node's leaf in place (swap, then
hope) leaves a node unreachable whenever the swap fails halfway: its old leaf is
gone and the new one is not yet accepted. And a second port for agent HTTPS would
change the container contract (ports in the Unraid templates, the Proxmox script,
the Compose example), which nothing checks.

## Decision

1. **Every mesh leaf is recorded.** The hub writes each leaf it issues (`enroll`,
   `renewal`, `boot`) to the hub-only collection `mesh_node_certificates`
   (nodeId, serial, fingerprint, notBefore/After, issuedAt, issuedVia, revokedAt).
   A node enrolled before that existed is recorded from the leaf it PRESENTS on its
   live mutual-TLS connection (`observed`, taken from the peer certificate the
   transporter keeps per node). Revoked serials are persisted there and replayed into
   the CRL at boot, before the TLS listener opens.
2. **Renewal is a handover.** `renewMeshOnNode`: the node makes a NEW key and CSR
   (the key never leaves it); the hub signs and records it; the node persists it
   BESIDE the old one (with the swap's state: which leaf, until when) and reconnects
   through the existing `reconnect()`; the hub confirms only after that node's
   `registerNode` has landed presenting the new leaf - a TLS handshake alone is not
   enough, the node has no capabilities until it registers. The hub waits on the
   registration-completion event (`onProcessNodeRegistered`, fired from
   `onRegisterNode`), with one deadline timer and no scan, and retries the confirm
   call to the deadline while the node capability is not routable yet. Only then does
   the node forget the old leaf and the hub put the old serial on the CRL. A failed
   swap keeps the old leaf valid and not revoked, asks the node to roll back, and
   returns the stage and the reason. The unused new leaf is SET ASIDE in the registry
   (`renewal-abandoned`: never `currentFor`, not on the CRL - the node may still hold
   it, and cutting it off would be the outage this order prevents; if the node is
   later seen presenting it, it is reinstated). The node rolls back by itself when no
   confirmation arrives in time, but only (a) while a swap is PENDING - the state is
   in `agent.json`, so it survives a restart and a swap whose deadline passed while the
   node was down is settled, not rolled back - and (b) to a previous leaf that is still
   unexpired; a leftover `meshTlsPrevious` is deleted at boot and on the next renewal.
   One certificate operation per node at a time: a second is refused (CONFLICT). Every
   step is logged with the node id.
3. **Revocation cuts, it does not forget.** `revokeMeshOnNode` puts EVERY leaf of the
   node that is not already on the CRL on it - the current one, an observed one, a
   renewal one and a leaf the hub had set aside (a copy of that one may sit on a stolen
   box) - and closes the node's mutual-TLS sockets; a leaf revoked this way is never
   reinstated when it is seen again. The result says the node must re-join with a new
   join token. A hub restart in the middle of a renewal sets the in-flight renewal leaf
   aside at boot (not current, not on the CRL; reinstated if the node is seen with it). Forgetting a node stays `clusterNodes.forgetNode`.
4. **The call path is the capability.** `node-certificates` is provided by the agent
   RUNTIME (the synthetic `agent-runtime` addon id, as `server-management` is) and
   called through the ordinary node-pinned capability proxy: no Moleculer action was
   added. No private key crosses the mesh in either direction.
5. **Agents serve HTTPS from the hub's LOCAL CA.** The agent makes a key and CSR; the
   hub signs the public key under `tls/camstack-ca.*` (the CA devices already trust).
   The smaller safe option was chosen for the names: the hub signs ONLY what it knows
   by itself - the node id and the remote address of the agent's LIVE mesh socket, when
   private (never an address the agent reports). Everything the agent reports about
   itself is dropped and logged; certifying extra self-reported names would need an
   operator approval flow, which does not exist. The observed address is skipped when it
   is zone-scoped IPv6 or in the default docker bridge 172.17.0.0/16 - then the node id
   alone is certified and the reason is reported (the hub's own bridge gateway is in its
   certificate's names, so excluded). Never signed: any name the hub's own
   certificate holds, any name already certified to another node (the hub remembers
   them in `agent_https_names`; two agents behind one NAT would otherwise share an
   address), and the node id `hub`. The agent keeps ONE file, `tls/agent-https.json`
   (0600: key + leaf + the pinned CA), written atomically, so a crash cannot leave a
   key that does not match its certificate; an unreadable or mismatched bundle is
   logged and treated as absent (plain HTTP keeps serving). The first CA that arrives
   over the authenticated mesh is pinned; a later leaf must chain to the pinned CA, not
   to the CA sent beside it. When the hub rotates its local CA (D227) it signals that on
   the authenticated install call (`caRotation`, decided from the CA fingerprint the node
   reports it pinned), and the node re-pins - verifying the leaf against the CA that came
   with it; without the signal a different CA is still refused. The hub records the names
   it signed BEFORE the install answer (a lost answer leaves them taken) and signs nothing
   while the names registry is not loaded; `forgetNode` releases a forgotten node's names,
   and a re-issue replaces the node's own row. The agent persists no database.
6. **One port, two protocols.** The agent's HTTP port also speaks TLS: the first
   byte of a connection decides (`0x16` is a TLS handshake record; no HTTP method
   starts with it), so the container contract does not change. A TLS client when no
   certificate is installed is closed and counted, never served in the clear. The
   serving context is replaced with `createSecureContext` per new handshake: renewal
   needs no restart; a bad certificate or key is refused and the previous one (or plain
   HTTP) keeps serving; a TLS handshake that does not finish in 10 s is destroyed; the
   listener is closed on shutdown (idle connections are destroyed after a 2 s grace);
   stalled-handshake warnings are logged once a minute. `reconnect()` runs through one
   serial queue with a 90 s per-job deadline: a broker whose `start()` never settles is
   destroyed and the queue moves on, so the rollback of a failed swap can still run. Both paths reach Fastify's own `http.Server`. Because Node's HTTP
   parser and TLS wrapper read a `net.Socket` natively and lose bytes already pulled
   into JS, the sniffed socket is wrapped in a duplex that replays the first chunk and
   forwards the peer address (the agent's loopback check reads it).
7. **`renewHttpsOnNode` works for agents too**: prepare, the hub signs, install and
   hot-swap. The hub's own HTTPS leaf is unchanged (`regenerateCertificate`).

## Consequences

- The mesh leaf lifetime (30 days) is now visible with its expiry per node, and an
  operator can renew it without touching the node. Nothing renews it automatically
  yet: that is a scheduler on top of `renewMeshOnNode`, not a new mechanism.
- Renewal needs the node online and on a build that provides `node-certificates`;
  an older agent answers "update the agent", not a silent no-op.
- A revoked node cannot reconnect and must be re-joined: revoking is deliberate.
- The mesh TLS listener does not open until the revocation registry has loaded and its
  revocations are in the CRL (`openMeshTlsWhenRevocationsLoaded`): with the settings
  store down, agents wait, because an empty CRL would accept a revoked leaf. The gate
  depends on the revocation registry ONLY (the names registry loads separately and best
  effort), catches its own failures (a failed open is retried), and publishes its state:
  `certificates.getMeshCertificates().listener` is `open`, `closed` (with a reason and
  since when) or `not-started`, for the admin page to show - topology status is unchanged.
  Without a settings store the error is logged once, loudly, not every 15 s.
- `node-certificates` is not a tRPC route: the runtime cap-router builder skips
  `mount: { kind: 'skip' }` caps (the line in the generated mounts table is inert; a
  spec pins that `nodeCertificates` is absent from the built routers).
- New schema: `mesh_node_certificates`; new capability `node-certificates` (admin
  tier, mount skipped); `types`, `system` and `server` must be published, and agents
  must be updated to gain HTTPS and renewal.

## Enforcement

Specs: `mesh-renewal.spec.ts` (ordering - the old serial is on the CRL only after the
hub saw the new leaf, failed swap keeps the old leaf and revokes nothing, backfill,
revoke), `agent-https.spec.ts` (SAN policy, issuance under the local CA, key never in
the CSR, install refuses the wrong key), `agent-sniffing-listener.spec.ts` (plain
HTTP and TLS on one port, TLS refused without a certificate, hot swap),
`agent-node-certificates.spec.ts` (persist beside the old leaf, self rollback,
refusals leave the file untouched), `certificates-router.spec.ts`. Disarmed: revoking
the old serial right after the install, before the node is seen, fails the ordering
specs.

## Amendment 2026-10-15 - a reconnect replaces the wire, never the broker

**Incident (server 1.2.565, agent agent-a, real hub).** `renewMeshOnNode` returned
`stage: confirm` with "`$agent-cap-fwd.forward` is not found on 'agent-a'". The agent log
showed `(child agent-a/ml gone)`, `pipeline-analytics gone`, `detection gone`, a settled
join with 6 addons instead of 17, then the rollback. The node stayed ONLINE and CAPLESS (no
`pipeline-runner`) until its container was restarted, and the hub registry kept the renewal leaf
as `current` while the node presented the old one.

**Cause.** `reconnect()` stopped the whole `ServiceBroker` and built another. Everything bound to
the old broker went with it: the `$process` service, whose `stopped()` SIGTERMs every forked
runner (the "child gone" lines), and every service created on it (`$agent`, `$agent-cap-fwd`, the
event bus, the readiness service, the addon services), plus every closure that had captured the
broker. The new broker was started empty, so the join settled with the in-process addons only and
the hub could not route `agent-child-forward`.

**Fix.**

1. **The broker is never rebuilt.** `broker-transport-swap.ts`: disconnect the transit, forget
   the remote nodes (their next INFO fires `$node.connected` again, which is what re-runs the
   mesh join), install a new transporter on the SAME transit (`createAgentTransport`, the one
   builder `createBroker` also uses, so a reconnect cannot dial differently from a boot) and
   connect it. Services, registries and child runners are untouched; the join's settle re-sends
   the full manifest (D3), children included, in one atomic `registerNode`. No timer, no poll.
   `agent-reconnect.ts` keeps its generation guard, now over the transporter; a late, abandoned
   run tears down nothing but a transport that is still installed. A reconnect that exceeds its
   deadline drops the wire, not the broker.
2. **The confirm gate waits for a node that is whole.** The registration announces the addon ids
   it carries (`emitProcessNodeRegistered(nodeId, addonIds)`). A renewal records the addons the
   hub held for the node before it started and treats a registration that lacks any of them as
   "not back yet" (logged), to the same single deadline; on the deadline it rolls back and names
   the addons that were lost. The confirm call itself retries EVERY failure, including
   `transport-failed ... is not found`, to the deadline.
3. **The registry converges on observation.** Every `registerNode` records the leaf the node
   presents NOW (`recordObserved`). Observing a live leaf sets aside (`renewal-abandoned`: not
   current, not on the CRL) any renewal leaf of the node that is newer than the presented one, so
   a node that reverted to its previous leaf is `presentingCurrent` at once; a node later seen with
   the set-aside leaf reinstates it, as before.

**Not changed, on purpose.** The old stop/rebuild/start cycle is gone, not kept as a fallback: a
transport that cannot be replaced in place is a connect that fails and is retried by the next
`reconnect()`, with the broker and its runners intact.

**Enforcement.** `agent-transport-reconnect.cluster.spec.ts` (real TCP: the agent's services and
their `stopped` hook survive, the hub calls `$agent-cap-fwd` again, `$node.connected` fires again;
disarmed by not forgetting the remote nodes), `mesh-renewal.spec.ts` (confirm waits for the
child-bearing registration and names the lost addons, retries "not found", the registry flips back
on revert; each disarmed), `moleculer-register-node-mesh-leaf.spec.ts` (the registration is the
observation; disarmed by removing the call).

**Review follow-up (same day).** `broker-transport-swap.ts` drives private Moleculer members, so
`moleculer` is pinned EXACTLY (0.15.0) in `packages/system` and `server/backend`, and
`broker-transport-swap-contract.spec.ts` (no socket) fails loudly if an upgrade moves any of them
(`transit.tx`, `tx.init`, `transit.messageHandler/afterConnect/connect/disconnect`,
`registry.nodes.disconnected/list`, `broker.wrapMethod`, `loadUrls()` replacing the hub node,
`init()` disabling heartbeats); the swap aborts BEFORE dropping the wire if one is missing.
Moleculer's own connect retry (every 5 s, on whatever `transit.tx` is when it fires) is neutralised:
every installed transporter's `connect` is single-flight, a failed connect is torn down before a
retry, and a replaced or dropped transporter never connects again. The TLS server is kept only once
it listens. A leaving transporter's writer/reader listeners are removed so a late FIN cannot touch
the shared node catalog. A renewal leaf is "in flight" until the handover ends, so a node seen with
its old leaf first does not flap it; when the handover ends the registry converges on the leaf the
node presents. A renewal rolled back for lost addons says the next one will go through.
