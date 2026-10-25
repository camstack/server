---
id: D802
title: Another node reaches the hub only through the mesh gate — proven by challenge–response, and never with an identity the hub did not stamp
status: superseded
superseded-by:
  - D857
date: 2026-10-09
supersedes: D797 (only the D797 hash as the registration proof)
applies-to:
---

> **Superseded by [D857](adr-0857-an-agents-identity-is-its-mesh-certificate-there-is-no-cluster-secret-and-a-pairing-is-confirmed-on-both-screens.md) on 2026-10-16.** The challenge-response join, the transition/enforced modes and the hub gate that waited for a join are gone: the certificate is the identity. The Context below is still the record of why it was built.

## Context

The security plan of 2026-10-09 (§1) measured the Moleculer mesh as the worst
exposure in CamStack: risk 20 of 25. A host on the LAN that speaks Moleculer
TCP to port 6000 could:

- call `$core-caps.repl.execute` — code execution in the hub — because every
  `$core-caps` action ran under one synthetic admin (`createMeshTrpcContext`);
- call any hub in-process addon as a raw Moleculer service
  (`createAddonService` publishes `keychain.keychain-admin.reveal` and the
  rest), and pass a forged `caller: { userId, isAdmin }`, which
  `keychainAdmin.reveal` trusts — `cap-router-builder` overwrites `caller` only
  on the tRPC path;
- forward the same forged `caller` through `$hub-cap-fwd.forward`, whose args
  reached the provider verbatim (only `callerAddonId` was rewritten);
- call `$process.spawnRunner` with an arbitrary environment.

D797's cluster secret gated `$hub.registerNode` only, so none of the above
needed it; and its proof — `sha256(secret)` in clear — is a password
equivalent that a sniffer replays.

## Decision

Every action and event another node sends to the hub passes ONE broker
middleware (`createMeshAccessMiddleware`), keyed on the sender node id
Moleculer reports and bound to a proof by `MeshAuthenticator`:

1. **Join.** A node proves the cluster secret by challenge–response
   (`$hub.joinChallenge` → single-use 60 s nonce bound to the sender;
   `$hub.authenticateNode` → `HMAC(SHA-256(secret), nonce ‖ nodeId)`), and the
   hub proves it back over the node's own nonce. Nothing reusable crosses the
   wire. The agent's broker holds every call to the hub until the join settles,
   and refuses a hub that cannot prove the secret. The hub forgets a node on
   `$node.disconnected`.
2. **Verdict.** An authenticated node is allowed. One that is not is refused in
   `enforced` and tolerated with a warning in `transition` (D803). `registerNode`
   registers only the sender itself. `$process.*`, `$node.*` and
   `$hub.setLogLevel` are refused to every other node; `$hub.unregisterNode`
   works only on the sender itself.
3. **No foreign identity.** A remote request loses `caller` and
   `callerAddonId` from its params — from the forwarded `args` for
   `$hub-cap-fwd.forward`, whose envelope `callerAddonId` stays subject to the
   sender's manifest. `$hub-cap-fwd` strips `args.caller` on its own as well.
4. **`$core-caps` names its caller.** `repl` is no longer bridged. A call runs
   as `mesh` (the hub's own runners) or `node:<nodeId>` (another node), and
   `logs` / `addonSettingsRaw` are refused to `node:<id>`.

## Consequences

- **First step, not least privilege.** `node:<id>` is still an admin principal
  for every other bridged namespace, and an authenticated agent may call every
  hub addon service. The next narrowing needs data, not guesses: arm the mesh
  census (`describeMeshOrigin` names `mesh:<node>`), list what each agent
  calls, then turn `node:<id>` into a per-method grant.
- **Spoofing remains until mutual TLS.** The transport is clear text and each
  packet's sender id is self-declared: a LAN host that watches a node join can
  impersonate it afterwards, and can read resolved secrets crossing the mesh.
  `docs/design/2026-10-09-mesh-mtls-plan.md` is the next step.
- **Agent inbound is gated the same way (mirror).** An agent installs the same
  broker middleware with `AgentMeshAuthenticator`: the hub is admitted only
  after mutual join proof, own children via `$agent.registerNode` (secret hash),
  everyone else refused when the agent holds a cluster secret. Spoofing of a
  declared node id on clear text remains until mTLS.
- In `enforced`, an event an agent broadcasts in the milliseconds between its
  connection and its join is dropped. What matters is pulled by the hub on
  connect anyway (the readiness snapshot, D8), not taken from that window.
- A node presenting the old D797 hash is accepted as `legacy` in `transition`
  only. A new agent sends that hash only to a hub that predates this record
  (no `$hub.joinChallenge`), for one release.
- **Rollout: hub first.** A new hub in `transition` serves old agents as
  before. A new agent against an old hub falls back to the D797 path. Both
  orders work; hub first is the one that never needs the fallback.

## Enforcement

- `mesh-access.integration.spec.ts` (real brokers): `keychain-admin.reveal`
  with a forged `caller` is unreachable — directly and through `$hub-cap-fwd`,
  from an unregistered node and from an authenticated one; an unregistered node
  is refused in `enforced`; a captured join cannot be replayed; `$process` is
  refused to an authenticated agent; events from an unauthenticated node are
  dropped. Verified discriminating: with the strip removed, two cases fail.
- `mesh-authenticator.spec.ts`: single-use, expiring, sender-bound nonce;
  mismatch vs retryable; modes; `registerNode` rules.
- `mesh-join-client.spec.ts`: a rogue hub is refused, a wrong secret blocks
  calls, the secret and its hash never cross the wire.
- `mesh-join-tcp.cluster.spec.ts`: the same over the production `createBroker` on
  real TCP sockets.
- `hub-cap-forward.spec.ts`: the forward service drops `args.caller` alone.
- `core-cap-bridge.spec.ts`: `repl` not bridged; `node:<id>` vs `mesh`;
  `logs` refused to another node.
- `agent-mesh-authenticator.spec.ts` / `agent-mesh-access.integration.spec.ts`:
  an unauthenticated peer is refused on the agent; the hub is served only after
  mutual join; a forged `caller` is stripped; `$process.list` stays reachable
  from the authenticated hub.
