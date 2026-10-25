---
id: D311
title: A UI reads the fleet through the generated hook, and the boot gate waits for the probe not the fleet
status: accepted
date: 2026-08-30
supersedes:
applies-to:
  - scripts/check-fleet-query-defaults.ts
  - packages/addon-admin-ui/src/hooks/useBootGate.ts
---

## Context

D274 moved the `deviceManager.listAll` caching window off the call site and onto
the query client, matched by key PREFIX, "so it could not be forgotten at a call
site". `scripts/check-fleet-query-defaults.ts` closed the two holes that leaves:
a fourth `QueryClient` that never receives the defaults, and a call site that
re-declares `staleTime` locally.

An audit on 2026-08-30 found a hole neither closes. Both existing rules look at
**observers**. Fourteen fleet reads in the UI trees are not observers at all:

```ts
const devicesQuery = useQuery({
  queryKey: ['deviceManager', 'listAll', 'forRules'],
  queryFn: async () => {
    const all = await system.trpcClient.deviceManager.listAll.query({})
    …
```

That read is invisible three times over, and the cause of all three is the same
single-vs-double nesting D274 already found once in `useUpdateDeviceConfig`:

- `setQueryDefaults` is registered on `[['deviceManager','listAll']]`. Element 0
  of that key is an **array**; element 0 of `['deviceManager','listAll',
  'forRules']` is the **string** `'deviceManager'`. `partialMatchKey` compares
  element-wise, so they do not match and the registered window never applied.
  These reads went out at the app-wide `staleTime: 0`, on every mount.
- The ~20 mutation handlers that invalidate `[['deviceManager']]` miss them for
  exactly the same reason. `EditableNameRow.tsx:37` invalidates
  `[['deviceManager','listAll']]` after a rename — and the rules page, the
  simulate tab, the summaries tab, the timelapses tab and the alarm tab all kept
  the old name until they were remounted.
- Each fetched its own copy of a fleet the sidebar search already holds warm.
  Measured on the reference hub the same day: **1 019 devices**,
  `deviceManager.listAll` **5.6 s** at the full projection and **2.9 s** slim,
  against `/health` at 0.18 s. Six of the fourteen asked for the full
  projection — 1 019 rows with every device's `config` blob, plus a settings
  store read per device.

A seventh was worse than full: `RunTargetPicker.tsx:95` passed `{ slim: true }`
under a comment explaining that slim "skips the per-device settings read". There
is no `slim` key in the input schema — it is `projection: 'slim'` — and Zod
STRIPS an unknown input key rather than rejecting it. The call was the full
projection for as long as the comment claiming otherwise had existed. A misspelt
narrowing is a widening that reads as a narrowing.

**The largest single cost was not a projection at all.** `SystemMirror.init`
(`packages/types/src/device/system-mirror.ts:251`) reads the fleet unprojected,
and `AppShell` refused to mount one child of the React tree until
`system.init()` resolved (`App.tsx:240`). `System.init()` is `awaitConnected()`
followed by `SystemMirror.init()`, which is **three** whole-fleet round-trips —
`getAllBindings` + `getAllSnapshots` + `listAll`. The splash's own docblock said
"~50–200 ms typical".

## Decision

**A UI reads the fleet through `useDeviceManagerListAll`.** A raw
`deviceManager.listAll.query()` in a UI tree needs a reason in the guard's
allowlist, and even allowlisted it must name a `projection`.

**The admin shell's boot gate waits for the transport probe, not for the
fleet.** `useBootGate` opens the tree on `system.awaitConnected()` — the
`auth.me` handshake, which is the entire reason the gate exists — and starts
`system.init()` without awaiting it.

**`SystemMirror.init` keeps the FULL projection.** Narrowing it was the tempting
move and is the wrong one; see below.

## Consequences

- The eleven admin-UI reads now share one cache entry with the ~36 hook
  observers, get the D274 window, and are reached by every `[['deviceManager']]`
  invalidation. On a warm client the Notification tabs cost **zero** fleet
  round-trips.
- Every narrowed read was narrowed **by field**. Slim drops exactly `config`
  (`{}`), `metadata` (`null`) and `sourceInfo`; the consumers read `id`, `name`,
  `type`, `stableId`, `location`, `disabled` and `isCamera`, all of which slim
  carries unchanged.
- A camera filter that was `d.type === DeviceType.Camera` client-side **stays**
  client-side. The server's `isCamera: true` is not the same question: for a
  hub-live device `isCamera` is `isCameraDevice(device)` — "exposes
  `getStreamSources()`" (`device-projection.ts:211`) — and only for a
  forked-worker device is it derived from the persisted type
  (`device-queries.ts:291`). Pushing that filter down would silently change
  which rows appear. Where a site already filtered on `d.isCamera`, moving it
  server-side IS provably identical: the resolver applies exactly
  `if (camerasOnly && !info.isCamera) continue` (`device-queries.ts:227`).
- **Why `SystemMirror.init` is not narrowed.** No consumer reads `config`,
  `metadata` or `sourceInfo` off a mirror row today — so a slim warm-boot would
  look safe. It is not, for a reason that has nothing to do with today's
  consumers: `refreshDeviceMetadata` re-seeds the SAME map from
  `deviceManager.getDevice`, which has no projection parameter and always
  answers full (`system-mirror.ts:1069`, `device-manager.cap.ts:654`). A slim
  warm-boot makes the map **heterogeneous** — a device that has emitted a
  `device.registered` / `device.updated` event carries its config, one that has
  not carries `{}`. `sm.dump(id)` in the REPL, which returns the row verbatim,
  would then show a config blob or an empty object depending on event history.
  That is a worse defect than the one it fixes, and it is invisible.
  Deferring the whole warm-boot removes far more (three fleet round-trips, not
  one leg of one) and changes no shape.
- A mirror warm-boot that FAILS is now a cold cache rather than a boot error.
  That is correct for the admin UI, which reads nothing off the mirror
  (`System.getDeviceInfo` / `listDeviceInfos` / `listDevices` have no admin-UI
  caller; devices come from React Query). It would not be correct for a host
  that does read it, which is why the rule is stated about this gate and not
  about `System.init` in general.
- `addon-benchmark` keeps two raw reads: it is a federated remote with no
  `QueryClient` and no React Query at all. Both are allowlisted with that
  reason and both now name a projection.

## Enforcement

`scripts/check-fleet-query-defaults.ts` gains two rules:

- `raw-client-fleet-read` — a `deviceManager.listAll.query(` anywhere in the
  scanned UI trees, unless the file is in `ALLOWED_RAW_FLEET_READS` with a
  reason; an allowlisted file must still name a `projection`.
- `unknown-fleet-input-key` — every top-level key of a fleet read's input must
  exist in the schema (`addonId`, `projection`, `isCamera`, `deviceIds`),
  because Zod strips the rest. Applies to the hook as well as the raw call.

`SCANNED_DIRS` gains `packages/addon-benchmark/src`, which was invisible to both
existing rules: it constructs no `QueryClient` and calls no hook.

Both new rules were verified by trial regression before this was committed: a
thirteenth raw call site added to `NotificationHistory.tsx` failed
`raw-client-fleet-read`, and `{ projection: 'slim', slimm: true }` on
`GlobalSearch.tsx:68` failed `unknown-fleet-input-key`. Removing each returned
the guard to green.

The boot gate is pinned by
`packages/addon-admin-ui/src/hooks/__tests__/useBootGate.spec.ts`, which hands
`init()` a promise that never settles and requires the gate to open anyway —
a gate that awaits the mirror cannot pass it. Each page's request shape is
pinned by an assertion on the CALL — which client, which projection, whose
window — in that page's own spec; every one was disarmed by reverting its
implementation file to the pre-change source and confirmed red.
