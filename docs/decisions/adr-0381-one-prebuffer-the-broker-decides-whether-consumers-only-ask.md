---
id: D381
title: One prebuffer — the broker decides whether and how long, and a consumer only asks
status: accepted
date: 2026-09-07
supersedes:
applies-to:
  - packages/addon-pipeline/src/stream-broker/prebuffer.ts
  - packages/addon-pipeline/src/stream-broker/prebuffer-migration.ts
  - packages/addon-pipeline/src/stream-broker/pre-roll.ts
  - packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker.ts
  - packages/addon-pipeline/src/recorder/addon/band-decision.ts
  - packages/types/src/interfaces/recording-config.ts
---

## Context

Six names meant three things.

| knob | where it was set | what it actually did |
| --- | --- | --- |
| `preBufferEnabled` | per camera-stream override | held the source dialed with no consumer |
| `preBufferSec` | per stream + cluster (`defaultPreBufferSec`) | sized the **Annex-B** ring |
| `detectionPreRollMs` (`preRollMs`) | per stream + cluster | sized the history a detection dial is served |
| `recordingPreRollMs` | cluster | sized the history a `/recording` dial is served |
| ring retention | derived | `max(detection, recording)` |
| `RecordingBand.preBufferSec` | per camera, recording config | which written segments survive a trigger |

Three concepts: keep the source warm, how much history to hold, and which
already-written media to keep. Four of the six were expressions of the second
one, in two units, in two addons, on two settings screens, with an invariant
("the recorder's keep gate is never narrower than the ring", D193) that the
operator had to maintain by hand across both.

**The census of 2026-09-07 measured what that cost, and the finding is worse
than duplication.** On the live hub, all 22 warm streams reported
`preBufferSec: 10` and `preBufferMs: 0`. The Annex-B ring the seconds knob sizes
is populated only for non-RTP sources (`stream-broker.ts`: "its video is never
flushed for RTP sources"), and every camera on this fleet is RTSP. So the one
number an operator could see and set **retained nothing at all**, on every
camera, for as long as it has existed — while the history that did exist was
sized by `recordingPreRollMs` on a different screen, and reported nowhere near
it.

The subscriber view was wrong in the same direction. The synthetic
`prebuffer-hold` row was gated on "no encoded subscriber", which is not the same
as "no holder": of the 22 warm streams, **12 were held by a real RTSP or decoded
consumer and still named the prebuffer as their holder**, and a camera the
prebuffer really was holding alongside an encoded consumer showed no prebuffer
row at all. "Who is keeping camera 102 warm?" had a confident wrong answer.

And the defaults contradicted each other. `StreamBroker._preBufferEnabled`
shipped `true` — with a comment explaining that the natural reading of the flag
is "keep the stream alive permanently" — while the settings screen resolved the
same question as `perStream?.enabled ?? false` and displayed OFF. Neither was
the configuration; there were two.

The obvious alternative was to keep the knobs and document the relationships.
That is what D192 and D193 already did, carefully, and it is how the fleet
arrived at a setting that retains nothing: a rule nothing checks has already
been broken somewhere.

## Decision

**There is ONE prebuffer.** It is a broker configuration, per camera-stream:
`enabled` (hold the source dialed and keep history) and `seconds` (how much).
Nothing outside the broker writes either, and every ring the broker owns is
sized from it — the source-RTP ring for RTSP cameras, the Annex-B ring for push
sources, the decoder seed. `resolvePrebuffer` is the only place the question is
answered, and the settings screen DISPLAYS that same answer, so a switch can no
longer report off on a function that is on.

**A consumer never configures a window; it asks.** A dial that declares an
intent (`/recording`, `/muted-detection`) is served what the ring holds, and
every read goes through `capPreRollRequestMs(requested, retained)` — a request
is answered with the smaller of what was asked and what exists, and an absent
request means "whatever you have". `detectionPreRollMs` and `recordingPreRollMs`
are gone as configuration; `getPreRollRetentionMs()` is no longer a maximum over
settings, it is the prebuffer.

**The recorder's keep gate is derived, not configured.** `RecordingBand.preBufferSec`
is retired: its only correct value was ever "at least as wide as the widest
history the broker can serve", so it IS that ceiling — `resolveBandBufferMs`
returns `PREBUFFER_MAX_MS`. A keep gate can no longer be set narrower than the
media the broker just handed the writer. `postBufferSec` stays a per-band
setting, because it is the LIVE demand window and a genuine policy about this
camera at this hour.

**Defaults, and they are the honest statement of what already runs.** ON for a
mains camera's warm (`high`) profile — which is what the broker has been doing
while the UI said otherwise; OFF for a battery camera and for a `pull-http`
terminal relay, stated once here instead of three times (`isDefaultWarm`,
`getEffectivePreBufferSec`, `resolveRecordingPreRollMs`); `seconds` ships at
**5**, down from 10.

Five, and not ten, is a measurement. The 10 s never bought retention through the
knob that named it, but the fleet DID retain 10 s through `recordingPreRollMs`,
whose default was 10 s and ON. Across the 22 warm streams — 112.8 Mbps in total,
mean 5.1 Mbps, peak 8.0 — that retention weighs **206.6 MiB** at the budget's
1.5x GOP headroom, and **103.3 MiB** at 5 s. The audit that motivated the
recording pre-roll (D192, camera 1438) measured the need as "the footage began
after the motion", which is seconds of margin, not tens. So half the RAM, on the
node that also runs decode, for a window that still covers the failure it was
built for — and an operator who wants more raises one number that now means what
it says.

## Consequences

- **DETECTION now receives the same history a recording does, and that is the
  one cost this record buys with somebody else's money.** The shipped detection
  window was `0` and the recording window `10 s`; one configuration cannot keep
  them apart, so every detection dial on the fleet is now served up to the
  prebuffer. Measured on the hub 3 minutes after deploy: `prebufferMs=5000`
  with `detectionPreRollServed=true preRollSpanMs=4560` (3833) and `4913` (103),
  where before the same dials took the current GOP.
  D193's first coupling named this exact cost — "hands every detection dial on
  the fleet a backlog to drain before it reaches the live edge" — and it is
  accepted here for three reasons: 5 s is inside the 6 s ceiling detection
  already had, so it was always a representable configuration; the burst is
  paced and keyframe-aligned (D57) with the span bound widened only for the
  session that declared an intent; and a detection decode drains at source rate
  while publishing throttled, which is why D125 wanted this window in the first
  place. **It is nonetheless the thing to watch**: detection latency after this
  change was NOT measured, and the levers are the cluster seconds and a
  per-stream override, both of which now move one number.
- **A camera's history is one number, reported next to itself.** The prime log
  line carries `prebufferMs` (retained) and `preRollSpanMs` (delivered) plus
  which intents joined, instead of four keys across two windows.
- **The prebuffer hold is a session.** It has an id (`prebuffer:<brokerId>`), a
  start time, and it is listed beside every other holder rather than instead of
  them. It is deliberately NOT killable: the authority over it is the prebuffer
  switch (D62), and a kill the next reconcile silently undoes is exactly the
  second disagreeing knob this record removes.
- **`_preBufferEnabled` starts `false`.** Unconfigured means off, and the
  manager applies the resolved prebuffer to every broker it creates, so the ON
  default arrives from the one place that decides it rather than from a field
  initializer nobody could see.
- **Turning the prebuffer on adopts a duration.** `{ enabled: true, seconds: 0 }`
  is unrepresentable: a switch that reports on and retains nothing is the shape
  of knob this record exists to remove. (Found by a test during this work.)
- **A band that carried `preBufferSec: 0` now keeps up to 15 s of pre-trigger
  footage.** That is the one behaviour change, it is a widening, and the media
  it keeps was written either way. An explicit `0` was previously excluded from
  D193's invariant by name; there is no invariant left to be excluded from.
- **Two migrations, both explicit, neither a silent strip.** The per-stream
  `DeviceOverride.preRollMs` becomes a prebuffer of the same seconds
  (`migrateRetiredPreRollOverride`, rounding UP); the band `preBufferSec` is
  dropped on read (`stripRetiredBandPreBufferSec`). Both retired keys stay
  DECLARED in their shapes for exactly this reason: a key merely deleted from a
  non-strict `z.object` disappears on the next save with no line anywhere, which
  is the failure D380 came one commit from shipping.
- **D192 and D193 are superseded in their configuration half, not their
  mechanics.** "The broker ring is the only pre-roll" (D192) is stronger now —
  it is the only retention as well. "One ring, two windows" (D193) is one ring,
  one window; its byte budget, its decoder-seed rule and its battery rule all
  survive, in one place each. D57's pacing and keyframe alignment are untouched.
- **The cluster keeps a per-stream override.** The default is a profile-shaped
  guess; an operator who typed a number for one camera has answered the question
  the guess was making, and that still wins over battery and over the relay rule.

## Enforcement

- `scripts/check-single-prebuffer-knob.ts`, wired into `.github/workflows/ci.yml`
  — fails if any file outside the prebuffer modules declares a pre-roll
  duration, resolver or ceiling; if a retired settings key (`preRollMs`,
  `recordingPreRollMs`) reappears on a screen; or if `preBufferSec` reappears in
  the recorder or in the recording settings forms. Verified by reintroducing
  both shapes: 2 violations, exit 1.
- `packages/addon-pipeline/src/stream-broker/__tests__/prebuffer.spec.ts` — the
  one resolution, including the battery and relay defaults, the override that
  beats them both ways, and `{ enabled: true, seconds: 0 }` resolving to off.
- The same file pins `capPreRollRequestMs`: a wide request is capped at what is
  retained, an absent request is the whole window, and a nonsense one is `0` —
  never the whole window, so an unparseable number cannot widen a burst.
- `packages/addon-pipeline/src/stream-broker/__tests__/pre-roll.spec.ts` — the
  mechanics still admit the WHOLE prebuffer: a selector that refused the
  keyframe the ring retained, or a span bound that withheld a burst for being as
  wide as configured, would make the knob read as ON and behave as OFF.
