---
id: D982
title: The hub owns every node's addon set; an agent converges to it and never removes an addon on its own
status: proposed
date: 2026-10-31
supersedes:
applies-to:
  - server/backend/src/core/agent/agent-addon-backfill.ts
  - server/backend/src/core/agent/agent-registry.service.ts
  - server/backend/src/core/agent/cluster-node-history-store.ts
  - server/backend/src/api/addon-upload.ts
---

## Context

An agent's addon set is today the roster the agent itself last DECLARED.
`recordPackages` (grow-only) stores what the agent reported on connect, and
`computeBackfillPlan` brings that roster back to the hub's versions. The hub
decides nothing beyond that:

- **A node with a roster never receives a new any-node addon.** `computeFreshNodePlan`
  (D962) applies only when the roster is empty. amd-proxmox joined before D962 and
  never got `terminal`; the operator found it by hand (2026-10-30).
- **Delivery runs at the wrong moments.** The back-fill runs on (re)connect, and
  `propagateToAgents` fans out only on a tarball upload, only to agents online at
  that instant. An npm `addons.updatePackage` without a `nodeId` is hub-only.
- **The hub cannot update an agent-only addon.** The back-fill skips the agent
  bootstrap set (`@camstack/system`, `@camstack/addon-agent-ui`) and drops every
  package the hub does not itself install (`notOnHub`). `addons.updatePackage`
  for agent-ui on the hub fails with "not currently tracked in manifest".
- **Leftovers stay.** little-unraid still carries hub-only packages (auth,
  notifiers, benchmark) from an older placement, at stale versions.

The operator's rule (2026-10-30): the hub drives every node's addons; an agent
cannot delete its own addons, because they support that node's functions; the
state is checked periodically; an addon leaves an agent only when it is deleted
on the hub; and the hub also updates agent-only addons.

## Decision

The hub keeps a **desired set per node** and every agent converges to it. The
desired set of a node is: every package the hub installs whose placement allows
that node (`any-node`, or a placement naming it), plus the agent-only packages the
hub tracks for agents (agent-ui), minus the packages tombstoned for that node, at
the hub's tracked version. The agent's declared roster is an observation used to
compute the difference, never the intent. A reconcile computes that difference
and applies it — install missing, update behind, remove what is tombstoned or no
longer placed there (a hub-only leftover) — on connect, after any hub install,
update or uninstall, and on a fixed schedule for every online node. An agent
refuses a local uninstall of a package in its desired set; the only way a package
leaves a node is a hub-side tombstone (`noteAddonUndeployed` /
`notePackageUndeployed`, or a hub uninstall `everywhere`).

## Consequences

- The hub must track a version for an agent-only package without loading it
  itself: a manifest entry marked "tracked for agents", which `updatePackage`
  resolves and fans out instead of answering "not tracked".
- `recordPackages` stops being the source of intent; the store keeps the
  tombstones and the last observation. The fresh-node special case (D962)
  becomes the general rule and its branch goes away.
- The periodic reconcile is a convergence loop, not a wait: it never gates
  registration (D3) and a failed delivery is retried on the next round under the
  existing circuit breaker, not in a tight loop.
- Removing a hub-only leftover from an agent is a real uninstall; the first
  reconcile after this lands must log each removal with its reason, and is
  dry-run first on the cluster.
- Agent UI loses its delete action for addons in the desired set.

## Enforcement

A pure spec of the desired-set computation (any-node added to a node WITH a
roster; agent-ui updated from the hub; hub-only leftover removed; tombstone kept
off; local uninstall refused). Nothing yet stops a new delivery path from
bypassing the reconcile — review only until a guard exists.
