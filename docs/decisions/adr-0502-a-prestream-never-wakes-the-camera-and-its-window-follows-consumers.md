---
id: D502
title: A prestream never wakes the camera, and its window follows consumers
status: proposed
date: 2026-09-15
supersedes:
applies-to:
  - packages/addon-pipeline/src/stream-broker/rtsp/rtsp-listen-server.ts
  - packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker.ts
---

> **Naming.** Since 2026-09-17 this mechanism is called **sentry**.
> The text below says `prestream` because that is what it was called when the
> decision was taken, and a record is not rewritten: `watch` and `monitor`
> were both already taken in the same module (`watchdog`, `watcher`).

## Context

`PRESTREAM_PATH_SUFFIX` defines a prestream dial as "asking for the stream
WITHOUT asking for the camera", and D173 forbids the system from waking a
battery camera on its own behalf. D493 built the demand half of that: a
prestream session is FED but is not INTENT, so it cannot dial.

It did not hold. Measured on device 106 (Baby monitor, battery) on 2026-09-15
with VLC pointed at `…/<token>/prestream`:

```
14:22:24  demand detected — resuming stream          ← before any session exists
14:22:24  rfc4571: lazy URL — requesting publisher to materialize
14:22:24  battery cam login while sleeping — this wakes the camera
14:22:35  rfc4571: publisher materialized {materializeMs=11116}
14:22:36  First keyframe received
14:22:40  no demand — suspending stream
14:23:08  battery sleep state committed {sleeping=true}
```

Two independent holes, and each one alone would have been survivable:

1. **`dispatch` warms the broker for every dial.** At DESCRIBE no session exists
   yet, so a cold broker would answer with an empty SDP — the worst RTSP
   failure. The warm-up subscribes a synthetic consumer, and a synthetic
   consumer is demand, and demand dials. It never consulted `declaration`.
2. **The pump was started only by a dial.** `checkDemand` has computed
   `prestreamWanted` correctly since the feature shipped and its comment says
   "the prestream pump follows CONSUMERS, not intent … it runs whether the
   camera is up or asleep" — but the only call to `PrestreamPump.start` was
   inside the lazy branch of `start()`, which is a dial, which needs live
   intent, which a prestream session does not have. `suspend()` stopped the pump
   and nothing restarted it.

So the wake cost 11.1 s of battery, bought 5 s of video, and then the broker
suspended under the consumer that had caused the wake — correctly, because that
consumer is not intent. From 14:22:40 the client had neither video nor picture.

Raising the suspend grace, or counting a prestream as intent, were both
rejected: the first delays the failure, and the second is the plus catalog-puller
drain that D173 and D493 exist to prevent.

## Decision

A prestream dial acquires no broker warm-up: it is answered from whatever SDP
exists, and it never causes a dial. The prestream window is driven by CONSUMERS
and not by the dial — it opens whenever a prestream session is attached and
nothing holds live intent (freshly attached, asleep, or just suspended), and it
closes on live intent or on the first real packet. Only a signal the camera
reported about itself wakes anything, and the camera returns to sleep on the
configured hold (`wake-hold.ts`), with the picture resuming when it does.

## Consequences

- A prestream consumer on a sleeping camera sees the camera's last picture
  indefinitely and costs no battery. That is the contract, now enforced rather
  than described.
- The two fixes are one fix and must ship together. Removing the warm-up alone
  would leave a prestream consumer with nothing at all, because nothing else
  would have started the pump.
- `reconcilePrestreamWindow` runs on every demand check. `PrestreamPump.start`
  is idempotent, so this is one encode per window and no more.
- A prestream DESCRIBE against a broker that has never held a stream has no SDP
  to answer with until the pump's first frame arrives. The bounded
  `waitForSdp` still applies; the pump now fills it without a dial.

## Enforcement

`sentry-never-wakes.spec.ts` drives a real `RtspListenServer` over a real
socket and asserts the warm-up is not acquired for a prestream dial — with an
ordinary dial and a `/muted` dial as controls, because "never warm up" would
re-break ffprobe. `sentry-window-follows-consumers.spec.ts` drives a real
`StreamBroker` through attach → live intent → suspend and asserts the window
re-opens. Both were verified by removing the fix: 1 of 4 and 2 of 4 go red.
