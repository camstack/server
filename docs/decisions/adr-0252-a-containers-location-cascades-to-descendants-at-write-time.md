---
id: D252
title: A container's location cascades to its descendants at write time, not read time
status: superseded
superseded-by: D329
date: 2026-08-26
supersedes:
applies-to:
  - packages/system/src/builtins/device-manager/device-linked-devices.ts
  - packages/system/src/builtins/device-manager/device-meta-actions.ts
---

> **Superseded by [D329](./adr-0329-the-location-cascade-has-no-type-predicate-and-the-unassigned-table-shows-only-what-cascades.md)**
> — the write-time cascade stands; the `DeviceType.Container` predicate on it
> does not. It is gone, and `setLocation` cascades for every parent.

## Context

 fixed a real bug — an operator's location, set on an
HA-adopted CONTAINER (the device they see and organise by), never reached the
container's capability-bearing CHILD, so auto-mode linking by location found
only the container. Its fix was `resolveEffectiveLocation`: a child with no
`location` of its own inherited its nearest container-ancestor's location,
resolved fresh on every `getLinkedDevices` read from the already-fetched
candidate list — explicitly chosen over a stored copy to avoid "the second
copy that diverges" shape (D224).

The operator reviewed that design and rejected it: *"la location ereditata non
deve essere in lettura ma quando un parente viene aggiornato con la location,
solo in quel momento esatto va a scrivere la location su tutti i suoi
figli."* [the inherited location must not be resolved at read time; when a parent is updated with the location, only at that exact moment does it write the location onto all its children.] A live-resolved value is invisible everywhere except the one call
site that resolves it — a device's own `location` column, as read by any
other consumer (device list, settings UI, exports), still showed `null` for
every child. The container's location visually "worked" only inside
`getLinkedDevices`.

## Decision

`setLocation` (device-meta-actions.ts) is the only place a container's
location reaches its descendants. When the target device is a
`DeviceType.Container`, the SAME location value is written to every
descendant's own `location` column — recursively, cycle-guarded, in the same
`withMetaWriteLock` critical section — the instant the operator calls it. A
descendant's own, possibly different, location is OVERWRITTEN: the cascade is
a write, and a write that stops at an existing value is not a cascade — the
operator setting the container's location is understood as organising the
whole subtree by it.

`resolveLinkedDeviceIds`'s auto-mode match reverts to a plain per-candidate
`c.location === selfLocation` field compare. `resolveEffectiveLocation` is
deleted. A location-less descendant of a container is therefore only reachable
by location once the operator has (re)saved the container's location since
this change shipped — see Consequences.

## Consequences

**Retroactivity.** A container that already carried a location before this
shipped does NOT retroactively align its descendants. They stay `location:
null` — invisible to auto-mode linking-by-location — until the operator
re-saves the container's location. This is why a device like the camera-101
door-contact from 's own bug report will not reappear in
`getLinkedDevices` until its container is touched again.

**Not atomic.** The cascade is N separate row `patch()` calls inside one
`withMetaWriteLock` section — that section serializes it against every other
device writer (no interleaved read/write), but it is not one SQL transaction.
A row write that throws does not abort the rest: the failure is collected,
every other descendant is still attempted, and if anything failed it is
logged at `error` with every failing id, tagged `{ deviceId: <container> }`.
A silently-partial cascade — some descendants aligned, some not, nothing
saying so — is exactly the failure mode this decision refuses to reproduce.

**More writes per operator action.** Setting a container's location now costs
one row write per descendant instead of one. Logged at `info` with `updated`
/ `failed` counts on the container's `deviceId` tag, so a mass update is never
indistinguishable from a no-op.

**More events per operator action.** `DeviceMetaChanged` fires once for the
container and once per descendant actually written (never for one that
failed) — the auto-link consumer, and anything else subscribed, sees every
row that changed, not just the one the operator directly touched.

## Enforcement

`packages/system/src/builtins/device-manager/__tests__/device-linked-devices.spec.ts`,
describe block `setLocation cascade to descendants` (renamed by D329): asserts
the recursive write, the overwrite-of-a-different-location, the end-to-end
`getLinkedDevices` before/after a re-save, and the partial-failure path (one
row's `updateWhere` throws — the sibling still lands, the failure is logged
against the parent). Nothing ever enforced the "cascade only on Container"
restriction itself beyond review, which is how D329 came to delete it.
