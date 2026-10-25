---
id: D915
title: A device's consumables are items of its consumables cap, shown as one collapsible section directly under the device's hero card
status: accepted
date: 2026-10-23
supersedes:
applies-to:
  - packages/types/src/capabilities/consumables.cap.ts
  - packages/types/src/capabilities/capability-definition.ts
  - packages/system/src/builtins/device-manager/device-aggregation.ts
  - packages/addon-admin-ui/src/components/device/hero/hero-widgets.ts
  - packages/addon-admin-ui/src/components/device/hero/DeviceHeroWidgets.tsx
  - packages/ui-library/src/composites/cap-settings/ConsumablesPanel.tsx
  - packages/ui-library/src/composites/cap-settings/consumable-rows.tsx
  - packages/ui-library/src/composites/cap-settings/consumables-summary.ts
  - packages/addon-post-analysis/src/notification-center/alerts/consumable-routing.ts
---

## Context

The robot vacuum and the dishwasher showed their consumables in three
different ways. The vacuum's wear parts (brush, filter) were items of the
`consumables` cap, rendered as a separate "Consumables" top tab. Its tanks
(clean water, dirty water, detergent, dust bin) were four fields of
`vacuum-control`, drawn by the vacuum's hero card. The dishwasher's salt and
rinse aid were `saltLevel` / `rinseAidLevel` on the `dishwasher` cap, drawn as
badges in the dishwasher's hero card and its device-list row. The operator
asked for ONE consumables component on every device that declares
consumables, never drawn by a hero card itself.

A consumables shape already existed and bound to every device type, but its
item status (`ok | replace`) could not say "low", "empty" or "full". And a
`deviceConfig` widget could only become a tab, not a section of the page. So
each device type had grown its own fields and its own drawing.

The first version put the section at the bottom of the Overview tab, in the
right column. The hero is in the left column (on a phone, at the top), so
the section was out of view on every other tab and far below the fold on a
phone. The operator asked for it inside the hero block, directly under the
hero card, collapsed when there is nothing to do.

## Decision

Everything a device uses up or fills is an item of its `consumables` cap.
`ConsumableItemSchema` gains `kind: wear | supply | waste` (absent = wear) —
which direction is bad — and `form: part | tank | product | bin` — how it is
drawn (absent = derived from the kind: wear → part, waste → bin, supply →
product; `consumableFormOf`). `status` widens to
`ok | low | empty | full | replace`. A vacuum's water tanks are `tank` items
(clean water `supply`, dirty water `waste`), its detergent a `supply`
`product`, its dust bin a `waste` `bin`, its brushes, filter and mop pad
`part`s. A dishwasher's salt and rinse aid are `supply` `product`s. The old
fields are removed from `vacuum-control` and `dishwasher`.

`DeviceConfigWidgetUi` gains `placement: 'tab' | 'hero'`. The `consumables`
cap declares `hero`, which `device-aggregation.ts` emits as `location: 'hero'`
per binding. The admin device page shows each hero widget once directly under
the hero card, in the same slot (left column on desktop, first row on a
phone), on every tab; a container also shows its primary child's. A hero card
or device row never draws a consumable itself.

The section collapses by its data: it starts OPEN while any item needs
attention (its kind-aware level is low, empty or full — a part to replace
reads low, a full bin or waste tank reads full) and CLOSED while every item is
ok or unknown. Closed, its header says one line: the worst item ("Salt ·
Low"), "N need attention", "All OK" (only when every item is KNOWN ok), or
"N OK · M unknown". The viewer's own toggle wins and is remembered per device
in the browser (`usePersistedDisclosure`).

Each form has one look in the shared `ConsumablesPanel`: a part is a wear bar,
its remaining time and a reset; a tank and a bin are a vertical fill gauge; a
product is a package icon, three steps and "refill" wording.

## Consequences

- A new device with consumables needs no UI work: its provider registers
  `consumables` and the section appears. Nothing in the UI names a device type.
- The notification centre reads every consumables slice item through one
  producer path and one low/normal pair (`device-consumable-*`); see **D934**
  (supersedes the tank-family split from D642 for supply/waste). Legacy
  `tank:<deviceId>:<key>` episodes close silently when the same key is observed
  as a consumable.
- The provider addons and `post-analysis` must ship together with the
  framework that carries the cap change. A new notification centre against an
  old Dreame addon sees no tanks until the Dreame addon is deployed.
- `ConsumablesPanel`, `WidgetPanel` (controlled `open`) and
  `usePersistedDisclosure` are ui-library changes: the section only collapses
  once a `@camstack/server` carrying that library is installed.
- On desktop the hero slot grows to fit the hero and the section (a cap on
  its height clipped the section behind the Logs block); the Logs block keeps
  a minimum height and the left column scrolls when both do not fit.
- The Home Assistant export loses its two disabled-by-default dishwasher
  sensors (`salt`, `rinse-aid`). The export maps flat cap fields only, and
  `consumables.items` is an array. Re-exporting them needs a per-item entity
  mint (open).
- The `vacuum-control` tank-level history series (D850) are gone. No provider
  ever reported a tank level (Dreame's library has none), so no series held
  data. The `consumables` items are recorded per item key instead (D917), and
  a leftover tank series is listed as an orphan for an admin to delete.

Rejected: keeping the tank and salt fields and teaching a shared component to
read three shapes. That keeps every new device type adding its own fields and
its own UI branch, which is the drift the operator complained about. Also
rejected: keeping a Consumables top tab (the operator asked for it on the
page, not behind a tab), and the bottom of the Overview tab (out of view on
other tabs and below the fold on a phone). A form derived only from the kind
was rejected too: a clean-water tank and a bottle of detergent are both
supplies but are not drawn alike.

## Enforcement

- `device-config-widget-hero.spec.ts` (the cap emits a hero section per
  binding).
- `hero-widgets.spec.ts` (the page derives the hero widgets from the
  aggregate, never from a device type).
- `consumables-summary.test.ts` (the attention rule and the summary line),
  `consumables-panel.test.tsx` (the collapse default, the remembered toggle,
  one look per form), `use-persisted-disclosure.test.tsx`.
- `consumables-cap.test.ts` (the form derivation), `dreame-decode.spec.ts`
  and `home-connect-domain-mapping.spec.ts` (each provider's forms).
- `vacuum-control-cap.test.ts` and `dishwasher-cap.test.ts` (the old fields
  stay gone).
- The hero specs (`vacuum-control.test.tsx`, `dishwasher-control.test.tsx`)
  assert no consumable is drawn.
- `consumable-routing.spec.ts` and `consumable-threshold-center.spec.ts` (tanks
  notify from the `consumables` slice).
