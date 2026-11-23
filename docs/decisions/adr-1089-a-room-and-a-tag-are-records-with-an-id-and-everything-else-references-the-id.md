---
id: D1089
title: A room and a tag are records with an id; everything else references the id
status: accepted
date: 2026-11-22
supersedes: D1054
applies-to:
  - packages/types/src/capabilities/device-manager.cap.ts
  - packages/types/src/capabilities/core-blocks.cap.ts
  - packages/types/src/capabilities/notification-rules.cap.ts
  - packages/system/src/builtins/device-manager/**
  - packages/system/src/builtins/core-blocks/**
  - packages/addon-post-analysis/src/notification-center/**
---

## Context

D1054 made a tag a trimmed string stored on the record it labels, with only its
style (colour, icon) registered. Rooms already worked that way: a device carries
`meta.location` as text, and the device manager keeps a suggestion list plus maps
keyed on the trimmed, lower-cased label (`locations`, `locationIcons`,
`locationDescriptions`, `locationZones`).

The text model has a cost that grew with every field. The label is the identity,
so a rename is a rewrite of every record that carries it: `renameLocation` exists
because a browser-driven rename split a fleet across two rooms, and a tag rename
reads six owner kinds through `ctx.api` and refuses when one cannot be read
(`TagOwnerUnreachableError`). Each new piece of metadata is another map keyed on
the label, and a case-only rename has to re-key all of them. A room has four such
maps today; a tag has one and was about to gain more (description, order).

The operator decided (planning#565, 2026-11-22) that rooms and tags become real
entities, extended together so the two stay one pattern.

## Decision

A room and a tag are each a record with an opaque, stable `id` and their own
metadata. A record that belongs to a room or carries a tag stores the id, never
the name.

- **Room**: owned by the device manager, records kind `rooms`:
  `{ id, name, icon?, description?, zoneId?, colour?, order? }`. A device meta
  carries `locationId: string | null`.
- **Tag**: owned by the `core-blocks` builtin, records kind `tags` (it replaces
  `tag-styles`): `{ id, name, colour?, icon?, description?, order? }`. The six
  owners of D1054 (core block, scheduler, template, action, device meta,
  notification rule) carry `tagIds: string[]`.
- A site zone gains an id the same way, so `Room.zoneId` is a reference and not a
  third text key.
- A name is unique within its kind, compared trimmed and case-insensitively.
  Creating a name that exists returns the existing entity, so the "type a new
  name in the picker" flow is one call (`ensureRoom`, `ensureTag`).
- A rename, a restyle, a new description are ONE write to ONE record. No owner
  is rewritten and no owner has to be reachable.
- A delete clears the references in one server operation, as a remove does
  today. A reference whose entity does not exist reads as unset: a reader never
  throws on it and never shows the raw id.
- Readers that want a label get it resolved: the device projection keeps
  `location` (the room's current name) and owners keep `tags` (names) as DERIVED,
  read-only fields beside the ids. Writes take ids. A write that still names a
  room or a tag by text is accepted for one release and resolved through
  `ensure*`, so a client that has not moved yet keeps working.

## Consequences

- `listLocations`, `listLocationIcons`, `listLocationDescriptions`,
  `setLocationIcon`, `setLocationDescription`, `renameLocation`, the zone-by-name
  methods and `tags.setStyle` / `tags.rename` become thin shims over the entity
  methods (`listRooms`, `updateRoom`, …) and are removed once the admin UI and the
  viewer no longer call them. `locationIconKey` and the label-keyed maps go.
- The tag fan-out through `ctx.api` survives for DELETE only (clearing
  references). `TagOwnerUnreachableError` no longer guards a rename.
- Filters and facets (`deviceManager` search `locations`, the "by tag" grouping,
  notification-rule scopes) take ids; a name is accepted for the same one
  release.
- An import that brings a room by name (the Home Assistant area on adoption)
  resolves it through `ensureRoom`.
- Stored data moves through the D987 ledger, in three steps so no step needs
  another owner's data:
  1. `device-manager/…-rooms-as-records` (plan, one transaction): reads the
     label-keyed maps and every device's `meta.location`, writes one `rooms`
     record per distinct key (and one zone record per site zone), sets
     `locationId` on each device, deletes the maps and `meta.location`. The
     display spelling is the registry's, else the most used one on devices.
  2. Tags, per owner (plan, one transaction each: `core-blocks`,
     `device-manager`, the notification center): each adds `tagIds` to its own
     records and KEEPS the names. The id of a tag is derived from its key by one
     pure function in `@camstack/types`, so three owners mint the same id without
     reading each other.
  3. `core-blocks/…-tags-as-records` (procedure, `dependsOn` the three plans of
     step 2, idempotent): writes one `tags` record per name in use or styled,
     carrying the style from `tag-styles`, then deletes `tag-styles`. Until it
     has run, a reader resolves an id with no record from the kept name.
  The kept `tags` names are dropped by a later migration, one release after.
- Ids derived from a key apply to MIGRATED rows only. A room or tag created
  afterwards gets a random id, so a later rename back to an old name does not
  collide with anything.
- A backup restored from before the migration converges at the next boot (the
  ledger travels with the file).

Rejected: one hub-owned plan over every owner in a single transaction. It would be
atomic across owners, but a hub plan runs before addons boot and may write only
record kinds a previous boot declared, so it needs the kinds shipped one release
earlier and breaks on an installation that skips that release. Also rejected:
keeping text plus a richer registry, which leaves the rename fan-out and the
label-keyed maps in place.

## Enforcement

Specs on real SQLite for each migration (a marked fixture per owner kind; removing
the per-migration transaction turns the rollback spec red; a restored older
snapshot converges). A spec that a rename writes exactly one record. A guard,
`check-no-room-or-tag-by-name`, added with the removal of the shims: no schema
field named `location` / `tags` that is not marked derived. Until then, review
only.
