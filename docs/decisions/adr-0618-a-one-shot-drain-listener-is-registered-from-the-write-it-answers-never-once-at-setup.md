---
id: D618
title: A one-shot drain listener is registered from the write it answers, never once at setup
status: accepted
date: 2026-09-23
supersedes:
applies-to:
  - packages/addon-provider-hikvision/src/clips/clip-stream.ts
  - scripts/check-drain-listener-rearmed.ts
---

## Context

D447 gives a raw HTTP stream a drain gate: honour `write()`'s return, await
`drain`, cut the peer that never drains. The gate arms on a write that returns
`false` and is disarmed only by `drain`.

`ClipStreamRouteSink.onceDrain` is `res.once('drain', …)`. **Firing consumes the
listener.** The Hikvision producer registered it a single time, at spawn. So the
first back-pressure episode used up the only listener; every later one armed a
gate that nothing alive could disarm, and 10 000 ms later the stream was severed
as `peer-stalled` — "the peer stopped taking bytes" — while bytes were still
flowing through it.

It did not look like that from either end. The operator reported, three days
running, that Hikvision clips "die after a few seconds". The picture stopped at
about six seconds, which is a plausible media fault, and the broker's own log
showed a healthy consumer: `pushed: 72`, `queued: 12`, a paced reader doing
exactly its job. What identified it was the arithmetic, not the symptom:

| attempt | `elapsedMs` | `accessUnits` | `bytesOut` |
| --- | ---: | ---: | ---: |
| 1 | 11 176 | 135 | 5 103 397 |
| 2 | 11 265 | 137 | 5 281 892 |
| 3 | 11 286 | 137 | 4 679 321 |
| 4 | 11 301 | 136 | 4 679 321 |

A 125 ms spread across four different clips is a **fixed timer**, never content:
10 000 ms of gate plus the ~1.2 s to the broker's *second* pause
(`clip-stream:first-frame sinceSeekMs: 1207`). And 4.68 MB with 137 units
delivered is the opposite of a peer that stopped taking bytes.

The first hypothesis — that the 600 ms feeder cushion was too small, or that the
10 s timeout was simply too short for a consumer paced at 1× — was wrong, and
raising the timeout would have moved the failure rather than removed it. What
settled it was that **Reolink and Amcrest were unaffected**: both re-register
`onceDrain` inside the branch that handled a refused write, and Amcrest pauses
`child.stdout` there too. Only Hikvision registered at spawn. A defect present
in one of three sibling implementations reads as a property of that vendor's
media for as long as nobody diffs the three.

## Decision

**A listener that is consumed when it fires is registered from the code path
that needs it, not once at construction.** Concretely, for the clip stream: the
drain listener is registered inside the branch handling a `write()` that
returned `false`, so every back-pressure episode gets its own — and the upstream
producer (`child.stdout`) is paused there and resumed in that listener, because
ffmpeg's output has native flow control and the camera hop has none.

## Consequences

The gate can now be disarmed as many times as the peer goes behind, which is
what a consumer paced at playback rate does for the whole length of a clip. The
provider stops buffering the backlog in its own heap: it rests in the pipe,
where ffmpeg will stop producing until it is read.

A test fake must model `once` faithfully — firing must remove the listener. The
fake in `clip-stream-producer.spec.ts` originally stored the listener in a slot
that survived its own firing, so a test written against it would have passed
against the broken code. That is the third time in this repo a fake has supplied
what production forgot; the spec now consumes the listener on fire and says why.

This does not change what the drain gate itself means. `createDrainGate` is
untouched: `wrote(true)` still does not disarm, which is the right reading of
D447 (an accepted write proves nothing about the socket's buffer). What changed
is only that a `drain` can actually arrive.

## Enforcement

`scripts/check-drain-listener-rearmed.ts`, wired into CI. Every `.onceDrain(`
**call** must have a `.write(` within 400 characters of code above it —
comments and whitespace stripped, because a rationale paragraph is not distance
and the first cut of this guard flagged the very fix that motivated it.
Disarmed against the historical code: the guard names
`clip-stream.ts:435` and exits 1.

Behavioural cover: *"survives a SECOND back-pressure episode — the peer's drain
is not one-shot"* in
`packages/addon-provider-hikvision/src/clips/__tests__/clip-stream-producer.spec.ts`,
which drives two episodes through a faithfully one-shot sink and asserts both
the re-registration and the mux pause/resume. Both halves of the fix were
disarmed separately and each fails it.
