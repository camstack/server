---
id: D1000
title: A parcel still is taken from a frame that still exists
status: proposed
date: 2026-11-02
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/package/package-still-capture.ts
  - packages/addon-post-analysis/src/pipeline-analytics/index.ts
---

## Context

`promoteWithStill` stored the parcel's picture by fetching the package LOOK
frame from the runner by RAM handle. That handle lives as long as the runner's
native lease (`holdFrames` 8, released about 100 ms after inference), but
promotion happens after the dwell and hit gate: seconds to minutes later. On
camera 615 every promotion since 1.2.654 logged `package still NOT stored`
(20 `native-miss`, 4 `preview-only`, zero stored) and shipped text-only. The
age bound (15 s) measured the wrong clock: the lease, not the frame's age.
There was one un-retried fetch and no second source (D60, D400).

## Decision

A parcel still is captured from a source alive at promotion. The native handle
is tried only while its lease can still be alive (`PACKAGE_NATIVE_HANDLE_MAX_AGE_MS`,
1 s); otherwise, or on a miss, the camera's own `snapshot.getSnapshot` is read.
A parcel is at rest, so a frame taken now shows it where it was seen. The live
read is retried until a frame lands, bounded by `PACKAGE_STILL_BOUND_MS` (6 s,
3 attempts, each capped at 3 s): the delivery waits at most that long before
`delivered` is emitted, then ships without a picture and says why. The frame is
stored whole under `track:<entry.id>` with the box beside it, as before; the
render crops it, so no crop rectangle is derived and D52 is not in play. A
stored still is logged (`package still stored {entryId, mediaId, source}`) next
to every miss (D400). The row carries the stored `mediaId`; the dispatcher
already reaches the media through the row's own `trackId` owner (D482).

## Consequences

A delivery can be up to 6 s later when the camera is slow. A snapshot may come
from a different stream resolution than the look frame; the stored box carries
`frameWidth` / `frameHeight`, so the crop scales by ratio.

## Enforcement

`package-still-capture.spec.ts`: a released handle falls back to the live
source and the row names a `mediaId`; a failing live read is retried; the
bound and its reason are logged. Disarmed by restoring the single handle
fetch: 5 of those cases fail.
