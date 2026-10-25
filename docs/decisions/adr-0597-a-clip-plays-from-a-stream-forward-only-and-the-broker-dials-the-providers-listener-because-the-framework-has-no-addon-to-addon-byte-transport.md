---
id: D597
title: A clip plays FROM A STREAM, forward-only, through a second feeder beside the file path — and the broker reaches the stream by dialling a one-shot URL on the provider's own listener, because the framework has no addon→addon byte transport
status: accepted
date: 2026-09-22
supersedes:
applies-to:
  - packages/addon-pipeline/src/stream-broker/recorded/clip-stream-feeder.ts
  - packages/addon-pipeline/src/stream-broker/recorded/fmp4-stream-demux.ts
  - packages/addon-pipeline/src/stream-broker/recorded/clip-stream-http.ts
  - packages/addon-pipeline/src/stream-broker/recorded/clip-path-choice.ts
  - packages/addon-pipeline/src/stream-broker/recorded/clip-stream-dial-answer.ts
  - packages/addon-provider-reolink/src/clips/clip-stream-dial.ts
  - packages/types/src/capabilities/videoclips.cap.ts
---

## Context

Stage 1, earlier the same day, made a Reolink clip STREAM off the
camera socket: `/addon/provider-reolink/clip-stream/<deviceId>/<clipKey>.mp4`,
a fragmented MP4 written from the first muxed byte, `accept-ranges: none`, no
length, `x-camstack-clip-transport: forward-only`. First byte 108–156 ms
against 733–2043 ms for the whole-file route. Nothing consumed it. The
operator's decision, from a packet capture of the Reolink app, bounded what a
consumer may do: **forward-only** — the camera offers no seek inside a
recording (every replay names a FILE; the `01YYYYMMDDHHMMSS` shape appears only
in stop payloads), no index, no persistence, no prefetch.

Two facts about the existing clip path
([D575](adr-0575-a-clip-is-another-position-of-the-recorded-source-pointer-behind-a-file-backed-feeder-and-a-file-that-cannot-be-indexed-is-refused-by-name.md))
decided the shape of the consumer.

**The file feeder cannot eat the stream.** `clip-mp4-index.ts` reads `stbl`;
an `empty_moov` fMP4 has an empty sample table and is refused `no-samples` by
design (the HKSV finding). The recorded feeder PULLS access units by time from
an index; a stream has no index until it has ended. So the stream needed the
feeder it actually implies — one that is PUSHED — built beside the file path,
not through it.

**The broker cannot reach the stream through either door the framework has.**
Traced, not assumed, because the framework's own docblock claimed it
(`videoclips.cap.ts`, on `readClipBytes`) and the claim held: the data-plane
listener is `127.0.0.1` behind a per-listener secret that ONLY the hub
presents (`addon-data-plane-facility.ts:65`); the hub's `/addon/<id>/…` proxy
in front of it takes a session cookie, a `cst_` token scoped `{type:'addon'}`
or a JWT (`server/backend/src/main.ts:1101`); and an addon holds none of
those. `ctx.api.<cap>.subscribe` is refused on the addon caller by design
(`addon-api-factory.ts:58`), so a streaming cap method is not available
either. The one working precedent for addon→addon MEDIA in this repo is the
broker's own restreams: a cap call mints a URL carrying a token, and the
consumer dials it directly (`getStreamWithCodec`, dialled by the recorder and
HomeKit).

**What was wrong first.** The feeder dropped every byte that arrived while its
phase still said `opening`. Node flushes the body bytes it already holds on
`process.nextTick` the moment the `data` listener attaches, and that tick runs
BEFORE the promise continuation that flipped the phase to `streaming` — so the
head of every live stream (`ftyp`, `moov`) was thrown away and the demuxer
refused the next fragment `no-moov`. Fourteen unit tests were green: the fake
opener delivered only after the `await`. A capture of the live stream, replayed
through the REAL dial listener + `node:http` opener, played out with ZERO
frames pushed and no error — the branch that accepts work and produces
nothing (D391). Fixed by taking bytes while `opening`, and pinned by a test
whose fake delivers synchronously before resolving.

## Decision

**A clip has TWO paths behind `playClip`, decided in ONE place, and the stream
is the default for everything it can serve.**

1. **The stream feeder is a second feeder, beside the file path.**
   `clip-stream-feeder.ts` implements `TimelineSessionClipFeeder` over
   `fmp4-stream-demux.ts`, an incremental box walker that emits every video
   sample the moment ITS bytes are in (not when its `mdat` closes), in decode
   order, params-fused on sync samples — the same `AccessUnit` contract the
   stored path pushes. `clip-file-source.ts`, `clip-mp4-index.ts` and
   `RecordedFeeder` are untouched.

2. **Forward-only is refused BY NAME, measured against the HEAD.** A `seek`
   behind the last frame pushed logs `clip-stream:seek-backward-refused`,
   re-sends the head so the viewer's playhead snaps back, and changes nothing.
   "Back to the start" is one of them. A seek ahead is honoured when the bytes
   have arrived (drop to the last keyframe ≤ target, burst to the target,
   resume pacing) and WAITS for them when they have not, holding one GOP.
   `stepFrame(-1)` and the scrub verbs are refused by name; a seek after the
   clip played out is refused (`seek-at-end`).

3. **Duration is unknown until it is known.** `durationMs()` resolves with the
   demuxer's sum when the stream ENDS, and with `null` when it was cut or left
   first — never `0` (D393). `TimelineSessionClipFeeder.durationMs` is now
   `Promise<number | null>`, and the session logs `null` as *unknown* and sends
   nothing.

4. **The path is chosen once, and said.** `chooseClipPath` in
   `clip-path-choice.ts`: the STREAM for `low | mid | null` whenever the broker
   has a dial; the FILE for `high` (the stream serves the sub twin only — stage
   1 — and a `high` handed to it would be the silent 33× substitution D576
   refuses) and for a broker with no dial; `none`, refused out loud, when
   nothing can serve. The broker logs `clip playback: path chosen` with the
   reason. A provider that predates the dial answers `NOT_IMPLEMENTED`, which
   is classified `stream-unavailable` and refused with the deploy hint — never
   an implicit fall-through to the file path.

5. **The broker dials the provider's own listener.** `videoclips.dialClipStream`
   (optional, like `readClipBytes`) mints `http://127.0.0.1:<port>/<token>` on
   a loopback listener the provider binds lazily (`clip-stream-dial.ts`); the
   token is 24 random bytes, ONE shot (`dial-used` on a replay), 30 s TTL
   (`dial-expired`), bounded at 64 outstanding (`dial-exhausted`). Behind the
   token is the SAME `createClipStreamHandler` as the data plane, with a
   token target resolver — the gates, the producer, the status line on the
   first byte and the reason codes have one authority. The dial runs the cheap
   gates before minting (the id, the row, in-progress, `high`, the sleeping
   standalone) and refuses in the clip vocabulary. Loopback only, because the
   provider is `hub-only` and the broker is hub-resident; a remote consumer
   would need the `hostname` rewrite the restreams have, and it is not built.

6. **D9/D18 holds by shape.** Media crosses the process boundary compressed,
   in one TCP stream, at the camera's delivery rate — the live path's shape,
   and the file path's one fetch spread over time. The backlog is bounded at
   the file path's own ceiling (64 MiB); above it the socket is PAUSED (D447
   on the consuming hop), and the producer's drain gate decides a consumer that
   never drains. A socket silent for 15 s is cut `stream-stalled`. Every exit —
   opened, first frame, ended, cut, refused, disposed, every refused verb, every
   backpressure transition — is one log line carrying `deviceId`.

**`playSpeed` is not wired**, and this is where it would go: an input on
`dialClipStream`, forwarded by the provider into the cmd-5 replay's
`<playSpeed>`; the viewer's `rateBy: 'camera'` reopens the replay, so it costs
a new dial and a new stream. The feeder's own `setRate` remains the player's
rate over frames already here.

## Consequences

- **Measured, same clips, read-only, local harness** (the hub serves no stream
  route: stage 1 is not deployed, `HEAD /clip-stream/… → 404`). `playClip` →
  first frame at the sink, FILE path (library fetch + mux + index + demux +
  `RecordedFeeder`) against STREAM path (dial listener → `node:http` →
  `clip-stream-feeder`), alternating order, on this Mac, camera the only
  remote party:

  | camera | clip | FILE first frame | STREAM first frame | both: AUs / duration |
  | --- | --- | --- | --- | --- |
  | 592 standalone | 25 s | 823 ms | **259 ms** | 385 / 25.67 s |
  | 592 | 225 s | 3 643 ms | **284 ms** | 3 354 / 223.6 s |
  | 592 | 190 s | 2 578 ms | **249 ms** | 2 832 / 188.8 s |
  | 3628 hub child | 34 s | 1 803 ms | **250 ms** | 540 / 36.0 s |
  | 3628 | 30 s | 1 578 ms | **193 ms** | 480 / 32.0 s |
  | 3628 | 48 s | 2 221 ms | **183 ms** | 740 / 49.33 s |

  The file path's first frame grows with the clip (the whole file crosses
  first); the stream's is flat. The DEPLOYED file path's own byte crossing,
  `readClipBytes` over the hub's tRPC, measured 43–538 ms on a scratch hit and
  2 462 ms cold (3628, 48 s) — a number the stream removes rather than
  improves.

- **The stream serves the sub twin only.** `high` stays on the file path,
  bounded at 50 MiB by `readClipBytes`. A `high` stream is the provider's to
  add (a `twin` on the dial, the main file name on the row); the path choice
  already has the branch for it.

- **Audio is not played on the stream path.** Stage 1 forwards no AAC; the
  feeder wires no audio sink, and says so where the sink is built.

- **A provider older than the dial breaks clip playback for the sub twin
  until it is redeployed** — by name (`stream-unavailable`, with the hint),
  not silently. Deploy `provider-reolink` before `addon-pipeline`, or accept the
  named refusal in between.

- **The viewer already has the rule** (`clipSeekAllowed`, `forward` measured
  against the head) and sends `playClip` unchanged; nothing on the wire
  changed. A backward seek that slips through is refused server-side and the
  head is re-sent.

- **`CLIP_STREAM_TRANSPORT_HEADER` moved to `@camstack/types`**, because two
  addons now spell it and a consumer that stops checking it would play a
  progressive file through a forward-only feeder.

## Considered and not taken

**Fetching the hub-proxied `/addon/provider-reolink/clip-stream/…` from the
broker.** No credential: the proxy admits a session cookie, an addon-scoped
`cst_` token or a JWT, and minting a scoped token from inside an addon would be
a user action performed by a process. Refused.

**A `kind: 'subscription'` cap method carrying base64 chunks.** Refused on the
addon caller by the framework (`subscribe() is not supported on direct
caller`), and it would put media on the cap channel through hub-main — the
exact shape that OOM'd (D9).

**A framework facility (`ctx.dataPlane.dial(addonId, prefix)`) handing the
consumer the producer's `{baseUrl, secret}`.** Cleaner and general, and the
right long-term home — but a `@camstack/types`/`@camstack/system` change ships
only inside a published `@camstack/server` (D16), cannot be measured live from
here, and the restream precedent already exists at addon level. Named as the
open question for the operator.

**Feeding the stream through `clip-mp4-index.ts` after buffering it whole.**
That is the file path with a slower fetch; it throws away the first frame the
stream exists for.

**Falling back to the file path when the dial refuses.** The file path runs
the same gates and would refuse the same way; a fall-through would only hide
which path answered.

## Enforcement

Every gate below was reverted in turn by a script that patches the line,
runs the spec, restores the file and verifies its hash — 15 reverts, 15 red,
15 byte-identical restores (the sleeping gate stayed green on its first
revert and went red on a re-run and on a gate-removed variant; recorded in
(planning repo: sessions/sessions.md) rather than smoothed over): <!-- drift-ok: moved to the private planning repo -->

- `recorded/__tests__/clip-stream-feeder.spec.ts` (14): backward seek refused
  by name and the head re-sent; a far seek waits for its bytes; bytes taken
  while `opening`; cut ⇒ `null` never `0`; backpressure pauses the socket;
  a silent socket is cut; refusals before the first byte; step/scrub refused;
  seek after play-out refused.
- `recorded/__tests__/fmp4-stream-demux.spec.ts` (14): byte-identical to the
  mp4box whole-file demux at 1/7/13/100/4096/whole-byte chunks on H.264 and
  H.265 fixtures (`-bf 0`, the camera's shape); a sample emitted before its
  `mdat` closes; the drain gated on the `mdat` header; `no-moov`,
  `no-video-track`, `malformed` by name.
- `recorded/__tests__/clip-path-choice.spec.ts` (10), `clip-stream-dial-answer.spec.ts`
  (3), `timeline-session-clip.spec.ts` (+1: `null` is unknown).
- `addon-provider-reolink/src/__tests__/clip-stream-dial.spec.ts` (7, real
  loopback socket): one shot, `dial-used`, `dial-expired`, `dial-unknown`,
  HEAD takes nothing, the outstanding bound, dispose.
- `addon-provider-reolink/src/__tests__/clip-stream-dial-service.spec.ts` (4,
  through the real service): the URL serves every unit forward-only with no
  file path called; `high` ⇒ `unsupported-option`; `catalog-miss` and
  `clip-in-progress`; the sleeping gate before any URL exists.
- The HTTP opener has no unit test; it is proved by replaying a captured live
  stream through the real listener and feeder (2 832 units, five runs), which
  is what found the ordering bug the unit suite had missed.
