---
id: D865
title: A deleted device is a recorded fact; its settings are cleared centrally and its data is removed by a hook driven by tombstones
status: accepted
date: 2026-10-17
supersedes:
applies-to:
  - packages/system/src/builtins/device-manager/device-tombstone-store.ts
  - packages/system/src/builtins/device-manager/device-removal-hooks.ts
  - packages/system/src/builtins/device-manager/device-meta-actions.ts
  - packages/types/src/capabilities/device-removal-hook.cap.ts
  - packages/types/src/device/device-removal-reconcile.ts
  - scripts/check-device-settings-standard.ts
---

> Revised by [D870](adr-0870-one-store-per-kind-of-setting-for-every-process-and-per-camera-state-is-a-key-of-the-camera.md): the standard store is now the SAME rows in every process, the moved collections are retired by one migration script (`migrate-device-store.ts`, which replaces the D865 script) and the broker maps are keys of the camera.

## Context

[D864](adr-0864-deleting-a-device-cleans-its-data-at-delete-time-store-by-store-and-the-keychain-is-purged-by-device-scope.md)
made `removeDevice` clean what device-manager owns and left every other addon to
clean its own data off `DeviceUnregistered`. That event is telemetry and may be
dropped (D8, D11); an addon that was down or restarting at that moment kept the
device's footage, events, history and settings for good. Device 4483 is the live
case, and the hub holds more from before.

The D864 audit also found the addons that DO keep their own per-device rows
(audio-analyzer, motion-wasm, the orchestrator's `device-features` mirror, the
recorder's per-camera config) — each a place where a delete has to be remembered,
and each one forgotten at least once.

Tried and rejected: one hook for everything (every addon would write and maintain a
settings-clearing handler that does the same thing), a boot sweep of "devices not in
the list" (a failed or partial list read destroys data — D49), and treating
`DeviceUnregistered` or "offline" as a delete (a provider restart emits the first
and every battery camera shows the second).

## Decision

Two kinds of per-device state, two mechanisms, and a record that makes both reliable.

**1. Per-device SETTINGS have one home and are cleared centrally.** Every addon stores
per-device configuration only through the framework API, `ctx.settings.readDeviceStore`
/ `writeDeviceStore` (rows `addon-device-settings`, `<addonId>:<deviceId>.<key>`).
`removeDevice` clears the whole scope, for EVERY addon, in the `addon-device-settings`
step (one `deleteWhere` on the device id the rows carry). No addon has a settings
handler, so none can forget one. Moved here: the recorder's per-camera config
(`recorder:recording-configs` → key `recordingConfig`) and the orchestrator's
device-features mirror (`pipeline-orchestrator:device-features` → key `deviceFeatures`).
The code reads and writes ONLY the standard store — **no fallback to the old
collections**; the rows are moved by a one-shot operator script (below).
audio-analyzer and motion-wasm already used the standard store and now need nothing.
`listDeviceStoreIds()` (optional on the settings view, door-backed only) lists the
devices an addon holds a store for, for fleet-wide passes.

**2. Device DATA that is not settings is removed by a hook, driven by tombstones.**
- device-manager keeps a TOMBSTONE per deleted device (`device-manager:tombstones`:
  `deviceId`, `deletedAt`, `providerAddonId`), written by `removeDevice` only. An
  unregistered, offline or provider-restarting device has none. Tombstones expire
  after **90 days** (`DEVICE_TOMBSTONE_RETENTION_MS`), pruned whenever one is written
  or the list is read. A tombstone is the first removal step, so it exists before any
  hook is called.
- The capability `device-removal-hook` (collection, internal): `onDeviceRemoved({
  deviceId, deletedAt, providerAddonId }) -> { counts }` (idempotent, counts per store)
  and `listDeviceData()` (reads only). After a delete, device-manager calls
  `onDeviceRemoved` on every provider, each as its own step with the bounded retry
  of D864 (30 s, 2 min, 10 min, then an error line); an enumeration that fails is
  retried too.
- Reconcile: `deviceManager.listDeletedSince({ sinceMs })`. Every implementer
  re-runs its own removal for each tombstone at hub link and every 6 h
  (`armRemovalReconcile`). It is driven by tombstones only; an unreadable list changes
  nothing.
- Implementers: **recorder** (footage across locations via the archive and the segment
  store, audit reason `orphaned-device`), **pipeline-analytics** (events and event
  media with reason `orphaned-device`, the track cascade with faces/plates reads and
  media, linked-sensor events), **device-history** (the device's series and clocks).
  Training and retrain datasets are NOT device data and are kept.

**3. Data of devices deleted before tombstones** is cleaned by an admin-triggered
action, never at boot: `deviceManager.cleanupDeletedDevicesData({ confirm })`,
System -> Data -> Deleted devices. It lists the device ids present in each store
(every implementer's `listDeviceData`, plus every addon's `addon-device-settings`
scope) that device-manager no longer knows, with counts per store. `confirm: false` is
a dry run. The absence check takes TWO answered reads of the device ledger and uses
an id only when absent from both; it refuses (status `skipped`, with the reason) when
a read throws, answers empty, returns fewer ids than the ledger has rows, or when
none of five or more data-holding ids is a known device (D72). The UI shows the
counts in the confirm dialog.

## Moving the existing rows: the one-shot script (REMOVE after the last hub ran it)

`scripts/hub/migrate-device-store.ts` moves the two legacy stores through the hub's <!-- drift-ok: deleted 2026-10-22 -->
admin API (`scripts/hub/hub.mjs`: audited admin token; no SQLite file is ever opened,
D679). It uses the existing admin `settingsStore` methods (`query`, `get`, `set`,
`delete`), so no cap method was added for it. `--dry-run` (the default) lists per addon
and device how many fields would move — counts, never values. `--apply` copies each row
into `addon-device-settings`, re-reads it and compares, and only then deletes the old
row; a copy that does not read back equal keeps the old row and fails. Idempotent, one
log line per device. A row with a credential-looking field is reported as a secret
field and neither copied, printed nor deleted: it goes through the keychain path.

Run it per hub, **in this order** — the new recorder reads only the new place, so a hub
updated first has every camera unconfigured (recording off) until the script has run:

1. `npx tsx scripts/hub/migrate-device-store.ts --server <hub>` (dry run) and read it.
2. The same with `--apply`.
3. Deploy the recorder and the orchestrator; then the dry run again must list nothing.

The legacy collections are declared only by the old builds; once those are gone the
script refuses to read them (it never declares one — a declaration with the wrong shape
rebuilds the table and drops its rows). A config an operator changes between step 2
and 3 is written by the old recorder to the old place: repeat steps 1-2 just before
deploying.

## Consequences

- A new addon that keeps per-device config in its own table is refused by the guard;
  one that keeps per-device DATA implements the hook (and its `listDeviceData`).
- Open: `stream-broker:probe-snapshots` and `stream-broker:profile-map` are
  device-keyed config/mirror collections still cleaned by the broker's own
  `DeviceUnregistered` handler with the catalog poll as backstop (listed in the
  guard's allowlist as OPEN). The per-device-keyed `pipeline-analytics:scenes` is
  operator content and keeps its own sweep.
- Not covered by the hook, by choice: the recorder's audit rows and export history
  (the audit answers "what happened to the footage"), `pipeline-analytics` stats-5m,
  scenes and tracking tapes (small, capped or operator content).
- A hook that stays unreachable for the whole retry schedule leaves the data until the
  implementer's next reconcile (restart or 6 h); the tombstone is what makes that safe.

## Enforcement

- `packages/system/src/builtins/device-manager/__tests__/device-removal-hooks.spec.ts`:
  the hook is called on deletion with device, time and owner, a failing implementer is
  retried alone and bounded, an enumeration failure is retried, a tombstone is listed
  and expires, an unregistered device gets neither tombstone nor call, the admin action
  is a dry run until confirmed and does nothing when a list read fails or the id space
  drifts, and a delete clears every addon's settings scope. Switching the absence
  check from the device ledger to the live registry turns "a registered device whose
  provider is gone is NOT a deleted device" red.
- `packages/types/src/__tests__/device-removal-reconcile.spec.ts` (a missed deletion is
  caught from tombstones; a failed read deletes nothing), the implementers' specs
  (`recorder/addon/__tests__/device-removal.spec.ts`,
  `pipeline-analytics/__tests__/device-removal-hook.spec.ts`,
  `addon-device-history` retention spec), `scripts/__tests__/migrate-device-store.spec.ts` <!-- drift-ok: deleted 2026-10-22 -->
  (dry run lists counts and changes nothing, apply copies + verifies + deletes, a second
  apply is a no-op; skipping the read-back verification turns "a copy that does not read
  back equal keeps the old row" red).
- `scripts/check-device-settings-standard.ts` fails when a `config` or `mirror`
  collection keyed by a device id exists outside the per-device settings API and is not
  in its written allowlist (wired in `.github/workflows/checks.yml`).
