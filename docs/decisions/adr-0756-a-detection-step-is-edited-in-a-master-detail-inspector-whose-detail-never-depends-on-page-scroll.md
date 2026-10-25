---
id: D756
title: A detection step is edited in a master–detail inspector whose detail never depends on page scroll
status: superseded
date: 2026-10-08
supersedes:
applies-to:
  - packages/ui-library/src/composites/step-inspector/**
  - packages/ui-library/src/composites/device-step-matrix.tsx
  - packages/addon-admin-ui/src/components/pipeline/step-inspector/**
  - packages/addon-admin-ui/src/components/device/tabs/CameraStepInspector.tsx
  - packages/addon-admin-ui/src/lib/step-url-selection.ts
---

## Context

A node's detection pipeline (Pipeline → node → Pipeline) and a camera's
(Detection pipeline → Steps) were each edited in a steps × accelerators
matrix. A click on a cell opened `SlideOverPanel`, which was absolutely
positioned inside the matrix block. That block lives in the page's scroll
container.

The operator's report was "very nice-looking, but very clunky; the settings
panel gets lost in the scrolling". Measured on a harness built from this hub's
real catalog, devices and camera 101:

- **The panel was pinned to the matrix block, not the screen.** Its title was
  the matrix's top and its Save button the matrix's bottom. Save sat 417–961 px
  below the fold. On a 1280 × 720 laptop, clicking the last step put the
  panel's title 274 px above the screen.
- **Opening the panel hid the cell that was clicked.** The panel reserved
  360 px, so the matrix re-measured and collapsed to its single-node layout.
  The clicked cell ended under the panel in every desktop and laptop run.
- **Every edit cost scrolling.** Raising one camera's person floor on all four
  accelerators took 9–11 clicks, 15 keys, 11 scrolls and 7.4–9.4 k px.
- **The keyboard could not reach the editor.** It took 45–53 Tab presses.
- **Save lost the context.** It closed the panel, dropped the selection and
  sent focus to `<body>`.
- **Nothing was linkable.** The selection was component state.

FaceDetailPanel had already left `SlideOverPanel` for the same anchoring
reason.

## Decision

**A detection step is edited in a master–detail inspector. The step list and
the inspector each own their scroll, inside a block sized to the page's
scroll container. The inspector's header and save bar are never off screen,
and the selection lives in the URL.**

- **The list** (`StepList`):
  - One row per step, child steps indented.
  - Each row carries the camera's gate and one chip per accelerator. Chips that
    run the same model fold into "model × N".
  - It is a listbox with a roving tabindex: one Tab stop, ↑/↓/Home/End move,
    Enter or → focuses the inspector, Escape there returns to the row.
  - `/` opens a search over step names and field labels. A cluster-owned knob
    is found too, and its step links to Cluster → Settings → Enrichment models.
- **The inspector** (`StepInspectorPanel`):
  - Pinned header: the step, the camera gate, and the accelerator a value is
    viewed on.
  - One scrolling body, then a pinned save bar. Save does not close anything.
  - Models are shown per accelerator (`StepModelList`). While nothing is
    pinned or edited they are summarised by model, behind "Per accelerator".
  - Settings are shown in the layer the runtime applies them (D754):
    node-wide on a node, camera-wide by default on a camera. Each field shows
    its value, the layer it comes from and the levels below it, with a reset to
    the next level.
- **Selection.** `?step=&acc=&compare=` (`step-url-selection.ts`), with
  `replace` and every other param kept. The node page keeps its tab in
  `?ntab=`, the cluster page in `?ctab=` (and `?section=` scrolls to a
  settings section).
- **Phone.** The list flows with the page, and the inspector is a full-screen
  `Dialog` sheet with "‹ Steps".
- **Compare.** The matrix survives as a READ-ONLY "Compare accelerators" view
  (`DeviceStepMatrix`, no gate, no editor). A cell selects that step in the
  inspector.
- **Cluster-scoped models are read-only.** Face and CLIP embedding are shown
  with a link to the one place they are edited; the inspector is never a second
  editor of that row.

## Alternatives rejected

- **Inline accordion under the clicked row.** Its sticky header and save bar
  would need the matrix to stop being a horizontally scrolling box. A long form
  also pushes the rest of the tree away, which breaks comparing steps.
- **Keep the matrix and pin the drawer to the viewport.** This fixes the
  literal complaint and nothing else. It keeps the per-column edits, the hidden
  node value behind an override, and a grid the keyboard cannot use.

## Consequences

- **Removed.** These had no consumer left, or never had one in production:
  - `SlideOverPanel`, `PipelineTreeMatrix`, `StepTreeMaster`;
  - `PipelineEditorField` with its `pipeline-editor` field type,
    `AsyncResolverRef`, `useFieldResolver` and `useAgentsList` (nothing had
    emitted that field since the L2.5 redesign);
  - the `PipelineStep` / `PipelineBuilder` three-state and Auto props that only
    it used;
  - the hidden batch-assign mode of the node tab;
  - the node tab's accelerator card, which lives in Cluster → Load balancing.
- **`AgentStepEditor` is single-accelerator now.** It is node-level only, built
  on the same `LayeredSettingsForm`. Model Studio's settings dialog keeps using
  it.
- **Measured after.** Every task from the Context costs 0 scrolls on a
  1440 × 900 desktop and at most one on a laptop or phone.
- **The model summary has a cost.** Changing one accelerator's model now takes
  one click more ("Per accelerator") while all accelerators agree. That click
  is what keeps the settings, the more frequent edit, in view.

## Enforcement

- **Unit specs** (ui-library `step-inspector/__tests__`):
  - the listbox keyboard model and search;
  - field-level writes; an edit that copies the merged view fails;
  - provenance and reset;
  - model folding;
  - panel chrome.
- **Fake-hub specs** (admin-ui `NodeStepInspector.spec`,
  `CameraStepInspector.spec`):
  - the writes each action makes;
  - that Save keeps the selection;
  - the deep link;
  - the read-only cluster model.
- **Layout.** jsdom cannot measure it. It was checked with Playwright on a
  harness over the real components, at 1440 × 900, 1280 × 720 and 390 × 844:
  for every step the header, the Save button and the selected row are on
  screen, nothing scrolls sideways, and the list does not resize. Nothing in CI
  re-runs that; `docs/architecture/ui.md` records the recipe.
