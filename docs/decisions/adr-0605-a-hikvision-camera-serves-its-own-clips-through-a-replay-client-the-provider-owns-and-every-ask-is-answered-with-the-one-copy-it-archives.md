---
id: D605
title: A Hikvision camera serves its own clips through an RTSP replay client the PROVIDER owns — forward-only, paced by the camera, ended by a quiet socket — and every quality ask is answered with the one copy it archives, said out loud
status: accepted
date: 2026-09-22
supersedes:
applies-to:
  - packages/addon-provider-hikvision/src/clips/rtsp/rtsp-replay-session.ts
  - packages/addon-provider-hikvision/src/clips/rtsp/rtp-depacketize.ts
  - packages/addon-provider-hikvision/src/clips/rtsp/rtsp-sdp.ts
  - packages/addon-provider-hikvision/src/clips/rtsp/rtsp-wire.ts
  - packages/addon-provider-hikvision/src/clips/clip-search.ts
  - packages/addon-provider-hikvision/src/clips/clip-catalog.ts
  - packages/addon-provider-hikvision/src/clips/clip-replay-rate.ts
  - packages/addon-provider-hikvision/src/clips/clip-stream.ts
  - packages/addon-provider-hikvision/src/clips/clip-stream-mux.ts
  - packages/addon-provider-hikvision/src/clips/clip-file.ts
  - packages/addon-provider-hikvision/src/clips/clip-twins.ts
  - packages/addon-provider-hikvision/src/clips/hikvision-videoclips-provider.ts
  - packages/addon-pipeline/src/stream-broker/recorded/clip-stream-feeder.ts
---

## Context

[D597](adr-0597-a-clip-plays-from-a-stream-forward-only-and-the-broker-dials-the-providers-listener-because-the-framework-has-no-addon-to-addon-byte-transport.md),
[D599](adr-0599-one-transport-for-clip-playback-and-one-place-that-maps-a-profile-to-a-twin.md),
[D600](adr-0600-a-clip-stream-carries-sound-transcoded-by-the-provider-and-the-broker-only-frames-and-paces-it.md)
and
[D604](adr-0604-a-clip-stream-carries-one-transfers-frames-muxed-at-a-rate-it-measured-and-nothing-a-run-armed-outlives-it.md)
built clip playback around ONE vendor. This record brings a second one to the
same contract — catalog, playback, sound — and it is written because four of
the things that decided its shape are measurements, two of them contradicting
the feasibility note this work started from
(`docs/design/2026-09-22-hikvision-clips-feasibility.md`).

**The obvious media path does not work, and would leak a password.** The
camera's `ContentMgmt/search` hands back a `playbackURI` that looks like an
ordinary RTSP URL, so the cheap implementation is
`ffmpeg -i rtsp://user:pass@host/Streaming/tracks/101/?starttime=…`. Driven that
way against 1436, **ffmpeg produced no output at all in three minutes** while
holding the session open, where the same session opened by hand answered in
under 300 ms. It also puts the camera's password in an argv, where every `ps`
on the hub can read it for the length of the clip. Neither is recoverable with
a flag, so the provider owns an RTSP client: `OPTIONS`, `DESCRIBE`, one `SETUP`
per track, one `PLAY`, `TEARDOWN`, digest on its own socket, and the media
depacketized into the SAME Annex-B elementary stream the Reolink clip path
already feeds its mux.

**The camera has one playback slot, and it is not forgiving.** That abandoned
ffmpeg blocked every later `SETUP` on 1436 with a **500** for three hours,
while `ContentMgmt/search` on the same camera kept answering normally. The 500
was read as a wedged firmware and written up as one; killing the stray process
restored the camera instantly. A `SETUP` refusal is therefore a statement about
the camera's one slot — never about whether the clip exists — and nothing here
retries it.

**A played-out replay does not close its socket, and a single idle rule filed
every complete clip as a failure.** On 3833, a 19 s segment delivered 246
access units and 10.3 MB in 18.9 s and then went quiet with the socket open
until the camera's own 60 s timeout. There is no end-of-stream marker on this
firmware and **zero RTCP**. The first version cut that stream at the 15 s idle
bound and called it `idle` — a branch that accepted work, produced all of it,
and threw the result away (D391). Fourteen unit tests were green; only a live
run could find it.

**A replay is paced at 1x.** 246 units in 18.9 s for a 19 s segment, measured.
That is the transport, not a tuning knob: the first byte reaches the peer in
**4.3 s** (the rate probe plus ffmpeg's first `frag_keyframe` fragment) where
the Reolink stream's is 183–284 ms, and a whole clip takes its own duration.
The feasibility note measured `Rate-Control: no` giving 3.97x lossless. It is
NOT used here — see "Considered and not taken".

## Decision

**A Hikvision camera's clips are served by the provider's own replay client,
forward-only, and every quality ask is answered with the one copy the camera
archives.**

1. **The provider owns the RTSP client.** Four pure modules — the interleaved
   wire, the SDP, the RTP depacketizer, the rate estimator — and one that
   drives a socket. It sends no `Range: clock=`, no `Scale` and no
   `Rate-Control`: the contract says `forward-only`, so nothing here can
   produce a stream that is not. The credential never leaves the process.

2. **The end of a segment is a QUIET SOCKET, not a closed one.** Quiet AFTER
   media (`RTSP_SEGMENT_QUIET_MS`, 3 s) is the segment's end and the pass is
   `complete`; quiet BEFORE any media (`RTSP_IDLE_TIMEOUT_MS`, 15 s) is a
   camera that took a `PLAY` and is sending nothing, and that is a failure with
   somewhere to put its reason. An RTCP packet re-arms neither — a keepalive
   that counted as media would hold a finished clip open for the session
   timeout. The pass reports the span it really delivered, from the media's own
   90 kHz clock, and a pass shorter than the catalog row says so by name
   (`stream-short`, `file-short`). `null` is unknown and is never short (D393).

3. **The rate is MEASURED from the replay's own timestamps, and an
   unmeasurable one is refused** — D567's rule and D604's closing of its back
   door, reached from a different wire. `record/tracks` declares
   `framerate=2.26 fps` for a track that measures 12.5; the field is never
   read. Nothing is snapped to a nicer number: a first version rounded an
   estimate within 4 % of an integer and turned an exact 12.5 into 13.

4. **Sound is a COPY on the µ-law path.** The archive is `PCMU/8000`, which IS
   what a `pcmu` session sends, so that ask is `-c:a copy` where Reolink pays
   a transcode; `opus` is still an encode, at the settings the Reolink path
   uses so the two sound alike. Everything else D600 decided holds unchanged
   and for the same measured reasons: µ-law cannot go in MP4 (`mov`, and the
   content type comes from the mux), the audio input exists only if a payload
   is already held, and a silent stream says which kind of silence it is.

5. **There is ONE archived copy and it is the 4K main.** `record/tracks` lists
   one video track. So `low`, `mid` and `high` are all served the same media
   and `served` answers `high` — an UPGRADE, where D599 built the field around
   downgrades. **The provider logs it** (`quality-upgraded`, per camera) and
   the broker now logs the mirror image of its downgrade line, because a rule
   that fires only downwards makes exactly this cost invisible (D382). Nothing
   ever DESCRIBEs a track to decide whether a twin exists: track 102 answers
   200 with a 720p SDP and delivers the 4K main stream.

6. **The catalog is PAGED, and the terminator is `responseStatusStrg`.**
   `numOfMatches` is the size of the page in hand (40, 40, 6 across a 48 h
   window; ten pages of ten when ten were asked for), results come back
   OLDEST-first, and `NO MATCHES` arrives with `responseStatus: true` — so a
   parser written to the vendor's own specification turns an empty day into a
   failure and a single-page reader answers with yesterday's footage. A body
   this parser cannot read is `unreachable`, never an empty day.

7. **The player gets a file, the broker gets the stream.** `getClipPlayback`
   points at a `+faststart` MP4 on the addon's own media plane, with `Range`,
   because the admin UI hands it to a `<video>` element that must show a
   duration and seek; `dialClipStream` mints the one-shot loopback URL D597
   defined. Both go through ONE producer and one scratch, so a clip is fetched
   once between them (D558).

## Consequences

- **Deploy order is the same as Reolink's and matters for the same reason:
  `provider-hikvision` first, then `addon-pipeline`.** A broker newer than its
  provider asks for a codec the provider ignores and plays the clip silent by
  name; a broker deployed ahead of a provider with no dial refuses with the
  deploy hint. That hint still names `provider-reolink` verbatim in
  `clip-stream-feeder.ts` and is now wrong for half the fleet — named here,
  not fixed, because it is one string and it belongs to a broker change nobody
  measured today.
- **A clip stream costs the clip's own duration.** 1x is the transport. The
  broker paces playback at 1x anyway, so this is invisible for watching and
  very visible for exporting: `readClipBytes` on a 19 s segment takes ~19 s,
  and the worst segment measured in 24 h on 1436 is 83 s / 42.7 MB.
- **First byte is 4.3 s, not 280 ms.** The rate probe holds 16 access units
  (1.3 s at 12.5 fps) and ffmpeg's first `frag_keyframe` fragment closes at the
  next keyframe. D597's win — a first frame that does not grow with the clip —
  still holds; its absolute number does not transfer.
- **No thumbnails.** This provider mints no stills: every row carries
  `thumbnailUnavailable: { reason: 'unsupported' }` rather than a
  `thumbnailMint` URL that would answer 204 on every tile. Minting one means
  another replay session per tile on a camera with ONE slot, and that trade
  has not been made.
- **`index-empty` and `sleeping` are not reachable.** This firmware exposes no
  day calendar to contradict, and every Hikvision camera on this fleet is
  mains-powered. A state nothing can produce would be a branch nothing tests.
- **1441 and 3831 will answer `no-storage`** — both are motion-recording to a
  card that is not there. That is an operator-facing defect this work surfaces
  and does not fix.
- **The contract was NOT widened.** `transport` stays `z.literal('forward-only')`,
  `dialClipStream` gains no offset and no reposition verb, and `served`/
  `downgraded` is unchanged. Parity with Reolink does not require seeking, and
  a capability nothing consumes is a capability nothing tests.

## Considered and not taken

**`Rate-Control: no`, for 3.97x lossless delivery.** Measured by the
feasibility note, reachable with one header, and it would cut a 19 s export to
5 s and the first byte to about a second. It is not taken TODAY because it is
the one thing that changes how the camera drives its single playback slot, it
was measured on a camera that had a stuck session at the time, and it buys
nothing for the path that matters most — the broker paces playback at 1x
whatever arrives. It is the first thing to add, behind its own measurement.

**Seeking (`Range: clock=`), and the `transport` enum it needs.** Real, and
measured at 114–157 ms to first frame. It is a capability, not parity: Reolink
is forward-only, the viewer's own rule refuses a backward seek, and widening a
shared `z.literal` to an enum to serve one provider would have to carry
`forward-only` as the default, a landed-position report and catalog clamping
(a gap seek kills the session AND the socket). That is a record of its own.

**Driving ffmpeg at the playback URI.** Measured unusable and it leaks the
password. See Context.

**Trusting `record/tracks`' first enabled track.** 3833 lists 101 AND 103 and
only 101 carries `trackType=video`; 1436 lists 101 alone. "The first enabled
one" would have read one camera's catalog on a track with no picture.

**Feeding the file mux all the video and then all the sound.** ffmpeg reads
whichever input has the lowest next dts, so it exits before the audio is
written and the next write is an `EPIPE` — measured on a real 19 s clip, and
the crash a unit suite with six access units never reached. The two tracks are
written in the order the replay delivered them, which is media order.

## Enforcement

`packages/addon-provider-hikvision/src/clips/__tests__` (81). The fixtures are
REAL bytes off 3833 on 2026-09-22: `replay-3833.sdp` is a verbatim `DESCRIBE`
body, `replay-3833-interleaved.bin` is 128 KB of the interleaved RTP stream cut
at a fragmentation-unit start (six access units, thirteen µ-law payloads), and
`replay-3833-idr.bin` is the head of the same session through the end of its
first 4K IDR. The search fixtures are verbatim `CMSearchResult` bodies from
1436, including the `NO MATCHES` one that carries `responseStatus: true`.

Every gate below was reverted in turn by a script that patches the line, runs
its spec, restores the file, verifies its sha256 is byte-identical and re-runs
green (`scratchpad/hik-revert-proof.mjs`, review-only) — **30 reverted, 30 red,
30 byte-identical restores, 30 green**. One of them was VACUOUS on its first
pass and is recorded as such rather than smoothed over: *an access unit is cut
on the TIMESTAMP, not the marker bit* stayed green under its own revert,
because this camera sets the marker on exactly the packet whose successor
carries a new timestamp. It needed the real capture with one structural field
changed — every marker bit cleared, which is what a lost final packet of a
frame leaves behind — before the gate had anything to fail on.

- `clip-search.spec.ts` — `responseStatusStrg` over `responseStatus`; `MORE`
  as the only terminator; the `&amp;` in the handle; an unreadable body is
  `unknown`.
- `rtsp-replay-bytes.spec.ts` — the session-level control is not a track; the
  access unit is cut on the TIMESTAMP, not the marker bit (against the real
  capture with every marker cleared); a fragment with no start is dropped and
  counted; the SDP parameter sets are not doubled on a stream that carries its
  own; a partial interleaved frame is held; the same units at 1, 7, 13, 4 096
  and whole-byte chunk sizes.
- `rtsp-replay-session.spec.ts` (a real TCP listener speaking this firmware's
  RTSP, which then goes QUIET WITHOUT CLOSING) — quiet after media is the end
  of the segment and carries the span it delivered; quiet before any media is
  `idle`; a `SETUP` the camera declined is refused with its status and opens
  nothing.
- `clip-mux-and-rate.spec.ts` — no fallback rate, no backwards span; `mov` and
  `-c:a copy` for µ-law; the µ-law input declared with its rate and channels;
  the file mux names its output FORMAT, because the scratch path is not a
  `.mp4`; a DISPOSED drain gate is silent for ever.
- `clip-stream-producer.spec.ts` — the probe widens rather than judging; audio
  is muxed only if a payload is held; a run that ANSWERED cannot be cut; an
  ffmpeg that produced nothing is refused, not served.
- `clip-stream-dial.spec.ts` (real loopback socket) — one shot, `dial-used`,
  `dial-expired`, `dial-unknown`, HEAD takes nothing, the outstanding bound,
  dispose.
- `addon-pipeline/…/clip-stream-feeder.spec.ts` (+2) — the UPGRADE line fires
  on a cheaper ask served `high`, is NOT the downgrade line, and stays quiet
  when `high` was asked or nothing was. Reverted, red, restored, green — a
  rule the broker does not execute is the failure this repo keeps naming.
- `videoclips-provider.spec.ts` — overlap not containment; a source that
  cannot answer REFUSES rather than answering `[]`; `served` is what is
  served, not what was asked; the catalog size gate runs before the camera is
  touched; no thumbnail is offered that cannot be minted; an absent audio ask
  is `none`.

**Live, through the real service** (`scratchpad/hik-clips-live.mts`,
review-only): `listSources` → `ok`; `listClips` 9 clips in 578 ms over 24 h;
`dialClipStream` in 8 ms; the dial GET answered 200 `video/quicktime`
`x-camstack-clip-transport: forward-only`, 246 access units, 10 461 116 bytes,
first byte 4 339 ms, 23 s, `deliveredMs: 19600` against a 19 000 ms row,
`short: false`, zero audio frames dropped and zero after the mux.

**Not a gate, and recorded as such**: `RTSP_HANDSHAKE_TIMEOUT_MS` and the
`CLIP_SEARCH_MAX_PAGES` bound are both bounds no test can distinguish from
their absence on this fleet's own answers — nothing here times out and nothing
pages past three. They are written down so the next person knows how much to
trust them.
