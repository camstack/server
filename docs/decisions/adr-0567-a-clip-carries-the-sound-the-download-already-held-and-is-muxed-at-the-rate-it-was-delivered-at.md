---
id: D567
title: A clip carries the sound the download already held, and is muxed at the rate it was DELIVERED at — the two numbers the wire declares are both wrong
status: accepted
date: 2026-09-20
supersedes:
applies-to:
  - packages/addon-provider-reolink/src/clips/clip-mux.ts
  - packages/addon-provider-reolink/src/clips/clip-catalog.ts
  - packages/addon-provider-reolink/src/clips/clip-service.ts
  - packages/addon-provider-reolink/src/clips/reolink-videoclips-provider.ts
---

## Context

Two pieces of D563 were written and never reached the screen.

**`Clip.inProgress` was not on any wire.** D563's own consequences say so, and
they are slightly generous: the schema had the field, `ClipTile` drew
`Recording…` from it, `clip-still-refusal.spec.ts` parsed it — and nothing
anywhere MEASURED it. The provider's `toClip` had nothing to copy, because
`ReolinkClipRow` had no such field and `listDayRows` never looked. So the
newest row, the one an operator sees first, kept reporting the frozen duration
D563 measured on 592 (`…_192927_000000_2B1E808_0.mp4`, read `17:29:27 →
17:29:56` at 17:37:06, 17:37:35 **and** 17:44:39Z, for a recording that had
been running fifteen minutes). `endMs` is the camera's own `<endTime>`, frozen
at whatever the index entry held when it was created.

**And every clip this addon has ever served has been silent.** `clip-mux.ts`
said so in its own docblock and blamed the library: the demuxer counted the
audio packets (`stats.audioPackets`) and had no API that returned them.
`@apocaliss92/nodelink-js@0.7.10` returns them, along with the measurements
that make a mux honest.

Two facts from the library's own session are the reason this is not a
one-line change, and both were re-confirmed here read-only on 592 (E1 Outdoor
PoE, mains, TCP) on 2026-09-20:

- **The declared frame rate is not the delivered one.** A Home Hub child's
  `InfoV1`/`InfoV2` says 30 and the camera delivers **15.019** (661 access
  units over 43.943 s of timestamps). Muxing at the declared rate makes the
  video half as long as its own audio. On 592 the two happen to agree
  (`fps 15 / infoFps 15` sub, `25 / 25` main, `fpsSource: timestamps` on
  both) — which is exactly why the declared number cannot be trusted: a camera
  where it is right looks identical to one where it is off by 2×.
- **The BcMedia header declares H264 on every packet of a hub child whose
  payload is H.265.** The detected codec is the only one worth reading.

What was NOT known, and had to be measured before anything could ship: the
library's whole report is `mainStream`, and this catalog lists the **sub**
files (D565) — whether a `RecS…` file carries audio at all was unknown.
Measured read-only on 592, 2026-09-20, one session, closed at the end:

| file set | picked file | video | audio |
| --- | --- | --- | --- |
| sub | `RecS03_DST20260920_121051_121133_…` | H264, `fps 15`, 43.254 s | **Aac / adts**, 677 frames, 351 363 B, 16 kHz mono, 43.328 s |
| main | `RecM03_DST20260920_121053_121133_…` | H264, `fps 25`, 41.295 s | **Aac / adts**, 645 frames, 334 755 B, 16 kHz mono, 41.280 s |

**A sub-stream clip carries audio, in the same ADTS layout as its main twin.**
There is no honest-silence surface to build, because there is no silence.

## Decision

**A clip is muxed at the rate it was DELIVERED at, with the codec that was
DETECTED, and it carries the sound the download already held.**

`buildClipMuxArgs` takes `fps` — `stats.fps`, the measured rate — and emits it
as an INPUT option, `-r`, before its own `-i`. When nothing on the wire
measured a rate (`null`, `0`, non-finite) **`-r` is omitted entirely**: the
fallback is the demuxer's own default, deliberately NOT the info header's
nominal rate, because that number is the one that caused the defect. A pass
whose `fpsSource` is not `timestamps` is logged with `tags: { deviceId }` — a
guess must never be indistinguishable from a measurement.

**The audio gate is `format === 'adts'`, never `audio != null`.**
`decideClipAudio` is the one place that decides, it carries the BYTES on the
`copy` arm so no caller can re-derive the gate and get it wrong, and
`CopyableClipAudio.format` is narrowed to the single literal so an `adpcm`
path cannot be typed into the mux at all. `adpcm` and `unknown` are served
silent and NAMED (`audio-not-copyable`), because a track stream-copied out of a
layout ffmpeg was not told about produces a file whose audio is garbage, which
is worse than a clip that is honestly silent. No transcode path is written:
there is no ADPCM camera on this fleet and a path nobody can exercise is a
leftover that reads as verification. A track that arrived with zero frames is
`no-audio-track`, not a track.

The mux is therefore
`-r <fps> -f <hevc|h264> -i video [-f aac -i audio] -c:v copy [-c:a copy
-bsf:a aac_adtstoasc] -movflags +faststart -f mp4 out`. `aac_adtstoasc`
because ADTS frames are not an MP4 audio sample. `+faststart` stays and is
pinned with two inputs as well as one: the seek and the known duration the MP4
path exists for depend on `moov` coming first (D549 22).

**And a recording that is still being written says so, from the file index to
the tile.** `isFileStillBeingWritten` is the one measurement: a `_000000_` end
stamp **and** a size of `0` or absent. BOTH, because a recording that ends
exactly at midnight is named `_000000_` and is closed, and a false positive
replaces a correct duration with `Recording…` for ever. `listDayRows` puts
`inProgress` on the row and `toClip` copies it onto the `Clip` — `toClip` is
the only site left, `toEventClip` having gone with the event path (D565).
`endMs` stays a number, because the mint window and the byte fetch both need a
bound; the flag says what that number is WORTH.

## Consequences

- **`@camstack/addon-provider-reolink` pins `@apocaliss92/nodelink-js@^0.7.10`**
  and will not work against 0.7.9: `ClipDownloadResult` now requires `audio`
  and the four new `stats` fields, and the narrow interface in
  `clip-catalog.ts` is the one place a library shape change shows up as a
  compile error. It did — in three test fakes, which is the seam working.
- **Every clip served from a Reolink camera gains an audio track**, and a
  `high` clip gains 335 KB of it per 27 s. Nothing re-encodes; the scratch
  directory gains a second file for the life of one mux.
- **`Clip.inProgress` is now reachable in production**, which makes D563's
  `Recording…` state real. The tile stops drawing a duration on the newest row
  of a camera that is recording right now.
- D563's consequence "`inProgress` is not on the wire yet" is retired by this
  record.
- Re-measured the same evening, read-only: of 355 sub and 355 main files on
  592's day, **zero** carried a `_000000_` segment and zero carried a size of 0
  or absent. The marker is rare, so the AND costs nothing and the detection
  will be exercised only while a recording is open — which is the one moment it
  matters.
- Nothing here was exercised on a battery camera or on a hub child. The hub
  child's two lies (declared 30 vs delivered 15.019, header H264 over H.265
  payload) are the library's measurement, honoured here and not re-confirmed
  on this fleet; 4263 was at 8 % and off limits, and no battery camera was
  woken.

## Enforcement

- `packages/addon-provider-reolink/src/__tests__/clip-mux.spec.ts` (27) pins
  the measured rate as an input option, a fractional rate carried verbatim,
  the omission of `-r` for every unmeasured shape (`null`, `0`, `NaN`, `-1`),
  the declared output container, the second input and its `-f aac`, `-c:v
  copy` / `-c:a copy`, `aac_adtstoasc`, `+faststart` with two inputs, the
  absence of every audio flag when there is no track, and the four
  `decideClipAudio` answers. **Proven red** by: dropping `-r` (2 fail);
  taking `fps` blindly so an unmeasured `0` reaches ffmpeg (1); dropping the
  audio input (3); dropping `aac_adtstoasc` (1); making the gate
  `audio != null` (2); dropping `+faststart` (3).
- `clip-catalog.spec.ts`'s `a recording still being written` (5) pins the
  measured name, the size-absent case, that a closed file is left UNMARKED
  rather than `false`, that real bytes beat the name, and that `endMs` stays a
  number. **Proven red** by removing the row field (3 fail across two files)
  and by dropping the size gate (1).
- `reolink-videoclips-provider.spec.ts`'s `a clip still being written says so
  on the wire` (3) pins the copy itself, from COLD. **Proven red** by removing
  the one line from `toClip` (1 fail).
- Verified end to end against the camera, not only against fakes:
  `scratchpad/clips/mux-verify.mts` downloads one real 592 file, runs the REAL
  `buildClipMuxArgs` through ffmpeg and ffprobes the result — sub: video
  26.667 s @ 15/1 beside AAC 16 kHz mono 26.944 s; main: 26.640 s @ 25/1
  beside the same 26.944 s of audio; `moov` at byte 36 and no `mdat` in the
  first 4 KiB on both.
- **Nothing guards the `tags: { deviceId }` log lines** in `clip-service.ts`
  — `prepareClipOnce` touches the real filesystem and spawns a real ffmpeg, so
  the addon has no `clip-service.spec.ts` and this is the one part of the
  change that is review-only. The vocabulary it logs (`no-audio-track`,
  `audio-not-copyable`, `fps-unmeasured`) is pinned in `clip-mux.spec.ts`; that
  the service prints it is not.
