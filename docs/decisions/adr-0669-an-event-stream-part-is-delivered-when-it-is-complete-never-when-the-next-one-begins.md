---
id: D669
title: An event stream part is delivered when it is complete, never when the next one begins
status: accepted
date: 2026-09-28
supersedes:
applies-to:
  - packages/addon-provider-amcrest/src/event-stream-parts.ts
covers:
  - packages/addon-provider-amcrest/src/amcrest-cgi-client.ts
---

## Context

A Dahua/Amcrest camera reports onboard motion on a long-lived
`multipart/x-mixed-replace` response (`eventManager.cgi?action=attach`). It
sends one part per edge (`Code=VideoMotion;action=Start`, later `action=Stop`)
and then nothing at all until the next edge. Every part carries a
`Content-Length`.

The provider's splitter cut the buffer on the boundary and kept the last
fragment as an unfinished tail. So a part was emitted only when the NEXT part's
boundary arrived. The attach URL requested no `heartbeat`, so nothing else ever
closed a part. The parser ran exactly one event behind, and on a stream with
two alternating messages, one event behind is a phase inversion:

- Live on camera 3836, 2026-09-28: the raw bytes read `action=Start` while
  CamStack logged `firmware event received {action=Stop}` and `onboard motion
  stopped`. Thirty seconds later the bytes read `action=Stop` and CamStack
  logged `onboard motion started`. The same held for every pair.
- The motion analyzer's rows (real motion) landed exactly on the firmware
  **Start** byte times (09:51:34, 09:52:39, 09:56:28, 10:03:50, 10:07:00). The
  onboard rows CamStack wrote landed on the **Stop** times and spanned the quiet
  (09:53:10 for 190 s, 09:57:04 for 180 s, …).
- The events-band recorder therefore filmed the quiet and cut on real motion:
  3836 high covered 623 of 684 minutes that day, and 14 of its holes longer
  than 60 s sat on real motion. For example, a real Start at 07:05:28 closed
  its window at 07:05:59, and the next "started" (the real Stop) came at
  07:12:07: 369 s of an episode, lost.
- The splitter's own test asserted the lag as correct ("emits the block that
  the second chunk closes"). The earlier fix to this code (2026-09-04) had
  repaired the preamble bug, and the test written for it enshrined the next
  one.

A Hikvision alert stream hides the same shape because it streams continuously,
so there the lag costs about a second. That is also why nobody noticed the lag
in the Amcrest code: the idea "a part ends at the next boundary" was borrowed
from a stream where the next boundary is always imminent.

## Decision

A streamed provider event is delivered as soon as its part is complete: its
headers are in and `Content-Length` bytes of body are buffered. Waiting for the
following boundary is allowed only for a part that states no length, because
for that part the boundary is its only end. A length that runs past the next
boundary is cut at the boundary. The event's `observedAt` is the arrival of the
chunk that completed the part. The attach stream asks for `heartbeat=5`, and a
`Heartbeat` part is a keep-alive: it is never an event, never a dropped-block
warning, and never an `event stream bytes` line.

## Consequences

- The onboard motion edge for Amcrest/Dahua cameras now arrives on time. The
  motion signal, the events-band recorder, and every notifier and export fed
  by `MotionOnMotionChanged` stop running inverted.
- A camera that sends no `Content-Length` gets the old lag back for that
  part. Every firmware observed so far sends one.
- The bytes carried while a part is incomplete are capped at 1 MiB, as on
  the Hikvision alarm stream. On overflow the head is discarded with one WARN
  (`event stream buffer hit its cap`, tagged `deviceId`) and the reader
  resyncs on the next boundary. A `Content-Length` that no boundary cuts
  short, or a first boundary that never arrives, can no longer grow the
  buffer for the life of a connection that has no timeout.
- A bare-LF blank line ends the headers as well as CRLFCRLF does. Otherwise a
  Unix-line-end firmware would fall back, silently, to the boundary wait.
- Heartbeats arrive every 5 s per camera. They are parsed and discarded. No
  silence watchdog consumes them yet: TCP keep-alive on the socket is still
  what detects a half-open stream.
- The recorder's out-of-order durable-row fold (the other half of the 3836
  investigation) is a separate defect and a separate fix. This record does not
  cover it.

## Enforcement

`packages/addon-provider-amcrest/src/__tests__/event-stream-parts.spec.ts`
enforces the rule:

- A single complete part yields its event with no following boundary.
- A pump test feeds the bytes in chunks split across the boundary line, the
  headers and the body. It asserts that `Start` is delivered, stamped at its
  own arrival, before any `Stop` byte is written.
- Heartbeat parts produce nothing.

Each of these tests fails against the boundary-delimited splitter. The package
gained a `test` script in the same change. Without it, nx inferred no test
target and CI had never run this suite.

Nothing enforces the rule for other providers' stream parsers; that is left to
review.
