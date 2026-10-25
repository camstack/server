---
id: D233
title: A hub-local isolated infra cap is proxied; a remote agent's is not
status: accepted
date: 2026-08-24
supersedes:
applies-to:
  - server/backend/src/core/moleculer/moleculer.service.ts
  - server/backend/src/core/addon/addon-registry.service.ts
  - packages/system/src/kernel/isolated-builtin-phase.ts
  - packages/system/src/builtins/sqlite-storage/sqlite-settings.addon.ts
---

## Context

[D231](adr-0231-sqlite-settings-forks-infra-isolates-spawn-before-the-door.md)
forked `sqlite-settings` so `better-sqlite3` `Statement.run` left the API
loop. Spawn-before-door was necessary and not sufficient.

`applyNodeManifest` skipped every capability in `INFRA_CAPABILITIES` on
every handshake. That skip existed so a remote agent's sqlite /
`storage-provider` could not appear in the hub's collection: two
`data-store-provider` engines make the door refuse rather than guess
([D44](adr-0044.md)). It also dropped the hub-local child. After 1.2.149
the sqlite process was alive (`[hub/sqlite-settings]`),
`listCapabilityProviders({ capName: "data-store-provider" })` returned
`[]`, and every settings read logged "the data door has nothing behind
it". Health stayed 200. The cluster was rolled back to 1.2.148.

Snapshot isolate never hit this: `snapshot` is not an infra cap, so the
UDS handshake already proxied it.

Rejected: stop isolating sqlite. The event-loop stall on hub-main is
real (D181 / D231).
Rejected: have `storage-orchestrator` call `ctx.api` instead of
`getCollection`. The door is in-process; the collection is the routing
table. A second path would be a shadow registry.
Rejected: register remote-agent infra onto the hub too. A second engine
is a D44 refusal, and the agent's store is the agent's, not the hub's.

## Decision

`applyNodeManifest` proxies an infra capability when the handshake is a
**hub-local child** (`nodeId` starts with `${hubNodeId}/`). It still
skips infra capabilities from any other node. sqlite-settings isolate
is this node's engine; an agent's sqlite is not.

## Consequences

- `getCollection('data-store-provider')` on hub-main sees the UDS proxy
  for `sqlite-settings` after the child's handshake. The settings door
  has something behind it.
- Spawn of the child is not that handshake. Boot waits until the
  collection is non-empty after the rest of the forked spawn plan
  (those awaits yield to the UDS read). Waiting *immediately* after the
  infra spawn (1.2.151) deadlocked onModuleInit, timed out, aborted
  bootstrap and crash-looped the starter. A timeout logs and continues.
- The child's `initialize()` must not read `settings-store`.
  `BaseAddon.resolveConfig()` did; on the isolated engine that is a UDS
  call to a parent waiting for this handshake (1.2.152: 30 s hang, then
  every in-process builtin skipped). sqlite-settings overrides
  `resolveConfig` to a no-op — it has no stored config.
- A remote agent that advertises `data-store-provider` still does not
  enter the hub collection.
- Agents currently boot sqlite-settings in-process (`bootCoreAddons`
  does not honour `execution.isolate`). That is a separate gap; this
  record does not fork the engine on an agent.

## Enforcement

- `packages/system/src/kernel/__tests__/isolated-builtin-phase.spec.ts`
  — `waitUntilReady` resolves when the predicate flips and times out
  when it does not.
- `packages/system/src/builtins/sqlite-storage/__tests__/engine-skips-door-at-init.spec.ts`
  — engine `initialize()` returns while `settings-store` never answers.
- `server/backend/src/__tests__/moleculer-register-node-idempotency.spec.ts`
  — hub-local `hub/sqlite-settings` registers `data-store-provider`;
  `agent-a` advertising the same cap does not.
