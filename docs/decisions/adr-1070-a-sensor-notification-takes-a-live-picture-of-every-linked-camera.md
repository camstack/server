---
id: D1070
title: A sensor notification takes a LIVE picture of every linked camera, never the wrapper's cached frame
status: accepted
date: 2026-11-20
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/linked-stills.ts
---

## Context

D632 composes the pictures a sensor notification carries from the linked cameras
and drops a frame older than the event. The first read was UNFORCED, and a stale
frame was re-polled unforced (the D60 pattern) before being dropped. On a live hub
a door contact linked to a mains camera almost never carried a picture: the snapshot
wrapper answered every unforced read with its cached frame (20-72 s old, and 15
minutes old on an awake battery camera behind a hub), so five re-polls returned
the same frame and the tile was dropped as `stale`. The re-poll could not help: a
poll is exactly the call that is served from the cache.

## Decision

A notification always takes a live picture. Per linked camera, after the
capture-free state read: awake (or mains, or the rule allows a wake) means ONE
forced capture, bounded (`NC_LINKED_LIVE_CAPTURE_TIMEOUT_MS`); a sleeping camera
keeps the D998 wake, which is the same forced capture. An unknown state on a
possibly-battery camera without the rule's leave stays unforced. The cached frame
is never the primary picture: only when the live capture FAILS (not times out) is
one unforced read tried, and only a frame the freshness check (10 s) accepts
ships. The unforced re-poll loop is removed. Each camera's line says taken live
(`live`, `liveMs`) or failed (`liveFailure`, the cause).

## Consequences

The state read now precedes the capture instead of running beside it. Worst case
for one camera is the state read plus the live bound (plus one cached read after a
non-timeout failure); the row waits through `pendingUntil`. An awake verdict is
trusted to mean a forced capture wakes nothing.

## Enforcement

`linked-stills.spec.ts`: a cached frame is never attached when the live capture
succeeds; failure paths name `liveFailure`.
