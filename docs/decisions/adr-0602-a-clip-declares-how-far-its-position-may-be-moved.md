---
id: D602
title: A clip DECLARES how far its position may be moved
status: superseded
date: 2026-09-22
applies-to:
  - packages/addon-pipeline/src/stream-broker/recorded/control-protocol.ts
  - packages/addon-pipeline/src/stream-broker/recorded/timeline-session.ts
---

> **Superseded by [D612](adr-0612-a-clip-s-controls-are-a-provider-fact-declared-once-and-a-rate-it-cannot-deliver-is-never-offered.md)
> on 2026-09-23.** The RULE this record states is right and survives whole: a
> clip declares what it can be driven to do, absence means the freedom the
> viewer always had, and a control that undoes the gesture is worse than a
> disabled one. What was wrong is the LEVEL. `clipTransport` was per clip, and
> it was measured not to vary per clip — `chooseClipPath` reads only whether
> the provider's dial and file read are wired, and is documented not to read
> the profile. The declaration moved to `videoclips.getPlaybackOptions`, one
> answer per provider, asked before a clip is picked, and it now carries the
> deliverable rate set as well. The message is gone.

## Context

D599 gave clip playback one transport: the provider's stream, for every
profile. That stream is forward-only — the bytes behind the playhead were
never kept and the camera offers no replay-from-offset — so the feeder refuses
a backward seek by name and re-sends the position.

The viewer was never told. It drew the same progress bar it draws for a file,
so a backward drag on a streamed clip was refused and the bar snapped forward
under the operator's finger with nothing to explain it. A control that undoes
the gesture reads as BROKEN, where a disabled one reads as unavailable. That
is the distinction D62 exists for, and the refusal-plus-correction was on the
wrong side of it.

The viewer had a module for this — `clip-controls.ts`, with `ClipSeekFreedom`
— and **nothing imported it**. It also described playback RATE as a
per-provider set (the camera's `playSpeed`, 8 and 16 on a Reolink), which is
wrong twice: the rate applied to a clip is the BROKER's, re-pacing frames it
has already decoded, so the recorder's domain is the true one and `1.5` works;
and the camera's `playSpeed` is deliberately unwired (D597, D600). A module
describing a mechanism nobody built reads as verification that it exists — and
it was cited to the operator as a live defect it is not.

## Decision

The broker sends `clipTransport { clipId, seek, stepBack }` when it starts a
clip, and the chrome honours it. The feeder declares it: the stream feeder is
`{ seek: 'forward', stepBack: false }`, a file feeder says nothing.

**Absent is the freedom the viewer always had**, not the safest one. A feeder
that has not answered has not restricted anything, and a viewer newer than its
hub must not start refusing gestures that worked.

Named by clip, like `clipDuration` and `clipAudio`: a report landing after the
pointer moved on must not restrict whatever came next.

Only `forward` and `free` are accepted at both ends. A third word from a newer
broker is dropped rather than passed through — a freedom the chrome cannot
read must not decide what it draws.

## Consequences

- The report is sent SYNCHRONOUSLY and before the duration and audio ones:
  what a clip can be driven to do is known before a byte arrives, and the
  viewer needs it before the operator's first drag, not after a measurement
  resolves.
- `clip-controls.ts` loses its rate half. What remains is the seek freedom and
  the backward frame-step, which are real.
- The viewer still refuses locally rather than relying on the server's
  correction. The server refusal stays — it is the authority — but a surface
  that lets a gesture through and undoes it has already misled the operator.

## Enforcement

Server: `timeline-session-clip.spec.ts` pins both declarations, pins that a
feeder which cannot say sends NOTHING, and pins that every message this
surface emits is a valid server message. `clip-stream-feeder.spec.ts` pins the
declaration on the REAL feeder — the session's tests use a fake, and removing
the line left all 457 recorded tests green.

Viewer: `clip-controls.spec.ts` pins the fallback and the head-relative
comparison; `recording-messages.spec.ts` pins that an unknown freedom is
refused; `use-clip-stage-forward-only.spec.ts` pins the gate and the clip match
on the real hook. Both were unpinned on the first pass and both now fail when
removed — the third such gap found in one session, which is why each one got
its own disarm rather than a suite run.

While this was being written, the same `clipAudio` message D600 added turned
out to have no coverage at all. It has some now.
