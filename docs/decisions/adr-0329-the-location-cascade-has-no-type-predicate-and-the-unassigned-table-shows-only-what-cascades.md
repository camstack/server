---
id: D329
title: The location cascade has NO type predicate, and the unassigned table lists only the rows that cascade
status: accepted
date: 2026-09-01
supersedes: D252
applies-to:
  - packages/system/src/builtins/device-manager/device-meta-actions.ts
  - packages/addon-admin-ui/src/pages/locations/site-locations.ts
  - packages/addon-admin-ui/src/pages/locations/UnassignedTable.tsx
---

## Context

D252 made `setLocation` cascade a location onto every descendant — but only
when the target device was a `DeviceType.Container`. Nothing enforced that
restriction; it was the shape of the bug D252 was written against (an
HA-adopted container whose child never got the room).

The Locations page redesign measured what that predicate does on the real
fleet: 1 022 devices, 971 with no location. Of the unassigned parents,
**50 containers cascaded to 440 children, and 13 non-container parents
(11 `camera`, 2 `hub`) left 20 accessories behind.** The gap falls exactly on
the cameras.

That mattered because the page needed to stop rendering 568 flat rows. The
only honest way to show 74 rows instead is to say "assign the parent, the
accessories follow" — which the container predicate made a lie for precisely
the parents an operator organises a house by.

The alternative considered and rejected: keep the predicate and list every
accessory whose parent is itself unassigned. That is the 568-row list the
operator called "confusionaria", and it asks a human to do 494 times what the
server already does once.

## Decision

`setLocation` cascades to `collectDescendants(deviceId)` unconditionally. No
device type is consulted. A descendant that already had a location of its own
is REWRITTEN, exactly as it already was inside a container — the cascade is a
write, and one cascade semantics is better than two.

The unassigned table therefore renders only devices with
`parentDeviceId === null`, and every row states its **accessories in tow**:
the size of that same descendant set, counted over the whole fleet (never over
a search-filtered slice, which the cascade does not know about).

"Unassigned" also widens: a device whose location names no REGISTERED room is
unassigned. `groupDevicesBySite` builds cards only for registered names, so
such a device used to be in no card and — under a `location === null` test —
in no list either. It left the page. The row now names the unknown room.

## Consequences

**More rows written per operator action, on more devices.** Assigning a camera
now writes its accessories too. That is the intent; the count on the row is
what makes it auditable before the tap.

**A camera's accessories can no longer be split into another room by an
operator, and then survive a re-save of the camera.** Same trade D252 already
took for containers, now uniform.

**The page can under-report a parent that a filter hid.** Rows come from the
filtered set, follower counts from the unfiltered fleet. A roomless accessory
whose roomless parent is filtered out gets no row and is not counted against a
visible one — it reappears the moment the filter is cleared.

**Nothing retroactive.** As in D252, a parent that already carries a location
does not align its descendants until the operator re-saves it.

## Enforcement

`packages/system/src/builtins/device-manager/__tests__/device-linked-devices.spec.ts`,
describe `setLocation cascade to descendants`: a `camera` parent cascades to a
child AND a grandchild with one event each; a camera parent rewrites a child
that already had `kitchen`; a childless device still writes exactly one row.
Re-introducing the `DeviceType.Container` predicate turns 2 of those red
(verified 2026-09-01).

`packages/addon-admin-ui/src/pages/locations/__tests__/site-locations.spec.ts`
and `.../__tests__/unassigned-table.spec.tsx`: the top-level row rule, the
unregistered-room absorption, and the follower count. Verified by disarming
each of `topLevelUnassigned`'s filter, `hasRegisteredRoom`'s registry lookup,
`unregisteredLocationOf`, `cascadeFollowerCount`'s descendant walk, the
table's `fleet`-vs-`rows` source, and the bulk bar's id set — every one of
them turns at least one spec red (verified 2026-09-01).
