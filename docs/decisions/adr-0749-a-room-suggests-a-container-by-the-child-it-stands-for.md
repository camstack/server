---
id: D749
title: A room suggests a container by the child it stands for; every Customize picker suggests the room
status: accepted
date: 2026-10-07
supersedes:
applies-to:
  - packages/ui-library/src/composites/device-select-filter.ts
  - packages/ui-library/src/composites/device-select-field.tsx
  - packages/addon-admin-ui/src/components/device/customize/assignments/room-suggestions.ts
  - packages/addon-admin-ui/src/components/device/customize/assignments/SuggestedDevices.tsx
---

## Context

D356 replaced automatic linking with a picker that SUGGESTS the devices sharing
the camera's location. Its rule suggested every non-container device in the
room, so every child of a container came up one by one: a door sensor offered
its contact, its battery reading and its "last seen" entity as three equal
suggestions, the same flood that gave camera 104 fifteen links, ten of them
container children. The Customize tab (D676) had no suggestions at all: its
Doorbell, Motion, Battery, Consumables and Linked devices pickers listed the
whole fleet, and the operator asked for a quick way to reach the camera's
room — "if they are containers, suggest only the auto-selected pick".

The alternatives considered: keep suggesting every child (the flood above), or
suggest the container and expand it on pick (a container is never a pick —
D648 rule 4 refuses it, and an expansion rule is what D356 removed).

## Decision

A device in a location is suggested; a container family in that location
contributes ONE suggestion, the child the container stands for — its stored
`primaryChildEntityId`, else `resolveContainerPrimaryChild`'s automatic choice
(role, then namesake, then type). The container itself is never suggested, and
a container with no child suggests nothing. Its other children are not hidden:
they stay in the picker's normal list. The rule is ONE function,
`sameLocationSuggestions` in `ui-library/composites/device-select-filter.ts`,
applied by the `device-multiselect` field's `suggestLocation` and by every
Customize picker; each surface intersects it with its own validity filter
(capability, kind, already assigned, the host). A suggestion is never assigned
on its own (D356): Customize shows "N suggested · <room>" on a card's header,
which opens the picker, and a "Suggested · <room>" group at the top of the
picker whose Add / Use is the picker's own pick.

## Consequences

- The `device-multiselect` field now suggests only a container's primary child
  ("Faretti hall 2" moves from Suggested to Other devices); it is still one
  click away.
- The device page's Customize tab reads the fleet (one shared `listAll slim`,
  the cap index, and the linked slot's candidates) as soon as a card can add
  and the device has a location, to count suggestions — no longer only when
  the picker opens.
- The Battery and Consumables pickers choose a device before a field, and
  have no device-level compatibility filter; their suggestions are the room's
  devices (minus the host and devices already feeding the card).
- The hub's `deviceExtension.listCandidates` still flags every same-location
  candidate `suggested`; only the read-only extensions panel reads that flag.
  Customize ignores it and applies this rule.

## Enforcement

`device-select-filter.test.ts` (`sameLocationSuggestions`: container → only
its primary, stored pick, role before type, childless container),
`device-multiselect-linked.test.tsx`, `room-suggestions.spec.ts` (compatibility
filter, already-assigned exclusion) and `room-suggestions-ui.spec.tsx`
(nothing assigned on render, one-click add is the picker's confirm).
