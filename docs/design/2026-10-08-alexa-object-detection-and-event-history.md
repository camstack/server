---
title: Alexa object detection and per-camera event history (R4) — what it needs
date: 2026-10-08
status: implemented 2026-10-08 as a switchable experiment (D779), default on; Amazon lists the interfaces for en-US only
applies-to:
  - packages/addon-export-alexa/src/endpoints/builder.ts
  - packages/addon-export-alexa/src/lwa-event-gateway.ts
---

# R4 — `Alexa.SmartVision.ObjectDetectionSensor` + `Alexa.DataController`

> **Update 2026-10-08 (D779):** points 2–5 below are built, default ON, behind
> an integration switch and a per-camera toggle, to test empirically what an
> it-IT account (and an Echo switched to English (US) on it) does with them.
> Differences from the plan: the declaration has no `properties` block; the
> ObjectDetection event id is a hash-derived v4 UUID per (track, class) so the
> history repeats it; a SmartVision camera is pushed in its own
> AddOrUpdateReport; firmware motion no longer posts ObjectDetection at all.
> Point 6 (privacy wording for certification) is still open. The sections below
> are the original reasoning.

## Why it is not built now

Amazon makes both interfaces available in **en-US only**
(device-apis/list-of-interfaces, checked 2026-10-08). The operator's account is
it-IT on the EU endpoint; an it-IT or en-GB account gets none of what they
drive: the per-camera event history in the Alexa app, the person/package
announcements, automatic live view on detection, the "person detected" routine
trigger. Building them for this hub would add an interface no user can reach and
a certification surface with no test account that can exercise it.

The EU-reachable substitutes ship instead:

- **Detection sensors** (R1): one `Alexa.MotionSensor` endpoint per camera and
  class (Person / Vehicle / Animal / Package), routine triggers in every locale.
- **Snapshots** (R2): `Alexa.SmartVision.SnapshotProvider`, available in it-IT
  and en-GB, through the token-checked image route this design reuses.

## What a US launch would need

1. **A US skill**: the North America Lambda and a US listing (runbook §D). The
   hub already posts to the NA Event Gateway when the skill region is NA.
2. **Discovery**: on a camera that runs a detector, declare
   `Alexa.SmartVision.ObjectDetectionSensor` v1.0 with
   `configuration.objectDetectionConfiguration` for `person` and `package` only
   (Amazon has no other class), and `Alexa.DataController` v1.0
   (`instance: Camera.SmartVisionData`, `targetCapability:
   Alexa.SmartVision.ObjectDetectionSensor`, `supportedAccess:
   [BY_IDENTIFIER, BY_TIMESTAMP_RANGE]`). Both need `Alexa.EndpointHealth`,
   which every camera already declares (D770). Add both shapes to
   `endpoint-shape-validation.spec.ts` first: an earlier declaration without the
   skill's SmartVision permissions made Alexa reject the camera and all its
   children.
3. **`SetObjectDetectionClasses`**: honour it — a class the user turned off in
   the Alexa app is not sent. Persist per endpoint.
4. **Events**: `ObjectDetection` (payloadVersion 1.0) with `eventIdentifier` a
   UUIDv4 per detection, `objectIdentifier` a stable UUID per track (map
   `trackId` → UUIDv5 under a hub namespace), at least 30 s between events for
   the same object, `frameImageUri` / `croppedImageUri` minted by the R2 image
   route (signed, ~10 min, 410 after expiry, account-link token checked). Feed
   from the same pipeline track events and per-class mapping R1 uses
   (`detection-sensors.ts`), so the two surfaces never disagree about a class.
   `postObjectDetection`'s signature gate stays: nothing is posted to an
   endpoint that does not declare the interface.
5. **History**: `DataController.ReportData` answered from
   `pipelineAnalytics` tracks (by identifier, by time range, 10 per page,
   paginated), image URIs re-minted on every read so Amazon never holds a
   long-lived link. `DeleteData` hides the event from Alexa only; deleting
   footage in CamStack from a voice assistant is not something this skill
   should be able to do.
6. **Privacy**: every event carries still images of the home and its people to
   Amazon. The privacy policy, the console's "collects personal information"
   answer and the listing must say so before this ships; the image route's
   per-integration switch (R2) must gate these images too.

## Effort

About 4–6 days on top of R1/R2, most of it the DataController paging and the
certification test cases. Revisit when Amazon lists it-IT for either
interface, or when a US listing is planned.
