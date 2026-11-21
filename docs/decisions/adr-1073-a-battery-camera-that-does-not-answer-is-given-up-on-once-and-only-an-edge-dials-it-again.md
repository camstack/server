---
id: D1073
title: A battery camera that does not answer is given up on once, and only an edge dials it again
status: accepted
date: 2026-11-21
supersedes:
applies-to:
  - packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker.ts
  - packages/addon-provider-reolink/src/battery-hourly-refresh.ts
---

## Context

Device 640 (Argus 3E, battery): the hub logged "battery cam login while
sleeping" about 60 times an hour (1 439 on 2026-11-19, still running on a dead
camera on 11-21), plus 182 first-video watchdog kills and 253 stream starts in a
day, plus a full hourly refresh retried because the snapshot never moved.

The lazy-materialize branch of the broker had a deadline (20 s) after which
"the exponential backoff is right again", but that backoff is capped at 30 s
(`MAX_RECONNECT_DELAY_MS`) and never ends while a consumer holds live intent:
every pass asked the publisher to materialize, which logs in on the camera. The
watchdog kills reset the backoff to its floor and re-requested the source each
time. The sentry pump itself never dials (D173); it was only the visible
consumer in the log.

## Decision

For a battery camera (`DeviceFeature.Sleeps`) the broker bounds its effort and
then stops, once, with a line under the device tag: a materialize that does not
land inside its deadline, or four watchdog kills with no video between them,
suspend the broker as "given up". Only an edge restarts it: the camera observed
awake (`setDeviceAsleep(false)`), a fresh demand edge, or the publisher
re-publishing a real source. Never a timer. Watchdog kills on a battery camera
keep the exponential backoff instead of resetting it. Wired cameras are
unchanged.

The hourly refresh (D847) stamps a window whose only failure is the stale
snapshot, and says so; any other failure is retried as before.

## Consequences

A dead battery camera costs one bounded episode per awake transition instead of
a login per 30 s. A consumer attached to a camera that never comes up sees no
media until an edge; that is the intended price of not waking it.

## Enforcement

`battery-dial-loops.spec.ts` (lazy materialize and watchdog loops over an hour,
fake timers) and `battery-hourly-refresh.spec.ts`.
