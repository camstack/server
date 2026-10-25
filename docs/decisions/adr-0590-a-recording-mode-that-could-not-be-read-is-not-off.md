---
id: D590
title: A recording mode that could not be read is not "off", and every cap route is scope-checked
status: accepted
date: 2026-09-21
supersedes:
applies-to:
  - packages/types/src/capabilities/recording.cap.ts
  - scripts/generate-method-access-map.ts
  - scripts/check-method-access-map-coverage.ts
---

## Context

A non-admin user (device grant over all cameras, plus `category:system[view]`)
reported that the recording badges were missing in the viewer. They were not
missing: every camera was drawn **green — "online, not recording"** — including
two that were recording continuously. After restarting the app the badges
appeared, and that is the observation that settled the diagnosis: a permission
wall does not heal on a restart, a failed read does.

The chain, end to end:

1. the screen aggregate (`deviceManager.getDeviceStatusAggregateBatch`) failed
   transiently. `capQuery` collapses any failure to `null`;
2. the dot fell back to this camera's own read, `recording.getDeviceConfig`,
   which was `auth: 'admin'` — an `adminProcedure`, refused regardless of
   scopes;
3. `capQuery` collapsed that FORBIDDEN to `null` too, and because it RESOLVES
   rather than rejects it also bypassed `query-client.ts`'s out-of-scope
   reporter, so no log line existed either;
4. `useRecordingMode` mapped `null` → `'off'`, and `cameraStatusKind` mapped
   `'off'` → green.

Two measurements had been folded into a value, twice in one chain. The same
shape sat in the timeline's recording band: a failed `getAvailability` became
`recording: []`, which draws as "this camera recorded nothing today" — while
the file's own comment already claimed a failed read on that path "is already a
rejection and the fault slot owns it". It was not; the comment was a leftover
describing the right design.

**A third defect surfaced while checking the first.** 105 of 1164 tRPC cap
routes were absent from `METHOD_ACCESS_MAP`, and the middleware SKIPS the scope
check for a path it cannot find (`if (path in METHOD_ACCESS_MAP)` — deliberate,
because a hand-written core route has no cap entry). 92 of the 105 were
`protected`: per-device reads (`battery.getStatus`,
`cameraCredentials.getStatus`, every `getDeviceLiveContribution`) reachable by
any authenticated non-admin for ANY device, outside their grant. Cause:
`generate-method-access-map.ts` enumerated `capDef.methods`, the DECLARED
surface, while `generate-cap-routers.ts` emits the EFFECTIVE one via
`expandCapMethods`. Nothing in the scope machinery was wrong — those paths
simply never reached it.

## Decision

**A failed read is `null` all the way to the surface, and the surface says so.**
`useRecordingMode` returns `RecordingMode | null` and rethrows, like
`useRecordingAvailability` beside it already did; `cameraStatusKind` gains
`recording-unknown` with a muted colour that does not pulse, ranked after the
two positive modes and before `online` so an unread mode can never borrow the
colour of a camera we know is not recording. The timeline band rethrows on both
its paths, and the rejection reaches the fault slot the file already described.

**`recording.getDeviceConfig` is `protected`.** It is a per-camera READ, still
covered by the per-device gate in `scope-access.ts`, and its schema carries
schedules and retention — no secret. `setDeviceConfig` stays `admin`.

**Both generators read the same expansion**, and
`check-method-access-map-coverage.ts` fails the build when any route in the
generated API reference is missing from the map. Coverage is now 1164/1164.

## Consequences

Until a `@camstack/server` carrying the `protected` change is installed, a
non-admin's dot for a camera whose aggregate failed will read *unknown* rather
than green. That is the point: the wrong answer is gone before the right one
arrives.

The map fix closes a scope-containment hole silently, which is the wrong way to
land a security change — hence this record, and hence the guard. It is the
second time a cap definition has been read by one consumer and expanded by
another; a third consumer is how these two drifted in the first place.

## Enforcement

`camera-status.spec.ts` (the unknown kind, its priority, and that it does not
pulse), `capquery-rethrow-family.spec.ts` (both new rethrows, beside the ones
that already existed; it is also the guard that caught an attempt to catch the
rejection back into a sentinel), and `check-method-access-map-coverage.ts`,
wired into `ci.yml` and confirmed to fail when one path is removed from the map.
