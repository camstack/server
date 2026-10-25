---
id: D924
title: A track keeps where it opened and where it closed, and a fused track spans its pieces
status: accepted
date: 2026-10-23
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/track-placement.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/track-merge.ts
---

## Context

A camera's detection session is elected per on-motion session and can hop
node or inference device between sessions (D916), so one track can be born on
the hub's NPU and last seen on an agent's Coral. The stored row named the root
model of its birth frame (D646) and nothing else: "which node and device ran
the 16:52 garage suppression?" was answered by correlating timestamps against
`inference device selection` log lines, which a log tier forgets.

Two shapes were possible for a track that L2 fused from pieces (D683): keep
every piece's placement as a list on the row, or keep the two ends.

## Decision

Every frame result carries where it was inferred: the runner's node on the
payload (`PipelineInferenceResultPayload.nodeId`), the root's inference device
on the frame (`FrameResult.rootDeviceKey`, stamped beside `rootModelId`). A
track keeps two placements, `{ nodeId, deviceKey?, modelId? }`:
`openedPlacement`, from the frame it was born on, never rewritten; and
`closedPlacement`, from its last MATCHED sighting — a coasted frame is not a
sighting and never moves it. A fused track keeps the two ENDS: opened from the
piece born first, closed from the piece seen last, decided by `firstSeen` /
`lastSeen` rather than by which piece survived. A piece with no placement never
erases the other's. The list of every piece's placement was rejected: the row
answers "where did this subject start and end", and the hops in between are
the session log's to tell. Absent is unknown — a row from before the fields,
an onboard detector (no device, no model) — and nothing renders it as a node.

## Consequences

- Two nullable JSON columns on `pipeline-analytics:tracks` (an existing table,
  D901 untouched), no index: nothing queries by placement.
- The cap `Track` carries both fields, so the read is stripped until a
  `@camstack/server` containing this `@camstack/types` is installed; the row is
  written as soon as the addons are deployed.
- A runner older than `rootDeviceKey` produces a placement with no device.

## Enforcement

`track-store-placement.spec.ts` (store, hop, coasted frame, fused-track rule),
`track-placement-wiring-e2e.spec.ts` (the payload's node reaches the row and
`getTrack`), `runpipeline-replay.spec.ts` (`rootDeviceKey` is stamped), and the
merge table's every-key check in `track-store-adopt.spec.ts`.
