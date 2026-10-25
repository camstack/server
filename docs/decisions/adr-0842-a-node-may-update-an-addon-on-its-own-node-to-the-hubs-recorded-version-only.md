---
id: D842
title: A node may update an addon on its own node, to the hub's recorded version only
status: accepted
date: 2026-10-13
supersedes:
applies-to:
  - server/backend/src/api/trpc/remote-addon-update-grant.ts
  - server/backend/src/api/trpc/core-cap-bridge.ts
---

## Context

D840 made the agent's addon Update a request to the hub, but
`addons.updatePackage` is outside `REMOTE_PRIVILEGE_ALLOWLIST`, so the hub
refused it. That list is by path: adding the path would let any enrolled node
deploy any package version to any node.

## Decision

The bridge grants `addons.updatePackage` to a node through a scoped rule, not an
allowlist entry. The call is accepted only when all hold: the target `nodeId`
equals the caller's mesh node id (the identity Moleculer reports for the calling
node, never a field of the body); the version equals the version the hub itself
has installed for that package (the one its back-fill restores); the hub installs
that package. Every decision, allowed or refused, writes an auth audit row
(`agent-addon-update` / `agent-addon-update-refused`, user `node:<id>`). The
rule is active only where `remoteUpdateGrant` is passed to `buildCoreCapService`
(the hub boot); a bridge built without it keeps refusing the path.

## Consequences

- An agent can converge itself to the hub, nothing else: no other node, no older,
  newer or unpublished build.
- The refusal sentence is returned to the agent UI as the update's failure reason.
