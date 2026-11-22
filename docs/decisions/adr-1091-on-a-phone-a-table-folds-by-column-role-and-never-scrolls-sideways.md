---
id: D1091
title: On a phone a table folds by column role and never scrolls sideways
status: accepted
date: 2026-11-22
supersedes:
amends: D862
applies-to:
  - packages/ui-library/src/composites/data-table.tsx
  - packages/ui-library/src/primitives/swipe-actions.tsx
  - packages/ui-library/src/composites/page-actions.tsx
  - scripts/check-table-mobile-roles.ts
---

## Context

[D862](adr-0862-a-table-is-always-a-table-it-scrolls-sideways-and-never-becomes-cards.md)
kept every table a table and let it scroll sideways inside its own box. On a
390 px phone that left the identifying column and the main control on opposite
sides of a scroll, and device rows ran two or three lines tall. The first
attempt hid cells with CSS (`hidden sm:table-cell` on a duplicate cell); 66
specs broke because both copies stayed mounted and queries found each twice.

## Decision

Under 640 px a `DataTable` folds by the role every column declares
(`DataColumn.mobile`: `primary | keep | detail | hidden`). Only `primary` and
`keep` columns are mounted; `detail` columns become one muted second line under
the primary cell; `hidden` ones are not mounted. The fold is done in markup
through `useIsPhone()`, never with CSS-hidden duplicates. A phone table has no
sideways scroll, is not turned into cards, and its rows are at most 64 px.
A device row carries its full title, one main control and its status; the
actions live in a swipe tray (`SwipeActions`: the most important action first,
then Open, Delete, the rest; the first row peeks once). A page header's
secondary actions collapse into ONE "More" menu (`PageActions`). Desktop is
unchanged, and D862 still holds above 640 px.

## Consequences

Every new `DataColumn` states its phone role. A cell that must stay on a phone
has to fit beside the primary one in 390 px (a column header can become an
icon). One documented exception: a table inside a form field that owns its
scroller (`ObjectArrayField`) and a wrapping log line (`LogStream`) may exceed
64 px.

## Enforcement

`scripts/check-table-mobile-roles.ts` fails a `DataColumn` without `mobile`.
`npm run ui:shots` measures the tallest row on a phone shot (flagged above
64 px) and the table's horizontal overflow.
