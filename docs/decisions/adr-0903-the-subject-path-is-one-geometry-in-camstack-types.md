---
id: D903
title: The subject's path is one geometry, in @camstack/types, re-exported by ui-library
status: accepted
date: 2026-10-22
supersedes:
applies-to:
  - packages/types/src/geometry/subject-path.ts
  - packages/ui-library/src/lib/subject-path.ts
  - packages/addon-post-analysis/src/notification-center/notification-image.ts
  - packages/addon-admin-ui/src/components/detection-intelligence/trajectory-overlay.ts
---

## Context

The operator asked for a notification rule flag, `media.showSubjectPath`, that
draws the subject's path on the notification picture "exactly like the path the
debug view shows". Two path implementations already existed and disagreed: the
admin event detail (`trajectory-overlay.ts`) downsampled pixel positions and
drew every one, a near-full-frame motion placeholder included; the viewer's
track detail (`track-trajectory.ts`) dropped placeholders and collapsed dwells.
A third copy in the hub's image stage would have made three lines for one
track. The natural home for a shared UI utility is `@camstack/ui-library`, but
the picture is rendered by `addon-post-analysis` with `sharp`, and that addon
cannot take the ui-library bundle (React, browser-only).

## Decision

The path geometry — which positions become points (up to an instant), the
placeholder and dwell rules, downsampling, the mapping into a crop with
clipping, the SVG point string — lives once in
`packages/types/src/geometry/subject-path.ts`: pure, framework-free, exported
from the root entry and from `@camstack/types/client`. `@camstack/ui-library`
re-exports it (`src/lib/subject-path.ts`) and adds nothing. Every surface that
draws a track's path uses it; colour and stroke stay with the renderer.

## Consequences

- The notification stage and the admin event detail draw the same line; the
  admin view now also drops full-frame placeholders and collapses dwells.
- The viewer resolves `@camstack/types` from npm, so its track-detail
  trajectory can move onto the module only after a types release carries it;
  until then it keeps its own model (a follow-up, not a second design).
- A change to the path rules is a `@camstack/types` change: it reaches the hub
  with a server closure and the admin UI with its build.

## Enforcement

Review only — no guard refuses a new path implementation. The shared module is
pinned by `packages/types/src/geometry/__tests__/subject-path.spec.ts`; the
admin overlay's spec runs through it.
