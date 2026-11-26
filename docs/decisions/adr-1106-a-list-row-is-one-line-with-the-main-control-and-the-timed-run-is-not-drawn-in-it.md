---
id: D1106
title: A list row is one line with the kind's main control; the timed run is not drawn in it
status: accepted
date: 2026-11-26
supersedes:
applies-to:
  - packages/ui-library/src/composites/device-item/actions.tsx
  - packages/ui-library/src/composites/device-controls/timed-run-row-control.tsx
---

## Context

D1027 made the device row draw the timed run (Run / Stop) from the hero slot,
and D1097 then bound the cap to every device with a `switch`. Together every
switch child row gained a third item. On a phone the Dreame children (Carpet
Boost, Auto Drying …) wrapped into three lines: name and toggle, then
`15 min Run`, then the open arrow and status dot. A list is scanned, not
operated; a row that is three lines tall for one toggle is not scannable.

## Decision

A device list row is ONE line and draws only the kind's main control (a
switch row: the toggle). A secondary control is never drawn inline in a row,
for any kind: the timed run lives in the device page and the quick detail
(the hero slot, D1023). The phone swipe tray keeps it as its `lead` action, off
the row's line. This record amends the row part of D1027 (it does not supersede it): the row no longer draws Run or
Stop, and a container row does not draw its primary child's either; the hero
slot stays the only source of a deadline, and the status line still ends with
the time left. D993 (the cap, its limits, the deadline row) and D1097 (where
it binds) are unchanged.

## Consequences

Starting a run from a list needs one tap more (open the row, or swipe on a
phone). A future secondary control for a kind goes to the detail, not the row.

## Enforcement

`device-item/__tests__/row-one-main-control.test.tsx`: no timed run inline in
a switch or light row (wide and narrow) nor in a container row; the tray's
`lead` part still draws it.
