---
id: D1052
title: A mesh certificate does not expire, an expired one is recovered by the hub, and revocation is the only kill switch
status: accepted
date: 2026-11-15
supersedes:
applies-to:
  - packages/system/src/kernel/moleculer/mesh-mtls/constants.ts
  - packages/system/src/kernel/moleculer/mesh-mtls/mesh-ca.ts
  - packages/system/src/kernel/moleculer/mesh-mtls/mesh-peer-verification.ts
  - packages/system/src/kernel/moleculer/mesh-mtls/tls-tcp-transporter.ts
  - server/backend/src/core/agent/expired-leaf-renewer.ts
---

Amends D857 (a node's identity is its mesh certificate) and D856 (leaves are recorded and handed over).

## Context

Two production agents dropped off the mesh because their mesh leaf, valid 30 days, expired (#558).
Nothing said why: validity is checked only at the TLS handshake, the refusal was logged at debug,
and the broker pins the transport loggers to `error`. Renewal (`certificates.renewMeshOnNode`)
needs a live mesh to the node, so an agent whose leaf had expired could be recovered only by
pairing it again by hand, and a paired agent refuses offers.

Tried first, and rejected: keep the 30-day leaf and renew it automatically before it expires. It
moves the failure rather than removing it. Any agent that is off for longer than the margin (a
laptop, a box in storage, a hub down for a month) comes back with an expired leaf and is stranded in
exactly the same way, and the renewal job becomes one more thing that has to be alive for identity
to keep working.

## Decision

A mesh leaf is issued with `notAfter` = 9999-12-31T23:59:59Z (RFC 5280 section 4.1.2.5, "no
well-defined expiration date"), at pairing and at every renewal. Identity ends in two ways only:
revocation (the CRL) and an explicit rotation by the operator (`renewMeshOnNode`, which now issues
the same no-expiry leaf).

The hub recovers a leaf that has already expired. Its listener keeps verification on but lets the
handshake finish (`rejectUnauthorized: false` reports `authorized` / `authorizationError`) and
decides explicitly (`judgeMeshPeerLeaf`): a peer is admitted when it is authorized, or when its sole
failure is `CERT_HAS_EXPIRED` and an independent check proves the leaf is signed by the mesh CA, is a
client-auth end entity, has started, and is not on the CRL. The hub then logs a WARN tagged with the
node id and renews that node's leaf through the existing handover once the node has registered.
Every other failure, a revoked serial included, is refused. An enrolled agent never admits an
expired leaf.

Every refused handshake is logged at WARN with its reason (`no-certificate`, `not-chained`,
`expired`, `not-yet-valid`, `revoked`, `cn-mismatch`) and the node id, through a reporter the
process publishes, not through the pinned transport logger.

The mesh CA keeps its 3650-day lifetime. A leaf outliving its CA is harmless to the chain build
(validity is not nested); the CA is the one clock that still ends the mesh and is rotated by the
operator.

## Consequences

- A leaf that leaks is valid forever: revocation is the only kill switch, so a lost box must be
  revoked (unpair, forget). It was already the only way to stop a leaf inside its 30 days.
- The listener now completes the TLS handshake for a client the old config refused in the handshake,
  and destroys the socket before reading any byte. The refusal moved from the TLS layer to
  `onTlsClientConnected`.
- Leaves issued before this change still carry 30 days; they are replaced as they are renewed, or
  recovered by the hub when they expire. The hub's own leaf is re-issued at every boot, so it no
  longer expires on a hub that stays up.
- The hub dials an agent over the agent's listener with Node's own verification; a recovery works
  through the agent's inbound connection, which exists before any dial.

## Enforcement

`packages/system/src/kernel/moleculer/mesh-mtls/__tests__/expired-leaf-admission.spec.ts`: an
expired leaf that chains is admitted and announced, a revoked, a foreign-CA and a not-yet-valid leaf
are refused, an enrolled agent refuses an expired one, the issued `notAfter` is 9999-12-31, and each
refusal reaches the reporter with its reason. `server/backend/src/core/agent/__tests__/expired-leaf-renewer.spec.ts`
covers the renewal trigger.
