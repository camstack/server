---
id: D1054
title: A tag lives on the record it labels; only its style is registered
status: accepted
date: 2026-11-15
supersedes:
applies-to:
  - packages/types/src/capabilities/core-blocks.cap.ts
  - packages/types/src/capabilities/device-manager.cap.ts
  - packages/system/src/builtins/core-blocks/**
  - packages/system/src/builtins/device-manager/**
  - packages/types/src/capabilities/notification-rules.cap.ts
  - packages/addon-post-analysis/src/notification-center/**
---

## Context

The operator asked for free tags on every "build your system" element (core
blocks, schedulers, templates, actions) and on devices: typed with
autocomplete, each tag with a colour and an icon chosen in a modal opened from
the autocomplete, usable as a filter in every section and in search, and as a
grouping ("by tag") inside each section.

Two storages were possible. A central assignment table — `(ownerKind,
ownerId) → tags` — keeps every record schema untouched, but it is a second
copy of a fact about a record that someone else owns: deleting a block, a
scheduler or a device would leave assignments behind unless every owner grew a
removal hook, and a section listing its own records would need a join against
another store to filter them. The room label already took the other path:
`meta.location` sits on the device, and `deviceManager.listLocations` is only a
suggestion list plus the room's icon — and its own history shows the cost of
doing a rename from the browser (`renameLocation` exists because a closed tab
split the fleet across two rooms).

## Decision

A tag is a trimmed string stored on the record it labels, in a `tags` array
the record's owner persists. There are six owners: `CoreBlock`, `Scheduler`,
`TemplateRecord`, the action record, the device meta beside `location`, and
the notification rule. A notification rule is tagged on its base, so every
kind carries tags: event, summary, timelapse and calendar-events. The only registry is the
tag STYLE: name → colour (an enum of tag-colour tokens, never a hex) and icon
(`IconKey`), kept by the `core-blocks` builtin. Listing tags returns the union
of styled tags and tags in use, with their counts. Renaming or removing a tag
is ONE server operation that rewrites every owner, never a sequence the
browser drives. Tags compare trimmed and case-insensitively, like rooms.

## Consequences

- Deleting a record deletes its tags; nothing can orphan an assignment.
- Every owner schema gains an optional `tags` field (absent = no tags), and a
  section filters its own list without a join.
- A tag with no style shows a colour derived from its name and the default
  icon; the style is a choice, never a prerequisite.
- Rename and remove fan out to the device manager and to the notification
  rules through `ctx.api` (`notificationRules.listRuleTags` /
  `setRuleTags`, owner ids `<kind>:<ruleId>` across all four rule kinds), so
  the `core-blocks` builtin is the one place that knows every owner kind.
- An owner that cannot be read does not blank the list: `tags.list` logs a
  warning, reports that owner's count as `null` (unknown, D393) and returns
  the other owners' tags. A rename or remove reads every owner before it
  writes, and refuses with `TagOwnerUnreachableError` naming the owner when
  one cannot be read, so nothing is half rewritten.
- A tags field never carries a default: a partial patch that does not name
  `tags` keeps them, and only an admin may set them.

## Enforcement

Specs on the tag registry: rename moves the tag on every owner kind in one
call (a fixture record per kind, marked), and a removed tag drops its style.
Otherwise review only.
