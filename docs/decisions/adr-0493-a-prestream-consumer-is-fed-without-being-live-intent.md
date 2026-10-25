---
id: D493
title: A prestream consumer is FED without being LIVE INTENT, and only the camera's own signal dials it
status: accepted
date: 2026-09-13
supersedes:
applies-to:
  - packages/addon-pipeline/src/stream-broker/stream-broker/wake-hold.ts
  - packages/addon-pipeline/src/stream-broker/stream-broker/sentry-eligibility.ts
  - packages/addon-pipeline/src/stream-broker/rtsp/restream-intent.ts
  - packages/types/src/capabilities/stream-signals.cap.ts
---

> **Naming.** Since 2026-09-17 this mechanism is called **sentry**.
> The text below says `prestream` because that is what it was called when the
> decision was taken, and a record is not rewritten: `watch` and `monitor`
> were both already taken in the same module (`watchdog`, `watcher`).

## Context

A camera whose stream is built on demand takes 2.2–12.4 s between "someone asked"
and "media flows"; on this hub the wyze bridge takes 12.4 s. Consumers see black,
and Alexa sees worse: Amazon requires an SDP answer within **six seconds**, so a
cold battery camera cannot answer an Echo at all.

The operator also wants a continuous-pull consumer — one that holds an RTSP session
open for ever — to be able to watch a battery camera. That is the trap. In this
broker **demand IS the wake**: `hasDemand()` counts RTSP sessions, and a permanent
session therefore keeps a lazy source permanently dialled. `redial` and
`kickReconnect` both refuse without demand precisely because a broker with no
consumer must not wake a camera (D173) — which means the naive prestream would
delete the reason the camera has a battery.

A first attempt treated the wake window alone (fill the gap, stop at the first
real packet). That ships and is useful, and it does not answer the continuous
case at all.

## Decision

A consumer attached to a lazy source **declares on its path** whether it is asking
for the camera or only for a picture, and the two asks are different kinds of
demand. `StreamBroker` therefore has two predicates where it had one:

- **`hasLiveIntent()`** — the whole of the former `hasDemand()`, with the RTSP
  session count filtered to exclude `/prestream` dials, plus the wake hold below.
  It governs every path that may dial, redial, kick or resume a source, and it is
  the only thing that may reach a `lazy:rfc4571:` sentinel. For a broker with no
  prestream session it is term-for-term the old predicate, which is why every
  existing camera, consumer and test is unaffected.
- **`hasAnyConsumer()`** — adds prestream sessions and governs nothing but the
  prestream pump.

The camera is dialled only by a real live intent (a play, a recorder hold) or by
a signal **the camera reported about itself** through
`streamBroker.reportStreamSignal`. The vocabulary of those signals is the
PROVIDER'S — `stream-signals` carries a `code` and a `label` it chooses, like
`consumables` — because a fixed enum makes every new signal a framework release.
Our own detections may never be the trigger: they are produced from decoded
frames, and would depend on the stream they are meant to justify.

A signal buys a **hold**: `holdMs` past the last signal, extended and never
stacked, bounded absolutely by `WAKE_HOLD_MAX_RUN_MS` from the run's first signal
— and a run that reaches that ceiling buys `WAKE_QUARANTINE_AFTER_CAP_MS` of
silence before another may arm. The quarantine is not decoration: without it a
run ends exactly AT the ceiling and the next signal from a stuck sensor re-arms a
fresh run, which is five minutes awake, an instant asleep, all night. Signals
during the quarantine are refused and counted, never queued — a queue fires them
all when it lifts, which is the same drain arriving late.

The whole mechanism is offered **only to a battery camera that declares the
signals cap**. Both facts are asked and an unanswerable question is a NO: a mains
camera has nothing to save by sleeping, and a battery camera with no signals could
never be woken, so a prestream consumer would hold a session open against a stream
that is permanently a photograph.

## Consequences

`hasDemand` no longer exists; six call sites read `hasLiveIntent`. A prestream
session is fed a still picture for as long as it is the only consumer, and the
camera stays asleep — so a plus catalog attach costs the battery nothing, which is the
property this record exists to guarantee and the one that must be measured before
it is believed.

A camera whose provider has not implemented `stream-signals` gets today's
behaviour exactly. A synthetic frame never arms `firstKeyframeReceived`, never
reaches the decode plane and never enters the clip buffer — that containment
predates this record by hours and this feature would have amplified it into hours
of still image written into recordings.

Not decided here: whether the prestream picture refreshes while a camera sits
asleep for hours, and what the overlay says beyond the camera's name and state.

## Enforcement

`wake-hold.spec.ts` (the ceiling, the quarantine, and the stuck-sensor loop that
found the ceiling was cosmetic), `sentry-eligibility.spec.ts` (both terms, and
unknown refused on either), `sentry-intent.spec.ts` (an ordinary dial is
unchanged — D382), `sentry-plan.spec.ts` (no geometry, no prestream) and
`synthetic-frame-containment.spec.ts`. The demand split's own safety property —
for a broker with no prestream session, `hasLiveIntent()` equals the old
`hasDemand()` on every input — is carried by the 1909 broker tests that pass
unchanged.
