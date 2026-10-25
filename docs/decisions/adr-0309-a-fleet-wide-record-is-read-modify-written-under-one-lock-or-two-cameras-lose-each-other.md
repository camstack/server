---
id: D309
title: One key range, one writer at a time — a fleet-wide record read-modify-written by unordered callers loses updates for cameras nobody named
status: accepted
date: 2026-08-30
supersedes:
applies-to:
  - packages/system/src/builtins/device-manager/write-lock.ts
  - packages/system/src/builtins/device-manager/device-bindings-store.ts
  - packages/system/src/builtins/device-manager/device-aggregation.ts
  - packages/system/src/builtins/device-manager/device-meta-actions.ts
  - packages/system/src/builtins/device-manager/device-meta-store.ts
---

## Context

`deviceManager.setWrapperActive` is one of the five authorities a per-camera
function switch writes through ([D62](adr-0062.md)). It was a read-modify-write
over a SINGLE fleet-wide record with no lock, no compare-and-swap and no
version check:

```ts
const store = await readBindingsStore(deps.bindingsDeps)   // the whole map
const perDevice = { ...store.deviceBindings[storeKey] }
…
await writeBindingsStore(deps.bindingsDeps, { deviceBindings: nextDeviceBindings })
```

`deviceBindings` is 775 bytes on the live hub, six devices, one record keyed by
deviceId. **A writer that only means to touch camera 101 rewrites every
camera's row**, so two toggles on DIFFERENT cameras — which an operator has
every reason to believe are independent — both passed through the same map and
the later write silently dropped the earlier one.

What goes missing is not a nicety. `{ wrapperAddonId: null }` is the explicit
"operator disabled" marker: it is the thing that stops `getBindings` step 2
from re-binding a `defaultActive` wrapper. Losing it does not read as "the
toggle did not save" — the camera **switches itself back on**, which is exactly
the failure D62 exists to prevent.

**Why this is live rather than theoretical.** The read-to-write window is an
`await` on the settings door, and since [D181](adr-0181-hub-mains-event-loop-is-the-clusters-only-queue.md)
isolated `sqlite-settings` into its own process that door is an RPC to another
process. Measured on the live hub 2026-08-30, mid-drain: **2.9 s for a
single-row `get`**, against 0.18 s for `/health`. A window that is normally
milliseconds is currently seconds wide.

**And concurrency is reachable, from several directions.** Every writer runs on
hub-main's event loop, which is single-threaded — but single-threaded is not
serialised: an `await` yields, and nothing on the path holds anything across
it. `setWrapperActive` is an `adminProcedure` on the generated cap router; the
Home-Assistant export takes ONE HTTP POST PER COMMAND on a Fastify route
(`ha-export.addon.ts:378`), so an HA script flipping detection off on five
cameras issues five concurrent writes; the admin UI's switches, the viewer, the
orchestrator's `camera-switch-service`, `addon-terminal`'s
`silenceAnalysisFor` and the orchestrator's legacy-flag migration are five more
independent callers of the same mutation. `removeDevice` rewrites the same map
from a second site, and its purge runs OUTSIDE `withMetaWriteLock` — that lock
covers only `rows.remove`.

**The exposure is wider than `deviceBindings`.** `writeAddonStore` is itself a
read-modify-write over the addon's whole key range: `createDoorSettingsView`
loads the range, merges the patch, deletes the range and re-inserts it
(`settings-door-view.ts`). So two writers naming DIFFERENT keys still lose each
other. That reaches `locations` (a read-modify-written array), `nextDeviceId`
(whose bump can be REVERTED, and two devices then receive the same numeric id)
and `roleDisplayDefaults` — whose comment claimed "single-writer top-level key —
no lock, no RMW", true of the key and false of the write.

## Decision

**Every read-modify-write of device-manager's `addon-settings` key range holds
one lock for the whole of it — read, compute and write inside a single
acquisition.** One lock per key range, created by the addon and shared by every
writer of it: `setWrapperActive`, `removeDevice`'s bindings purge,
`addLocation`, `removeLocation`, `setRoleDisplayDefaults` and
`allocateNextDeviceId`.

Two alternatives were weighed and rejected as the fix to make FIRST:

- **Normalise `deviceBindings` to a row per `(deviceId, capName)`**, which
  makes the race structurally impossible because writers touch different rows.
  It is the better end-state and `DeviceRowStore` already proves the shape, but
  it is not a superset of this decision: `locations` is one array under one key,
  and the cross-KEY collision above survives any amount of normalising. It also
  costs a migration on a live NVR plus a version-skew window in which an older
  `@camstack/server` reads the blob and sees an empty fleet. Do it when the
  storage layout is next opened, on top of this lock — not instead of it.
- **Compare-and-swap / a version column.** The door has no conditional write,
  so CAS degenerates into read-verify-write with a retry loop — and every retry
  costs two door round trips on hub-main's only queue, which is the resource
  D181 says nothing may spend more of than its answer is worth. It is more code
  for a weaker guarantee.

## Consequences

- **Writers queue; readers never do.** `getBindings`, `getBindingsBatch` and
  `getAllBindings` take no lock, so a 1 019-device sweep is never parked behind
  a toggle. That is not a nicety either: `SystemMirror.init` gives
  `getAllBindings` 15 s.
- **The read path is untouched.** The fleet-wide inputs are still resolved once
  per pass and handed down, so a sweep costs a constant number of door round
  trips whatever the fleet size.
- **N queued toggles now cost N door round trips of latency instead of
  overlapping.** Accepted: these are operator-rate mutations, and the
  overlapping version was overlapping into a lost update.
- **There are two locks and they nest in ONE direction.** `withMetaWriteLock`
  guards device ROWS, `withAddonStoreWriteLock` guards this addon's
  `addon-settings` key range. The only place both are held is
  `allocateNextDeviceId` (called from inside `allocateDeviceId`'s meta lock), so
  the order is always meta ⊃ addon-store. `removeLocation` releases the
  addon-store lock BEFORE its cascade takes the meta lock, deliberately — held
  together in that order they would be the ABBA pair.
- **A torn READ is still possible and is NOT fixed here.** `replacePrefixed`
  deletes the addon's key range and then re-inserts it, so a reader that lands
  between those two door calls sees the range EMPTY and `getBindings` answers as
  if no operator had ever disabled anything. That is a kernel-wide property of
  the door (it has no transaction), it needs a fix at that altitude, and the
  lock here cannot reach it. Recorded rather than silently left.

## Enforcement

`packages/system/src/builtins/device-manager/__tests__/addon-store-write-race.spec.ts`,
seven tests, **each confirmed RED by neutralising exactly the one lock
acquisition it covers** (six sites, six independent disarms).

The fake in that file is load-bearing and deliberately unlike its siblings:
`bindings-store.spec.ts` and `location-registry.spec.ts` write the addon store
with a synchronous `Object.assign`, which **cannot lose an update** and would
have kept this suite green over the defect for as long as it existed. The fake
here models `createDoorSettingsView`: a read is a round trip, and a write is
itself read-modify-write with a round trip on each side.

Every assertion is on BEHAVIOUR, never on a spy: a lost activation is observed
as `getBindings` reporting the `defaultActive` wrapper bound again on a camera
the operator switched off, and a fixture check on an untouched third camera
proves the wrapper registry is live rather than binding nothing at all. The
"reads are not blocked" test parks a write with the lock HELD and requires both
read shapes to answer — a read that took the lock fails it by timing out, not by
an assertion someone can weaken.

No guard script: "is this an unordered read-modify-write" is not mechanically
decidable, and the legitimate shape (a write under the lock) is textually
identical to the broken one. Review, against this record.
