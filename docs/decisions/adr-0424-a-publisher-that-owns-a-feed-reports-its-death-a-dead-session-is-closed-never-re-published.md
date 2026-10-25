---
id: D424
title: A publisher that owns a feed reports the feed's death — a dead session is closed, never re-published
status: accepted
date: 2026-09-09
supersedes:
applies-to:
  - packages/addon-provider-dreame/src/devices/dreame-rfc4571-server.ts
  - packages/addon-provider-dreame/src/devices/dreame-camera-device.ts
---

## Context

The Dreame robot camera (D370) publishes a local RFC 4571 server the broker
dials while the monitor is open, and the lazy sentinel while it is closed.
The server subscribed to the feed's `videoAccessUnit` and `audioFrame` and
to nothing else. The broker's refresh request (`onRequestStreamSourceRefresh`,
sent after every failed or silent dial) was answered by re-publishing
whatever stood: the server while the session was open, the wake while it
was closed.

Measured on 2026-09-09, `Robot piano terra` (device 4374, robot 996872505),
hub log:

- 22:13:51 monitor open on port 37585; video flowed for 38 min (pipeline
  ~60 frames / 10 s).
- 22:52:03 `source-RTP activity watchdog: no packets within window` — the
  LinkVisual relay went silent, no FIN, no error. From then to 23:08:36 the
  broker reconnected **71 times** (`first-video watchdog` at 8 s, or the
  muxer closing an idle client at 5 s); each reconnect produced a refresh
  request, and the device answered each with
  `stream published on the broker {lazy=false}` — **the same dead port**,
  76 times. Meanwhile the duration cap re-armed every 10 min ("the robot is
  in function") and the relay keep-alive to the cloud kept passing: the robot
  was online, only the video was gone. Nothing in the addon could see that.
- 23:08:37 `[addon-runner CRASH] uncaughtException: read ETIMEDOUT` at
  `TCP.onStreamRead` — the kernel gave up on the silent relay socket ~16 min
  after the silence began, nodedreame's `DreameCameraStream` re-emitted the
  socket's `error`, and no listener existed, so the EventEmitter threw. The
  whole provider (both robots, 196 persisted devices) died and was
  respawned; the fresh monitor at 23:08:44 worked immediately.

So the crash was the only thing that fixed the stream, and it cost the
operator 16 minutes of a camera that "does not arrive". A second silent path
existed too: on a clean relay close nodedreame stops the stream itself and
emits `stopped`, which the addon also ignored — the port stayed published
with nothing behind it.

What was tried first: answering a refresh on an open session by re-opening
the monitor. Rejected — the broker also asks for a refresh when the source
closed because WE closed it, and a wake per refresh would cold-start the
robot on every reader detach.

## Decision

A publisher that owns the feed behind a source it publishes OBSERVES that
feed and REPORTS its death; it never lets a dead session stand. For the robot
camera: `startRfc4571Server` listens to the feed's `error` and `stopped`
from the first listener on (a Node `error` with no listener is a crash, not
a log line), keeps an allocation-free stall watch (`FEED_STALL_MS`, 10 s,
just past the broker's own 8 s), and calls `onFeedLost` ONCE — never for its
own `close()`. A loss before the server is up fails the open. The device's
answer to a loss is `closeStream('feed-lost')`: the lazy sentinel goes back
on the broker, so the broker's next dial is a materialize request, which is
the wake (D370). The refresh handler is unchanged: "already open, re-publish
what stands" is right exactly because a dead session no longer stands.

## Consequences

- A relay that dies is re-opened within roughly the stall window plus the
  broker's redial plus the open (3–9 s measured for an open), instead of
  never. The cost is one more cold start of the robot per real relay death.
- `onFeedLost` is a REQUIRED parameter of `startRfc4571Server`: a caller
  that forgets it does not compile, because a caller that forgets it
  reproduces the crash.
- The addon no longer dies on a relay socket error; every such error is a
  `warn` with `tags: { deviceId }`, `reason` and `openMs`.
- Not covered: a relay that keeps sending video the robot is not looking
  at. Only silence and errors are losses.

## Enforcement

`dreame-rfc4571-server.spec.ts` — `error` after the server is up is reported
once and does not throw (this test throws `read ETIMEDOUT` with the fix
removed, the production crash in-process); `stopped` is reported; silence
past the stall window is reported and flowing frames are not; the server's
own close is not a loss; an `error` before the first keyframe fails the open
at once. `dreame-camera-stream.spec.ts` guards the device wiring
(`onFeedLost` → `closeStream('feed-lost')` with its log line).
