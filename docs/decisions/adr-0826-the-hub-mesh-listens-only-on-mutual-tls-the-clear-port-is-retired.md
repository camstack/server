---
id: D826
title: The hub mesh listens only on mutual TLS; the clear port is retired
status: accepted
date: 2026-10-11
supersedes:
applies-to:
  - packages/system/src/kernel/moleculer/mesh-mtls/**
  - packages/system/src/kernel/moleculer/broker-factory.ts
  - packages/system/src/builtins/system-config/system-config.addon.ts
  - server/backend/src/core/moleculer/moleculer.service.ts
---

## Context

Release A ran mesh mTLS on `:6443` alongside the legacy clear TCP port `:6000` and
UDP discovery so operators could enroll agents with a join token without cutting off
agents still on clear. That parallel channel defeats the purpose of mutual TLS: any
node on the LAN could keep using unsigned clear mesh traffic while enrolled peers
used certificates.

Operators who have not yet enrolled every agent must do so before upgrading to a
hub build that ships this decision — otherwise those agents lose mesh connectivity
until they present a join token and receive a leaf certificate.

## Decision

The hub **never** listens on clear mesh TCP `:6000` or mesh UDP discovery for
cluster join. Only the mutual-TLS listener on `:6443` (default) is started once the
mesh CA is ready. Join tokens carry `hubMeshAddress` with the TLS port, not `:6000`.
There is no operator setting to re-open clear mesh on the hub.

Agents without a mesh leaf may still reach the hub over HTTPS for enrollment; they
must not expect clear Moleculer TCP to the hub after this cutover.

## Consequences

- A cluster with agents still dialing clear `:6000` **disconnects** when the hub
  upgrades — intentional; enroll each agent with `mintJoinToken` first.
- E2E and dev overrides that relied on `CAMSTACK_HUB_TCP_PORT` for hub clear listen
  no longer apply to hub mesh listen (agents retain their own derived listen ports).
- The agent side of UDP discovery is removed too (D843): an agent without a hub
  address stays `unconfigured` instead of listening for an announcement that no
  hub sends.
- `MeshTransport` telemetry may still report `clear` for misconfigured peers that
  never completed TLS; the hub will not accept their connection.

## Enforcement

- Hub `TlsTcpTransporter` is constructed with `hubTlsOnly: true` in `broker-factory`.
- Tests: `mesh-tls-only-transport.spec.ts`, system-config join-token address tests.
- Review only for stored `cluster.meshClearPort` rows — ignored on write, not migrated.
