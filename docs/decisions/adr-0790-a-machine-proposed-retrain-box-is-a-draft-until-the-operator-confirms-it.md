---
id: D790
title: A machine-proposed retrain box is a draft until the operator confirms it, and the pipeline's own boxes are read back, never re-run
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/retrain-pipeline-boxes.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/retrain-service.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/retrain-annotation-store.ts
  - packages/types/src/capabilities/pipeline-analytics.cap.ts
  - packages/addon-training/src/page/frames/lib/retrain-editor.ts
  - packages/addon-training/src/page/frames/**
---

## Context

The Retrain page opened every frame on an empty canvas. The only machine help
was "Propose", which re-ran a detector on the copy. On the frames an operator
picks to correct — the false alarm, the missed person — a re-run answers a
different question than the one being corrected: if the re-run is right, the
phantom the operator came to remove is not on screen at all.

The page also treated a proposal as an annotation. Proposed boxes went into
the same list as drawn ones, and Save stored all of them. A box the operator
never looked at became ground truth because they pressed Save for another box.

Three proposal sources are now coming (the live pipeline's boxes, a larger
teacher detector, a vision LLM), so the rule has to be settled once.

## Decision

**Every machine-sourced box (`source: 'pipeline' | 'assist' | 'llm'`) opens as
a DRAFT on the page and is not saved until the operator accepts or corrects
it. A confirmed box keeps its machine source, model and score as provenance.
The pipeline's boxes are derived when a frame is listed, from the track store
(the subject box recorded on the source media row, else the track positions
nearest the capture time), and are never written to the annotation table
except as a box the operator confirmed.**

- Correcting a draft (geometry, class, label, kind) confirms it. Selecting it
  does not.
- A reopened frame does not offer a pipeline box again when a saved
  annotation already sits at the same place (IoU ≥ 0.8), whatever the
  operator turned it into.
- `RetrainAnnotationSource` is `operator | assist | pipeline | llm`. Unknown
  stored values read as `operator`.

## Consequences

- `listRetrainFrames` reads the camera's tracks around each copy's capture
  time (index rows, a 30-minute `firstSeen` window). A track that started more
  than 30 minutes before the frame (a long-parked car) contributes nothing;
  the operator draws that box.
- Drafts live only in the page. Leaving a frame discards unconfirmed drafts;
  the pipeline ones come back on reopen, the assist ones need a new run.
- Old rows are unchanged: their sources were already `operator` or `assist`.

## Enforcement

`retrain-pipeline-boxes.spec.ts` (subject box before position, tolerance,
other tracks, recording stills, clamping, class tiers),
`retrain-service-pipeline-boxes.spec.ts` (listing carries the boxes; a failed
evidence read degrades, never fails), `retrain-editor.spec.ts` in the admin UI
(drafts never reach the save payload; correction confirms; no re-offer) and
`retrain-drafts.spec.tsx` (drafts painted apart, Accept only on drafts).
