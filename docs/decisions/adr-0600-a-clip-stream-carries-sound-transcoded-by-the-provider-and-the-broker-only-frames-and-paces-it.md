---
id: D600
title: A clip stream carries SOUND — transcoded where the AAC already is, framed and paced by the broker, and named when it is absent
status: accepted
date: 2026-09-22
supersedes:
applies-to:
  - packages/addon-provider-reolink/src/clips/clip-stream-mux.ts
  - packages/addon-provider-reolink/src/clips/clip-stream.ts
  - packages/addon-provider-reolink/src/clips/clip-stream-route.ts
  - packages/addon-pipeline/src/stream-broker/recorded/fmp4-stream-demux.ts
  - packages/addon-pipeline/src/stream-broker/recorded/clip-stream-audio.ts
  - packages/addon-pipeline/src/stream-broker/recorded/clip-stream-feeder.ts
  - packages/types/src/capabilities/videoclips.cap.ts
---

## Context

[D597](adr-0597-a-clip-plays-from-a-stream-forward-only-and-the-broker-dials-the-providers-listener-because-the-framework-has-no-addon-to-addon-byte-transport.md)
gave clip playback a second transport and
[D599](adr-0599-one-transport-for-clip-playback-and-one-place-that-maps-a-profile-to-a-twin.md)
made it the only one. Both closed with the same open item: **the stream is
video only.** The provider's decoder handed over every AAC frame and the
producer counted them as dropped; the incremental demuxer knew one track; the
broker built the feeder's sink with a comment saying the audio half was not
wired. Choosing the stream — which is now every clip — meant choosing silence.

The file path has carried sound since D567 by COPYING ADTS into the MP4, and
the recorded path transcodes per fragment (`segment-audio.ts`,
`segment-audio-js.ts`). Neither shape fits here: the copy serves a player that
decodes AAC, and a WebRTC session never does; the per-fragment transcode wants
a whole fragment in hand, which is the thing D597 exists not to wait for
(first frame 183–284 ms against 823–3643 ms).

Four things were MEASURED rather than assumed, and each one moved the design.

**µ-law cannot go in MP4.** `ffmpeg 7.1` answers `Could not find tag for codec
pcm_mulaw in stream #1, codec not currently supported in container`. Its MOV
muxer takes it as a `ulaw` sample entry. So the two codecs a session
negotiates need two containers — the same boxes, a different brand.

**ffmpeg will not write output until every input has been probed.** An audio
input declared and never fed does not produce a silent clip; it holds the
VIDEO hostage. The decision to carry sound therefore has to be taken before
the mux is spawned, from audio already in hand.

**The muxer writes a track's run when its own fragment closes**, so the head
of a stream can carry sound slightly behind the picture — 43 ms worst case on
a 60x delivery of a 20 s clip, zero after the first fragment, and identical
under `-max_interleave_delta 0`, `+separate_moof` and `frag_custom`. It is a
warm-up, not a policy, and it is small because a clip is delivered far faster
than it plays.

**A µ-law run is not a whole number of RTP frames.** ffmpeg hands over 512
bytes (64 ms) at a time; WebRTC wants 160 (20 ms).

What was wrong first, and is the reason for the shape below: the feeder ran a
SECOND `MonotonicClock` for audio, as `RecordedFeeder` does, and kept the pair
aligned by marking both on a discontinuity. That alignment is only as good as
the discipline — each clock re-bases on its OWN last output, so every seek
leaves the two a frame further apart. Three forward seeks on a four-second
fixture put them 900 ms apart. Invisible on a short clip, audible on a long
one, and unattributable afterwards.

## Decision

**The transcode happens where the AAC already is, and the broker only frames
and paces.**

1. **The provider muxes the sound.** `buildClipStreamMuxArgs` takes a second
   input — `-f aac -i pipe:3`, the ADTS frames the same BcMedia decoder hands
   over, on the fd the production spawn already opens — and encodes it to the
   codec the caller asked for: `libopus -ar 48000 -ac 1 -b:a 24k`, or
   `pcm_mulaw -ar 8000 -ac 1` into `mov`. One ffmpeg, the one that was already
   running. The alternative — copying the AAC across and transcoding at the
   broker — would put a second long-lived ffmpeg, fed incrementally, on the
   consuming hop, with a backlog outside the one bound D597 set.

2. **The ask travels on the DIAL, and `servedAudio` answers it.**
   `dialClipStream` takes `audio: 'opus' | 'pcmu' | 'none'` and answers
   `servedAudio` beside `served` — the same reasoning D599 applied to twins,
   applied to sound. ABSENT IS `none` on both halves (D382): a broker older
   than the field keeps the video-only stream it had, and a provider older
   than it is read as offering nothing rather than as promising something.
   The dial promises a CODEC, never content: whether the recording has a
   microphone track is not knowable before its first audio frame arrives.

3. **The mux's audio input exists only if an ADTS frame is already held.**
   Decided once, in `startMux`, from the frames the rate probe has been
   holding alongside the video ones. A stream with none is muxed silent and
   says which kind of silence it is: `not-requested`, `no-audio-track`,
   `audio-not-copyable` (ADPCM — the file path draws the same line), and
   separately `framesAfterMux` for the loudest case, sound that arrived after
   the decision was taken. Every served stream says what became of its sound,
   including the ones that carried it.

4. **The demuxer follows a second track, and BOTH are on one origin.**
   `fmp4-stream-demux.ts` emits audio samples through `onAudio` as their bytes
   land, interleaved with the video in FILE-OFFSET order, with `ptsMs`
   measured from the first sample of EITHER track in exact integer arithmetic
   over the two timescales. Per-track anchoring would zero out the offset
   between the tracks, which is the whole content of lip sync. A track in a
   codec this process cannot forward is REPORTED (`Fmp4StreamDemuxer.audio`)
   and not followed — never a refusal, because silence is not a reason to lose
   the picture. Without an `onAudio` the track is not followed at all.

5. **ONE clock in the feeder, converted per track.** The audio RTP timestamp
   is the video clock's own output at the negotiated rate
   (`stampAudio`). There is nothing to keep in step, so nothing can drift.

6. **Audio is never pushed late, and never at a rate but 1x.** Sound and
   picture share one PTS-ordered schedule, video first on a tie. A unit whose
   moment has passed by more than `CLIP_STREAM_AUDIO_LATE_MS` (120 ms — under
   the lip-sync bound, under any jitter buffer) is DROPPED and counted rather
   than fired off in a burst the receiver would discard. Units dropped for the
   rate, and for a forward seek, are counted apart.

7. **Framing, not decoding, on the consuming hop.** `clip-stream-audio.ts`:
   Opus passes through (an mp4 Opus sample IS an RTP payload), µ-law is re-cut
   into 160-byte frames with a carry across container samples and a `ptsMs`
   counted in BYTES off one anchor — exact at 8 kHz for ever, where
   re-deriving each frame from its sample's rounded `ptsMs` accumulates. A
   sample whose timestamp disagrees with the count by more than one frame is a
   GAP: the carry is dropped, the anchor moves, and the re-anchor is counted.

8. **The viewer is TOLD.** `TimelineSessionClipFeeder.audio()` settles from the
   `moov` — the first fragment, not the end of the stream — and the session
   sends `clipAudio { clipId, carried, codec?, reason? }`. Silence has six
   distinguishable causes (`not-negotiated`, `not-offered`, `no-audio-track`,
   `unsupported-codec`, `codec-mismatch`, `stream-failed`) and a listener can
   tell none of them apart, so the server says which. A branch that cannot
   say sends nothing rather than claiming `false`.

**And, found while wiring it: `clip-stream-route.ts` opened
`row.subFileName` unconditionally** while the dial already answered
`served: 'high'` for a `high` ask. D599 widened the dial's `twin` and the
route was never told, so the one thing D599 claims to have cured was live on
the one path that serves it. The twin now travels on `ClipStreamTarget`
beside the audio ask, and a `main` twin the row has no handle for is refused
by name rather than quietly served as the sub copy.

## Consequences

- **A clip stream is `video/quicktime` when it carries µ-law**, and the
  content type comes from the mux rather than from a constant. Nothing in the
  broker cares — the boxes are the same — but the header is not a guess.
- **The provider now spawns ffmpeg with four pipes, always.** An unused fd
  costs nothing, and a spawner that had to read the args would be a second
  authority on whether a stream carries sound.
- **An ADPCM camera gets a named silence, not a garbage track**, exactly as
  `decideClipAudio` decided for the file path.
- **A recording whose sound starts after the rate probe is silent, by name**
  (`stream-audio-after-mux`). The window is ~16 access units, about one
  second, and the camera interleaves audio from the first packets, so this is
  a stated bound rather than an expected case.
- **Deploy order is unchanged and still matters**: provider-reolink first,
  then addon-pipeline. A broker newer than its provider asks for a codec the
  provider ignores, reads `servedAudio` absent, and plays the clip silent with
  `audio-not-offered` on the line — never a refusal, and never silence nobody
  can account for.
- **`playSpeed` stays unwired** (D597), and audio makes the case against it
  stronger: the camera's own 8x replay would need a resample this path has no
  decoder for.
- The viewer half of `clipAudio` is NOT built. The server sends it; nothing
  reads it yet.

## Considered and not taken

**Copying the AAC across and transcoding at the broker.** It keeps the
provider codec-agnostic, and it costs a second long-lived ffmpeg on the
consuming hop with its own stdin/stdout drain rules and its own backlog —
the second bounded queue D597 and D447 exist to avoid. It also needs the ADTS
headers rebuilt from `esds` after `aac_adtstoasc` stripped them.

**Serving Opus to every session and converting to µ-law at the broker.** That
is a decode, in the process that must not decode.

**Refusing audio on PCMU sessions and saying so.** Defensible, cheap, and it
would have tested beautifully. It is also the answer that picks the path that
is easy rather than the one that works: `mov` costs one flag and one content
type, and both codecs are now proved on real bytes.

**Waiting for the first audio fragment before the first video frame**, so the
head is never clipped. It pays back D597's entire measured win to save the
43 ms this is worth.

## Enforcement

Twenty-one gates, each reverted in turn by a script that patches the line,
runs the spec, restores the file, verifies its sha256 is byte-identical and
re-runs green — **21 reverted, 21 red, 21 byte-identical restores, 21 green**.
Two of them were VACUOUS on the first pass and are recorded as such rather
than smoothed over: the demuxer's shared origin and its offset ordering are
both inert on the bytes ffmpeg actually writes (it starts both tracks at media
time 0 and lays the video run out first), so each needed a fixture with one
structural field changed — `shiftAllTfdt` and `swapTrafs` — before the gate
had anything to fail on.

- `recorded/__tests__/fmp4-stream-demux.spec.ts` (+16): the Opus and `ulaw`
  sample entries; identical audio at 1/7/100/4096-byte chunks; monotonic
  timestamps; BOTH tracks measured from the stream's own origin and not from
  media time zero; offset-order draining with the trafs swapped; an
  unsupported codec reported and the video kept; no track followed without a
  sink; the video byte-identical to the mp4box whole-file demux either way.
- `recorded/__tests__/clip-stream-audio.spec.ts` (7): Opus pass-through; the
  µ-law re-cut with nothing invented or lost; the byte-counted clock; the gap
  re-anchor and the rounding that is NOT one; **and the 440 Hz tone recovered
  from the fixture through a pure G.711 decode** — the check that a wrong
  rate, a channel mismatch or silence passes every frame count.
- `recorded/__tests__/clip-stream-feeder-audio.spec.ts` (13): the codec on the
  dial; `none` with no sender; every Opus packet at 48 kHz; 160-byte µ-law at
  8 kHz; one interleaved schedule; ONE clock across three seeks; a recording
  with no track; a dial that offered nothing; a codec mismatch; late audio
  dropped not burst; audio dropped off 1x; the first-audio line; the answer
  settled on a cut.
- `addon-provider-reolink/src/__tests__/clip-stream.spec.ts` (+4) and
  `clip-stream-mux.spec.ts` (+2): the `pipe:3` input only when a frame is
  held; the mapping; `mov` for µ-law; ADPCM named apart; sound after the mux
  named apart.
- `clip-stream-route.spec.ts` (+2): the twin the route was TOLD, and the
  refusal when the row has no handle for it.

**The fixtures are real bytes**: `clip-frag-opus.mp4` and `clip-frag-pcmu.mov`
are written by `buildClipStreamMuxArgs` itself, spawned with the production
four-pipe `stdio`, fed video and ADTS in interleaved media order. The whole
chain was also run live — the real producer, a real ffmpeg, the real one-shot
loopback dial listener, the real HTTP opener and the real feeder — on both
codecs: 60/60 access units, 206 Opus packets (4.100 s against 3.940 s of
video) and 204 µ-law frames (32 640 bytes = 4.080 s), zero dropped, zero
timestamp regressions, first audio 0 ms late. Decoded back, both served
streams carry the source's 440 Hz tone at its original level.
