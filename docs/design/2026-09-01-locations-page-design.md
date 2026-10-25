---
title: Locations page — per-room overview and a table of unassigned devices
date: 2026-09-01
status: implemented (2026-09-01) — decision recorded in D329
covers:
  - packages/addon-admin-ui/src/pages/Locations.tsx
  - packages/addon-admin-ui/src/pages/locations/site-locations.ts
  - packages/addon-admin-ui/src/pages/locations/LocationCard.tsx
  - packages/addon-admin-ui/src/pages/locations/UnassignedTable.tsx
  - packages/addon-admin-ui/src/pages/locations/NewLocationButton.tsx
  - packages/addon-admin-ui/src/pages/locations/device-glyphs.tsx
  - packages/addon-admin-ui/src/pages/locations/location-icons.tsx
  - packages/addon-admin-ui/src/pages/locations/LocationIconPicker.tsx
  - packages/system/src/builtins/device-manager/device-meta-actions.ts
---

# Locations — a per-room overview, and one table for what has no room

## The problem, measured

The page arrived on 01/09 with the storage train. On the real fleet:

| Fact | Value |
| --- | --- |
| Total devices | 1 022 |
| Without a location | **971** (95%) |
| Assigned | 51, across 16 rooms |
| Rows the *Unassigned* section renders today | **568** |
| …of which top-level (`parentDeviceId === null`) | **74** |
| …of which accessories whose parent is itself unassigned | **494** |
| Top-level cameras without a room | 20 |

The 568 rows sit in a raw `<ul>`, with no pagination and no table.
This is the concrete reason for "confusing": 95% of the fleet ends up
in a flat list at the bottom of the page, and 87% of that list is accessory
entities (sensor=271, switch=110, control=45 — Home Assistant entities) that
the operator does not assign one by one.

## The defect the page would reveal

`setLocation` (`device-meta-actions.ts:553`) cascades to the descendants **only
if the device is of type `Container`**:

```ts
if (persisted.meta.type === DeviceType.Container) {
  const descendants = await collectDescendants(pctx.metaStore, deviceId)
  …
}
```

Among today's unassigned devices that have children: 50 containers → 440 children (cascade ok);
**13 non-container parents (11 `camera`, 2 `hub`) → 20 children, no cascade**.
The gap falls exactly on the cameras. A UI that lists only the top-levels
would promise "assign the parent, the accessories follow" and for those 13 it would be
a lie.

**Operator decision**: the cascade must be **exactly** that of containers,
for any parent. No exception for a child that already has a location of its own:
it is rewritten, as already happens today inside a container.

`collectDescendants` (line 485) is already type-agnostic — a BFS over `parentDeviceId`
with `visited`, cycle-proof. The change is to **remove the predicate**, not to
add one. The rest of the function already runs inside `withMetaWriteLock`,
already accumulates `cascaded`/`failed`, already emits one `DeviceMetaChanged` per child
and already logs with `tags: { deviceId }`.

## The page

Three bands, all on **a single page** — no per-room detail view
(16 rooms today; the grid holds up).

### 1. Header and creation

The "new location" form is no longer the first thing on screen: it becomes a
`+ New location` that opens the input. The page opens on the content.

### 2. Room grid

One card per registered room, **compact list always visible**:

```
┌─ Living room ─────────── ⋯ ─┐
│ 📹 Living room camera ○ off │
│ 📹 Sofa camera        ● on  │
│ 📹 TV camera          ● on  │
│    └ 🔔 Siren         ● on  │
│ 🌡 Temp sensor        ● on  │
│ 🔒 Lock               ● on  │
└─────────────────────────────┘
```

- icon per type, name, status dot; accessories nested under the parent
  (`topLevelAtLocation` already does this grouping);
- no aggregate counts in the header — the list IS the information;
- the `⋯` menu holds rename and delete;
- **an empty room stays visible** with an explicit empty state. If it
  disappeared, nothing could be assigned to it.

### 3. Table of unassigned devices

The shared `DataTable` (`@camstack/ui-library`, the `columns` / `rows` /
`rowKey` / `mobileMode` / `emptyMessage` API already used throughout the admin-ui), **not**
a `<ul>`.

- **Rows: top-level only** — containers and simple devices. 74 instead of 568.
  Accessories do not appear: they follow the parent by cascade.
- Columns: name · type · status · number of accessories in tow · action.
- **Two assignment paths, both**:
  - an inline select in the row, for the single case;
  - a checkbox per row + a selection bar with *Assign to…*, for the first
    population (today's 74 are almost all first population).
- The "accessories in tow" column is what makes the cascade honest: the row
  says, before the tap, how many other devices will move with it.

## Rename

Today `onRename` runs in the browser as *create new → reassign N devices one by
one → delete the old one*. A tab closed halfway leaves the devices split between
two rooms. It must become **a single server-side operation**, under the same
write lock as the rest.

> **Not implemented (2026-09-01).** The redesign moved rename and delete
> into the `⋯` menu, but rename stayed the same client-side sequence:
> it needs a new `renameLocation` action on the `deviceManager` provider
> (registry + meta rows under `withMetaWriteLock`), which is server work
> outside the perimeter of this change. Until it exists, the
> half-closed-tab risk is unchanged.

## The hole we do not touch (but name)

`groupDevicesBySite` maps only the **registered** names, and `unassignedDevices`
returns only those with `location === null`. A device with an unregistered
location is in no card **and** not among the unassigned: it
vanishes from the page. Today it is not triggered — all 16 rooms in use are
registered — but it is the shape of defect this repo punishes (work
silently discarded). The table of unassigned devices absorbs it: its
definition becomes "no room **or** a room that does not exist", and the row
says so.

## Tests

- `site-locations.spec.ts` is extended to the new `topLevelUnassigned` and to the case
  of the orphan location.
- New server specs: the cascade on a **non**-container parent, and the fact
  that it rewrites a child that already had a location.
- New UI specs: bulk assignment, and the "accessories in tow" column
  that counts what the cascade will actually move.
- Every gate verified **by disarming**: with the fix removed, the spec must turn
  red. If it does not turn red, the spec is missing.


## Addition 2026-09-16 — the room icon

The icon is chosen here, from the icon button in the card header: the button
**is** the current icon, because that is the answer the operator is
choosing and will see again in the viewer's location filter. It also appears in the
tab strip, next to the room name.

The vocabulary is **closed** and names the drawing, not the room — the kebab-case
lucide ids of `LOCATION_ICON_IDS` (D511). Reason: the admin UI has all of
`lucide-react`, the viewer has a hand-written per-icon allowlist, and a free
string would be drawable on one surface and a hole on the other. An id
that this build does not know degrades to the pin, never to a blank.

A room without an icon is **absent** from `listLocationIcons`, not `map-pin`: the
fallback belongs to the renderer, otherwise "I chose the pin" and "I did not choose" are the
same answer and the picker cannot draw them differently. Rename and delete
carry the icon with them server-side, so the page invalidates
`listLocationIcons` after those two as well — without it, the tab strip showed the
glyph of the old room on the new name.
