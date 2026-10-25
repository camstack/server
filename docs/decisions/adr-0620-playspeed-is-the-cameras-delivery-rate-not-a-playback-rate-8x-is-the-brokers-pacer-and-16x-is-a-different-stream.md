---
id: D620
title: "`<playSpeed>` is the camera's DELIVERY rate, never a playback rate — 8x stays the broker's pacer, 16x is a different stream, and the supply that feeds either was thrown away by the always-on ReplaySeek"
status: proposed
date: 2026-09-23
supersedes:
applies-to:
---

## Context

The operator asked twice for the full Reolink ladder — *"ancora non mostriamo
tutte le speed disponibili fino a 16x"* [we still do not show all the available speeds up to 16x], *"ieri li abbiamo gia' identificati per
Reolink, sono 0.25,0.5,1,2,4,8,16"* [yesterday we already identified them for Reolink, they are 0.25,0.5,1,2,4,8,16]. The hub answers
`videoclips.getPlaybackOptions` for 592 / `provider-reolink` with
`[0.25, 0.5, 1, 1.5, 2, 4]`, and the record above `CLIP_BROKER_PACED_RATES`
priced the missing two as "the camera's own `<playSpeed>`, unwired (D597,
D600)": a rate change costing a new dial and a new stream, an 8x needing an
audio resample this path has no decoder for, and — the premise the whole price
rested on — a cmd-5 transfer that "lands the clip at 49–62x realtime", so that
the broker already reaches 4x for free and `playSpeed` would buy only the
rates above it (D612).

The operator then removed the audio objection outright: *"L'audio non serve in
velocità non 1x!!!"* [Audio is not needed at speeds other than 1x!!!] — there is nothing to resample because nothing is carried.
So the work came down to one measurable question: **does a `<playSpeed>` above
1 deliver media that is really time-compressed?** These firmwares answer 200
and do as they please, so the answer had to come from decoding what arrives,
not from the absence of an error.

### What was measured

Camera **107** (E1 Outdoor PoE, `v3.1.0.5223_2510172100`), direct TCP on the
LAN, `@apocaliss92/nodelink-js@0.11.1` — the deployed version — with
`<playSpeed>` made settable in a throwaway copy of the installed `dist` and
the transfer decoded with the library's own `BcMediaAnnexBDecoder`, which is
what the provider's clip stream uses. Clip
`…/2026-09-23/Rec{S,M}03_DST20260923_194619_194657…`, 38 s wall, ~39.9 s of
media.

Sub twin (947 472 B), one row per run, `x` = media seconds delivered per second
of wall clock:

| `<playSpeed>` | delivery | x realtime | access units | media span | audio frames |
| --- | --- | --- | --- | --- | --- |
| 1 | 33 591 ms | 1.2x | 594 | 39.855 s | 624 AAC |
| 2 | 15 913 ms | 2.5x | 594 | 39.855 s | 624 AAC |
| 4 | 6 135 ms | 6.5x | 594 | 39.855 s | 624 AAC |
| 8 | 1 919 ms | 20.8x | 594 | 39.855 s | 624 AAC |
| 16 | 334 ms | 108.7x | **10** | 36.296 s | **none** |

Main twin, same clip (31 703 064 B, 989 access units, 39.895 s): `playSpeed 1`
→ 10.06 s of media in the first 7 370 ms, **1.37x**, the transfer abandoned
there rather than hold the camera's one replay lane for the rest;
`playSpeed 8` → 4 872 ms, **8.19x**, all 989 units, full audio;
`playSpeed 16` → 788–951 ms, **20 access units**, median inter-frame
**2 025 ms** (exactly the camera's measured ~2 s GOP), span 38.375 s, **no
audio**, reproducible.

Three facts fall out, and only the third was expected:

1. **`<playSpeed>` does not touch the media.** At 1, 2, 4 and 8 the transfer is
   byte-identical — same 947 472 bytes, same 594 access units, same first and
   last presentation timestamps, same 39.855 s span, same 624 AAC frames. Only
   the wall clock changes. There is no time compression to deliver; a player
   handed the `playSpeed 8` bytes and paced at 1 plays a 39.9 s clip for
   39.9 s.
2. **`playSpeed 16` is not a rate at all — it is an I-frame-only MODE.** The
   camera answers with one frame per GOP across the whole clip and drops the
   audio track entirely. That is a genuine fast-forward SOURCE, but it is
   different CONTENT, not the same stream delivered differently.
3. **The 49–62x premise is true of the camera and false of the code.** The
   cmd-123 `<ReplaySeek>` that 0.11.1 now sends before *every* replay (added
   2026-09-23, to stop a sticky seek silently shortening the next clip) puts
   the channel into a PACED playback mode. The same file, same connection,
   same `playSpeed 1`, with the seek suppressed:

   | | with `<ReplaySeek>` | without |
   | --- | --- | --- |
   | sub, ps 1 | 33 591 ms (1.2x) | **418 ms (95.3x)** |
   | sub, ps 2 | 15 913 ms (2.5x) | 412 ms (96.7x) |
   | sub, ps 4 | 6 135 ms (6.5x) | 362 ms (110.1x) |
   | sub, ps 8 | 1 919 ms (20.8x) | 343 ms (116.2x) |
   | main, ps 1 | 10.06 s of media in 7 370 ms (1.37x) | whole clip, **3 137 ms (12.7x)** |

   Without the seek, `playSpeed` is indistinguishable from absent (418 vs
   343 ms): the transfer is already a raw file download at line rate. With the
   seek, supply collapses by ~80x and `playSpeed` is the only thing that
   restores it.

## Decision

**A Reolink clip's playback rate is the BROKER's pacer. `<playSpeed>` buys
SUPPLY, never speed, and is set from the rate the dial asked for — never
offered to a surface as a rate of its own. A rate is offered only when the
supply measured behind it exceeds it; 16x is not a rate but an I-frame-only
STREAM and is dialled as one, with its own declaration that it carries neither
every frame nor any sound.**

Corollaries, each of them a thing this record forbids:

- **Nothing in this repository may describe `<playSpeed>` as the mechanism for
  8x or 16x playback.** It is a transfer knob. The docblock above
  `CLIP_BROKER_PACED_RATES` and D612's own pricing both say otherwise and are
  wrong on the measurement; they are corrected by this record, not by silence.
- **`0.25 … 4` is not currently deliverable on Reolink.** With the always-on
  seek the source arrives at 1.2–1.37x, which is precisely the condition
  `CLIP_REALTIME_SOURCE_RATES` exists for (D616): the pacer consumes `rate`
  seconds of media per second of wall clock while the socket supplies ~1, so
  1.5x, 2x and 4x drain the queue and starve. Reolink is today offering a
  ladder it cannot serve — the D612 defect, returned through a different door,
  and not by anybody adding a rate.
- **The repair is the supply, before the ladder.** Either the replay is not
  positioned when the caller asked for no offset (restoring the 95–116x
  download), or every replay carries `<playSpeed>` at least as large as the
  rate that will be paced over it. The second is strictly better because it
  keeps the seek's correctness and it is the only one that survives a seeked
  clip; the first is a smaller change and would restore 2x/4x today.
- **Audio above 1x is dropped, deliberately, and said so.** The broker already
  does the dropping — `ClipStreamFeeder.pushNextAudio` discards every frame
  while `rate !== 1` and counts them as `audioDroppedRate` — so the operator's
  instruction is, on the broker-paced path, already the live behaviour and
  needs no change. What it does NOT do is TELL anyone: the run's summary line
  carries the count, but the `clipAudio` server message has no reason naming
  the rate, so a clip silent at 2x and a clip silent because the stream broke
  are the same `carried: false` to the viewer. That is the D391 half of this
  record, and it is the one thing that must ship before any rate above 1 is
  widened.

## Consequences

- **8x and 16x are not wired by this record**, and nothing in the Reolink
  provider changes to make them appear. They cannot be: the user-visible rate
  is `ClipStreamFeeder`'s, `clampPlaybackRate` pins it at 4, and the `setRate`
  control message's own schema is `.max(4)`. Offering 8 today would accept a
  rate and deliver 4 — the exact defect D612 exists to end. The ladder widens
  in `packages/addon-pipeline`, not here.
- **The order is fixed, and it is not the order the request implies.** (1) the
  audio reason that names the rate; (2) the supply repair, which is worth more
  than either new rate because it is what makes the THREE rates already on the
  fleet honest; (3) the clamp, the `setRate` bound and `CLIP_BROKER_PACED_RATES`
  moving together to `[…, 4, 8]`; (4) 16x last, as a separate I-frame dial,
  because it is a different stream and its ~0.5 fps source has to survive
  `probeClipStreamRate`, which wants more access units than a whole clip in
  that mode contains (20, main; 10, sub).
- **The library is the gate on (2) and (3).** `@apocaliss92/nodelink-js` hard-
  codes `"<playSpeed>1</playSpeed>"` in both
  `buildFileInfoListReplayByIdXml` and `buildFileInfoListReplayByNameXml`
  (`src/reolink/baichuan/utils/recordingReplay.ts`), and
  `fileInfoListReplayBinaryDownload` has no parameter to reach it. The change
  is one optional `playSpeed?: number` on both builders, defaulting to 1, and
  one on the download's params object forwarded to whichever builder it picks —
  plus the same on `startRecordingReplayStream` and
  `standaloneStartReplayStream`, which call the same two builders. Until that
  release lands, no amount of work in this repository can send anything but 1.
- **`seek: 'forward'` is untouched.** The seek measured here is the library's
  own positioning call, not a viewer gesture; suppressing it for an
  unpositioned transfer does not make the stream seekable.

## Enforcement

Nothing, review only — deliberately, because there is nothing wired to guard.
What can be guarded, once the ladder does move, is the thing that would make it
a lie again: a test that drives `ClipStreamFeeder` at every entry of
`CLIP_BROKER_PACED_RATES` and asserts the pacer emits at that rate rather than
at `clampPlaybackRate`'s ceiling — asserting what it DOES, not that the
constants match, because a constant compared against itself is exactly how 8
and 16 were offered and clamped to 4 with no line anywhere saying so.

The measurement in this record is reproducible: patch a throwaway copy of the
installed `dist` so `<playSpeed>` and the cmd-123 seek are settable from the
environment, run the transfer through `BcMediaAnnexBDecoder`, and compare the
access-unit count and presentation-timestamp span against the clip's own
duration. Verifying by the absence of an error proves nothing here: every
`playSpeed` value above, including the two that change the camera's behaviour
completely, returned success.
