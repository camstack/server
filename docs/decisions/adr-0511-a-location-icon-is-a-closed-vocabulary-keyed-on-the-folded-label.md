---
id: D511
title: A location icon is a CLOSED vocabulary keyed on the folded label, and it travels with the room
status: accepted
date: 2026-09-16
supersedes:
applies-to:
  - packages/types/src/device/location-icon.ts
  - packages/system/src/builtins/device-manager/device-meta-actions.ts
  - packages/addon-admin-ui/src/pages/locations/**
---

> **Amended by [D854](adr-0854-one-typed-icon-catalog-every-lucide-icon-both-surfaces-draw.md):** the CLOSED 20-icon vocabulary is gone — a location wears any key of the one icon catalog. The rest of this record (the folded-label key, the icon travelling with the room, the fallback pin) still holds.

## Context

An operator asked for an icon per location, to be drawn in the viewer's camera
list location filter. Two things about locations made the obvious shapes wrong.

**A location is not an entity.** `deviceManager.listLocations` returns
`string[]`, the union of an operator-curated registry (`locations` in the
device-manager addon store) with every `row.meta.location` the fleet carries.
There is no record to add a column to, and changing that return shape would hit
the Device Info autocomplete, the Home Assistant adoption import and the
recorder — none of which want anything but labels.

**Two surfaces draw the icon and they do not share an icon module.** The admin
UI imports `lucide-react` (everything is available). The viewer imports a
hand-maintained per-icon allowlist, `src/lib/icons.ts`, re-exporting
`lucide-react-native/icons/*` one file at a time because the package barrel
measured 47 % of the app's module count. A free-form icon string would
therefore be renderable on one surface and an empty box on the other, decided
at runtime by whichever icon happened to be bundled — and the operator would
have no way to tell which names were safe.

The first shape considered was a ROOM-typed vocabulary (`kitchen`, `garage`,
`garden`). It reads better in a picker and it is worse in every other way: it
needs a meaning→glyph table maintained independently on both surfaces, and it
argues with the operator who wants the car glyph on a room called
"Ripostiglio".

## Decision

A location icon is a member of **`LOCATION_ICON_IDS`**, a closed vocabulary in
`@camstack/types` whose members are the exact kebab-case **lucide icon ids** —
the vocabulary names the DRAWING, not the room. "Can this surface draw it?" is
then mechanical (`lucide-react`'s PascalCase export; the viewer's
`lucide-react-native/icons/<id>` line) instead of a judgement call, and there
is no per-surface meaning table to keep in step. A value outside the vocabulary
— an id from a newer hub, a hand-edited settings row — **degrades to
`LOCATION_ICON_FALLBACK` (`map-pin`), never to a hole**; read it through
`resolveLocationIcon` and that is what you get.

The assignment lives in a **map beside the registry**
(`AddonStore.locationIcons`), keyed on **`locationIconKey(label)`** — trimmed,
lower-cased, the equality the registry already matches on everywhere. The
surface is **additive**: `listLocationIcons` / `setLocationIcon`,
`listLocations` unchanged. Only assignments that EXIST are returned — a room
with no icon is absent, never `map-pin`, so "chose the pin" and "chose nothing"
stay distinguishable.

**The icon travels with the room.** `renameLocation` moves it (including when
`from` was never registered — `setLocationIcon` does not require registration
either), and `removeLocation` drops it.

## Consequences

- Growing the vocabulary is a framework change AND a viewer change: the id
  here, the line in the viewer's `icons.ts`. Older viewers draw the fallback
  for a new id until they update — which is the contract, not a bug.
- Ten of the twenty members are not yet in the viewer's allowlist (`sofa`,
  `bed-double`, `bath`, `briefcase`, `trees`, `umbrella`, `waves`, `fence`,
  `warehouse`, `store`). Until that session lands them, those rooms draw the
  pin on the phone and their real glyph in the admin UI.
- A rename that MERGES two rooms keeps the target's icon: renaming "Sala" into
  "Hall" moves devices into Hall, it does not restyle it.
- The store decoder DROPS an unrecognised id rather than passing it through, so
  a renderer is never handed a value it cannot draw.

## Enforcement

- `packages/addon-admin-ui/src/pages/locations/location-icons.tsx` is
  `satisfies Record<LocationIconId, …>` — an id added to the vocabulary without
  its lucide component fails `npm run typecheck`. The viewer has no equivalent
  today; it is covered by the fallback instead, which is why the fallback is a
  rule and not a nicety.
- `packages/system/src/builtins/device-manager/__tests__/location-registry.spec.ts`
  pins the folded key, the absent-not-pin rule, the unknown-id drop, and the
  rename/merge/remove carry-over. Each was verified by neutralising the
  implementation and watching the matching case go red.
