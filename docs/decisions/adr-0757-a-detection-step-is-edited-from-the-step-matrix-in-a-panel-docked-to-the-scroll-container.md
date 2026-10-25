---
id: D757
title: A detection step is edited from the step matrix, in a panel docked to the scroll container
status: accepted
date: 2026-10-08
supersedes: D756
applies-to:
  - packages/ui-library/src/composites/device-step-matrix.tsx
  - packages/ui-library/src/composites/accelerator-label.ts
  - packages/ui-library/src/composites/step-inspector/**
  - packages/addon-admin-ui/src/components/pipeline/step-inspector/**
  - packages/addon-admin-ui/src/components/device/tabs/CameraStepInspector.tsx
  - packages/addon-admin-ui/src/lib/step-url-selection.ts
---

## Context

D756 replaced the step × accelerator matrix with a list + inspector,
because the matrix's settings slide-over got lost in the scrolling. It
shipped in release 1.2.476, and the operator's verdict was precise: the
**table** was what he liked, at node and at camera level. What was unusable
was the settings **detail**.

The list had cost the comparison the matrix gives at a glance: one row per
step, one column per accelerator, each cell's model, `root`, `→ iGPU`,
`⚠ skip`, `cluster` and `ovr`. A per-row chip strip and a Compare toggle were
weaker copies of it.

The slide-over failed for its anchoring, not for being a side panel:

- It was `absolute` inside the matrix block, so its title and Save scrolled
  away with the page.
- It reserved 360 px, so the matrix re-measured into its single-node layout and
  hid the clicked cell.

## Decision

**The step matrix is the page. A cell (or a step's header) opens that step's
settings in a panel docked to the page's scroll container. The panel overlays
the matrix and never reflows it, and the selected cell is kept visible beside
it.**

- **The matrix** (`DeviceStepMatrix`):
  - The interactive view on both pages: slot colours, class chips, the cell
    states, the camera's gate as a badge in the step's header.
  - Column headers name each accelerator through ONE function
    (`acceleratorLabel`, `@camstack/ui-library`), with its format, its elected
    model, and "off".
  - Switched-off accelerators are hidden behind "Show disabled accelerators".
  - Keyboard: one Tab stop (a roving tabindex over headers and cells); arrows,
    Home, End and PageUp/PageDown move it. Enter or Space opens the cell and
    focus follows into the panel. Escape on the panel or on the matrix closes
    it and returns focus to the cell.
- **The panel** (`StepDetailDock`) is `position: fixed` over the right edge of
  the nearest scroll container, with its top, bottom and right measured from
  that box. It reserves no width:
  - The matrix adds a trailing spacer as wide as the panel, so any column can
    scroll clear of it, and scrolls the selected cell into the uncovered part.
  - Where a sticky step column plus the panel leaves less than one column of
    room (the camera page beside its live view), the step column scrolls with
    the cells. Same width, nothing reflows, but no longer sticky.
  - On a phone the panel is a full-screen sheet.
- **The panel's content is D756's:**
  - Models per accelerator; cluster-scoped models read-only, with a link.
  - Settings in the layer the runtime applies (D754), with provenance and
    "Reset to <next level>".
  - "All accelerators / Only <accelerator>" on a camera.
  - Save keeps the panel open; the gate is in the header.
- **Selection.** `?step=&acc=`. The panel is open exactly while `step` is set.
  `/` filters the matrix rows by step name or field label, and Enter opens the
  first hit.

## Alternatives rejected

- **Keep D756's list + inspector.** The operator rejected it on use: it hid the
  comparison that is the reason to open the page.
- **Reserve the panel's width beside the matrix.** That is the reflow that hid
  the clicked cell under D756's predecessor. It also hands half a narrow
  content area to an empty gutter whenever the panel is closed.
- **Slim the sticky step column while the panel is open.** It changes the
  grid's widths, which is the reflow the operator ruled out. Un-sticking the
  column keeps every width and moves only the scroll.

## Consequences

- **Removed:** `StepList`, `StepInspectorLayout`, `StepChips`, the Compare
  toggle (`?compare=`) and `StepInspectorFrame`.
- **Single naming function.** Model Studio's chips, the load-balancing rows,
  the camera assignment pin and the matrix now share `acceleratorLabel` /
  `acceleratorShortLabel`. The Mac mini reads "Apple Neural Engine" / "ANE"
  everywhere — it was "Coreml All" in the matrix.
- **Narrow areas.** On the camera page the step names scroll out of view while
  a far-right column is selected. The panel's title names the step.

## Enforcement

- **`device-step-matrix-interactive.test.tsx`:** the grid's single Tab stop and
  arrow moves, cell and header activation (and whether the keyboard did it),
  `focusCell`, column headers, and the trailing spacer that leaves the column
  template untouched.
- **`accelerator-label.test.ts`:** one name per device.
- **Fake-hub specs** (`NodeStepInspector.spec`, `CameraStepInspector.spec`):
  - opening by cell and by header;
  - Escape closing and returning focus;
  - Enter moving focus into the panel;
  - the disabled-accelerators toggle;
  - the `/` filter;
  - every write.
- **Layout.** jsdom cannot measure it. It was checked with Playwright over the
  real components at 1440 × 900, 1280 × 720 and 390 × 844, opening every step
  on its rightmost accelerator. In all 72 checks: the panel header and Save
  were on screen, the clicked cell was on screen and not under the panel, the
  grid did not reflow, the page did not scroll sideways, and Escape returned
  focus to the cell. Nothing in CI re-runs that.
