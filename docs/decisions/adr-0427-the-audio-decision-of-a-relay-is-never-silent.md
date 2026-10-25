---
id: D427
title: The audio decision of a relay is never silent
status: accepted
date: 2026-09-10
applies-to:
  - packages/addon-provider-dreame/src/devices/dreame-rfc4571-server.ts
last-verified: 2026-09-10
---

## Context

The operator reported that the dreame robot camera arrives without audio. The
relay builds its RFC 4571 session once: it waits for the first H.264 keyframe,
then grants a **1.5 s grace** for the first AAC frame, and builds the SDP from
whatever it has. If no audio arrived in that window the SDP is video-only —
and, decisively, the `audioFrame` handler is never attached at all:

```ts
if (audioFacts !== null) stream.on('audioFrame', (adts) => muxer.sendAudioAdtsFrame(adts))
```

So a late first frame does not delay the audio, it removes it for the entire
life of the session. A robot vacuum that brings its microphone up a moment
after its camera is muted permanently, and reconnecting changes nothing because
the same race runs again.

That is a hypothesis about the code. What made it *unfalsifiable* is the second
defect: **the branch wrote no line**. The whole file logged only two
`logger.debug` calls, for consumer connect and disconnect. Twelve hours of hub
logs contained nothing that could distinguish "this camera has no microphone"
from "the grace window is too short" — the two diagnoses that lead to opposite
fixes. This repo already has the rule (*a branch that drops work silently logs
it*); this relay predates it.

Guessing a larger grace would have been the third mistake of the same night:
raising a timeout on a story, with no way to tell afterwards whether it worked
for the reason claimed.

## Decision

**The audio outcome of a relay session is always reported, both ways.**

- Audio found: `rfc4571: serving audio` with `codec`, `sampleRate`, `channels`
  and `waitedMs` — the format actually negotiated, not the one hoped for.
- No audio in the grace: `rfc4571: no audio within the grace — serving
  video-only` with `waitedMs` and the `audioGraceMs` that bounded it.
- **Audio that arrives after the grace**: a `warn`, once per session, with
  `lateByMs`. The SDP is negotiated once so this frame cannot join the session
  — but this line is the entire diagnosis. Its presence means the window is too
  short and names the number to raise it to; its absence over a period of real
  use means the camera genuinely has no audio, and the grace is not the
  problem.

The default grace is **left at 1.5 s** deliberately. It is tuned once the log
says what to tune it to, not before.

## Consequences

- The next robot session answers the question by itself, with a number.
- A raise, when it comes, is justified by `lateByMs` rather than by a guess,
  and its cost (added start latency for genuinely silent cameras) is weighed
  against a measured benefit.
- The same shape applies to any other relay that negotiates a track once from a
  race: report the outcome, or the failure is invisible for as long as nobody
  is watching the stream itself.
