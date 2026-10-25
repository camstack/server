---
id: D700
title: A linked-camera notification still uses getSnapshot; the tracked opt-in is timeline-only
status: accepted
date: 2026-10-04
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/index.ts
  - packages/addon-post-analysis/src/notification-center/index.ts
  - packages/addon-post-analysis/src/notification-center/linked-stills.ts
  - packages/addon-admin-ui/src/components/device/customize/kinds/LinkedDevicesTable.tsx
---

## Context

D632 already said a sensor notification photographs every LINKED camera and
ignores `producesTrackedEvents` for the capture set. The implementation still
gated the sensor-level shelf on `mediaCameraIds.length > 1`, so a sensor linked
to exactly ONE camera that had NOT opted into tracked events fell through to
unowned text-only — no mosaic path, no marker (nothing tracked), no photograph.
Kitchen lock/contact on camera 112 looked "unlinked" in notifications even
though Customize showed the link. Operators need a still when the link exists;
detection/timeline events may be absent at that moment.

## Decision

- **Link alone is enough for media.** When `allCamerasFor` answers one or more
  cameras, `beginLinkedStills` / `linkedSet` may photograph them. Exactly one
  linked camera with zero tracked rows uses the same shelf path as a
  multi-camera set (plain still, not a mosaic of one).
- **The photograph is `getSnapshot` on the snapshot capability** (cache / camera
  snapshot API), never a detection-event frame. Events may not exist when the
  sensor fires.
- **`trackedDeviceIds` / `producesTrackedEvents` govern timeline rows and
  markers only** — Customize labels the switch "On camera timeline". Rules and
  linked stills do not require it.

## Consequences

- One tracked camera keeps the per-row + marker path (no double capture).
- UI copy that says "Tracked events" for the opt-in is wrong; notifications
  photograph every linked camera without that switch.
- Zero linking cameras still means no linked stills.

## Enforcement

- Specs: `sensor-linked-evaluation`, `sensor-linked-wiring`,
  `sensor-ingest-unowned`, `LinkedDevicesTable` (timeline copy + DeviceList).
- Review: any new gate that folds `rowCameraIds.length === 0` into "no media"
  for a non-empty `mediaCameraIds` / `allCamerasFor` set violates this record.
