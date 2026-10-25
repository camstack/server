---
id: D192
title: The broker ring is the only pre-roll
status: accepted
date: 2026-08-20
supersedes:
applies-to:
  - packages/addon-pipeline/src/stream-broker/rtsp/restream-intent.ts
  - packages/addon-pipeline/src/stream-broker/rtsp/rtsp-session.ts
  - packages/addon-pipeline/src/stream-broker/pre-roll.ts
---

> **Superseded in part by [D381](adr-0381-one-prebuffer-the-broker-decides-whether-consumers-only-ask.md)
> (2026-09-07).** The rule survives and is stronger — the broker's ring is the
> only pre-roll AND the only retention — but the DURATION is no longer
> `preRollMs`. It is the one prebuffer (`enabled` + `seconds`), and the
> recorder's `preBufferSec`, described below as "the retroactive KEEP bound…
> honest only while it is at least as wide as the pre-roll", is retired: a
> number whose only correct value is another subsystem's ceiling is that
> ceiling, and it is derived now rather than maintained by hand.

## Context

An `events`-band recorder spawns its ffmpeg writer AT the trigger. ffmpeg then
dials, waits for a keyframe, and writes — so the first frame it can possibly
record is the live edge, which is after the event. The audit of 2026-08-20
measured the consequence on camera 1438: **the footage began after the motion in
60 % of episodes**. The feature reads as "record the event"; it recorded the
part of the event that had not happened yet.

The broker already retains the missing seconds. `getRtpPreRollBuffer` serves a
keyframe-aligned window reaching `preRollMs` into the past, and the recorder is
an ordinary RTSP client of that restreamer. But the window was served to ONE
population — a dial carrying `DETECTION_MUTED_PATH_SUFFIX` — and a recorder
cannot join it: that suffix means muted, and a recording keeps its audio.

The obvious alternative was a `preBufferSec` on the recorder that pre-dials or
buffers its own seconds. That is a second retention of the same bytes on the
same node, a second number to configure, and — worse — a number that can
disagree with what the ring actually held. This repo has shipped two knobs for
one function before (D62); the recorder's own `preBufferSec` was already being
read as a pre-roll setting when it is nothing of the sort.

## Decision

There is ONE pre-roll in this system and it belongs to the broker: the ring, of
the duration that stream's `preRollMs` is configured with, bounded by
`PRE_ROLL_MAX_MS`. A consumer that attaches after the edge it needs to see
DECLARES an intent on its dial path and receives whatever the ring held — it
never configures a duration of its own and never asks for a number.

`RECORDING_PATH_SUFFIX` (`/recording`) is that declaration for the recorder:
non-muted, so a recording keeps its audio, and served the same pre-roll window
detection gets. The two intents are siblings — `RtspSession.wantsPreRoll()` —
and stay distinct from `isDetectionIntent()`, which additionally lifts the
live-edge withhold and must not be lifted for anyone else.

The recorder's `preBufferSec` is NOT that duration. It is the retroactive KEEP
bound of [D191](adr-0191-an-event-recording-is-kept-against-every-trigger-window-not-the-last-one.md),
and it stays honest only while it is at least as wide as the pre-roll the broker
can serve: wider can only over-keep footage that exists, narrower would delete
media the broker just handed the writer.

## Consequences

- The pre-roll a recording actually carries is whatever the ring HELD, which is
  never more than it retained. `getRtpPreRollBuffer` degrades to the current GOP
  for a source that had not been warm long enough, and the recorder is told so
  rather than pretending: the broker's `restream prime (lat-probe)` line carries
  `preRollMs` (configured) and `preRollSpanMs` (delivered) side by side, and the
  recorder logs at `info` when its dial carries no intent at all.
- **The single knob is the broker's `preRollMs`, per stream or cluster-wide, and
  it ships OFF (`DEFAULT_PRE_ROLL_MS = 0`).** A recorder on a stream with
  pre-roll off gets today's behaviour — the current GOP — honestly and by
  construction. Turning on event pre-roll is turning on the broker's ring.
- A cost the operator does not choose separately: retained RTP bytes on the
  ingest node now feed viewers' recordings as well as detection. The ceiling is
  unchanged (`PRE_ROLL_MAX_MS`, 6 s) because both planes honour the same maximum.
- The first segment of a recording that carried pre-roll is OLDER than its own
  name: ffmpeg names a segment when it opens it, which is when the burst
  arrives, while the media in it begins up to `preRollMs` earlier. Correcting
  that label needs the broker to report the span it actually served, which
  crosses a capability boundary (`RtpSource`) and is therefore train-bound —
  **still open**, recorded here so the skew is not rediscovered as a bug.
- `restream-intent.ts` is imported directly by its consumers across addon
  boundaries (`pipeline-runner` already did; the recorder now does too). That is
  deliberate and predates this record: a suffix written by one addon and parsed
  by another has no test that catches the two drifting apart if it is declared
  twice. It is a URL wire format, not a cross-addon API.

## Enforcement

- `packages/addon-pipeline/src/stream-broker/__tests__/rtsp-pre-roll-prime.spec.ts`
  — `RtspRestreamer — pre-roll on the recording join` pins that a recording dial
  receives the window and that the plain viewer beside it still gets the current
  GOP (the D57 blast radius).
- `packages/addon-pipeline/src/stream-broker/rtsp/__tests__/restream-intent.spec.ts`
  — round-trips the suffix the recorder writes through the parser the listen
  server uses.
- `packages/addon-pipeline/src/recorder/addon/__tests__/band-decision.spec.ts` —
  `pre-roll contract: the gate can never be narrower than the ring` fails if
  `PRE_ROLL_MAX_MS` is ever raised past the default keep window, which is the
  silent drift this record exists to prevent.
