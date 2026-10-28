---
id: D857
title: An agent's identity is its mesh certificate — there is no cluster secret, and a pairing is confirmed with the same six digits on both screens
status: accepted
date: 2026-10-16
supersedes: D802, D803, D821 (whole); D797 and D799 (only what they say about the cluster secret)
applies-to:
  - packages/system/src/kernel/moleculer/mesh-identity.ts
  - packages/system/src/kernel/moleculer/mesh-mtls/tls-tcp-transporter.ts
  - packages/system/src/kernel/moleculer/mesh-mtls/pairing/**
  - packages/system/src/kernel/moleculer/agent-ui-unlock.ts
  - packages/system/src/builtins/local-network/agent-mdns.ts
  - packages/types/src/capabilities/node-certificates.cap.ts
  - server/backend/src/core/moleculer/hub-mesh-guard.ts
  - server/backend/src/core/agent/hub-agent-pairing.ts
  - server/backend/src/core/agent/agent-pairing-http.ts
  - server/backend/src/api/core/agent-pairing.router.ts
  - server/backend/src/agent/agent-mesh-gate.ts
  - server/backend/src/agent/agent-pairing-routes.ts
  - server/backend/src/agent/agent-pairing-store.ts
  - server/backend/src/agent/agent-http-auth.ts
---

## Context

Four layers had grown around one shared string. The cluster secret was generated
by the hub (D803), copied by hand into every agent, hashed into a challenge–
response join (D802), used as the key of the agent-UI unlock tickets (D821) and
checked as a Bearer on the agent's `:4444`. It had to be revealed, pasted,
rotated everywhere, kept in two keychains and two settings rows, and an agent
without it either ran in a `transition` mode that tolerated strangers or was
refused with an error that read like a bug.

At the same time D826/D848/D856 gave every node something strictly better: a
leaf certificate from the hub's mesh CA, a TLS listener that refuses any other
chain, a transporter that drops a packet whose `sender` is not the peer's CN,
and a registry that revokes. Nothing marked a TLS peer as authenticated BY that
certificate — the secret was still asked for on top, on a channel that was
already mutually authenticated.

What was tried first and rejected: keeping the secret as a second factor "for
one more release". The two identities disagree the moment one of them is
stale (a rotated secret, a revoked leaf), and the agent then shows the operator
the wrong one of the two as the reason.

## Decision

**The mesh certificate is the node identity, and the cluster secret does not
exist.** A node is admitted when its mutual-TLS handshake chained to the mesh
CA, its leaf CN is the node id it speaks as, and the serial is not on the CRL
(`TlsTcpTransporter.verifiedPeer`). The hub's gate (`MeshIdentityGate`) and the
agent's (`AgentMeshIdentityGate`: only the certified hub may call an agent) do
nothing but turn that answer into allow or deny, plus a short list of actions
no node may call. They hold no state, so a revocation takes effect on the next
packet and there is no join to wait for or hold messages behind.

**An agent is paired, never given a secret.** The hub starts it (an agent found
over mDNS `_camstack-agent._tcp`, or an address the operator typed) and the
operator confirms the SAME six digits on the hub AND on the agent's own page.
After pairing every agent↔hub interaction is certificate-based.

```
hub                                   agent (unpaired, plain HTTP :4444)
 |  GET  /api/agent/pairing/hello  -------------->|  { nodeId, state, version }
 |  POST /api/agent/pairing/offer  -------------->|  CA cert, commit = H(caFp | hubNonce),
 |                                                |  hubUrl, hubMeshAddress
 |<----------- { pairingId, CSR, agentNonce } ----|  mesh key made HERE, TTL 5 min
 |  POST /api/agent/pairing/reveal -------------->|  hubNonce (agent checks the commit)
 |                                                |
 | code = 6 digits of H(caFp | agentPubKey | hubNonce | agentNonce)   — on BOTH sides
 |                                                |
 | operator types the code read on the AGENT      | operator types the code read on the HUB
 | -> hub confirms      (3 wrong codes cancel)    | -> agent confirms    (3 wrong codes cancel)
 |                                                |
 |  (the hub polls GET .../pairing/status until the agent confirmed — either order works)
 |  POST /api/agent/pairing/complete ------------>|  leaf signed by the mesh CA + ES256 proof over
 |                                                |  (pairingId, nodeId, both nonces, leaf fp, CA fp)
 |                                                |  installed ONLY if confirmed locally and the
 |                                                |  proof verifies under the CA that was OFFERED
```

- **Commit–reveal.** A code is 20 bits. A man in the middle who could choose a
  value after seeing the others could grind a CA key whose code equals the real
  one in about a million tries. The hub therefore commits to its nonce (bound to
  the CA it offers) before it sees the agent's answer, and reveals only after, so
  nothing the attacker controls is chosen after everything the code derives from
  is fixed. A substituted CA or key changes the code (tested with a substituting
  transport), and the operator cannot confirm what he reads.
- **Local confirmation is the gate.** `complete` is refused with
  `awaiting-local-confirmation` until the agent's own operator typed the hub's
  code; the agent never installs a certificate on the hub's say-so alone, and
  verifies the proof with the CA it was offered, not the one in the message.
- **One at a time.** A second hub offering while a pairing is pending is refused;
  a paired agent refuses every offer (unpair first, from the hub or locally);
  expiry or a rejection on either side cancels both; the hub refuses a node id
  that is already connected, and supersedes (revokes) every older leaf of a node
  id when it pairs it.
- **The operator TYPES the other screen's code.** `confirmPairing` and the
  agent's `confirm` compare what was typed with the code computed locally. A
  page that echoes the code it was given defeats the check; the admin UI must not.
- **The agent's `:4444` while unpaired** serves only the pairing protocol
  (`hello`, `offer`, `reveal`, `status`, `confirm`, `reject`, `complete`), health
  and the static UI. Every other `/api/` route needs loopback, or a session minted
  from a hub unlock ticket. Pairing routes are authorized by what they carry (a
  pairing id the agent made up, a proof the mesh CA signed), not by who calls.
- **Unlock tickets (D821)** are ES256 JWS signed by the mesh CA key
  (`typ: camstack-agent-ui-unlock+jwt`, `use: agent-ui-unlock`), verified by the
  agent against the CA it pinned at pairing; join tokens and pairing proofs are
  also CA-signed and cannot be replayed as tickets (typ and use are pinned both
  ways). The "emergency cluster secret" Bearer is gone; loopback is unchanged.
- **Unpair** — hub: `agentPairing.unpairAgent(nodeId)` tells the agent first
  (`node-certificates.forgetHub`: the agent erases its mesh material and the
  HTTPS bundle, goes unpaired, advertises again), THEN revokes every certificate
  of the node and drops its sockets; an unreachable agent is still revoked. Agent:
  `POST /api/agent/pairing/forget` (this machine or a hub-unlocked session).
- **Discovery.** Every agent advertises `_camstack-agent._tcp` on its API port:
  TXT `nodeId`, `version`, `state=unpaired|pending|paired`, `fp` (short leaf
  fingerprint, only once paired). There is no pairing key to advertise before a
  pairing: the key is fresh for every offer. Finding an agent grants nothing.

**There are no join tokens.** `mintJoinToken`, `/api/mesh/enroll`, `POST /api/agent/config
{ joinToken }`, the agent's boot-time redemption and the desktop setup field are removed: the
shared-secret era is over, and an agent gets a certificate only by being paired (the same six
digits on both screens). A hub-less enrollment of a headless agent is not a supported path.

**"Loopback" is a property of the socket, and a relay on the same host defeats it.** The agent
treats a request as "this machine" when the peer is loopback, no forwarding header is present, the
Host is `localhost`, `127.0.0.1` or `[::1]`, the Origin is absent or the same, and a mutation is
`application/json` (a web page or a DNS-rebound name cannot satisfy all of these; the API sends no
CORS headers). It cannot see a same-host relay that adds none of those headers: `socat`,
`ssh -R`, a port-forward or a reverse proxy that rewrites them make a remote caller look local.
Run no such relay on an agent's :4444, and treat anyone who can open a local port on the machine as
its operator.

**An unpaired agent has no mesh reader.** Its transport is the mTLS transporter with `hubOnlyPeers`
and no material: it listens on no clear port, dials nobody and accepts no packet. A plain Moleculer
TCP reader would take a msgpack REQUEST from any LAN host, and a request naming the receiver as
its own sender is treated as an in-process call. Both holes are closed in the transporter (a packet
with a missing, non-string or own sender is dropped) and in the mesh middleware (no sender is never
local).

**The config API is an allow-list.** `POST /api/agent/config` writes `name`, `hubAddress` and
`logLevel` and refuses every other key whole; `GET` returns no filesystem path.

**No cleanup code.** Nothing reads or writes the secret any more: a `secret`
field in `agent.json` is never read (and never echoed), a keychain entry
`secret://system/global/clusterSecret` is no longer recognised as in use (it
reads as an orphan the operator deletes on the Secrets page), and the
`cluster.clusterSecret` / `cluster.meshAuth` settings rows are dropped on write.
The operator's manual checklist is in
(planning repo: superpowers/plans/2026-10-16-cluster-secret-removal.md).

## Security review amendments (same decision)

A review of the first implementation found that "confirm on the agent's own UI" was doable by anyone on
the LAN. What the decision now says:

- **The agent confirms only for someone at its machine.** Entering `pending` the agent mints, per hub
  offer, a one-time **local pairing PIN** (8 digits, single use, TTL = the pending TTL). It is shown ONLY
  locally: on the process console (`docker logs` for a container), in a 0600 file `pairing-pin.txt` in
  the data dir, and to the desktop window through the agent's loopback `status`. `confirm` and `reject`
  need that PIN (constant-time compare, wrong PINs counted: 5 in 5 minutes lock confirming for 2 minutes)
  unless the request is **genuinely local** - a loopback peer with no forwarding header (`Forwarded`,
  `X-Forwarded-*`, `X-Real-IP`, `Via`): a reverse proxy on the same host would otherwise make every
  caller loopback. The operator types (a) the hub's code and (b) the local PIN into the agent's page. A
  status read from the network returns the state, who asks (hub name, URL, CA fingerprint) and the
  expiry - never the code, the pairing id or the PIN. The hub follows its pairing with `poll`, which is
  authorized by the pairing id and returns only "pending/idle" and whether the local operator confirmed.
- **Grinding is rationed.** Offers that never reached local confirmation are budgeted while unpaired:
  3 per 10 minutes, then a lockout (5 minutes, doubling per further abandonment, capped at 1 h); the same
  hub CA waits 30 s, doubling to 10 min, after its second abandonment. Refusals are `429` with
  `retryAfterMs`, and logged. Offers are also rate limited per source address at the route.
- **Several offers coexist** (up to 4 pending sessions, one per hub CA fingerprint), so a stranger's
  offer cannot squat the slot of the real hub; the local operator picks by hub name/CA and code.
- **The reserved node id.** `issueMeshLeafFromCsr` refuses `hub` (any case) and any id outside
  `^[a-z0-9][a-z0-9._-]{0,62}$`; only the in-process hub-own-leaf path may issue the reserved id. The
  hub refuses a node id differing only in case from one it knows; the agent refuses to carry an invalid id.
- **An unpaired agent offers nothing but the pairing protocol to the network**; config writes and restart
  need loopback or a hub-unlocked session, and the inbound mesh gate only admits the hub by certificate.
- **Sessions are bound to what vouched for them** (the pinned CA fingerprint): replacing the CA ends them,
  and the one-use ticket ledger restarts with it. Tickets carry `iat`, live at most 5 minutes and are
  refused when issued before the agent booted; pairing proofs carry `iat` and a 5-minute maximum life.
- **The hub revokes a node's previous leaves only after the new pairing completed** (keeping the new
  leaf), never before issuing. A ticket's `returnTo` is limited to private/local hosts on port 4444 (or an
  operator-listed origin).
- **Offers are signed, and the board can be cleared.** The CA certificate is public, so an offer is an
  ES256 signature, made with the CA KEY, over its transcript (target agent, hub, CA fingerprint,
  commitment, addresses, `iat`); it is single use and at most 2 minutes old. An unsigned or invalid offer
  never creates or replaces a session and is never counted. When all four slots are taken a signed offer
  evicts the oldest pairing whose hub never revealed or polled (never one the operator confirmed). A
  stranger who still fills the slots with throwaway CAs and spends the abandon budget is undone by the
  **local reset code**: printed at boot to the console and `pairing-reset.txt` (0600), renewed on use,
  accepted by `POST /api/agent/pairing/reset` (from this machine no code is needed); it clears lockouts,
  the budget and every pending offer.
- **Wrong PINs and reset codes are counted per source address** (5 in 5 minutes lock that source for
  2 minutes, doubling); 200 wrong PINs across sources within one pairing lifetime cancel the pending
  pairings. Loopback is never locked. A stale `pairing-pin.txt` is removed at boot.
- **A failed completion never revokes a leaf the agent may have installed.** The hub asks the agent
  (`poll`): installed means paired; provably not installed revokes that one leaf; unreachable revokes
  nothing and says so. `GET config` never echoes `meshTlsPrevious`. A ticket may be issued before the
  agent's boot by up to 2 minutes (clock skew). A ticket's `returnTo` must be an address the hub knows for
  that node (its id, the address of its live mesh socket) unless the operator listed the origin.
- **The agent remembers how each pairing ended, by pairing id** (the last 16, for 15 minutes), so ending
  the other pending sessions never changes the answer a hub gets for its own. A hub that gets
  `no-pairing` learns nothing about its leaf: it checks whether the leaf has appeared on the mesh
  (registry convergence), and otherwise revokes nothing and reports the pairing as "unconfirmed" until
  observation settles it. With no names recorded for a node the hub issues no `returnTo` at all.
- **Accepted for a LAN appliance:** a stranger on the LAN with self-signed CAs can fill the offer slots
  and spend the abandon budget; the local reset code recovers it. Cancellations caused by the wrong-PIN
  ceiling do not count toward the abandon budget.
- Known and accepted, documented only: an on-path attacker on the plain-HTTP pairing link can delay but
  not complete a pairing; the 8-digit PIN is brute-forceable only within the per-source and global limits.

## Rollout — two releases, never one

The cluster is updated hub first, then `applyServerUpdate` to each agent THROUGH the hub, with the
capabilities checked after every node. A single release that drops the join strands every agent: an
agent that still holds a secret keeps its own inbound gate and refuses the hub's calls (it can only mark
the hub authenticated by the old mutual proof), so the hub could not even deliver the update. So D857
ships as two releases:

**Step 1 — the transition release (ships to EVERY node first).** Purely additive:

- the **agent** serves the hub when the hub's mutual-TLS leaf chains to the CA the agent pinned, its CN
  is `hub` and it is not revoked (`AgentMeshAuthenticator.isVerifiedPeer`), IN ADDITION to the old
  mutual join; a hub that stops answering the join is read as `unsupported` by the existing client and
  its calls flow;
- the **hub** admits a node by its certificate (`MeshAuthenticator.isVerifiedPeer`: calls, events,
  `registerNode`) and keeps answering the HMAC join, reading the keychain secret exactly as before
  (read-only: nothing new is generated or written); it still mints HMAC unlock tickets;
- discovery (`_camstack-agent._tcp`), the pairing protocol and `agentPairing.*`, `node-certificates.forgetHub`
  (unpair), and ES256 unlock tickets (accepted by the agent beside HMAC) are all there;
- an agent that holds a mesh certificate is locked on `:4444` even without a secret.

**Step 2 — the removal release (only after every node reports step 1).** Removes the HMAC join and its
actions, the modes, the auto-enforce, the keeper, the secret settings and keychain wiring, the Bearer
secret and the emergency path, the legacy registerNode hash, and the HMAC tickets (the hub mints ES256
only); replaces the two gates with the stateless certificate gates.

| hub | agent | registers | hub -> agent call |
| --- | --- | --- | --- |
| step 1 | old (pre-D857) | yes | yes — mutual join, as before |
| step 1 | step 1, secret | yes | yes |
| step 1 | step 1, no secret | yes | yes — certificate |
| step 2 | step 1, secret | yes | yes — the join is gone, the certificate serves |
| step 2 | step 1, no secret | yes | yes |
| step 2 | OLD agent | yes | **no** — why step 1 reaches every node first |

Both halves are specs (`rollout-matrix.integration.spec.ts` in step 1; the step-2 spec of the same name
emulates the step-1 agent's observable moves against the real removal hub). Operator order: (1) publish
and apply step 1, hub then each agent through the hub; (2) check every node runs step 1 and holds its
capabilities (`nodes.topology`); (3) publish and apply step 2 the same way; (4) ONLY THEN the manual
cleanup of the secret (keychain orphan, settings rows, each agent's `agent.json` field) — an agent whose
secret is removed while it still runs the old release cannot join. A secretless agent paired during
step 1 unlocks its page from its own machine until step 2 (the step-1 hub still mints HMAC tickets).

## Consequences

- **A LAN confirmation is as strong as the LAN path to the agent's page.** The
  agent's page is plain HTTP before pairing: a man in the middle who can rewrite
  that page can show the operator a code that matches the hub's. Confirmation
  on the agent's own machine (loopback) is not exposed to that. The code never
  protects a path an attacker can already rewrite; it protects the CA substitution,
  which is what pairing exists to prevent. The unauthenticated offer endpoint can
  be squatted for five minutes by anyone on the LAN (the pending slot); the
  agent's operator rejects it on the page.
- **The HTTPS leaf is not part of the pairing.** The hub certifies only the
  address of a LIVE mesh socket (D856); at pairing time there is none. HTTPS is
  issued by the existing hub-driven renewal once the agent is on the mesh.
- **The admin UI, agent UI and desktop setup no longer name a secret.** The external repositories
  (unraid template, proxmox script, public docs) are mirrored by hand (D717, D822).

## Enforcement

Specs: `mesh-mtls/__tests__/peer-identity.spec.ts` (real TLS: valid, unknown
CA, wrong CN, revoked), `mesh-access.integration.spec.ts` and
`agent-mesh-access.integration.spec.ts` (gates over real brokers, old-agent
messages ignored), `pairing.spec.ts` (happy path, either order, substituting
man in the middle, local-confirmation gate, proof binding, expiry, refusal while
pending/paired, three wrong codes), `agent-pairing-routes.spec.ts` (real HTTP),
`agent-pairing-router.spec.ts` (discovery, unpair both ways),
`agent-ui-unlock.spec.ts` (ES256). Each gate was disarmed once and the named
spec went red. There is no guard script: nothing mechanical stops a new secret
from being introduced, review only.

## Amendment 2026-10-28 - the agent shows its own code, only after it confirmed

Observed live: the agent page asked for "the code shown on the hub", accepted it, and never displayed the
agent's OWN computed code, so the operator could only re-type the hub's code on the hub - a degenerate check
that does not protect against a man in the middle faking "agent confirmed" on the poll. The rule is now:

- The hub asks for the code computed BY THE AGENT, so the agent shows it - but only **after** the local
  confirmation (hub code, plus the PIN away from the machine). Before that it is hidden, so it cannot be copied
  into the agent's own field.
- Loopback `status` carries `code` as `null` until `localConfirmed`, then the code. The network `status`
  never carries it (unchanged).
- A successful `confirm` (which required the PIN, or loopback) answers `{ ok: true, code }`; the page shows
  that code ("type this code on the hub"). Counters and constant-time compares are unchanged.
- The console and `pairing-pin.txt` print the PIN and who asks at reveal; the agent's code is printed there only after the local confirmation.
