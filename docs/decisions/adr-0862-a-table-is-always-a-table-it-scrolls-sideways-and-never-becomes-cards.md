---
id: D862
title: A table is always a table — it scrolls sideways and never becomes cards
status: accepted
date: 2026-10-17
supersedes:
applies-to:
  - packages/ui-library/src/composites/data-table.tsx
---

## Context

`DataTable` could swap to a stack of cards below the phone breakpoint
(`mobileMode` `auto` / `cards`). The operator met it on Certificates -> Nodes
and on Zones in a narrow window and on an iPad, while Rules and Targets kept
their table and scrolled. Two renderings of one list meant the same data
changed shape with the window width and lost the column alignment every
per-column question depends on.

## Decision

`DataTable` renders a `<table>` at every width. A narrow viewport scrolls it
horizontally inside its own container; the page body never moves sideways.
There is no card renderer, no `mobileMode` prop and no layout resolver.

## Consequences

- The card path, `resolveTableLayout`, `CARD_MODE_MIN_COLUMNS` and the unused
  tanstack `composites/data-table/` variant are deleted.
- A wide list is read by scrolling; if a surface genuinely needs a different
  phone shape it is a different component, designed with the operator.

## Enforcement

`data-table-narrow.test.tsx` asserts a table (and no card) at phone width.
