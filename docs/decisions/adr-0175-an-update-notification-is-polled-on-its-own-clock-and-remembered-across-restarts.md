---
id: D175
title: An update notification is polled on its own clock and remembered across restarts
status: accepted
date: 2026-08-18
supersedes:
applies-to:
  - server/backend/src/core/updates/**
  - server/backend/src/core/update-availability-emitter.ts
  - server/backend/src/core/update-availability-store.ts
---

## Context

`update.available` had an emitter (`UpdateAvailabilityEmitter`) and no clock.
Every path that could publish it was either request-scoped or dead:

| publisher | reached how | live status |
| --- | --- | --- |
| `AddonPackageService.checkUpdates` | only via `addons.listUpdates` | fires once per hub boot, and only if the operator opens the Addons page |
| `AddonPackageService.runAutoUpdate` | the only periodic path | armed by `scheduleAutoUpdate`, which **returns early when the auto-update channel is `off`** |
| `RootUpdateService.checkServerUpdate` (hub + agent) | the manual per-node "Check" button | never unattended |
| `AddonPackageService.listFrameworkPackages` | the panel that SHOWS a framework update | published nothing at all |

The live hub reports `addons.getAutoUpdateSettings → {"channel":"off"}`, which
is the correct operator choice — "tell me, don't install". So the one periodic
publisher was structurally unreachable on exactly the configuration everybody
runs, and the operator had never received an update notification. At the same
time `addons.listFrameworkPackages` was returning `@camstack/system` with
`hasUpdate: true` and emitting nothing.

The dedup state was two RAM `Map`s. Even had the poll existed, every restart
would have re-announced the whole list — and a hub restarts on every framework
update, which is precisely when the list is longest.

## Decision

The availability POLL is a separate mechanism from auto-APPLY, on its own
clock, and its dedup state is durable.

- `UpdateCheckScheduler` sweeps all four discovery paths (hub addons, framework
  packages, per-node server root, per-agent addon roster) on a timer that takes
  **no auto-update channel input at all** — the channel decides whether to
  install, the scheduler decides how often to look.
- Its cadence is an operator setting, `updateCheckIntervalSeconds`, carried on
  the existing auto-update settings surface (`addons.getAutoUpdateSettings` /
  `setAutoUpdateSettings`), default 6 h, clamped server-side to
  **900 s … 604800 s**. A change re-arms the live timer; no restart.
- `UpdateAvailabilityEmitter` persists `latestByKey` + `held` through an
  injected `IUpdateAvailabilityStore`. Production wires a JSON file under the
  node's data dir, beside `auto-update.json` — the mechanism the neighbouring
  update code already uses, and one that works on an agent (which has no hub
  SQLite settings store).
- A check that FAILS publishes nothing and logs. Never an empty snapshot: an
  empty snapshot means "up to date", clears the scope, and re-announces
  everything on the next good poll. A partial addon sweep publishes as
  *candidates* (additive), never as a *snapshot* (authoritative).
- A framework row announces only when the registry version is STRICTLY newer.
  `hasUpdate` is `latest !== current`, which is true for a hub running a
  `-dev.<timestamp>` build AHEAD of the npm tag; announcing that would be
  telling the operator to downgrade.

## Consequences

- Two knobs now live on one settings object and mean different things. A reader
  who conflates `intervalSeconds` (auto-apply sweep, gated on `channel`) with
  `updateCheckIntervalSeconds` (availability poll, ungated) will reintroduce
  the bug. The field docs say so at both the Zod schema and the config type.
- The data dir gains `update-availability/<scope>.json`. It is disposable: a
  corrupt or missing file costs one duplicate announcement, never a missed one,
  and the emitter heals it on the next save.
- Availability publishing is now spread across three emitters (addon-package,
  server-update, agent-update), each with its own store file. They are
  independent on purpose — an agent must be able to announce its own root
  update without the hub holding its state.
- The 6 h default means a publish can go unannounced for up to 6 h. That is the
  accepted trade against registry traffic; the operator can lower it to 15 min.

## Enforcement

Tests, not a guard.
`server/backend/src/core/updates/__tests__/update-check-scheduler.spec.ts` pins
that the poller arms with no channel input, takes its interval from settings,
re-arms on change, clamps below the minimum, skips an offline node with a
`tags: { nodeId }` log, and survives a failing check.
`server/backend/src/core/__tests__/update-availability-persistence.spec.ts`
pins announce-once-across-restart and announce-again-on-newer.
`server/backend/src/core/addon/__tests__/update-availability-publish.spec.ts`
pins the framework publish, the downgrade guard, and that a failed registry
lookup neither publishes nor poisons the dedup state.
