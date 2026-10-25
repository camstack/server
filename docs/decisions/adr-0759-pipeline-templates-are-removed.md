---
id: D759
title: Pipeline templates are removed — a camera's pipeline is its node's base plus its own overrides, never a preset
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/types/src/capabilities/pipeline-orchestrator.cap.ts
  - packages/types/src/capabilities/pipeline-executor.cap.ts
  - packages/addon-pipeline-orchestrator/src/pipeline-settings-store.ts
  - packages/addon-pipeline/src/detection-pipeline/provider.ts
  - packages/addon-admin-ui/src/components/pipeline/ClusterDetail.tsx
  - packages/ui-library/src/composites/pipeline-builder.tsx
  - packages/addon-benchmark/src/tabs/ImageTab.tsx
---

## Context

Two template libraries existed side by side:

- `pipelineOrchestrator.{list,save,update,delete}Template`, stored as the
  orchestrator's durable `templates` blob and shown on Pipeline → Cluster →
  Templates;
- `pipelineExecutor.{list,save,update,delete}Template`, stored under the
  `pipelineTemplates` key of the `detection-pipeline` addon settings row.

An audit found that neither could be used any more. The Cluster tab could only
rename or delete; its empty state pointed at a "Save as template" button that
no longer existed, because the only save path (the `pipeline-editor` settings
field) is no longer emitted. Nothing applied a template to a camera: the
orchestrator resolves a camera's pipeline from the node's per-device base and
the camera's own overrides (`resolvePipelineForDevice`), and no code path reads
`templates` while doing so. The only remaining writer was the Benchmark Image
Tester's save/load bar, a scratch-pad that saved presets nothing else read. The
executor library had no UI caller at all. The live hub holds no templates.

The operator never used them.

## Decision

Pipeline templates do not exist. Both caps lose their four template methods,
the template schemas and types are deleted from `@camstack/types`, the
orchestrator's store handle and the executor's key handling go, the Cluster →
Templates tab goes (a stale `?ctab=templates` link lands on Assignments), and
`PipelineBuilder` no longer renders a template bar. A camera's pipeline is the
node's per-device base plus the camera's overrides — there is no third layer.

Stored data is left alone: the orchestrator's `templates` blob and the
`pipelineTemplates` key are neither read, written nor swept. Removing the code
changes no running pipeline, because no running pipeline was ever resolved
from a template.

## Alternatives rejected

- **Repair the save path.** Re-adding a "Save as template" control would bring
  back a third configuration layer next to the node base and the camera
  override (D754), with no request for it.
- **Delete the stored rows.** A one-shot sweep (`RETIRED_SETTINGS_KEYS`) is
  cheap, but it is a data change the operator did not ask for, and the rows are
  inert.

## Consequences

- Eight methods leave the method-tier baseline. The `osdManager` templates (OSD
  text parsers) are a different feature and stay.
- A client built against the old caps calling `listTemplates` gets a
  not-found procedure. The hub-served viewer embed bundle still contains the
  generated hook for it until its next build; the viewer never calls it.

## Enforcement

`packages/types/src/capabilities/__tests__/no-pipeline-templates.spec.ts` fails
if either cap grows a template method or exports a `PipelineTemplate*` schema;
`cluster-detail-tabs.spec.tsx` fails if a Templates tab returns. The
method-tier guard fails on any new method until it is recorded.
