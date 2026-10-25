---
id: D677
title: The runtime-state row writer never writes a row this process has not read — a claims index that vouches for a device's claims does not vouch for its row, and a load that did not answer is never an empty state
status: accepted
date: 2026-09-29
supersedes:
applies-to:
  - packages/system/src/builtins/device-manager/mirror-row-writer.ts
  - packages/system/src/kernel/moleculer/runtime-state-load.ts
  - scripts/check-runtime-state-row-writers.ts
covers:
  - packages/types/src/device/device-context.ts
  - packages/types/src/device/base-device-provider.ts
  - packages/addon-provider-onvif/src/addon.ts
  - packages/addon-provider-homeassistant/src/addon.ts
  - packages/addon-provider-homematic/src/addon.ts
  - packages/system/src/builtins/device-manager/device-meta-actions.ts
  - packages/system/src/builtins/device-manager/device-state-mirror.ts
  - packages/system/src/builtins/device-manager/device-manager.addon.ts
  - packages/system/src/kernel/moleculer/device-cap-proxy.ts
  - packages/system/src/kernel/config-manager.ts
  - packages/system/src/builtins/device-manager/__tests__/mirror-row-read-before-write.spec.ts
---

Amends [D663](adr-0663-a-customization-owns-single-fields-by-a-claim-at-the-hub-write-chokepoint-and-removing-it-restores-the-native-slice.md):
supersedes its ruling S6 branch (c) **for writes only**. The status-read path
keeps it.

## Context

A device's runtime-state row (the `device-runtime-state` collection, keyed by
the numeric device id; `__device-state` is only the legacy prefix a canonical
write retires) is written whole: every write REPLACES the row with what the hub
mirror holds (`writeDeviceRuntimeState`).
That is correct only if memory holds everything the row held.

At hub boot the mirror is empty. The pipeline-orchestrator hydrates `zones` and
`zone-rules` onto every camera through `deviceState.setCapSlice` about 1–3 s
after boot, before the camera's provider has rebuilt it and called
`loadRuntimeState`. `setCapSlice` asked `ensureSeeded`, whose branch (c) — a
LOADED claims index that does not name the device — marked the device seeded
**without reading its row** (D663 S6, adopted for D447's cost). The 1 s writer
then found no baseline, so nothing looked persisted, and replaced the row with
`{zones, zone-rules}`. The provider's `loadRuntimeState` landed later, read the
already-truncated row, and `seedMirror('fill')` had nothing left to fill. That
write was not even logged: the "runtime state persisted" line fires only when
the effective-change gate had skipped something.

What it cost, measured in Loki from 09-18 to 09-29 (a lower bound, since the
truncating write itself is silent):

- **159 row shrinks on 15 devices, all cameras, at 65 of 82 hub restarts.**
  Across 40 259 logged writes, shrinks NOT across a restart: 0.
- The losers are always the same cameras: Reolink hub children (3628, 3629,
  3825), rebuilt after their parent, and cameras late in a provider's
  sequential restore (Hikvision rebuilds 32 devices one after another). A
  provider load that landed inside the 1 s window was rescued by `fill`.
- **Ten rows are still below their history today**: nine are short of caps
  (592, 618, 4263 at 7; 104 at 5; 587 at 4; 637, 1438, 3831, 1441 at 3), and
  101's `doorbell` slice was re-created on 09-29 with its lifetime count and
  `lastPressedAt` gone.
- **The doorbell seed.** 101 lost `doorbell` (written only on a press) at the
  15:41:50 restart. Nothing re-created it until the next press, so the D670/D671
  migration seeded from nothing: count 0, and a text-only notification.
- Reolink's onboard AI logged *"no restored state — cold-start default (OFF)"*
  for every Reolink camera at essentially every restart: the restored
  `native-object-detection` was replaced by a default.
- It is not D663's doing: the loss is in Loki on 09-18, and the code shape has
  existed since the 09-09 squash. D663 added the seed and then skipped the read
  in exactly this case, and its spec asserted "reads NO row" against a harness
  row that was EMPTY — "did not read" and "read and found nothing" were the
  same row, so the assertion vouched for the defect.

A second route to the same loss: the worker's device build did
`loadRuntimeState(...).catch(() => ({}))`, so a load that failed built the
device on cold-start defaults, and `ConfigManager.getDeviceRuntimeState`
answered `{}` before the settings store was wired (the D294 window) — a store
that was never asked, read as "never persisted".

## Decision

**No row write of a device happens until this process has READ that device's
row.** "Claims known" (`seeded`, which a loaded claims index may vouch for) and
"row read" (`rowRead`, which only a real read sets) are separate facts:

- The claims index still clears a device for the status read AND for the
  native-write RPC: `setCapSlice` applies the slice and emits it once the
  device's claims are known (`ensureSeeded`, index first). A transient row-read
  failure must never cost the live slice and its event (D49) — so the RPC does
  not wait for a read it does not need.
- The ROW WRITER owns the row read. The debounced write, the claim
  write-through, the migration drain and the shutdown flush each read the row
  first if it has not been read (`ensureRowRead`: single-flight,
  `seedMirror('fill')` — memory wins per cap, the row fills the gaps), and only
  then replace it.
- A read that fails writes NOTHING and logs once per episode with
  `tags.deviceId`. The debounced path re-arms with a backoff — 1 s doubling to
  60 s — at the writer's own timer, never a 1 Hz loop (D3). The armed timer is
  what a migration drain sees as owed, so a row that has become readable drains
  normally.
- A write whose blob lacks a cap the stored row holds warns with the dropped
  cap names and `tags.deviceId`. It is a TRIPWIRE with no legitimate trigger:
  once the row is read no production path removes a cap from memory, and a
  durability demotion ships in code and is out of the baseline at boot.
- `removeDevice` forgets the device in the mirror before clearing its row:
  armed write cancelled, one in flight awaited, slices, claims and baseline
  dropped — nothing writes an orphan row back.
- A runtime-state load that did not answer is not an empty state. A worker
  build REFUSES (`RuntimeStateLoadError`, logged with `tags.deviceId`):
  `create()`, accessory children, and the rebuild, which loads before it tears
  the live instance down. `loadContext` is the hydrated `createContext` for a
  caller that builds a device from a bare context (ONVIF restore and adopt). An
  ANSWERED `{}` — a new or unknown device — is the true state and never
  refuses. `ConfigManager.getDeviceRuntimeState` throws before the store is
  wired.
- A refused restore is retried under the bounded restore retry (D347), in the
  default pass and in a provider's own restore loop
  (`restoreWithBoundedRetry`: HA and Homematic standalone entities, ONVIF) —
  never lost until the next runner restart.
- `writeDeviceRuntimeState` is called only by the row writer and the
  migration swap (which reads both rows and writes them swapped, under the
  writer's hold).

## Consequences

- One `door.get` per device per process for a device whose row is written
  before its provider's `loadRuntimeState` — at boot, roughly the cameras the
  orchestrator hydrates (32 of 1013 devices on this hub). `loadRuntimeState`
  already reads every row at boot, so it is at most a second single-key read,
  never an aggregate (D447 is about aggregates).
- A device whose row cannot be read keeps its slices in memory and its events
  flowing; only the row write waits. Nothing is replaced in the meantime.
- **`createContext` stays synchronous and EMPTY.** Making it load would change
  its return to a promise, and an addon compiled against the old contract
  (types travel bundled with each addon) would receive a promise as its
  context. So the hydrated path is a new, optional `loadContext`, and a caller
  on an older kernel falls back to `createContext`. The one remaining
  `createContext` caller in the repo is the composer graft, which builds no
  device from the context and writes no slice through it: it registers
  method-serving natives only, and its `getStatus` reads the hub's merged
  slice. For it, empty is correct.
- A device build whose load fails now FAILS instead of starting on cold
  defaults. The default restore pass and the provider-owned loops retry it
  (10/30/90 s, then terminally `failed`, visible in `getStatus().error`). An
  accessory child is re-spawned at its parent's next reconcile; it is logged
  and not pruned. An operator `create` or `reloadDevice` surfaces the error; on
  a create the id is already allocated and config/meta pre-persisted, so the
  row stays until the operator retries.
- `ConfigManager.getDeviceRuntimeState` throws in the D294 window. Its only
  caller is the settings view's `readDeviceRuntimeState`, whose callers treat a
  throw as "unreadable".
- **Rollout order: addons FIRST.** `addon-provider-homeassistant` and
  `addon-provider-homematic` bundle the `restoreWithBoundedRetry` they call, so
  they must be deployed BEFORE the server: an old HA or Homematic addon on the
  new kernel makes ONE restore attempt while the kernel now refuses a build
  whose load did not answer, and a transient read then loses the entity until
  the next runner restart. `addon-provider-onvif` falls back to `createContext`
  on an old kernel, so its order does not matter.
- `restoreWithBoundedRetry` applies the D376 quarantine like the default pass
  (a config-less top-level row is reported once, never dialled), and no retry
  scheduler starts once the provider is shutting down, even from a restore
  pass that was still in flight.
- Rows already truncated are not repaired by this: only a pre-truncation
  backup of the `sqlite-settings` bind holds them.
- **Not addressed (L7).** `pipeline-analytics` reads rule gates through
  `deviceManager.loadRuntimeState`. Each call re-seeds the mirror (fill, so it
  loses nothing) and resets the writer's baseline to the row: at worst one
  extra write when it races a write in flight, and an answer up to a debounce
  window behind the mirror. It should read `deviceState.getCapSlice`.

## Enforcement

- **Guard:** `scripts/check-runtime-state-row-writers.ts` (CI repository
  guards). Outside tests, every reference to `writeDeviceRuntimeState` /
  `setDeviceRuntimeState` (a call, a destructuring, a bracket access) is
  counted per file against a PINNED count: `mirror-row-writer.ts`,
  `migrate-hardware-state.ts`, the settings-surface plumbing in
  `config-manager.ts` and one duck-type check. The `'device-runtime-state'`
  collection literal is pinned to the three storage backends, so a
  `door.set({ collection: … })` or `writeBlob('device-runtime-state', …)`
  elsewhere fails too. It cannot see WHETHER the writer reads first; the tests
  below do.
- Tests, each disarmed by hand (a green run with the fix removed means the test
  is vacuous):
  - `mirror-row-read-before-write.spec.ts` — a slice written before any read
    keeps the stored row's other caps; memory wins per cap; an unread device
    whose read fails is never written, is logged once, and re-arms with a
    backoff; flush and drain read first; a drain after a transient refusal
    writes; `forgetDevice` leaves no orphan write; the drop tripwire.
  - `field-claims-api.spec.ts` — under a loaded index the RPC reads no row and
    the writer reads it once, before the first row write; a failing row read
    still applies and emits the slice, and the row is written only after a
    read succeeds; the boot race (orchestrator `zones`, provider load 2 s
    later) loses nothing; `removeDevice` leaves no orphan row.
  - `device-state-mirror-ownership.spec.ts` — the index-clears test runs over a
    NON-empty row and checks the flushed row.
  - `config-manager-runtime-state-unwired.spec.ts`,
    `device-build-refuses-unread-state.spec.ts` (create, `loadContext`,
    rebuild), `base-device-provider-restore-retry.spec.ts`
    (`restoreWithBoundedRetry`: retried, bounded, quarantine, no scheduler
    after a shutdown mid-pass).
- Review only: the HA, Homematic and ONVIF restore loops call
  `restoreWithBoundedRetry` / `loadContext`; no test builds those addons.
