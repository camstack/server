---
title: Mesh mutual TLS — implementation plan (2026-10-09)
last-verified: 2026-10-09
---

# Mesh mutual TLS — implementation plan (2026-10-09)

Status: **LIVE cutover 2026-10-09 evening** — both agents enrolled (TLS),
`meshClearPort=off` on hub (:6000 closed). Server **1.2.497** /
`system@1.2.390`. Soft reconnect after enroll is insufficient (runners orphaned);
hard-restart the agent. `meshClearPort` via admin UI needed
`updateGlobalSettingsAsOperator` → section-aware path (same release).
Built on: CA + join tokens + `POST /api/mesh/enroll` + dual-port transporter +
A→B writer TLS dial + registerNode hub pin. `clearMeshTls` on
`POST /api/agent/config` remains the permanent recovery control.
Known gaps: a token-only agent has no cluster secret, so it stays `no-secret`
under D802 `enforced` until the hub accepts a TLS CN as join proof; an agent
with `meshTls` also listens on 6443, so two such nodes on one host collide.
The P1 containment it builds on shipped as D802–D804. This record is P2 of the
[security hardening plan](2026-10-09-security-hardening-plan.md) §1,
recommendation D + C + E.

## Why it was not done in the same pass

It is a transport change on both ends of every cross-node packet, with a PKI
behind it, and it must keep a Node agent (`server/backend/src/agent/main.ts`)
and an Electron agent (`packages/desktop`) working. Measured scope: a TLS
subclass of Moleculer's TCP transporter (reader + writer + the UDP path), a CA
with issuance, renewal and revocation, a join-token flow that replaces the
"copy the secret" step in two setup UIs, and a rollout that cannot split a
live cluster. That is the L of the plan (> 1 week with specs), and D802 already
removes the unauthenticated-admin path. P1 first was the operator's fallback.

## What it closes that D802 does not

| Residual after D802 | Closed by |
| --- | --- |
| A LAN host that watched a node join spoofs its node id afterwards (sender id is self-declared per packet) | per-connection certificate, sender id = certificate CN |
| Resolved secrets and camera credentials cross the mesh in clear | TLS 1.3 on every mesh socket |
| An agent accepts calls from any node *(partially closed: agent inbound gate admits only the mutually joined hub and own registered children; spoofing of those ids remains)* | the agent requires a hub-CA certificate too (mutual) |
| The hub's service catalog is readable by anyone who connects (INFO) | no TLS handshake, no packet |
| Discovery is needed to find the hub | the join token carries the address; UDP off on the hub |

## Design

### 1. The hub CA

- An EC P-256 CA key generated at first boot, kept in the keychain
  (`secret://system/global/meshCaKey`, owner `system`, always "in use"); the CA
  certificate (10 y) is public and lives in `system-settings` `cluster.meshCa`.
- Library: Node's `crypto` has no X.509 *issuance*. Use `@peculiar/x509`
  (pure TS over WebCrypto — works in Node and Electron, no native build) —
  confirm the version against the registry before adopting it.
- A locked keychain: no issuance, existing certificates keep working until
  expiry (the CA key is needed only to sign).

### 2. Join tokens (replace "copy the secret")

- System → Cluster → **Add agent** mints a token: `{ v, hubUrl (https 4443),
  hubMeshAddress (host:6000), caFingerprint (SHA-256 of the CA cert), nodeId?,
  jti, exp ≤ 1 h }`, signed with the CA key (JWS ES256). Single use (`jti`
  recorded until `exp`), shown once, copyable as one string.
- The agent's first-run setup (status page `POST /api/agent/config`, desktop
  Setup window) takes the token instead of the secret. The agent:
  1. generates its own key pair (kept in `agent.json` 0600 — desktop: OS
     keychain via `safeStorage`, as D797 does for the secret);
  2. calls `POST /api/mesh/enroll` on `hubUrl` over HTTPS, pinning the hub's
     TLS by the CA fingerprint in the token (the hub's 4443 certificate is
     issued by the same CA, or the token also pins the HTTPS leaf);
  3. sends `{ token, csr }`; receives `{ cert (30 d), caCert }`.
- The cluster secret stays valid as a join proof for one release
  (`transition`), then is removed.

### 3. Transport: `TlsTcpTransporter`

- A subclass of Moleculer's `TcpTransporter` that overrides the two socket
  factories: `TcpReader` (`net.createServer` → `tls.createServer` with
  `requestCert: true, rejectUnauthorized: true, ca: [caCert], minVersion:
  'TLSv1.3'`) and `TcpWriter` (`net.connect` → `tls.connect` with the node's
  cert/key and `checkServerIdentity` comparing the peer CN to the expected node
  id). Both live in `node_modules/moleculer/src/transporters/tcp/tcp-reader.js:55`
  and `tcp-writer.js:71`; subclass them (preferred) or extend the existing
  `patches/moleculer+0.15.0.patch` (it already carries the D457 parser fix).
- **Bind identity to packets:** the reader knows the peer certificate of the
  socket a packet arrived on; drop any packet whose `sender` ≠ that CN
  (`transporterReceive` hook or inside the reader's `onTcpClientConnected`).
  This is what makes the D802 `ctx.nodeID` trustworthy.
- UDP discovery: off on the hub once `enforced` + mTLS; agents connect to the
  address from the token.
- Electron: the agent runtime already runs Node's `tls`; nothing native.

### 4. Privilege (E)

With a trustworthy `ctx.nodeID`, turn D802's `node:<id>` from admin into a
grant: measure with the mesh census (`mesh:<node>` principals) over a week of
normal traffic, write the per-namespace/method allowlist, refuse the rest,
keep a "log only" week first.

### 5. Renewal and revocation

- Certificates live 30 d; the agent renews over the mesh at 2/3 of lifetime
  (`$hub.renewCertificate`, authenticated by the current certificate).
- **Forget node** on the Cluster page revokes: the serial goes into an
  in-memory CRL (persisted in `system-settings`), checked in the reader's
  handshake; the node's open sockets are closed.

## Rollout (no split)

1. Release A — hub: CA + enroll endpoint + `TlsTcpTransporter` listening on a
   SECOND port (6443) alongside clear 6000. Agents unchanged.
2. Release A — agents: an agent with a certificate dials 6443, else 6000.
   The operator enrolls each agent (token). System → Cluster shows per-node
   "TLS / clear".
3. When every known agent is on TLS (same rule as D803), the hub stops
   listening on 6000 and turns UDP off. A switch back exists for one release.

## Specs to write first

- A forged packet `sender` on a TLS socket whose CN differs is dropped.
- A node without a CA-issued certificate cannot complete the handshake (both
  directions).
- A token is single use, expires, and pins the hub (a MITM with another CA
  fails enrollment).
- A revoked certificate is refused at the next handshake and its sockets close.
- Electron: the desktop agent enrolls and connects (packaged-app smoke).

## Effort

L: CA + enroll (3 d), transporter + identity binding (3 d), agent/desktop
enrollment UX (2 d), renewal/revocation (2 d), rollout switches + specs (2 d).
