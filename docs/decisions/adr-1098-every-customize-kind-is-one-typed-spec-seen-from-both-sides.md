---
id: D1098
title: Every Customize kind is one typed spec, seen and removable from both sides
status: accepted
date: 2026-11-24
supersedes:
applies-to:
  - packages/types/src/capabilities/customize-spec.ts
  - packages/addon-admin-ui/src/components/device/customize/**
---

## Context

A device's Customize tab grew one kind at a time: field overrides, formulas,
keyed items, event pulse and span, config extensions, whole-cap links (D1076),
the lock door sensor, the power source (manual and stamped by an identity link,
D1063), the `linked-devices` slot (D648, D655), linked actions (D356) and
Triggered-by automations. Each kind was wired by hand, and an inventory on
2026-11-24 found them diverging on every axis the operator touches:

- the active toggle was a `Switch` on some kinds, a `Checkbox` on others
  (scalar link rows, event cards, linked actions) and absent on the rest,
  although every composition feature carries `enabled`;
- remove asked for confirmation on some kinds, not on scalar rows, was hidden
  on link-stamped rows with nothing in its place, was "clear the picker" on a
  cap link and did not exist on config rows;
- cap links and linked actions used private pickers instead of the common
  `SourceSelector`; editing a power source opened the formula dialog;
- Triggered-by, linked actions and linked devices were separate cards outside
  the table, and linked cameras were a separate table;
- composition saves carried `expectedUpdatedAt`, the slot, the action list and
  the trigger automations did not; a toggle off-then-on on an event hit a stale
  stamp because the second save reused the pre-save stamp;
- only `linked-devices` (and identity links, on the Overview page) showed the
  link from the other device. A power-source switch, a door sensor, an event
  source or a trigger source did not know it was used, and could not drop it.

Three partial lists existed — `CUSTOMIZE_CARDINALITIES`, `EXTENSION_SLOT_IDS`,
`COMPOSITION_LINK_KINDS` — and the last was checked by grepping source text.
Power source, lock door sensor and follow-switch were recognised only by the
shape of a scalar entry. The operator had to restate "the same components for
every customization" repeatedly; a rule nothing typed had already been broken
in every new kind.

## Decision

There is ONE closed list of Customize kinds, `CUSTOMIZE_KINDS`, in
`customize-spec.ts`, and ONE registry `Record<CustomizeKind, CustomizeKindSpec>`
in the admin UI. A kind exists only as an entry of that registry, and the spec
requires every piece, so a kind that omits one does not compile:

- **storage** — where it lives (composition feature, extension slot,
  automation, action links) with an explicit discriminant; no kind is inferred
  from the shape of another kind's entry;
- **owner side** — the row in the single `CustomizeTable`, the Add/Edit dialog
  built on the common `SourceSelector`, remove through `useConfirmRemove` (a
  row an identity link contributed offers "Unlink <device>", which removes the
  link and names every feature that goes with it, D1063), and the library
  `Switch` bound to the stored `enabled` where the kind can be toggled;
- **linked side** — what the source/target device shows under "Used by" on its
  own Customize tab, computed on read from the owner's stored record (never a
  second store, D676), and the removal from that side, which edits the OWNER's
  record: a link can be deleted from either device;
- **concurrency** — every save carries the stamp it read and takes the stamp
  the write returned before the next save on the same record; saves on one
  record are serialised.

A field another device forces (a claim, D663) is a linked-side entry of the
kind that created it, shown and releasable from both devices.

## Consequences

- Power source, lock door sensor and follow-switch get a discriminant in the
  stored entry; existing compositions are read through a one-time migration of
  the shape, not by a second reader.
- The `linked-devices` slot, the action-links list and the trigger automations
  gain an `expectedUpdatedAt`-style stamp on write.
- Triggered-by, linked actions, linked devices and linked cameras render as
  rows of `CustomizeTable`; their private cards and pickers are deleted.
- The "Used by" section needs a hub read that answers, for a device, every
  record of every kind that names it. It is a query over owners' records, not
  a reverse index kept in step by writes.
- Identity and display name are not link kinds and stay outside the registry.
- Rolled out in phases: registry and types first (existing kinds adapted
  behind it), then kind-by-kind migration of UI and storage, then the
  linked-side read and section.

## Enforcement

- Type: the registry is `Record<CustomizeKind, CustomizeKindSpec>` with every
  member required; adding to `CUSTOMIZE_KINDS` without a full spec fails
  `tsgo`.
- Guard: `scripts/check-customize-coverage.ts` moves from text grep to the
  registry, and refuses `Checkbox` and any picker other than `SourceSelector`
  under `customize/**` kind folders.
- Spec: one parameterised spec runs each registered kind through add, edit,
  toggle, remove from the owner, remove from the linked side, and two
  consecutive saves.
