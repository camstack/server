---
id: D534
title: A grid publishes the rungs the operator chose, and high is not one by default
status: accepted
date: 2026-09-18
supersedes:
applies-to:
  - packages/system/src/builtins/camera-grid/grid-instances.ts
  - packages/system/src/builtins/camera-grid/grid-profiles.ts
  - packages/ui-library/src/composites/cap-settings/CameraGridLayoutEditor.tsx
---

## Context

D532 made a grid publish all three profiles, each 1:1 with its sources. That is
the right shape, and it has a consequence the operator met immediately: a grid's
`high` is composed of its sources' `high`, so on this fleet it is a 4K canvas
built from two 4K decodes. A viewer's adaptive climbs to the best rung it can
see, so every client reached for it whether or not the hub wanted to serve it.

The operator asked for the rungs to be configurable, defaulting to `low` and
`mid`.

## Decision

A grid carries `publishedProfiles`, defaulting to `['mid', 'low']`. A profile
outside it is still SIZED and still reported — the editor shows what it would
come out as — but it is not offered to the broker and no session is built for
it.

The default lives in the persisted schema rather than at a call site, so a grid
written before this starts publishing the two cheap rungs without anyone
touching it.

## Consequences

**`offered` and `published` are different questions, and the editor shows both.**
A row reads `3840x2160 — serviceable, not published` with its checkbox off, so
turning `high` on is a decision made with the number in view rather than a
surprise discovered in a CPU graph.

**Only a serviceable profile can be toggled.** The checkbox says what this grid
publishes, never what its cameras can do — a profile one source cannot serve
stays disabled, with the source named.

**`high` remains available and is expected to work** (D533 removed the restart
loop that made it look broken); it is simply not something a client should be
handed by climbing.

## Enforcement

`grid-profiles.spec.ts` pins that an unpublished profile is still sized and
reported; `camera-grid-layout.spec.ts` pins that an older hub's silence reads as
published, and that `offered` and `published` stay distinct.
