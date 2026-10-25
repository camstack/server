---
id: D766
title: An uninstall names its nodes, removing an addon from an agent stops its runner, and the back-fill never installs what the hub does not
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - server/backend/src/core/addon/addon-uninstall.ts
  - server/backend/src/agent/agent-undeploy.ts
  - server/backend/src/core/agent/agent-addon-backfill.ts
  - packages/types/src/capabilities/addons.cap.ts
  - packages/addon-admin-ui/src/components/addons/AddonUninstallControls.tsx
  - packages/addon-admin-ui/src/components/addons/NodeOnlyPackagesPanel.tsx
---

## Context

On 2026-10-08 `@camstack/addon-decoder-ffmpeg` was uninstalled from the hub
through the admin UI and stayed installed on both agents — on `agent-a`
(Docker) and on the macOS Electron agent — with its runner running and `decoder`
still advertised. Nothing in the product could remove it:

- `addons.uninstallPackage({ packageName })` acted on the hub alone, and the
  admin UI's Uninstall button sent nothing else, whatever node the page was
  scoped to — while `NodeCard` told the operator that the Addons page "owns
  per-node addon management (deploy / restart / uninstall / upload)".
- `addons.startJob({ kind: 'uninstall', nodeIds })` refuses agents: the
  lifecycle job engine is hub-local.
- The one existing agent removal, `$agent.undeploy` (used by
  `nodes.undeployAddon` and the stale-addon reconcile), shut down an in-process
  instance, destroyed its Moleculer service and deleted its folder. On an agent
  nearly every addon runs in a GROUP RUNNER spawned through
  `$process.spawnRunner`, so for the addons that exist the first two steps were
  no-ops and the third deleted the code from under a process that kept running.
  The stale-addon reconcile, which "removes" an addon the hub no longer
  installs, had the same hole.
- The addon back-fill pinned a missing package to the hub's version and FELL
  BACK to the version the node last reported. That made it the one path that
  could put an uninstalled addon back: the operator moved agent-a's copy
  out of `/data/addons` by hand, and the node's declared roster still named it,
  so the next reconnect would have reinstalled it from npm — in the same pass
  whose stale sweep exists to remove exactly such an addon.

Extending the lifecycle job engine to agents was considered and not done: the
engine is a hub-local install/swap pipeline, and an agent is already reached for
updates by `updatePackage({ nodeId })` through a hub-side `broker.call` to the
agent's `$agent` service. Uninstall takes that same path.

## Decision

`addons.uninstallPackage` takes `{ packageName, nodeId?, everywhere? }` and
answers per node (`uninstalled | not-installed | refused | failed |
pending-reconnect`). No `nodeId` keeps the original hub-only call, which still
throws. An agent `nodeId` calls the agent's EXISTING `$agent.undeploy` in package
mode; `everywhere` does every node that has it, agents first and the hub last,
and an offline node answers `pending-reconnect`. A protected package is refused
before any node is touched. `addons.listInstallations` says which nodes have a
package, so the confirm can name them.

Removing an addon from an agent STOPS the runners that host it
(`$process.listByAddon` + `$process.stop`, which reaps the process group, D668),
respawns a shared runner's survivors without it, drops the agent-registry cap
proxies and re-registers upward. Both callers of `$agent.undeploy` — the
operator's uninstall and the stale-addon reconcile — get this. The agent refuses
its own bootstrap packages and any package whose manifest marks an addon
`protected: true`.

A removed package is pruned from the node's declared roster, and the back-fill
never delivers a package the hub does not install (`notOnHub`). The hub's
install set is the ceiling of what a node is converged to, in both directions.

## Consequences

- An agent built before this answers `$agent.undeploy` the old way. The hub
  sends `addonId` alongside `packageName` so such an agent still deletes the
  code, and reports `this agent predates runner teardown` — its runner keeps
  running until that agent restarts. Updating the agents first is the clean
  order.
- An offline node's copy is not removed by the uninstall. Its record is pruned
  and the stale-addon sweep removes the copy when it registers again — but only
  while the hub does not install the package. A package uninstalled from ONE
  agent and still on the hub is kept off that agent by the pruned record alone.
- A package the hub reinstalls later is NOT pushed back to an agent whose roster
  was pruned by an uninstall; it is pushed back to one whose roster still names
  it.
- The unmounted `bridge-addons.router.ts` — a second `uninstallPackage` with its
  own hard-coded REQUIRED list that read like the guard and was not — is
  deleted.

## Enforcement

- `server/backend/src/__tests__/cap-routers/addons-uninstall-per-node.router.spec.ts`
  drives the live cap router into the real provider; it fails against the
  hub-only provider.
- `server/backend/src/agent/__tests__/agent-undeploy.spec.ts` pins the runner
  stop, survivor respawn, protection and path-escape refusals; its wiring case
  fails against the pre-fix handler.
- `agent-addon-backfill.spec.ts` pins "never re-installs a package the hub no
  longer installs".
- `AddonCardUninstall.spec.tsx` fails against the pre-fix card.
