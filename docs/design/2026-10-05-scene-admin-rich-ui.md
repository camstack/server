---
title: Scene admin UI — finish plan
status: proposed
date: 2026-10-05
covers:
  - packages/addon-post-analysis/src/pipeline-analytics/scene/**
  - packages/addon-admin-ui/src/pages/Scenes.tsx
  - packages/ui-library/src/composites/**/Scene*
---

# Scene — resume and rich Admin UI

Scene lives in `@camstack/addon-post-analysis` as cap `scene-monitor` (no
separate addon). Admin route: `/scenes`. Design history:
`docs/design/scene-state-analysis.md`. Architecture page still missing —
queue `docs/architecture/scene-monitor.md`. <!-- drift-ok -->

## Gaps that make the UI feel thin

1. **CLIP encode path** — image leg still fragile post-D209 (sessions history).
2. **`check.mode: 'llm'`** — declared in settings, not wired through
   `buildSceneMonitor`.
3. **List page** — no fleet filters, no Reset/Recheck in-row, no confidence /
   last-checked columns, weak empty/error states.
4. **Editor** — no side-by-side live vs reference; advanced confirm /
   `anchorThreshold` not exposed; multi-state / text prompts underused.
5. **Viewer / HA** — gallery `sceneFrame` and dynamic HA mint still open.

## Phased plan

### A — Stabilize (P0)

- Fix CLIP encode for scene image checks (or document supported formats).
- Smoke: create → capture reference → latch → NC gate → reset.
- Write `docs/architecture/scene-monitor.md`. <!-- drift-ok -->

### B — Rich Admin without new backend (P1)

- Fleet KPI strip (latched / unknown / unreachable / suspended).
- Filters + search on `/scenes`.
- Row actions: Reset, Recheck (existing cap methods).
- Columns: `lastConfidence`, `lastCheckedAt`, suspended reason.
- Editor: side-by-side crop vs reference; expose `anchorThreshold` + confirm
  advanced fields already on the cap.
- Optional history drawer on `EnrichmentSceneStateChanged`.

### C — Model decisions (P2)

- Either wire `scene-llm-adapter` for `check.mode: 'llm'` or drop the mode from
  the form (do not leave a dead control).
- Multi-state UI only with a named operator use-case.

### D — Surfaces outside Admin (P3)

- Viewer gallery `sceneFrame`.
- HA entity mint.
- NC pattern docs: `onTrigger → resetScene`.

## Success criteria for "UI ricca"

An operator can triage the whole fleet on one screen, open one scene, see why
it latched (confidence + reference vs now), and Reset/Recheck without leaving
the page — with loading / empty / error states that never look like "not
installed".
