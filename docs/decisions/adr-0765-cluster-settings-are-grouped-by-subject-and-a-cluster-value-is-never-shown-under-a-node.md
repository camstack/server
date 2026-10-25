---
id: D765
title: Cluster settings are grouped by subject, and a value stored for the cluster is never shown under a node's name
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/addon-admin-ui/src/components/pipeline/tabs/ClusterSettingsTab.tsx
  - packages/addon-admin-ui/src/components/pipeline/tabs/cluster-settings-sections.ts
  - packages/addon-admin-ui/src/lib/settings-section-shape.ts
  - packages/addon-admin-ui/src/components/settings/NodeAddonsSettingsPanel.tsx
  - packages/addon-admin-ui/src/components/pipeline/NodeDetail.tsx
---

## Context

Pipeline → Cluster → Settings rendered the orchestrator's sections in schema
order and the face-gallery cap's section after them: the face encoder at the
top, the face-matching knobs at the bottom, help texts written for whoever
built the feature. Three "min face size" settings looked like one setting
three times.

The node page rendered every field of its addons under the node's name. The
runner tuning (`pipeline-runner`) and the audio backend (`audio-analyzer`) are
not `perNode`: one bare key that every node's runtime reads. A save on the Mac
mini's page changed the hub too (audit B7, the D266 failure again).

## Decision

1. **Cluster → Settings is one titled card per subject**
   (`cluster-settings-sections.ts`): Faces & recognition, Semantic search,
   Enrichment crop, Full-resolution crops, Runner defaults, Failover. A card
   may draw fields from several addons. Grouping is only where a field is
   DRAWN (`NodeAddonsSettingsPanel` `fieldKeys` / `hideSectionChrome`): each
   key is still saved by its owning addon, so the layout does not depend on
   which addon version is deployed.
2. **The cluster-scoped encoders (face, CLIP) are edited only in Cluster →
   Settings** (D651 cluster rows). The step matrix shows them read-only and
   links to their card (`clusterStepSettingsHref`). No other editor exists.
3. **A node's page renders only `perNode` fields** (`fieldScope="perNode"`).
   A value the runtime reads once for the cluster is shown on Cluster →
   Settings as a cluster value. Per key, by what the runtime reads: runner
   tuning and the audio backend → Runner defaults; decoder hwaccel, the probed
   backends and the inference executor stay on the node.
4. **The three face-size floors stay three keys.** They are three gates in
   two pixel spaces: embed (detection frame, runner,
   `clusterStepSetting:face-embedding:minLandmarkFaceSize`), keep and
   auto-assign (native, post-analysis `minFacePx`, `recognitionMinFacePx`).
   Merging them would change what runs on deploy; they are labelled "to
   embed / to keep / to auto-assign" instead.

## Consequences

- No stored key moves and nothing is migrated.
- The audio backend is offered with the hub's platform choices on the cluster
  card; "Auto" still picks Apple SoundAnalysis on a Mac.
- The detection pipeline's "Model substitutions" readout is not `perNode`, so
  the node page no longer shows it; the step matrix shows a substitution per
  cell. (The readout read the hub's provider for every node.)
- `?section=cluster-step-models` lands on Faces & recognition.

## Enforcement

- `cluster-settings-tab.spec.tsx`: the card order, the face card holding the
  encoder + floor + face-gallery knobs, every cluster-scoped key drawn exactly
  once, runner and audio panels in `cluster` scope.
- `node-detail.spec.tsx`: the node page's `perNode` scope and the merged
  engine tab.
- `settings-section-shape.spec.ts` for the regrouping helper;
  `settings-surface-scope.spec.ts` (D266) for the other surfaces.
