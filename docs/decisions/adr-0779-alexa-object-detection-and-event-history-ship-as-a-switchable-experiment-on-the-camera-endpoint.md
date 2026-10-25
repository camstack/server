---
id: D779
title: Alexa object detection and event history ship as a switchable experiment on the camera endpoint, fed by pipeline tracks
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/addon-export-alexa/src/vision/**
  - packages/addon-export-alexa/src/handlers/data-controller.ts
  - packages/addon-export-alexa/src/endpoints/builder.ts
  - packages/addon-export-alexa/src/endpoints/validate-endpoint.ts
  - packages/addon-export-alexa/src/lwa-event-gateway.ts
  - packages/addon-export-alexa/src/sync-engine.ts
---

## Context

R4 (`docs/design/2026-10-08-alexa-object-detection-and-event-history.md`) was
left unbuilt because Amazon lists `Alexa.SmartVision.ObjectDetectionSensor`
and `Alexa.DataController` for en-US only, and the operator's account is it-IT
on the EU endpoint. The operator wants to find out empirically whether an
Italian Echo, or an Echo switched to English (US) on the Italian account, does
anything with them.

Two earlier failures shaped the build. A SmartVision declaration that also
claimed a retrievable property ReportState never answered made Alexa reject the
camera and every child sent beside it. And the gateway used to post a `person`
ObjectDetection for every firmware motion edge — 223 posts in 11 minutes on one
camera, all accepted (202) and all discarded, because no endpoint declared the
interface.

## Decision

- The CAMERA endpoint declares, while the feature is on for it,
  `Alexa.SmartVision.ObjectDetectionSensor` 1.0 with
  `objectDetectionConfiguration` `person` (+ `package` where the pipeline
  produces it) and no properties, and `Alexa.DataController` 1.0, instance
  `Camera.SmartVisionData`, target that sensor, schema `JSON/SmartVisionData`,
  access `BY_IDENTIFIER` + `BY_TIMESTAMP_RANGE` — Amazon's documented example.
  The validator encodes both interfaces' rules.
- Events come from the pipeline's track lifecycle only, mapped like the
  detection sensors: one per (track, class), `objectIdentifier` a UUIDv5 of the
  track under a per-hub namespace, `eventIdentifier` a version-4 UUID whose bits
  are a hash of the track and class (so the history hands Alexa the same id
  without a lookup table), at least 30 s between events for one object. Camera
  motion never posts one. The gateway posts only when the camera's exported
  signature declares the interface.
- Images are lazy signed URLs on the R2 route (ten minutes, account-link token,
  410 when gone): the pixels are read only when Alexa fetches them — the
  track's clean key frame and best-shot crop, or, within a minute of a live
  event, the camera snapshot. The Snapshots switch off means no URIs at all.
- `SetObjectDetectionClasses` is persisted per camera; a class turned off is
  neither posted nor listed. `ReportData` reads `listRecentTracks`, newest
  first, 10 per page with an opaque cursor, URIs minted afresh per read.
  `DeleteData` hides events from Alexa only. All three need `view`.
- Default ON for every exposed camera. One integration switch
  (`objectDetection`) and a per-camera toggle (per-device store
  `alexaObjectDetection`) turn it off; the change re-pushes the camera without
  the two interfaces.
- A camera that declares the interface is pushed in its OWN AddOrUpdateReport,
  and every pushed endpoint logs the gateway's answer and its interfaces, so a
  rejection costs only that endpoint and is readable in the hub log.

## Consequences

- On deploy every exposed camera is re-pushed once (shape change). If Amazon
  rejects the shape for a non-US account, the cameras disappear from the Alexa
  app until the switch is turned off and a re-sync runs — the documented
  recovery. An on-demand Discover still answers every endpoint together.
- Each person/package track produces one Event Gateway POST per linked account
  while the feature is on.
- Pictures of the home go to Amazon with each event (when Snapshots is on);
  the certification privacy answers must say so before a submission that
  includes this.
- The per-device store holds, per camera, the class choice, an index of the
  last 300 event ids and up to 1000 hidden ids.

## Enforcement

`endpoint-shape-validation.spec.ts` (the shapes, the validator rules, ReportState
coverage), `object-detection-feed.spec.ts`, `data-controller.spec.ts`,
`vision-ids-and-state.spec.ts`, the ObjectDetection cases in
`motion-event-gating.spec.ts`, the router cases in
`directive-user-scoping.spec.ts` and the isolation cases in
`sync-engine.spec.ts`.

## Amendment 2026-10-08 — the empty history

Measured on the live hub after the operator switched the Echo to English (US):
the camera page shows an events section, ~300 ObjectDetection events in 20 min
were accepted (202), no `ReportData` ever arrived, and the history stayed
empty. Amazon caches each posted event and calls `ReportData` only when the
customer opens one, so an empty list means the cloud kept none of them.
Changes, each pinned in `object-detection-delivery.spec.ts`:

- `objectIdentifier` is a version-4-shaped hash (Amazon types it "Version 4
  UUID String"); the first build sent a UUIDv5.
- Lazy image URIs have their own bound (4096), not the 128 shared with
  GetSnapshot images: at the measured rate a URI was evicted ~4 min into its
  ten minutes.
- Every fetch of an image URI logs one line with its status, size and user
  agent; one redacted ObjectDetection body is logged per endpoint per process.
- At most one event per camera and class per 30 s; a track held back is
  reported if it is still present after the window.
