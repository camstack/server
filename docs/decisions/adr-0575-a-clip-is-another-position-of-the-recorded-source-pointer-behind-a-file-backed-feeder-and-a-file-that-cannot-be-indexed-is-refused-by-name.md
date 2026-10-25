---
id: D575
title: A clip is another POSITION of the recorded source pointer, served by a file-backed byte source behind the existing feeder — and a file that cannot be indexed is refused by name, never played as a zero-length timeline
status: accepted
date: 2026-09-21
supersedes:
applies-to:
  - packages/addon-pipeline/src/stream-broker/recorded/clip-mp4-index.ts
  - packages/addon-pipeline/src/stream-broker/recorded/clip-file-source.ts
  - packages/addon-pipeline/src/stream-broker/recorded/timeline-session.ts
  - packages/addon-pipeline/src/stream-broker/recorded/control-protocol.ts
---

## Context

[D570](adr-0570-a-clip-plays-in-the-cameras-own-frame-and-the-playback-machine-is-structurally-detached-while-it-does.md)
banked a shape and refused to build it: *"add a file-backed source behind the
existing `RecordedFeeder` … a control message carrying a clip handle and a
file-relative timeline, a `TimelineSession` branch … Order of a week of server
work, and it deletes this ADR's sheet."* It was written from a reading, not
from an implementation. Three of its four claims survive contact with the code
and one is wrong in the direction that made the work cheaper.

**Survived.** `playRecorded` on the control channel really does carry only
`{deviceId, epoch, profile}` and has no room for a file. A progressive
`+faststart` MP4 really has no `mfra`, so a time→sample map has to be read out
of `stbl`. And the work really does touch no broker registry, no reconcile
sweep and no non-device key — a clip never becomes a cam-stream, so
`brokerOwned` and the cap wire are untouched.

**Wrong.** *"`RecordedFeeder`'s only byte source is `recording.locateSegment` /
`readSegmentBytes` / `readGopBytes`, all keyed `(deviceId, profile, epochMs)`.
No path, no handle. That is the thing to widen."* The feeder was never keyed to
the recorder at all: `RecordedFeederDeps` takes `locate` / `readBytes` /
`readGop` as **injected closures**
(`recorded-feeder.ts:123`), and it is the BROKER
(`broker-webrtc-server.ts`) that happens to wire them to the recording cap. The
feeder needed no widening; the clip path is a second implementation of two
closures it already accepted. The week of work was a day.

Two facts about the files themselves decided the rest.

**Reolink clips are muxed `+faststart`** — a `moov` at the front, a real
`stts`/`stss`/`stsz`, a known duration. They index.

**HKSV clips cannot be indexed at all.** Measured 2026-09-20: `mvhd.duration =
0`, `mdhd.duration = 0`, no `sidx`, no `mfra` — ffmpeg writes the trailer only
on close and the tee cuts like a pipe. Reproduced here as a committed fixture
(`__tests__/mp4-fixture.ts`, `HKSV_CLIP`) and cross-checked against a real
`-movflags frag_keyframe+empty_moov` file: the `moov` parses, the sample table
is present and EMPTY, and every duration field says 0. A remux costs 40 ms and
+0.7 % bytes and **this slice does not do it** — see Consequences.

## Decision

**A clip is another POSITION of the recorded source pointer, not a second
player and not a mode.** One control message (`playClip`) puts the pointer on a
file; `seek`, `scrubStart`/`scrubTo`/`scrubCommit`, `setRate`, `stepFrame` and
`goLive` then travel on that file's own axis, unchanged and unaware. Five rules
follow and each is enforced by a test proven red on revert.

1. **The byte source is swapped; nothing else is.** `createClipFileSource`
   implements the same `locate` / `readBytes` closures `RecordedFeederDeps`
   already takes, over ONE clip file. The broker builds both feeders through
   one `buildFeeder(profile, clip)`, so the demux, the push sink, the audio
   codec branch and the state/position/log seams are literally the same code.
   A clip that behaved differently from recorded footage would mean the claim
   was false.

2. **The timeline is FILE-RELATIVE, and the offset is REQUIRED.** `offsetMs` is
   milliseconds from the clip's first sample. Nothing adds an epoch base to it,
   here or downstream. It is not optional: an unstated position is not zero
   (D382), so a client that means "from the start" says `0` and a client that
   forgot is refused at the schema.

3. **Clip playback is recorded mode with a different source — NOT a third
   mode.** `currentMode` still reads `live | recorded`, so every invariant built
   on it holds unchanged (the adaptive ladder still suspends itself while the
   pointer is off live). D570's go-live terminator is honoured by construction:
   `goLive` clears the clip pointer in the same dispatch it ungates the feed,
   and the cheapest way not to have a mode `GO_LIVE` cannot leave is not to add
   the mode. `playRecorded` leaves it too, through the one `leaveClip()`.

4. **A file that cannot be indexed is REFUSED BY NAME, and so is every other
   dead end.** `indexClipMp4` answers `no-moov | no-video-track | no-samples |
   malformed`; the source adds `fetch-failed` and `too-large`. Each is thrown
   AND logged with `tags: { deviceId }` and the clip id. A `playClip` on a
   session with no clip byte source never gates the live feed, never builds a
   feeder and emits `state: 'error'` — it is refused, not dropped (D391: the
   branch that accepts work and produces nothing is the same branch). A
   `setProfile` during a clip says the clip has no tier rather than rebuilding
   the feeder and throwing the fetched bytes away.

5. **The index is a TIME index, on purpose — the time→BYTE half is not built.**
   D570 said "map time to bytes". Offsets in a progressive `moov`
   (`stco`/`stsc`) are absolute to the whole file, so a GOP-ranged slice of one
   is not standalone-demuxable without rewriting `stbl` — a remux per scrub
   target. The clip is already resident whole, so **the file IS its byte
   range**, which is exactly what `RecordedFeederDeps.readGop` says of the
   playback path. The clip source therefore offers **no `readGop`**, and the
   feeder degrades to the whole-segment read on its own. Parsing offsets nobody
   reads would have been a leftover describing a design this slice does not
   have.

**D9/D18 is honoured by the SHAPE, not by a bound.** The clip crosses the
process boundary exactly ONCE, whole and already compressed, by handle
(`videoclips.readClipBytes` → base64 → `Uint8Array`), cached for the life of
the feeder. Every frame after that is demuxed and pushed in the broker process,
where recorded frames already are. A terminal refusal (unindexable, over-size)
is cached so a drag cannot re-fetch a 35 MB file per pointer move; a FETCH
failure is deliberately NOT cached, because a sleeping battery camera is a
transient no and the operator's retry must reach it.

## Consequences

- **The clip sheet D570 shipped can be deleted — but not by this slice.** This
  is server-side only. The viewer change is named in Enforcement and is the
  next piece of work; until it lands, nothing sends `playClip` and the sheet is
  still what the operator sees.
- **HKSV clips do NOT join yet, and the remux is owed by the PRODUCER.** A
  consumer-side remux would put an ffmpeg per viewer in the broker runner and
  would have to buffer the whole file to write a trailer — the same cost D570 §
  5(b) rejected, moved one process along. The right owner is whoever writes the
  tee (`addon-export-hap`), at mint time, once per clip, at the measured 40 ms
  and +0.7 %. Until then an HKSV `playClip` is refused with `no-samples` and the
  operator is told which file it was. This is named as not-yet rather than
  hidden behind a branch.
- **Analytics clips still do not join**, for the reason D570 gave: they are an
  HLS VOD window over footage, not a file. They do not need to — they are
  already recorded-path positions, which is what this makes a native clip into.
- **A session with no RECORDER gets no clip playback**, because the whole
  `TimelineSession` block is gated on `locateRecordedSegment && readRecordedSegmentBytes`
  being wired. On this cluster the recorder is always present, so it costs
  nothing today; it is written down because "clips need the recorder" is not
  obvious from the design and would be a confusing failure on a recorder-less
  node.
- **The `?mode=recording` HLS embed is dead and should go, separately.** Reading
  the viewer to place the file-relative timeline turned this up: nothing in
  `camstack/src/**` builds an embed URL with `mode='recording'` — the three
  builders are only ever called with `player` / `grid` / `events` — so
  `EmbedRecordingPage` compiles, is dispatched by `EmbedApp.tsx:32`, and is
  reachable by nobody. Its own docblock already calls it legacy. **The admin
  UI's `recording.getPlaybackManifest` consumer is a different thing and is NOT
  dead** (`RecordingTimeline.tsx` → `HlsVideo` → real `hls.js`), and neither is
  the recorder's own `videoclips-wiring.ts` use of it — nothing server-side
  moves. Not touched here; recorded as a finding with its evidence.

## Enforcement

Every test below was proven red by reverting the line it guards and re-running
it (12 reverts, all red; one was added BECAUSE the first attempt stayed green).

- `recorded/__tests__/clip-mp4-index.spec.ts` (10) — the HKSV shape refuses by
  name, a missing `stss` means every sample is sync, a truncated file refuses
  instead of throwing, and two cases cross-check a REAL ffmpeg `+faststart`
  file and a REAL `empty_moov` one when those local fixtures are present.
  Red on: deleting the empty-sample-table gate (the HKSV file would "play"), and
  on calling every sample a keyframe.
- `recorded/__tests__/clip-file-source.spec.ts` (9) — one segment over the whole
  file, `ended` past the end, snap-forward to the first sync sample, ONE fetch
  per session, a cached terminal refusal, an uncached transient one, the byte
  bound. Red on removing each.
- `recorded/__tests__/timeline-session-clip.spec.ts` (15) — the schema refuses a
  `playClip` with no offset / an empty clip id / a negative offset; the session
  never consults the profile ladder for a clip; seek/scrub/rate/step stay on the
  clip feeder; `GO_LIVE` leaves in one dispatch; **a `seek` after `goLive` is
  ordinary recorded playback** (the guard the first pass missed — without
  `goLive` clearing the pointer the stale clip branch swallows the operator's
  tap and logs nothing); `playClip` with no clip source is refused out loud.
- **The viewer half is unguarded because it does not exist yet.** What it would
  do: send `{t:'playClip', deviceId, clipId, offsetMs, profile}` on
  `camstack-control` instead of mounting a `<video>`, treat every `position`
  while a clip is attached as file-relative ms, and STOP calling
  `videoclips.getClipPlayback` for playback (it stays the right answer for
  download/export). `RecordedTrackSession` in `EmbedPlayerPage` already owns the
  channel; nothing new is negotiated. Whoever lands that deletes D570's sheet
  and this bullet with it.
