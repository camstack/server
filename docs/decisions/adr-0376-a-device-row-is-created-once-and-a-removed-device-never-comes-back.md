---
id: D376
title: A device row is created once and a removed device never comes back — a reservation is not a device, and a device without configuration is neither restored nor online
status: accepted
date: 2026-09-06
supersedes:
applies-to:
  - packages/system/src/builtins/device-manager/removal-fence.ts
  - packages/system/src/builtins/device-manager/device-online-fallback.ts
  - packages/system/src/builtins/device-manager/device-meta-actions.ts
  - packages/system/src/builtins/device-manager/device-queries.ts
  - packages/types/src/device/base-device-provider.ts
---

## Context

On 2026-09-05 the hub's device registry held two rows nobody owned, both with
`config` at zero keys.

**105 "Camera studio"** was a camera the operator had deleted the day
before. The row was still there: `config: {}`, `disabled: false`,
**`online: true`**. Every time the Reolink provider booted, its restore dialled
that row, `reolinkCameraSchema` refused it on `host` and `password`
(`Invalid input: expected string, received undefined`), and the bounded retry
was scheduled again — eight occurrences in one day, because the bound is per
PROCESS and the runner restarts. In parallel the stream-broker asked for it
every thirty minutes on all three nodes: `stream-catalog pull failed — device
omitted from this catalog reconcile {consecutiveFailures=5 retryInMs=1800000
error="parent could not route child unowned cap call"}`.

`removeDevice` was not the culprit. It deletes the row and then clears the
device's config store, in that order. What put the row BACK is that nothing
downstream of a removal refuses to re-create it: `registerDevice` writes through
`upsertRegistration`, which "doubles as the INSERT for a device whose row does
not exist yet" (`device-row-store.ts`), and it does not write config — config
stopped being threaded through `registerDevice` when `create()` started
pre-persisting it. So a live device object whose runner had not finished tearing
down re-registered the number it had just lost and produced exactly what was
found: the right name, the right type, `registered` again, and no configuration.
The same hole exists one level down — `allocateDeviceId` mints a fresh row for
any `(addonId, stableId)` it cannot find.

**4370 `__camstack_probe_nonexistent__`** was a reservation. Its `stableId`
equals its `name`, its type is `generic`, its config is empty and it was never
registered — the exact shape `allocateDeviceId` writes. The string appears
nowhere in `packages/`, `server/` or `scripts/`: it is a sentinel some external
caller used to ask "does this device exist?", against
`deviceManager.allocateDeviceId`, which is a public `protectedProcedure`
mutation and the only method that maps `(addonId, stableId)` → id. The answer
was written into the registry as a device. `listPersistedByAddon` then handed it
to a provider restore at every boot: `No device class registered for restored
type — skipping {type=generic}`.

Both rows were also reported `online: true`, from the same line:
`resolveDeviceOnline(id, pctx.registry !== null)`. The comment said a persisted
row "implies a successful registration by its owning process". For these two
rows no owner existed, so no `device-status` slice ever arrived to contradict
the guess, and it stood for a day.

## Decision

**A device row is created once, by a deliberate act, and a removed device does
not come back.** Four rules, all in the addon that owns the rows or in the
provider base class:

1. `removeDevice` fences the identity it deleted — the numeric id and the
   `(addonId, stableId)` pair — under the same write lock that deleted the row.
   `registerDevice` and `allocateDeviceId` REFUSE a fenced identity, loudly,
   with `tags: { deviceId }`. The fence is in-memory and expires (5 min): it
   closes a teardown race seconds wide, it is not a durable tombstone, because
   a second durable authority on "does this device exist" is worse than the
   bug. An operator re-adding the same hardware goes through `createDevice` /
   `adoptDevice`, which run with the fence down.
2. **A reservation is not a device.** `listPersistedByAddon` never hands a
   provider a row that was never registered AND carries no configuration; it
   says so once per boot with `tags: { deviceId }`. A never-registered row that
   DOES carry config is a `create()` whose registration never landed, and the
   provider is exactly who should finish it — so the config decides, not the
   flag alone.
3. **A persisted top-level row with no configuration is quarantined, not
   dialled.** `BaseDeviceProvider` reports it once, at `error`, with its
   `deviceId`, records it as a permanent restore failure and never retries it.
   No retry can supply a configuration that is not there. Children are exempt
   (an accessory legitimately carries an empty blob, a hub-adopted child is
   repaired by `healSavedConfig`), and a provider whose devices genuinely need
   no configuration sets `quarantineConfiglessTopLevelRestores = false`.
4. **A device without configuration is never reported online.** The authority
   stays the addon that owns the device (D224) — a mirrored `device-status`
   slice always wins — but the FALLBACK the hub uses before any slice arrives
   is now `false` for a config-less top-level row, in `listAll` and in
   `getDevice`.

## Consequences

- `registerDevice` and `allocateDeviceId` can now throw for a reason that is
  not the caller's fault. That is deliberate: the alternative is a silent
  resurrection, and both callers are kernel paths that already handle a
  refusal.
- A device deleted and re-created from a script within five minutes, WITHOUT
  going through `createDevice`/`adoptDevice`, is refused. No production path
  does this; a test that wants to must use those two methods or wait out the
  TTL.
- `allocateDeviceId` stays a public mutation, so an external caller can still
  mint a reservation. It is now inert: not restored, not listed to a provider,
  never online. Making it internal-only would need an access level the cap
  system does not have — that is left open, and the reservation being harmless
  is what buys the time.
- `quarantineConfiglessTopLevelRestores` changes what a provider does with a
  row it used to dial. Two existing restore specs asserted on fixtures whose
  `config` was `{}` while both production entry points
  (`runWorkerDeviceRestoreWithRetry`, `restoreAddonDevices`) read
  `deviceManager.loadConfig` per row — the fixtures were describing a row
  production never produces, and they now carry a config.
- An `online` default flipped: a config-less top-level row with no mirrored
  slice reads offline. `device-manager.addon.spec.ts` asserted the old default
  explicitly; it now asserts both halves.

## Enforcement

Tests, in three places:

- `packages/system/src/builtins/device-manager/__tests__/device-ghost-rows.spec.ts`
  — the real addon against a real sqlite-backed row store: the late
  `registerDevice` and the late `allocateDeviceId` are refused, the reservation
  is withheld from restore while a configured one is not, and a config-less
  top-level row reads offline in `listAll` and `getDevice`.
- `packages/system/src/builtins/device-manager/__tests__/removal-fence.spec.ts`
  and `device-online-fallback.spec.ts` — the two rules as pure units.
- `packages/types/src/device/__tests__/base-device-provider-configless-quarantine.spec.ts`
  — one report, no dial, no retry, `deviceId` on the line; children exempt; an
  UNFETCHED config never quarantines anything.

Every claim was re-checked with the fix removed: all four behavioural claims in
the addon spec and the quarantine claim go red.

No guard script: the rules are about what a specific set of writes may do, and
a grep cannot tell a legitimate `upsertRegistration` from a resurrecting one.
