---
id: D772
title: Alexa detection sensors are one MotionSensor endpoint per camera and class, fed by pipeline tracks and reconciled against the active tracks
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/addon-export-alexa/src/detection-sensors/**
  - packages/addon-export-alexa/src/endpoints/builder.ts
  - packages/addon-export-alexa/src/sync-engine.ts
  - packages/addon-export-alexa/src/lwa-event-gateway.ts
---

## Context

The operator wants "events like HomeKit" in Alexa. Amazon's object-detection
interface (`Alexa.SmartVision.ObjectDetectionSensor`) and the event history it
feeds are en-US only and know two classes (person, package); the operator's
account is it-IT. What every locale has is `Alexa.MotionSensor`, usable as a
routine trigger. Until now the only MotionSensor was the camera's own, fed by
the camera firmware's `motion` cap — the ML pipeline was not used at all.

Two traps shaped this. The pipeline's track lifecycle does not promise an `end`
for every `start` (a zero-media false birth or a discarded stale track ends
silently), and events are telemetry (D8): a sensor fed by events alone can stay
"detected" forever. And the classes a camera emits are read from
`pipelineAnalytics.listEventKinds`, which answers "no ML classes" — not an
error — when the orchestrator cannot be reached; removing a class deletes the
user's Alexa sensor and the routines built on it.

## Decision

- An integration switch, "Detection sensors", default ON (operator decision):
  every exposed camera publishes `<camera>__det_<class>` endpoints — "Front
  door Person / Vehicle / Animal / Package", `MOTION_SENSOR`, with
  `Alexa.MotionSensor` and `Alexa.EndpointHealth` (D770) — for exactly the
  classes its pipeline emits.
- Presence is per `(camera, class)` and per `trackId`, from
  `PipelineAnalyticsTrackLifecycle` (`data.deviceId`; the events carry no
  device on `source`); a package delivery is a pulse. Every minute, each camera
  that shows a class present is reconciled against
  `pipelineAnalytics.getActiveTracks` — the read is the authority, and a read
  that fails changes nothing.
- ChangeReports reuse the camera-motion hold: instant DETECTED, NOT_DETECTED
  only after the source is quiet and at least 30 s after DETECTED (Amazon), and
  only to an endpoint the last AddOrUpdateReport named (D76).
- A class that appears is published at once; one that disappears is removed
  only after it has been missing for 15 minutes across reads. A failed class
  read answers the last known classes (persisted).
- A push deletes (DeleteReport) the detection-sensor endpoints a camera no
  longer builds — and ONLY those: an accessory missing from one build may be a
  failed read, and is never deleted on it.

## Consequences

- Sensors carry no images (Amazon offers none outside en-US). They give the
  operator routine triggers and Activity entries in every locale.
- With the switch on, each exposed camera adds up to four endpoints; Amazon's
  limit is 300 per account.
- The class list is the timeline lanes' list, so Alexa and CamStack agree on
  what a camera detects.

## Enforcement

`detection-tracker.spec.ts`, `detection-feed.spec.ts`,
`detection-classes.spec.ts`, `detection-sensor-endpoints.spec.ts`, the R1
scenarios in `endpoint-shape-validation.spec.ts` (discovery rules and
ReportState) and the retirement cases in `sync-engine.spec.ts`.
