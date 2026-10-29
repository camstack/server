---
id: D973
title: Remote layout components are data; the UI draws them from closed vocabularies
status: accepted
date: 2026-10-29
supersedes:
applies-to:
  - packages/types/src/remote/**
  - packages/types/src/capabilities/remote-layout-components.cap.ts
  - packages/system/src/builtins/core-blocks/remote-components-service.ts
---

## Context

The `remote` template kind (D963) was a flat grid of identical rectangular
keys. A real remote has a ring around its D-pad, a rocker for volume, a
colour-key row, a keypad, titled sections. Hard-coding each of those as UI would
make every new control a UI release, and letting an addon ship UI code for a
palette entry would put third-party code in the admin page.

## Decision

1. A **component** is declarative data (`RemoteLayoutComponentSchema`): a
   namespaced id (`core:dpad`, `<addonId>:<name>`), a size, buttons placed
   relative to it, and an optional group frame. It carries no UI code.
2. Look is a name from a **closed vocabulary** the UI knows how to draw: button
   `shape` (`rect|rounded|round|pill`), `tone` (`neutral|accent|danger|red|green|yellow|blue`),
   group `frame` (`none|panel|divider|dpad|rocker-v|rocker-h|keypad`). A layout
   never carries a style. Growing a vocabulary is a UI change; using it is data.
3. A layout may carry **groups** (rectangle, frame, title). A group and its
   member buttons move, and are removed, **atomically** (`moveGroup`,
   `removeGroup`, `ungroup`). The schema refuses a member outside its group, a
   key inside a group it does not belong to, overlapping groups, and a divider
   with members. Every new field is optional: old payloads parse and render
   unchanged.
4. Components are contributed through the **`remote-layout-components`
   collection cap** (`listComponents`, read-only). core-blocks provides the
   built-in `core:*` set; any addon may add its own. The reader dedupes by id,
   built-ins first. Presets are composed from the same built-ins with the pure
   `insertComponent`, shared by editor, presets and server.

## Consequences

An addon cannot invent a frame, shape or tone; it picks one. A UI that meets a
value it does not know must fall back to the plain look, not fail. The pure
helpers live in `@camstack/types`, so a refusal reason (`outside`, `overlap`,
`unknown-group`, `too-many`) is the same everywhere. A cap change ships with a
force-publish of `@camstack/system` and `@camstack/server`.

## Enforcement

Specs: `remote-layout-groups.spec.ts`, `remote-layout-ops.spec.ts`,
`remote-components-service.spec.ts`; every built-in component and every preset
is parsed by the schemas; codegen's capability guards cover the cap.
