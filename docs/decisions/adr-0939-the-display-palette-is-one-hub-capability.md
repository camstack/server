---
id: D939
title: The display palette is one hub capability, and a failed read is not the default
status: accepted
date: 2026-10-25
supersedes:
applies-to:
  - packages/types/src/catalogs/display-palette.ts
  - packages/types/src/catalogs/palette-cie.ts
  - packages/types/src/catalogs/palette-legend.ts
  - packages/addon-admin-ui/src/components/pipeline/tabs/palette-legend.tsx
  - packages/types/src/catalogs/event-taxonomy.ts
  - packages/types/src/capabilities/display-palette.cap.ts
  - packages/addon-pipeline-orchestrator/src/display-palette-provider.ts
  - packages/addon-admin-ui/src/components/pipeline/tabs/ClusterPaletteTab.tsx
---

## Context

Kind colours lived in `EVENT_TAXONOMY` (and, before that, in four copies). The
viewer had already packed a second table — one colour per mark, the same in
dark and light — because the taxonomy greens and ambers failed 3:1 on
`#fafaf9`. A cluster cannot change either table, and a server-drawn box still
used one accent for every class.

Rejected: a per-theme pair (two colours for one kind), a per-camera palette
(the legend would disagree with the picture the hub drew), and treating an
unreadable settings row as the CamStack preset (D393, D651: a failed read is
not the default).

## Decision

One palette for the product, served by the hub-only system singleton
`display-palette`. `getPalette` returns the effective palette (`presetId`,
every entry as `{ form: 'solid', hex }` or the audio `{ form: 'gradient', hex,
alphas }`, plus `fallbacks`) or `{ status: 'unknown', reason }` when the
settings store cannot be read or the stored blob does not parse. An empty
store is `status: 'ready', source: 'unconfigured'` — the bundled CamStack
preset, named as such. `setPalette({ presetId } | { presetId, overrides })`
refuses, naming the pairs, when two entries are closer than ΔE2000 7 or any
entry is below 3:1 on either theme background (`#0c0a09`, `#fafaf9`). The
live cursor and the heatmap handle must also clear ΔE2000 20 against each
other: they sit next to each other as small swatches, and ΔE 7 still lets
two olives read as one (CamStack `#8d7a00` vs `#715c1d` was 12.8 on the same
hue). The global floor stays 7. The closest pair in each preset is CamStack
7.30, high contrast 7.49, colour-blind safe 7.01, so a higher global floor
would refuse the tables. The CamStack heatmap handle is `#4b32ff`, a violet,
so it does not read as the live cursor. The same function validates in admin
while editing. The Palette tab names every swatch (label and hex) on both
grounds; subclasses stay in a collapsed group under their parent. Audio
leaves (`audio-*`) are the one audio gradient, not extra colours. Taxonomy
keeps kinds, parents and icons; the colour on an entry is the bundled
preset, not a second table.

## Consequences

Consumers that need the cluster choice call `getPalette`. On `unknown` they
paint the bundled CamStack preset and say so. `getPalette` and `listPresets`
are labelled `viewer` so the viewer app can call them; `setPalette` stays
admin. The viewer (phase 2) consumes this output shape unchanged. A custom
palette cannot store a pair the validator rejected.

## Enforcement

`packages/types/src/catalogs/__tests__/display-palette.spec.ts` (every preset
passes; a close pair is named; an unreadable store is `unknown`, not the
bundled preset) and
`packages/addon-post-analysis/src/shared/__tests__/display-palette-painter.spec.ts`
(an unknown read is logged once and still paints the bundled preset).
