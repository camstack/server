---
id: D621
title: 8× is the BROKER's pacer over media it HOLDS — the ladder is a fact about supply, 16× is refused by name rather than clamped, and silence caused by the rate SAYS the rate
status: proposed
date: 2026-09-23
supersedes:
applies-to:
  - packages/types/src/capabilities/videoclips.cap.ts
  - packages/addon-pipeline/src/stream-broker/recorded/control-protocol.ts
  - packages/addon-pipeline/src/stream-broker/recorded/clip-stream-feeder.ts
  - packages/addon-pipeline/src/stream-broker/recorded/timeline-session.ts
---

## Context

The operator asked for the two rates the picker has never drawn — *"Vai anche
con le 8 e 16"* [go with the 8 and 16 too] — and, in the same breath, removed the objection that had
priced them: *"L'audio non serve in velocità non 1x!!!"* [Audio is not needed at speeds other than 1x!!!]. He also widened the
scope in the direction that makes the work worth doing: *"Se sono utili anche
al nostro recording interno facciamolo"* [if they are useful for our internal recording as well, let's do it] — the broker's pacer is the same path
that plays our own recorded footage, so whatever it gains, every camera gains.

D620 had already removed the mechanism everyone assumed was needed. A Reolink
`<playSpeed>` is not a playback rate: at 1, 2, 4 and 8 the transfer is
byte-identical — same 947 472 bytes, 594 access units, 39.855 s presentation
span, 624 AAC frames — and only the wall clock moves. It buys SUPPLY, never
speed. So there was never a second mechanism to wire for 8×. There is one
mechanism, `ClipStreamFeeder`'s pacer, and what it needs is media in hand and
a clamp that does not move the number.

### What was refused first, and why

Widening `CLIP_BROKER_PACED_RATES` to `[…, 4, 8]` and stopping there. That is
the obvious change and it is wrong, because that one array was the rate list
for **two** envelopes with opposite supply:

| envelope | provider today | where the media is | measured supply |
| --- | --- | --- | --- |
| `file` | none yet; the recorder's own footage and any `readClipBytes`-only source reach the pacer the same way | wholly in hand, `stbl` indexed | bounded by disk, not by wall clock |
| `stream` | `provider-reolink` | arriving on a socket while the pacer consumes it | **1.2× (sub), 1.37× (main)** — D620, camera 107, with the `<ReplaySeek>` 0.11.1 sends before every replay |
| `realtimeStream` | `provider-hikvision`, `provider-amcrest` | an RTSP replay at record speed | **1.01×** — D616, camera 1436 |

The pacer consumes `rate` seconds of media per second of wall clock. Where the
media is HELD that is free. Where it is ARRIVING, the ceiling is the supply,
and giving Reolink `8` would have been the D612 defect multiplied by two: a
transport that cannot honour the `2` it already declares would have been handed
a number four steps further out.

### The thing that had to ship first

`ClipStreamFeeder.pushNextAudio` has discarded every audio frame while
`rate !== 1` since D600, counting them as `audioDroppedRate`. The operator's
rule was therefore already the live behaviour. What was missing was the
TELLING: the `clipAudio` server message's reason enum was
`not-negotiated | not-offered | no-audio-track | unsupported-codec |
codec-mismatch | stream-failed`, none of which names the rate. A clip silent at
2× and a clip silent because the stream broke were the same `carried: false`.

That is a D391 defect standing on its own, and it is the reason the ladder had
not moved: multiplying the rates multiplies the cases where the operator cannot
tell why there is no sound. It is also structurally different from the other
six — they are permanent facts about the clip, this one comes and goes under
his finger — so a report that settles once cannot express it.

## Decision

**A rate ladder is a fact about the SUPPLY behind a transport, not a taste. The
broker's pacer carries `8` over media it HOLDS and nothing else gains it until
its supply is measured above it. `16` is not a rate and is refused at the wire
rather than clamped in silence. And silence the RATE caused says so, by name
and with the rate, on a report that is re-issued whenever the rate crosses 1×.**

Corollaries, each of them a thing this record forbids:

- **`CLIP_BROKER_PACED_RATES` is `[0.25, 0.5, 1, 1.5, 2, 4, 8]` and is the
  WIDEST ladder there is** — the domain, not an envelope's offer. `file` carries
  it whole. `stream` carries `CLIP_STREAM_SOURCE_RATES`, frozen at the six it
  had, because D620 fixed the repair order — the supply first, the ladder
  after — and this record does not jump it. `realtimeStream` is unchanged.
  Every narrower ladder is a SUBSET of the widest; a rate in one of them that
  the clamp has never heard of is D612 with extra steps.
- **The clamp, the `setRate` bound and the ladder are one decision with one
  place to be written down.** `clampPlaybackRate` reads
  `Math.min(...BROKER_PACED_RATES)` and `Math.max(...)`; the `setRate` schema's
  `.max()` reads the same maximum. They were three literals — an array, a
  `Math.min(4, …)` and a `.max(4)` — and that is exactly how 8 and 16 came to
  be offered while the clamp served 4 with no line anywhere saying so. Nothing
  may re-introduce a literal there.
- **A ladder agreeing with a clamp proves nothing.** The gate is behavioural:
  `clip-stream-feeder.spec` plays the fixture out at EVERY entry and measures
  the wall milliseconds it took, against `1933.3 / rate`. Disarmed (clamp back
  to 4) the 8× row misses by 100.3 % — which is precisely "accepted 8, paced 4",
  the defect, reproduced on demand.
- **16× is refused, and the refusal is the honest answer rather than a
  shortfall.** Two separate things called 16× exist and neither is this one.
  The camera's `playSpeed 16` is an I-frame-only MODE — measured on 107: 10
  access units for a whole 36.3 s sub clip, 20 for the main twin at a 2 025 ms
  median spacing, no audio — which is different CONTENT, a stream of its own.
  The broker's honest twin of it would be a pacer that DROPS whole GOPs. What
  the pacer would actually do at 16 is push 16× the bitrate at a live WebRTC
  track: 4× already costs a `high` twin ~16 Mbit/s, 8× ~32, and 16× is where
  the wire, not the clamp, decides what the operator sees. So `setRate: 16` is
  rejected by the schema, and a caller that reaches the feeder anyway is NAMED
  (`clip-stream:rate-not-delivered { requested: 16, applied: 8 }`) rather than
  clamped in silence.
- **Silence caused by the rate is `reason: 'rate'` and carries the rate.** The
  pair is enforced, not documented: the `clipAudio` schema refuses `rate`
  without the reason and the reason without the rate, and
  `serializeServerMessage` parses on the way out, so a branch that gets it
  wrong throws instead of shipping. "No sound because of the speed" without the
  speed is the unanswerable message it replaces.
- **The overlay applies only to a clip that really is carrying sound.** A
  camera with no microphone is silent at 1× too; replacing `no-audio-track`
  with `rate` would swap the true cause for a transient one and send the
  operator to the speed chip. And **pause is not a rate** — nothing plays at
  all at 0, so the feeder holds its last non-zero rate and a `clipAudio`
  blaming the speed is never sent for a stopped clip.
- **One predicate decides both halves.** `audioPlaysAtRate(rate)` lives beside
  the clamp and is read by the branch that DROPS the audio and by the branch
  that TELLS the viewer why. A second copy of `rate !== 1` is the disagreeing
  second switch D62 forbids: the telling would then be able to describe a drop
  that did not happen. It commutes with the clamp — `clampPlaybackRate(x) === 1`
  exactly when `x === 1` — which is why a caller may read either rate.
- **`clipAudio` is now a FOLLOWED report, not only a settle.**
  `TimelineSessionClipFeeder.watchAudio` is how a feeder says the answer moved;
  `TimelineSession.sendClipAudio` is the one place that builds the message, for
  the settle and for every change alike, and it is where the clip-identity
  guard lives — a report that lands after the pointer has left names a clip
  nobody is playing, and the viewer would mute whatever came next.

## Consequences

- **What each provider ends up offering, and why:**
  - `provider-reolink` (`stream`): unchanged, `[0.25, 0.5, 1, 1.5, 2, 4]`. It
    does not gain 8 and it does not lose 2 or 4 in this record. D620 measured
    that it cannot honour those two today and named the repair — forward a
    `<playSpeed>` at least as large as the rate being paced, which is gated on
    `@apocaliss92/nodelink-js` hard-coding `<playSpeed>1</playSpeed>` in both
    replay builders. Shortening the ladder here would take away a control the
    fleet has had for a month on the strength of a measurement whose fix is one
    release away; widening it would make the lie worse. It is frozen, by name,
    in a constant whose docblock says so.
  - `provider-hikvision`, `provider-amcrest` (`realtimeStream`): unchanged,
    `[0.25, 0.5, 1]`. Their source arrives at 1.01×; nothing above 1 is
    deliverable and nothing above 1 is offered (D616).
  - **Everything reaching the pacer over HELD media gains 8:** the `file`
    envelope, and — because `getPlaybackOptions` is an `optionalMethod` and the
    recorder's own `analytics` source does not implement it — the viewer's
    fallback ladder, which is `CLIP_BROKER_PACED_RATES` itself. That fallback
    is also what plain recorded playback draws from, which is the operator's
    *"anche al nostro recording interno"* [also for our internal recording]: our own footage is on local disk and
    `RecordedFeeder` paces it off the same clamp.
- **No provider package was touched.** The rate a provider offers is a constant
  it names, and the three names it may pick from are all in `@camstack/types`.
- **The viewer needs two changes, and neither is in this repository.** They
  are listed here rather than made, because an agent owns `camstack/`:
  1. `src/components/camera/recorded-transport.ts` holds
     `MAX_PLAYBACK_RATE = 4` and an `isSupportedPlaybackRate` built on it —
     documented as the *"mirror of the hub `clampPlaybackRate`"*. It is a
     second authority and it is now wrong. Today it is referenced only from
     its own spec, so nothing filters 8 out at runtime (`clipRateChoices`
     takes `controls.rates` verbatim, *"including a rate this build has never
     heard of"*), but the mirror has to move or the next reader trusts it.
     `src/components/camera/__tests__/recorded-transport.spec.ts` also pins the
     ladder's labels as a six-element literal and goes red the moment the
     viewer's `@camstack/types` is bumped past 1.2.246.
  2. **Nothing in `camstack/` parses `clipAudio` at all** — not `src/`, not
     `embed/`; `embed/src/playback/recorded-track-session.ts` handles
     `servedProfile` and `clipDuration` and stops there. So the reason this
     record adds reaches nobody until the embed forwards it. What it needs is
     small: read `t === 'clipAudio'`, keep `{carried, codec, reason, rate}` per
     `clipId`, and render `reason: 'rate'` as a muted-by-speed affordance
     rather than a fault — an `N×` badge on the speaker, not an error. The
     other six reasons stay what they are. Rendering `rate` as a failure would
     be worse than the silence, because a disabled thing must never look broken
     (D62).
- **The 8× bitrate is the real ceiling, and it is a wire fact, not a clamp
  fact.** The pacer will push whatever it is asked to; what decides whether the
  operator sees smooth motion at 8× is the receiver's decode rate and the link.
  On a `low` or `mid` twin over LAN this is comfortable; on a `high` twin over
  WAN it is not, and it will present as a stall rather than as a refusal. That
  is unchanged in KIND from 4× and doubled in DEGREE. If it turns out to bite,
  the answer is a GOP-dropping pacer — which is also the only honest road to a
  16× — and not a bigger buffer.

## Enforcement

Four gates, each disarmed separately and each confirmed to bite:

| # | Gate | Disarm | Result |
| --- | --- | --- | --- |
| 1 | `clip-playback-options.spec` — 8 belongs to the transports that HOLD the media and to no other | `file.rates` → `CLIP_STREAM_SOURCE_RATES` | 2 failed |
| 2 | same | `stream.rates` → `CLIP_BROKER_PACED_RATES` (Reolink gains 8) | 2 failed |
| 3 | same | drop 8 from `CLIP_BROKER_PACED_RATES` | 1 failed |
| 4 | `control-protocol.spec` — the clamp reads the ladder's ends | `Math.min(4, …)` | 2 failed here, **2 failed in `clip-stream-feeder.spec`** (`rate 8: expected 1.0027931516060622 to be less than 0.15`) |
| 5 | same — the wire bound reads the same ceiling | `.max(MAX_PACED_RATE)` → `.max(4)` | 2 failed |
| 6 | same — `rate` present exactly when `reason` is `rate` | remove the schema `.check` | 2 failed |
| 7 | `clip-stream-feeder-audio.spec` — the answer is re-issued when the rate moves | remove `refreshAudioReport()` from `setRate` | 2 failed |
| 8 | same — the overlay never overwrites a real cause | drop the `!settled.carried` guard | 1 failed |
| 9 | same — pause is not a rate | let `setRate(0)` set `audioRate` | 1 failed |
| 10 | same — the drop reads the shared predicate | make `pushNextAudio` push at every rate | 1 failed |
| 11 | `timeline-session-clip.spec` — a late change is not pinned on the next clip | remove the identity guard | 1 failed |
| 12 | same — the feeder's changes reach the wire | do not wire `watchAudio` | 1 failed |

The behavioural gate is #4's second half and it is the one that matters: it
reads no constant of the feeder's, it plays the fixture out and measures the
wall clock. `npm run codegen` was run (`videoclips.cap.ts` changed).

What is NOT guarded, deliberately: that a receiver can actually decode 8× of a
`high` twin. Nothing in this repository can measure the operator's link, and a
gate that pretended to would be the fake supplying the value production forgot
to fetch.
