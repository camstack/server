---
id: D231
title: sqlite-settings forks (`execution.isolate`); infra isolates spawn before the in-process door
status: accepted
date: 2026-08-24
supersedes:
applies-to:
  - packages/system/package.json
  - packages/system/src/kernel/isolated-builtin-phase.ts
  - packages/system/src/kernel/settings-door-view.ts
  - packages/system/src/kernel/config-manager.ts
  - server/backend/src/core/addon/addon-registry.service.ts
---

## Context

On 2026-08-24 ~19:13 the live hub's event loop was the cluster's only queue
([D181](adr-0181-hub-mains-event-loop-is-the-clusters-only-queue.md)): JS thread
idle 16.4 %, GC 13 %, native `Statement.run` up to 35 % of a 20 s V8 profile,
callers `sqlite-settings.addon` `set` / `tableUpdate` / `deleteWhere`. Disk was
idle (~170 KB/s). Events, stream metadata and scrub were unusable because every
tRPC / UDS / Moleculer hop shares that thread.

`better-sqlite3` is synchronous. The public door (`settings-store`, owned by
in-process `storage-orchestrator`) already `await`s the engine — but the engine
lived in hub-main, so `async set` still ran `Statement.run` before the promise
settled. A timer-shaped `await` on the same isolate yields; the sqlite burst
does not. That is the event-loop-churn spec.

[D123](adr-0123.md) already taught the fork: a `@camstack/system` builtin may
declare `execution.isolate`. Snapshot uses it because capture and sharp do not
belong on the API loop. The same record also said isolated builtins spawn AFTER
in-process builtins, because everything they persist lives behind
`settings-store`. That is true of snapshot. It is false of sqlite-settings:
sqlite-settings IS the engine behind that door. Spawn it in the consumer wave
and every in-process builtin initialises against a missing store — the D44
empty-read failure, just with a fork in the way.

A `worker_threads` wrapper inside hub-main was the other candidate. The
connection cannot be shared, and a native abort still kills the process. Isolate
is the CamStack-shaped move: one addon, one process, UDS `await` on the door.

The UDS proxy for `data-store-provider` is not `ISettingsStore`
(`getAllAddon` / `setDeviceRuntimeState` are not cap methods). ConfigManager
used to take that sync handle as a backdoor around the door. After isolate the
backdoor is gone; `createSettingsView` must use the async door.

## Decision

`sqlite-settings` declares `execution.isolate: true` (and `heapProfile:
"heavy"`). `storage-orchestrator` stays in-process and owns `settings-store`.

Isolated builtins are two spawn waves, classified by
`isolatedBuiltinPhase` / `partitionIsolatedBuiltinIds`:

- **infra** — provides a capability in `INFRA_CAPABILITIES` (today:
  sqlite-settings / `data-store-provider`). Spawned BEFORE in-process
  builtins.
- **consumer** — everything else (today: snapshot). Spawned AFTER, as D123
  required.

When the engine is isolated, ConfigManager does not get an `ISettingsStore`.
`createSettingsView` is served by `createDoorSettingsView` over the door.
`setDeviceRuntimeState` stays a sync void **inside the engine process**.

## Consequences

- Every `settings-store` call from hub-main is a UDS hop. Cheap reads pay
  serialization they did not pay in-process; the 1 Hz fleet runtime-state
  flush no longer parks the API loop.
- `vector-store` moves with the same addon / same handle. Callers already
  reached it over UDS from forked runners; they now reach a sibling instead
  of hub-main.
- ConfigManager `get()` / `getAddonConfig()` without a sync store fall back
  to yaml / `{}`. In-process addons that persist go through
  `ctx.settings` (the door view), not `getAddonConfig`.
- `ConfigManager.set()` without a sync store writes the door fire-and-forget
  and logs a failure. Operator capability-preference writes still land.

## Enforcement

- `packages/system/src/kernel/__tests__/isolated-builtin-phase.spec.ts` —
  sqlite-settings is infra, snapshot is consumer, the manifest declares
  isolate, the door addon does not.
- `packages/system/src/builtins/sqlite-storage/__tests__/event-loop-churn.spec.ts`
  — the engine on its own isolate still stalls (the disease stays pinned).
- `packages/system/src/builtins/sqlite-storage/__tests__/settings-door-view.spec.ts`
  — an awaiting door looks like a timer; runtime state round-trips without
  `ISettingsStore`.
- `packages/system/src/kernel/__tests__/moleculer/addon-runner.spec.ts` —
  sqlite-settings with isolate is in the runner plan.

## Amendment, 2026-09-29 — the `{}` fallback was the defect ([D675](adr-0675-a-settings-read-that-cannot-ask-the-store-refuses-and-the-store-never-answers-for-env-owned-auth.md))

Two Consequences above were accepted as costs and turned out to be a live
defect. "ConfigManager `get()` / `getAddonConfig()` without a sync store fall
back to yaml / `{}`" meant every such read answered "nothing stored" for the
life of the hub: `addonSettingsRaw.getGlobal` was `{}` for every addon, and
virtual-doorbell's durable read — built on it — never worked, so an operator's
persisted doorbell OFF was never honoured. "Operator capability-preference
writes still land" was true, and nothing read them back after a reboot.

Since D675 those readers REFUSE (`SettingsReadUnavailableError`) instead of
answering `{}`; the callers read through the door three-way, or from a
boot-time mirror (capability preferences, `auth.tokenExpiry`). The door itself,
the spawn waves and the isolation decided here are unchanged.
