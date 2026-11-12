---
id: DNNN
title: A battery connection error is a sustained whole-camera outage
status: accepted
date: 2026-11-12
supersedes:
applies-to:
  - packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker-manager.ts
  - packages/addon-pipeline/src/stream-broker/stream-broker/device-stream-outages.ts
  - packages/addon-pipeline/src/stream-broker/stream-broker/stream-health-policy.ts
  - packages/addon-post-analysis/src/notification-center/event-intake.ts
---

## Context

D883 stopped a sleeping battery camera from looking like a stream outage, and
made an outage one event per device. It left `connection-error` immediate: the
sweep that first judges an awake camera with a quiet stream emits
`stream.offline` on that pass.

Live notification history on the hub, 2026-11-11/12, was that immediate emit.
Device 3629 (a lazy dial) went `connection-error` and `recovered` 15 s later —
the first attempt of a wake failed and the retry worked. Device 3825 went
`connection-error` on `rtsp:sub` (`lastPacketAt` 0) and `recovered` on
`flv:sub` a minute later — one source failed while another source of the same
camera took over. Device 3628 went `connection-error` on `rtsp:sub` and never
came back. Filtering those in the notification center cannot see the other
source's packets, and a one-shot emit cannot be unsent after a fallible read.

## Decision

A battery `connection-error` is an outage only when it is sustained and the
whole camera is down. The broker holds the verdict in memory for
`STREAM_STALE_TIMEOUT_MS` (the same 120 s the stale-timeout path already
waits) before it emits. A recovery of that camera inside the window cancels
the hold, and no `stream.online` is sent for an offline that was never sent.
A source that fails while another source of the same camera is delivering
packets is not the camera's outage; a source that never delivered a packet
and is replaced by a working fallback is the same fact. Both are logged with
`tags: { deviceId }` and emit nothing. A camera with no source delivering
past the window is still notified once, with `connection-error`, and its
recovery once, with `recovered`. A hold that has aged out is judged again
with the same battery policy: asleep, or still inside the wake bound, drops
the hold with no event. Age alone never announces a camera that went back
to sleep.

A live session that has already been quiet for the stale window is already
sustained: that transition emits on the pass that judges it. The hold is the
in-memory outage record. It is never gated on a registry or slice read.

This narrows D883's `connection-error` bullet. Sleep, `wake-timeout`,
`battery-unreachable`, and one event per device are unchanged.

## Consequences

A dial that errors and recovers inside two minutes is silent. A source
failover inside the window is silent. A camera that stays down is still one
offline and, when it returns, one online. The notification center keeps
accepting `connection-error`; it does not re-time it.

## Enforcement

`battery-connection-error-sustain.spec.ts` (the three hub sequences, plus a
sibling that already had packets, plus a wake that errors and then sleeps)
and the sustained arm of `battery-stream-health.spec.ts`. Nothing else checks
the hold.
