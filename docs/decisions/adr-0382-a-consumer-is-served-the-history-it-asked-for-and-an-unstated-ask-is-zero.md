---
id: D382
title: A consumer is served the history it ASKED for, and an unstated ask is zero
status: accepted
date: 2026-09-07
supersedes:
applies-to:
  - packages/addon-pipeline/src/stream-broker/rtsp/restream-intent.ts
  - packages/addon-pipeline/src/stream-broker/rtsp/rtsp-session.ts
  - packages/addon-pipeline/src/stream-broker/rtsp/rtsp-restreamer.ts
  - packages/addon-pipeline/src/stream-broker/rtsp/rtsp-listen-server.ts
  - packages/addon-pipeline/src/stream-broker/prebuffer.ts
---

## Context

D381 removed six prebuffer knobs and left one: the broker decides whether it
holds history and for how long, and *a consumer never configures a window; it
asks*. That half of the sentence was true. The other half was not implemented.

There was no way to ask for **less**, and no way to ask for **nothing**.
`capPreRollRequestMs(requestedMs: number | undefined, retainedMs)` read
`undefined` as "whatever you have" (`prebuffer.ts`), the broker's supplier
called `getRtpPreRollBuffer()` with no argument
(`stream-broker.ts`, the `setPreRollSupplier` thunk), and the restreamer served
the resulting window to **any** session whose dial path carried an intent
(`rtsp-restreamer.ts`, `if (preRollIntent !== null)`). So the ask was decided by
its own absence, everywhere, for everyone.

That mattered because the two intents were not created for the same reason.
`/recording` exists to be served history — the recorder attaches at the trigger
and its footage would otherwise start after the event (D192, camera 1438).
`/muted-detection` exists for something else entirely: to be **exempt from the
live-edge join withhold**, a rule measured for re-clocked consumers that a
detection decode is not (`restream-intent.ts`, Stage 0). Detection declared that
suffix to lift a withhold. Under D381 the same suffix silently bought it the
whole prebuffer — and D381's own consequences section names this as "the one
cost this record buys with somebody else's money", accepted with the note that
detection latency after the change **was not measured**.

It could not be measured, either. The only per-attach broker line was
`restream pre-roll served` (a decision, not an outcome, and only for a declared
intent); the rest was `restream prime (lat-probe)`, a per-STREAM aggregate. On
the consumer side `session-decode: detection first frame` carried `firstFrameMs`
but nothing about the burst, and its own comment says so: "`primeSpanMs` is
deliberately absent … correlate by deviceId". Correlating by `deviceId` across
back-to-back attaches is not correlating, and the decode worker's `User-Agent`
was the shared constant `decode-worker` — the exact defect the recorder's
`consumerTag` had already been created to fix (`ffmpeg-args.ts`: "it used to be
the constant `recorder` … which is why `restream pre-roll served` could name a
consumer and still identify nothing"). The census of 2026-09-07 measured 17
served bursts against 127 unserved in 90 minutes, inside 10-second statistics
windows: a 4-second transient cannot be seen through that by construction.

## Decision

**The dial states BOTH halves: what this consumer is, and how much history it
asks for. An unstated ask is ZERO, never "everything".**

The amount travels as a path segment, `/preroll-<ms>`, after the intent suffix,
parsed by the same module that writes it. `ParsedRestreamPath` carries a
`RestreamDeclaration` — one shape, so a caller cannot state a purpose and forget
to state a number — and `NO_DECLARATION` is `{ intent: null, preRollRequestMs: 0 }`.
`capPreRollRequestMs(requestedMs: number, …)` and
`StreamBroker.getRtpPreRollBuffer(requestedMs: number)` take the amount as a
REQUIRED parameter: an ask that can be omitted is a default acting without a
decision, which is the shape D381 retired for the retention and this record
retires for the ask.

**An intent alone buys only what that intent was for.** A detection dial that
names no amount is still exempt from the live-edge withhold and is served the
ordinary current-GOP burst — byte-for-byte what it received before there was a
prebuffer at all.

**Both shipped dials now name their number, in the open, in the module that owns
the grammar**: `DETECTION_PRE_ROLL_REQUEST_MS` and
`RECORDING_PRE_ROLL_REQUEST_MS`, both `PREBUFFER_MAX_MS` — "as much as you
kept". Detection's value is deliberately the behaviour D381 already shipped:
this record makes the ask explicit and measurable, it does not change what the
fleet does. Whether detection should ask for less is an operator's call on the
numbers below, not a constant a session changes on its own.

**And the join is instrumented per attach.** `restream attach live-edge` fires
once per session, tagged `deviceId`, naming `requestedMs`, `retainedMs`,
`preRollSpanMs` (history delivered BEYOND the ordinary burst — `0` for a plain
join, so both populations are comparable on one line), `burstSpanMs`,
`gopSpanMs`, `drainMs` and `liveEdgeMs` (PLAY → on the live feed). A
history-free attach is throttled to one per stream per 10 s; an attach that
carried history is **never** throttled, because that is the rare population the
question is about. The decode worker's dial now carries
`decode/<deviceId>/<dial>` as its `User-Agent`, so a served burst and the first
frame it produced are one attach and not two coincidences, and
`session-decode: detection first frame` names the `preRollRequestMs` it dialed
with.

## Consequences

- **The question D381 left open is answered, on the fleet, and the answer is
  no.** One hour on the live hub, 2026-09-07, with this instrumentation running:
  239 attaches, 56 of them carrying history, 235 first-frame lines.

  | | n | `liveEdgeMs` p50 | p90 | `drainMs` p50 | `preRollSpanMs` p50 |
  | --- | --- | --- | --- | --- | --- |
  | attach WITH history | 56 | **313 ms** | 343 | 307 | **3 995 ms** |
  | attach with none | 183 | **171 ms** | 304 | 142 | 0 |

  | | n | `firstFrameMs` p50 | p75 | p90 |
  | --- | --- | --- | --- | --- |
  | first frame after a pre-roll attach | 48 | **483 ms** | 949 | 1 074 |
  | first frame, no pre-roll | 187 | **780 ms** | 1 102 | 1 600 |

  The pre-roll costs **~142 ms** on the broker side — the paced replay's drain,
  bounded at ~320 ms by `PacedRtpReplay`'s own budget and NOT a function of the
  window — and the first decoded frame arrives **sooner**, not later, in 7 of the
  9 cameras where both populations appear (hall 389 vs 886, studio 535 vs
  1 091, porch 461 vs 927; kitchen and parking are the two where it does
  not, on n=2 each). Four seconds of media is delivered in 0.3 s and decoded
  faster than real time; the transient the census could not see is not there.
  The plausible mechanism for the improvement is the one Stage 0 was built on:
  an attach served a burst starts on a keyframe it already has, instead of
  waiting up to a full IDR interval for the next live one.

- **`preRollSpanMs` is 3 995 ms against a 5 000 ms prebuffer, every time.** The
  ring holds ~4 s of the 5 s configured — the keyframe-aligned selector cannot
  start before the oldest retained IDR. That is the honest degradation D192
  demanded be visible, and it is now visible per attach instead of being
  inferable from nothing.

- **Detection's behaviour is UNCHANGED by this record, deliberately.** The ask is
  `PREBUFFER_MAX_MS`, which resolves to exactly what D381 was already serving. It
  is now a decision with a name, a rationale and a measurement behind it rather
  than the consequence of an omission — and the numbers above are the input an
  operator needs to change it. Nothing here narrows a window on its own.

- **A history-free attach is throttled and a history-bearing one is not.** The
  common population would otherwise be one info line per join per camera; the
  rare one is the entire point. The throttle is per restreamer (per stream), so
  a quiet camera is never starved by a busy one.

- **The decode dial's `User-Agent` is now per attach.** It was the shared
  constant `decode-worker`, which made the broker's `consumer` field
  unfalsifiable — the same defect `ffmpeg-args.ts` records for the recorder's old
  constant `recorder`. Two attaches on the same camera minutes apart are now two
  identities, which is what makes a slow start attributable instead of averaged
  away.

- **What this does NOT measure, and a future session should not assume it does.**
  `firstFrameMs` is dial → first DECODED frame. First INFERENCE is downstream of
  it and is not measured anywhere (`runner.ts`'s `e2e` starts at the runner's
  enqueue). The correlation above is by camera name within a 4 s window, not by
  the per-attach `consumer` tag, because the runner's line does not yet carry
  that tag — the tag exists on the broker side and closing that last seam is one
  field on `session-decode: detection first frame`. And the whole sample is the
  HUB's brokers: the agent nodes' restreamers did not appear in the forwarded
  log during the window.

## Enforcement

- `scripts/check-single-prebuffer-knob.ts` grew two checks, both wired into
  `.github/workflows/ci.yml` through the existing job: a pre-roll REQUEST
  constant may be declared only in `restream-intent.ts`, and no file may call
  `withDetectionIntent(` / `withRecordingIntent(` with a single argument.
  Verified by reintroducing both shapes in `pipeline-runner/index.ts`: 2
  violations, exit 1.
- `packages/addon-pipeline/src/stream-broker/rtsp/__tests__/restream-intent.spec.ts`
  — the grammar in both directions: an intent with no amount parses to `0`, a
  request without an intent is not a request, an unparseable amount is `0` and
  never the window, and the amount is clamped at `PREBUFFER_MAX_MS`.
- `packages/addon-pipeline/src/stream-broker/__tests__/rtsp-pre-roll-prime.spec.ts`
  — the serve: a detection dial that named no amount gets the current GOP, that
  same session still has the live-edge withhold lifted (losing it would trade
  one regression for another), and two sessions asking for different amounts get
  two different windows. Counterproof run: restoring the D381 shape (plan built
  from the whole retention, request ignored) turns 2 of them red.
- The same file pins the attach line: `preRollSpanMs` is the history beyond the
  ordinary burst, a plain join reports `0`, and it is reported at all — the
  control group the pre-roll cost is measured against.
