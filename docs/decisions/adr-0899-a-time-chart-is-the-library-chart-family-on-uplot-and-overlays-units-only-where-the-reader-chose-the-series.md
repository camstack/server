---
id: D899
title: A time chart is the library chart family on uPlot, and it overlays units only where the reader chose the series
status: accepted
date: 2026-10-21
applies-to:
  - packages/ui-library/src/composites/charts/**
  - packages/ui-library/src/composites/device-history/**
  - packages/addon-admin-ui/src/pages/system/History.tsx
  - packages/addon-admin-ui/src/components/history/**
---

## Context

Every time chart in the product was hand-drawn inline SVG, one per surface:
the node Load tab (`LoadChart.tsx` over its own geometry module), four camera
analytics charts with a hex palette and an index-spaced x axis, the training
sparkline, and the recording timeline's event heatmap with palette classes.
Each re-solved axes, gaps, hover and colour, and they disagreed: the analytics
charts spaced points by INDEX (an outage was one bucket wide), their y ticks
printed `1, 1, 2`, and the SVGs were stretched with `preserveAspectRatio="none"`,
so axis text was squashed. device-history (D850, D896) then made every device,
node and storage series readable over a year — a dozen more charts per device,
a synced cursor and a cross-device overlay. A fifth hand-drawn variant per
surface was the failure waiting to happen.

The rule "no charting dependency, no dual axis" (`docs/ui/admin-patterns.md`)
was written for the Load tab. The operator approved replacing it on 2026-10-21.

## Decision

- Every chart over time is one of the library's chart family in
  `packages/ui-library/src/composites/charts/` — `TimeSeriesChart`,
  `StateTimeline`, `BarSeries`, `Sparkline` — drawn by uPlot (pinned exactly
  in ui-library's dependencies, loaded lazily). Radial gauges, live meters
  (waveform, VU), overlays and coverage tracks stay hand-drawn: they are not
  charts over time.
- Colour comes ONLY from the eight `--color-chart-series-*` tokens in fixed
  order (validated in both themes; a ninth series reuses a slot with a dash),
  resolved at draw time so a theme switch is a redraw. Identity is never
  colour alone: two or more series always carry a legend with values.
- The family keeps the Load tab's truths: the value axis starts at zero unless
  the unit floats (°C, dBFS), an unknown sample and a hole longer than the
  series' cadence BREAK the line and the hole is shaded, the x axis is wall
  time.
- A device page draws one chart per UNIT. Several value axes (one per unit)
  appear only on the cross-device History page, where the operator picked the
  series to overlay.
- A device's history is one component, `DeviceHistoryView`: the device page's
  History tab and, fixed at 24 h, the camera's Live Stats tab.

## Consequences

- ui-library carries a runtime dependency (uPlot, ~50 KB, a lazy chunk). A
  document without a 2D canvas (jsdom) renders the chart's DOM half — title,
  legend, values, accessible summary, bucket buttons — and no plot; specs
  assert on that half.
- The analytics widgets keep their own data (events, the audio ring) but draw
  with the family; the Live Stats tab no longer mounts the motion, audio and
  occupancy widgets — device-history's series of the same producer replace
  them. The detection histogram stays: per-class object counts are not a
  device-history series.
- "Two measures, two charts" still holds wherever the surface chose the
  series; the History page is the one place the reader overlays units, and
  each unit gets its own labelled axis.

## Enforcement

`ui:check` refuses hex, palette classes and inline colour in the touched
files; the family's pure halves are specced (`charts/__tests__`,
`device-history/__tests__`). Choosing the family over a new hand-drawn chart is
review only.
