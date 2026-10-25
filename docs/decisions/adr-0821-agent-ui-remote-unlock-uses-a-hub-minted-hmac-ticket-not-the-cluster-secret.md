---
id: D821
title: Agent UI remote unlock uses a hub-minted HMAC ticket, not the cluster secret
status: superseded
superseded-by:
  - D857
date: 2026-10-09
supersedes:
applies-to:
---

> **Superseded by [D857](adr-0857-an-agents-identity-is-its-mesh-certificate-there-is-no-cluster-secret-and-a-pairing-is-confirmed-on-both-screens.md) on 2026-10-16.** Tickets are now ES256 JWS signed by the mesh CA key, not an HMAC under the secret. The Context below is still the record of why it was built.

## Context

Remote browsers on an agent's `:4444` dashboard required pasting the cluster
secret as a Bearer. That secret is the mesh trust anchor (D802 / D803) and a
pairing credential — putting it in `sessionStorage` of every admin tab that
opens an agent through NPM taught operators to treat it as a daily password.
A hub admin session already proves who they are; the agent only needs a
short-lived, node-bound proof it can verify with the secret it already holds.

## Decision

A hub admin mints a single-use HMAC ticket (`K = SHA-256(cluster secret)`,
domain `camstack-agent-ui-unlock/v1`, bound to `nodeId`, TTL ≤ 5 min). The
agent redeems it at `POST /api/agent/session` for an opaque tab session Bearer
(8 h, in-memory). Pairing (unpaired agent) still requires the cluster secret
or a mesh join token. Pasting the secret remains an emergency unlock only.

## Consequences

- Daily unlock flows through the hub admin session (Open dashboard / Continue
  with hub); the cluster secret is revealed only for pairing and emergencies.
- A stolen ticket is useless after one redeem or five minutes; a stolen session
  token dies with the agent process.
- `returnTo` for Continue-with-hub is allowlisted (`:4444` or
  `agentDashboardOrigins`).

## Enforcement

`agent-ui-unlock.spec.ts` (mint/verify/JTI/returnTo) and agent-http auth /
session specs.
