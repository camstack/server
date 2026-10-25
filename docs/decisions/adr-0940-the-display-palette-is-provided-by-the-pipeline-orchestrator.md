---
id: D940
title: The display palette is provided by the pipeline orchestrator
status: accepted
date: 2026-10-25
supersedes:
applies-to:
  - packages/addon-pipeline-orchestrator/src/display-palette-provider.ts
  - packages/addon-pipeline-orchestrator/src/__tests__/display-palette-provider.spec.ts
  - packages/addon-pipeline-orchestrator/package.json
  - packages/system/package.json
  - packages/system/vite.config.ts
---

## Context

D939 made the display palette one hub capability and refused to treat a
failed settings read as the bundled preset. The provider was a new system
builtin, `display-palette`. That process never came up: `onInitialize` did
not call `super({})`, so the addon crashed before it could write a settings
row. No palette was ever stored, so there is nothing to migrate.

The palette is one cluster-wide setting. The pipeline orchestrator already
owns that class of setting, on Pipeline → Cluster, and it is already a
hub-only process. A second addon would be a second process for a settings
read.

## Decision

`pipeline-orchestrator` provides `display-palette`. Behavioural metadata
stays in `display-palette.cap.ts` (D4). The palette document is the
`displayPalette` key of the orchestrator's addon settings store — the store
is shared with the orchestrator's other settings, so the document is not the
whole row. Read and write semantics stay D939's: an unreadable store is
`unknown`, an absent key is the bundled CamStack preset named
`unconfigured`, and `setPalette` refuses by naming the pairs. The builtin is
deleted. There is no compatibility shim.

## Consequences

One fewer hub process. Admin, post-analysis and the viewer keep the same
cap contract. A palette write does not replace `nodeBindings` or any other
key in the orchestrator's store. D939's colour contract is unchanged; this
record only moves the provider.

## Enforcement

`packages/addon-pipeline-orchestrator/src/__tests__/display-palette-provider.spec.ts`
(get, set, listPresets; an unreadable store is `unknown`; a refusal names
the pairs; a sibling key survives). `npx tsx scripts/check-addon-calls-super.ts`
stays green: the orchestrator already calls `super`.
