---
id: D1068
title: An event category is catalogued or it does not compile
status: accepted
date: 2026-11-20
supersedes:
applies-to:
  - packages/types/src/enums/event-category-catalog.ts
  - packages/ui-library/src/composites/event-category-picker.tsx
  - packages/ui-library/src/composites/event-stream.tsx
---

## Context

`EventCategory` grew to ~176 values. Only 24 had a UI label, none a
description, and each surface kept its own list: the events tab mirrored the
ring buffer's deny list by hand, and the automation `device-event` row offered
all categories in one flat select, deprecated ones included. A new category
shipped unlabelled and unclassified, and the lists drifted apart.

Rejected: a partial label map with a fallback to the raw id. It compiles
whatever is added, so the gap is only found by an operator reading a picker.

## Decision

`EVENT_CATEGORY_CATALOG` is `Record<EventCategory, EventCategoryEntry>`. A
category without an entry (group, label in both languages, `noise`,
`deprecated`) fails the type check. Every operator-facing category list is
derived from it: `EventCategoryPicker` groups and labels from it,
`DEFAULT_EVENT_CATEGORIES` leaves out its `noise` entries, the event ring's
deny list is `noiseEventCategories()`. A custom pattern (exact id or
`prefix.*`) is the only way to select what the catalogue does not name.

## Consequences

Adding a category means writing its catalogue entry in the same change. A
surface must not keep a hand-written list of categories.

## Enforcement

`tsc` (the `Record` is total over the enum) and
`packages/types/src/enums/__tests__/event-category-catalog.spec.ts`.
