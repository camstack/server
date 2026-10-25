---
id: D764
title: The step settings panel is about the clicked cell, and a row header opens the step itself
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/ui-library/src/composites/step-inspector/step-inspector-panel.tsx
  - packages/addon-admin-ui/src/components/pipeline/step-inspector/**
  - packages/addon-admin-ui/src/components/device/tabs/CameraStepInspector.tsx
  - packages/addon-admin-ui/src/lib/step-url-selection.ts
  - packages/addon-admin-ui/src/hooks/useStepUrlSelection.ts
---

## Context

D757 made the step matrix the page and opened a cell's settings in a docked
panel, but kept D756's panel content: accelerator tabs at the top, a model
list for every accelerator, and on a camera an "All accelerators / Only
<accelerator>" switch in the settings header. The operator clicked ONE cell
(one accelerator) and got a panel about all of them: the model he could
change might not be the clicked accelerator's, the tabs moved the "viewed"
accelerator away from the cell, and the camera's layer switch sat far from
Save, so it was easy to save to a layer he had not meant. A row header opened
"the step on the current accelerator", which was whichever came first.

## Decision

The panel is about exactly what was clicked.

- **A cell** opens `(step, accelerator)`: the title is "<Step> · <node> ·
  <accelerator>", the model section is that accelerator's model alone (change,
  reset, and on a node "Run on"), then the settings as they run there.
- **A row header** (or a search hit) opens the step itself: "<Step> · <node>"
  or "<Step> · this camera", the models of every accelerator listed read-only
  (a model is changed from its cell), then the node-wide or camera-wide
  settings.
- On a node, settings are node-wide (unchanged, D210/D754) and the panel says
  so in one line.
- On a camera cell, "Applies to: This accelerator / All accelerators of this
  camera" is drawn beside Save (`saveBar.scope`). It opens on "This
  accelerator" when the camera already overrides settings there, else on the
  camera-wide layer (D754's default). The step view edits only the camera
  layer and says so. Field provenance is unchanged.
- `?acc=` is never guessed: no accelerator, or one the page does not show, is
  the step view; opening a step without one clears a stale `acc`.

## Consequences

- `AcceleratorTabs` and `StepModelList` are deleted from the library.
- Comparing models across accelerators is the matrix's job (it already shows
  each cell's model); the panel no longer duplicates it.
- Changing two accelerators' models is two cell visits; the draft of a step is
  kept while moving between its cells, as before.

## Enforcement

- `NodeStepInspector.spec`: a cell's title names the accelerator, one model
  row, no accelerator tablist, the node-wide line; a header opens the step with
  read-only models and drops `acc`.
- `CameraStepInspector.spec`: the cell title and single model row, the
  "Applies to" control beside Save and its default, and that "This accelerator"
  writes only that accelerator's override.
- `step-url-selection.spec`: no guessed accelerator.
- Layout (Playwright over the real components, scratch harness): every step on
  its rightmost cell AND on its header, 1440/1280/390, node and camera pages —
  heading and Save on screen, no reflow, no sideways scroll, Escape closes.
  Nothing in CI re-runs it.
