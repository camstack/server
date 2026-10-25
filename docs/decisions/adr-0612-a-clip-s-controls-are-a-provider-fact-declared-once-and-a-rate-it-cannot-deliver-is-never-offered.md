---
id: D612
title: A clip's controls are a PROVIDER fact, declared once — and a rate it cannot deliver is never offered
status: accepted
date: 2026-09-23
supersedes: D602
applies-to:
  - packages/types/src/capabilities/videoclips.cap.ts
  - packages/addon-pipeline/src/stream-broker/recorded/control-protocol.ts
  - packages/addon-pipeline/src/stream-broker/recorded/clip-stream-feeder.ts
  - packages/addon-provider-reolink/src/clips/reolink-videoclips-provider.ts
---

## Context

The operator: *"i playback rates reolink non sono rispettati."*

### What was measured, and what it refutes

The standing hypothesis was that the provider STREAM transport (D597, D599)
cannot outrun the camera: frames arrive at the camera's pace, so the feeder can
hold them back but never go faster, and 2x/4x quietly deliver 1x. **That is
false, and the numbers are not close.**

Device 107, live hub, three clip sessions inside one minute (`clip-stream:*`
lines read back from `logs.query`, 2026-09-23 06:55):

| session | first-frame → ended | clip length | arrival | queued at end |
| --- | --- | --- | --- | --- |
| `ec0b8cdd` | 681 ms | 33 873 ms | **49.7x** | 497 / 508 samples |
| `ec0b8cdd` (2nd clip) | 576 ms | 35 673 ms | **61.9x** | 526 / 535 |
| `141933f2` | 555 ms | 33 873 ms | **61.0x** | 499 / 508 |

`bytesIn` was 474–583 KB against a 64 MB backlog ceiling
(`CLIP_STREAM_BUFFER_MAX_BYTES`), so the socket was never paused and `dropped`
was 0 on every one. The whole clip is decoded and queued before the eleventh
frame is pushed. Arrival is not within an order of magnitude of being the cap.

The third session then **delivered 4x, end to end**. It played from
06:55:39.515 and paused (`set-rate-zero`) at 06:55:46.323 — 6 808 ms of wall —
having pushed 222 access units covering 14 740 ms of media. A constant 2x is
arithmetically impossible (it yields 13 616 ms, short of what was pushed); 1x
for 4 164 ms followed by 4x for 2 644 ms gives 62.6 + 159 = 222 frames and
14 740 ms exactly. The operator set 4x and got 4x.

Reproduced off the fleet on the real fixture (`clip-frag.mp4`, 30 frames at
15 fps) with the whole clip pre-delivered: 1 000 ms of wall pushed 8 frames at
0.5x, 16 at 1x, and the full 30 at 2x and 4x. The pacer honours the rate.

### So what was actually broken

Two things, neither of them the pacer.

1. **The viewer kept its own list.** `PLAYBACK_RATE_OPTIONS` in
   `recorded-transport.ts` is a constant, offered for every clip. The camera's
   own `<playSpeed>` domain includes 8 and 16; the broker's `clampPlaybackRate`
   answers `{0} ∪ [0.25, 4]`. Ask for 8, get 4. Ask for 16, get 4. **Nothing
   anywhere logged it** — a branch that accepts work and produces something
   else, which is the same branch as one that drops it (D391).
2. **The server's own declaration was on the wrong level.** `clipTransport`
   (D602) told the viewer, per clip, what that clip could be driven to do. It
   cannot vary per clip. `chooseClipPath` reads exactly two inputs —
   `streamDialWired` and `fileReadWired` — and both are constants of the
   broker's compiled-in closure over the provider's methods; the `profile` it
   is handed is documented as *"kept for the log line and NOT read by the
   decision since D599"*. Every clip of a provider is served the same way. The
   per-clip channel carried a value with no information in it, and was paid for
   with a message on every `playClip`.

## Decision

**The controls a surface draws for a camera's clips are declared ONCE, by the
provider, and a rate that cannot be delivered is never offered.**

- `videoclips.getPlaybackOptions({ deviceId, provider })` is the one authority.
  It returns `{ transport, seek, stepBack, scrub, rates }` and is asked per
  camera, before a clip is picked — which is when a surface needs it, not after
  the first byte. It is answered from a constant and never costs a camera call.
- A provider never composes an envelope. It returns one of the two spelled in
  `CLIP_PLAYBACK_OPTIONS` — `stream` (forward, no step-back, no scrub) or
  `file` (free, step-back, scrub) — chosen by which accessors it wires. That is
  what makes "the declaration may not promise what no clip can be given"
  structural rather than a discipline: there is nothing else to promise.
- `CLIP_BROKER_PACED_RATES` is the one rate ladder: `[0.25, 0.5, 1, 1.5, 2, 4]`.
  `1.5` is in it because a re-pacer has no reason to refuse it. `8` and `16`
  are not, because they are the camera's mechanism and it is unwired.
- **`clipTransport` is removed** from `ServerMessageSchema`, from
  `TimelineSessionClipFeeder` and from the feeder. No bridge, no negotiation,
  no transitional period with both.
- A rate the broker accepts and does not deliver is NAMED:
  `clip-stream:rate-not-delivered { requested, applied, deliverable }`, with
  `tags: { deviceId }`.

## Consequences

- **Rollout order: the VIEWER ships first, and the hub follows.** The two halves
  travel on different trains — the server through a publish +
  `applyServerUpdate` (this touches `packages/types`, so a `camstack deploy` is
  not enough), the viewer through an OTA — so a mismatch window is unavoidable.
  It is not symmetric. `clip-controls.ts` reads the ABSENCE of `clipTransport`
  as `LEGACY_CONTROLS` — free seek, backward step — deliberately, so that a
  viewer newer than its hub never refuses a gesture that worked. An OLD viewer
  against a NEW hub therefore falls back to free seeking on a forward-only
  stream: drag back, the bar snaps forward, nothing explains it — the original
  D602 defect, returned. Shipping the viewer first costs nothing and means that
  case never occurs at all, rather than occurring briefly. A new viewer against
  an old hub is harmless: `getPlaybackOptions` is an `optionalMethod`, an
  absent answer is the same "freedom you always had", and the operator has
  accepted a period of misalignment either way.
- **The camera's `playSpeed` is still not wired, and now it is priced.** The
  work: an input on `dialClipStream` → forwarded by the provider into the cmd-5
  replay's `<playSpeed>` → the rate joins `CLIP_BROKER_PACED_RATES`. The cost is
  not the plumbing, it is what a rate change BECOMES: because the camera paces
  the replay, changing the rate means a new dial and a new stream — first frame
  again (measured 139–543 ms on 592), the buffered remainder of the clip thrown
  away, and the position re-established. Today a rate change is a re-anchor of
  a pacer, at zero cost, over frames already in hand. And the audio does not
  survive it: D600 has no resampler on this path, so a camera-paced 8x is
  necessarily silent — where a broker-paced 2x is also silent, but by a choice
  that can be reversed with a decoder. Given that arrival is measured at 49–62x
  and the broker already reaches 4x for free, `playSpeed` buys only the rates
  ABOVE 4, at the price of a stream restart per change.
- **`seek: 'forward'` for Reolink is a CURRENT measurement, not a property of
  the vendor.** A parallel measurement the same day found that the camera CAN
  seek inside a clip — cmd 123 `<ReplaySeek>`, addressed by wall-clock second,
  snapping to the nearest I-frame (~2 s GOP), verified on 592 and on a Home Hub
  child by reading back the I-frame timestamp that actually arrives. It is
  unreachable today: `BC_CMD_ID_REPLAY_SEEK` is declared and never used in
  `@apocaliss92/nodelink-js`, and two bugs there (an `isHardError` numeric band
  that swallows the post-seek timestamp stamp, and a header-length allow-list
  that mis-parses the class) make a seeked replay look like a failure. When
  that library release lands, this provider is expected to answer
  `CLIP_PLAYBACK_OPTIONS.file`-style freedom for seek; the enum already has
  `'free'`, so nothing widens — only the envelope a provider picks changes.

- **Nothing gained a way to say "unknown".** The envelope is a statement about
  wiring, which is always known. A provider that cannot answer omits the method,
  and absence means the old freedom.
- One sharp edge is left as found and named here: a videoclips provider that
  implements only `readClipBytes` (the recorder's `analytics` source, HKSV) is
  still routed to the STREAM path by `chooseClipPath`, because the broker's
  `streamDialWired` is about the BROKER's closure and not about that provider,
  and the dial then answers `unavailable`. Those providers do not implement
  `getPlaybackOptions` yet, so they declare nothing and the viewer keeps the
  legacy freedom. Making the path choice per-provider is a separate change.
- `packages/types/src/capabilities/videoclips.cap.ts` now carries
  `CLIP_PLAYBACK_OPTIONS` **after** the capability definition, with a comment
  saying why: `scripts/lib/parse-cap.ts` finds a capability by the FIRST
  `export const <X> = {` in the file, so an object literal above
  `videoclipsCapability` is silently taken for the capability and codegen emits
  a `DeviceProxy` entry that does not compile. Cost: one confusing hour.
- `createRefusedClipFeeder.setRate` was `() => {}` where every sibling verb
  refused by name. It refuses now: the session calls it on every rebuild whose
  rate is not 1, so a clip nothing can serve used to take a rate change and say
  nothing — the operator's own report in miniature. `scrubTo` / `scrubAck` stay
  silent DELIBERATELY and that is written into the file: they ride every pointer
  move and every rendered frame, and `beginScrub` has already refused the
  gesture they belong to, once, by name. One is the same silence wearing a
  different hat; the other is a storm that would bury the line that matters.

## Enforcement

`packages/addon-provider-reolink/src/__tests__/clip-playback-options.spec.ts`
(6) pins the two envelopes, that both share ONE rate list by identity, that
neither offers 8 or 16, that the ladder is ascending, and that the Reolink
provider returns `CLIP_PLAYBACK_OPTIONS.stream` by identity rather than a shape
of its own. `control-protocol.spec.ts` pins that every declared rate survives
`clampPlaybackRate` unchanged — the invariant has to hold against the thing
that enforces it, and the clamp lives in the broker, which a provider may not
import — and that `clipTransport` is no longer a valid server message.
`clip-stream-feeder.spec.ts` pins that 4x is really delivered over held frames
and that an undeliverable rate is named once. `timeline-session-clip.spec.ts`
pins that no `clipTransport` is sent.

Ten gates were reverted in turn, in the FOREGROUND, one file at a time — each
red, each restored byte-identical (`cmp`), each green again. **10 reverted,
10 red, 10 identical restores:**

| reverted | suite | tests red |
| --- | --- | --- |
| let the rate ladder contain 8 and 16 | types (2246) | 1 |
| drop `.min(1)` from the declared rate set | types | 1 |
| make the `stream` envelope free/steppable/scrubbable | types | 1 |
| give the `file` envelope its own rate array | types | 1 |
| let the provider spread the envelope instead of returning it | reolink (961) | 1 |
| make `clampPlaybackRate` top out at 2, disagreeing with the ladder | broker (464) | 4 |
| put `clipTransport` back on `ServerMessageSchema` | broker | 1 |
| make the feeder ignore the rate (`setRate` → 1) | broker | 2 |
| remove the `rate-not-delivered` line | broker | 1 |
| restore the refused feeder's `setRate: () => {}` | broker | 1 |

Two of these were proved twice, and the first proof is worth recording because
it was WORTHLESS. The envelope invariants were first pinned in
`packages/addon-provider-reolink`, whose vitest resolves `@camstack/types` to
the BUILT package — so adding 8 and 16 to the ladder in `src` left all 967
tests green. They live in `packages/types/src/__tests__/` now, where the import
is the source. And a first attempt to run the broker disarms as one background
chain was killed by a timeout mid-chain, leaving two files disarmed on disk; the
"red" counts that followed were reading those leftovers rather than the revert
under test. Everything above was redone from a verified-green baseline.

The live measurements are review-only: they are `clip-stream:first-frame`,
`clip-stream:ended` and `clip-stream:disposed` lines already written by the
production feeder and read back through `logs.query`. Nothing was woken and no
camera was touched.
