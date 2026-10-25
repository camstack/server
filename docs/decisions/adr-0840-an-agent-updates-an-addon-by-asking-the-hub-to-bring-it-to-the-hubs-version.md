---
id: D840
title: An agent updates an addon by asking the hub to bring it to the hub's version
status: accepted
date: 2026-10-13
supersedes:
applies-to:
  - server/backend/src/agent/agent-hub-addon-update.ts
  - server/backend/src/agent/agent-update-routes.ts
  - server/backend/src/api/trpc/core-cap-bridge.ts
---

## Context

The agent UI could update the framework but not an addon, on the reasoning
that "there is no agent-to-hub trigger". That is no longer true: `addons` is in
`HUB_SERVICE_CAP_NAMES`, so `$core-caps.addons.*` is reachable over the mesh.
The real trap is different: every reconnect runs the back-fill, whose intended
version is "the hub's own installed version, and only that". An update run on
an agent to any other version is restored to the hub's.

## Decision

The authority for an agent's addon version is the hub's installed version. The
agent's Update asks the hub, over the mesh channel it already holds, to deploy
the hub's version of that package to this node
(`addons.updatePackage({ name, version: <hub version>, nodeId: <self> })`);
the hub packs and pushes it. A newer published release is a hub-level decision
and is shown, not started. Nothing is installed locally and no new credential
exists. The hub's refusal is shown verbatim.

## Consequences

- `addons.updatePackage` is outside `REMOTE_PRIVILEGE_ALLOWLIST`; the hub accepts it from a node only under the scoped grant of D842 (own node, the hub's recorded version, audited).
- Both `addons.list` (the hub's versions) and `updatePackage` are called as the
  agent's node principal, never as an admin session.
