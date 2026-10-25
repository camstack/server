---
id: D512
title: A site zone groups LOCATIONS, and everything hanging off a location key survives a rename
status: accepted
date: 2026-09-16
supersedes:
applies-to:
  - packages/types/src/device/site-zone.ts
  - packages/types/src/device/location-icon.ts
  - packages/system/src/builtins/device-manager/device-meta-actions.ts
  - packages/system/src/builtins/device-manager/device-meta-types.ts
  - camstack/src/components/cameras/camera-locations.ts
---

## Context

The operator asked for a concept one level above a location: "tutte le camere da
letto vanno sotto Night zone, ma la singola camera appartiene a una sola
location" [all the bedrooms go under Night zone, but a single bedroom belongs to one location only] — and, explicitly, an entity that binds locations "così da non toccare
affatto i singoli device" [so as not to touch the individual devices at all].

That last clause is the design. A camera's zone is DERIVED from its location and
is never written on the device row, so grouping rooms rewrites nothing in the
fleet and cannot be undone by a device re-registering.

By the time this was asked, three things already hung off a location label: the
icon (D511), the description the summary AI reads, and now membership. Two of
those three had already been lost to an edit somewhere else — the description
because it lived in a different addon under a hand-typed, case-sensitive key
while the icon lived on the location under a folded one. A rename carried the
icon and orphaned the description, in silence.

## Decision

**A zone is stored as TWO maps, not one.**

- `siteZones: zoneKey → { label, icon? }` — the registry.
- `locationZones: locationKey → zoneKey` — the membership.

Separate because **a zone exists even when it is empty**. Folding membership
into the registry would make the just-created zone unrepresentable, so
"create it, then fill it" — the obvious order, and the one the admin panel
offers — would be impossible; and emptying the last room would silently delete
the zone along with its icon.

The membership direction is `location → zone` and not the reverse, because that
makes **at most one zone per location true by construction**: there is one slot,
so a second assignment moves the room instead of listing it twice. No check to
remember, no state where a room is in two places.

**Both keys are the folded label** (`siteZoneKey`, `locationIconKey` — trimmed,
lower-cased), the same equality the registry matches on everywhere. A case-only
rename is a real edit this repo supports.

**Everything hanging off a location key moves with it.** `renameLocation` now
carries icon, description AND zone membership; `removeLocation` drops all three.
`removeSiteZone` deletes the zone and its membership and **keeps the rooms** —
deleting a grouping must never delete what was grouped. `renameSiteZone` carries
icon and members, and a rename onto an existing zone merges into it, the target
keeping its own icon.

**The code says `siteZone`, never `zone`.** `zone` is the most loaded word in
this product: 612 source files and 24 Italian strings where it means a DETECTION
zone — a polygon drawn on one camera. The two are unrelated, and a reader who
conflates them goes looking for a camera's bedrooms. `LocationGroup` was
unavailable too: it is the storage-location (disk) panel.

**The UI frees the plain word by naming the other one honestly.** The bare
labels of the detection concept ("Zone", "Zona", "Zone escluse") become "zone di
rilevamento" / "detection zones". Only the labels: in sentences already about a
camera frame there is no ambiguity to remove, and "il bordo di una zona di
rilevamento" [the edge of a detection zone] reads worse than what it replaces.

**In the viewer the bucket key is prefixed** (`z:` / `l:`). A zone and a
location may carry the same name — an operator with a "Cantina" zone and a
"Cantina" room is not confused — and the prefix makes the two structurally
different strings, so `===` keeps working as React state. A zone the hub no
longer reports selects **nothing**, never everything: falling through to "all
cameras" is indistinguishable from a cleared filter and would hide the fact that
the zone is gone.

## Consequences

- One more thing keyed on a location label, and the rename/remove carries are
  now three parallel movers in `device-meta-actions.ts`. They are deliberately
  separate functions rather than one generic mover: the value types differ, and
  a generic one would be a place to add a fourth key and forget the test. The
  spec file asserts each carry independently, and each was verified red by
  neutralising its carry alone.
- The viewer declares its own structural `ZoneView` instead of importing
  `SiteZone` from `@camstack/types`. That specifier resolves to the workspace
  source for tsc and to the PUBLISHED package at runtime — an import of a
  same-day type compiles green and throws on first evaluation. See the sibling
  change that made the strict resolution the viewer's default.
- An older hub has no `listSiteZones`; the query fails, the list is empty, and
  the strip renders exactly as it did before zones existed.
- Membership is edited in ONE place, on the room. A screen that also assigned
  rooms from the zone's side would be two places to change one fact — the exact
  shape that let the description drift away from the icon.
