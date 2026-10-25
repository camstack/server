---
id: D617
title: An Amcrest clip PLAYS from the camera's replay and is EXPORTED from the file, because the 75 seconds are the camera's own wire — and a refusal that reaches nobody reads as a size limit
status: accepted
date: 2026-09-23
supersedes:
applies-to:
  - packages/addon-provider-amcrest/src/clips/clip-stream.ts
  - packages/addon-provider-amcrest/src/clips/clip-stream-mux.ts
  - packages/addon-provider-amcrest/src/clips/clip-stream-dial.ts
  - packages/addon-provider-amcrest/src/clips/clip-replay-url.ts
  - packages/addon-provider-amcrest/src/clips/replay-lane.ts
  - packages/addon-provider-amcrest/src/clips/clip-data-plane.ts
  - packages/addon-provider-amcrest/src/clips/clip-file.ts
---

## Context

The operator timed the shipped Amcrest clip path end to end, cold, against 3836
(server 1.2.376, `addon-provider-amcrest` 0.2.119): 74.7 s to first byte for a
42.5 MB clip, 67.9 s for 38.2 MB, and **zero bytes after 151 s** for 106 MB.
Three questions followed: where the seconds go, what the 106 MB clip really
did, and what a clip should be played from.

### 1 — Where the seconds go: nowhere this process can reach

The provider already logs the breakdown, and it is not close:

| clip | `fetchMs` | `remuxMs` | total |
| --- | --- | --- | --- |
| 42 523 532 B | **74 475** | 121 | 74 596 |
| 38 243 779 B | **67 729** | 110 | 67 839 |

**99.8 % of the wait is the HTTP pull and 0.2 % is the re-index.** Confirmed
against the wire rather than inferred — the same file, same minute:

| puller | elapsed | rate |
| --- | --- | --- |
| the provider (`fetchMs`) | 74.5 s | 0.57 MB/s |
| `curl` inside the hub container | **81.5 s** | 0.50 MB/s |
| `curl` from a Mac on the same LAN | 42.5 s | 0.96 MB/s |
| two concurrent pulls from the hub | 46.2 / 46.7 s | 0.73 + 0.82 MB/s |

A bare `curl` is SLOWER than the provider. There is no overhead to remove: the
camera serves the hub at 0.5–1.1 MB/s while it is also serving its own live
main and sub streams to the recorder and the pipeline. The feasibility probe's
2.87–3.5 MB/s was a different client against a camera nobody else was using,
and it is not the number this path gets.

`/cam/playback`, muxed by **the exact argument list `buildClipStreamMuxArgs`
ships**, run from the same hub container against the same 51-second clip:

| audio ask | first byte | bytes in 5 s |
| --- | --- | --- |
| `none` | **835 ms** | 2 888 669 |
| `opus` | **1 102 ms** | 1 755 340 |
| `pcmu` | **1 659 ms** | 2 500 052 |

The same clip costs 74 475 ms one way and 835–1 659 ms the other, and the
difference is not code. (A first run measured 16 950 ms — while a whole-file
pull of the 106 MB clip was saturating the same camera. Every number above was
taken with nothing else of ours attached, which is the discipline the 3.5 MB/s
figure did not have.)

### 2 — What the 106 MB clip really did: the card, reported as nothing at all

Reproduced exactly, twice. A GET of the media route for
`1790168287-1790168435` ran **228.6 s and answered `HTTP 404`, zero bytes, no
body and no header** — the same answer a typo in the URL gets. The provider had
named the reason on a WARN line at the same instant (`ffmpeg exited 183: moov
atom not found`) and the route threw the name away on the one path that reaches
a person. That is D391 and D611 in one branch, and it is why the operator read
it as "above ~100 MB it does not deliver at all".

It is not a size limit and it is not a transfer fault. Replicating
`fetchRecording` byte for byte, twice, on different hosts:

- the camera declares `content-length: 105971106` and delivers **exactly**
  105 971 106 bytes — counted, and on disk;
- the box chain is `ftyp`, `free`, **68 `mdat`**, and then at offset
  **1 801 275** a box typed `FF FF FF FF`: a **33 733-byte run of `0xFF`**
  ending exactly on the 1 792 KiB (28 × 64 KiB) erase-block boundary;
- the break is at the SAME offset on both reads, so it is on the card;
- the two reads nevertheless DIFFER from byte 51 169 356 on, so the unreadable
  region is served with whatever the camera had rather than deterministically;
- `/cam/playback` over the same window answers `DESCRIBE/SETUP/PLAY` 200 and
  delivers **57 RTP packets in 4 s** where a healthy clip delivers ~2 400;
- an **88 900 431-byte** clip from the same card, pulled the same way, parses
  to its last box and `ffprobe`s to 106.496 s.

So: one damaged recording, and `fetch-failed` sent the operator to look at a
network that had done its job to the byte.

### 3 — The declaration and the routing DID disagree, on this hub, today

`chooseClipPath` picks `stream` whenever `streamDialWired`, and that flag is
`dialClip !== undefined` on the BROKER — a literal arrow function in
`stream-broker/addon.ts`, so it is `true` always, for every provider. D612
noted this; D615 left it. Measured against the live hub:

- `videoclips.getPlaybackOptions` for 3836 answered
  `file | seek free | scrub true | rates [0.25 … 4]`;
- `videoclips.dialClipStream` for an Amcrest clip answered
  `child-cap-dispatch: method 'dialClipStream' not found`.

So a clip of this camera reaching the broker would be routed `stream`, dialled,
answered `unavailable`, and handed `createRefusedClipFeeder`. **Nobody has seen
it only because nothing routes an Amcrest clip through the broker**: the
viewer's `resolveClipTap` maps every native clip to `kind: 'file'`, and the
74.7 s the operator measured is a `<video>` element on the addon's own media
route. Six hours of hub log carry not one `clip playback: path chosen` for
3836.

### 4 — The camera's session ceiling is not three, and is not ours to hold

D615 carried forward "exactly THREE slots, and the fourth is a 404". Re-measured
on 3836 with the hub's live streams running, sessions opened and held:

| asked | granted | first refusal |
| --- | --- | --- |
| 10 | **9** | `DESCRIBE 404` on the 10th |
| 12 | **8** | `DESCRIBE 404` on the 9th |

Neither three nor stable — a total budget the playbacks share with whatever else
is dialling the camera, and the hub's own live streams attach and detach with
every detection session. Two of the granted sessions also answered `PLAY 200`
and delivered **zero RTP in four seconds**. The refusal is still a 404, still
byte-identical to a bogus path and to an evicted clip.

## Decision

**An Amcrest clip PLAYS from `/cam/playback` and is EXPORTED from the file, and
the declaration says which** — `CLIP_PLAYBACK_OPTIONS.realtimeStream`, the
entry D616 minted, named rather than re-minted.

- **`dialClipStream` is wired**, so the broker's `stream` routing and the
  provider's `stream` declaration agree. They agree because the envelope's
  transport and the method's presence are now decided together, which is the
  only thing keeping them in step while `chooseClipPath` reads a constant of
  the broker's own closure (see Consequences).
- **`offerClipBytes` and `readClipBytes` keep the file path unchanged.** An
  export IS a download and 75 s for 42 MB is what a download costs here; it is
  also the only route that yields a whole `stbl`-indexed MP4 with sound.
- **`rates` is `CLIP_REALTIME_SOURCE_RATES`.** The source arrives at ~1.1×
  (about 600 video RTP per second against a 51 s clip), the pacer consumes
  `rate` seconds of media per second of wall clock, and D612's rule is that a
  rate which cannot be delivered is never offered.
- **`seek` is `forward`, and that is a measurement we have NOT made.**
  `/cam/playback` honours a repositioning `PLAY Range` and answers where it
  landed; nobody has decoded the RTP timestamps back to a wall-clock offset to
  check the answer is true. Declaring `free` would mean minting a fourth
  envelope on the strength of a status line, and this repo has been lied to by
  a declared field twice.
- **ONE replay per camera from this node**, held by the provider
  (`replay-lane.ts`), refused by name with the holder and the wait. The lane
  counts OUR replays and not the camera's, because the camera's ceiling is 8–9
  and varies with load — a number this addon cannot be the authority for. What
  it CAN own is that a 404 is reported as the camera's refusal naming all three
  things that status covers, never as this clip being gone (D611, D315).
- **Nothing reaches the peer until the mux has produced a byte**, so a camera
  that refuses is a status and a reason rather than an empty 200.
- **A re-index that fails after a byte-exact fetch is the CAMERA's**, decided
  structurally — the fetch has already proved the declared length arrived, so
  there is nothing to retry and the card is the only thing left. `camera-refused`,
  with a sentence that says re-fetching returns the same bytes. When the camera
  declared no length it stays `fetch-failed`, because a short body and a
  complete one are then indistinguishable and the bytes could be ours (D393).
- **The media route carries its refusal**: `404` only for a clip this node has
  no row for, `413` for too large, `502` for the camera or its card, with the
  reason in `x-camstack-reason` through `clipReasonHeaderValue` and the code in
  `x-camstack-reason-code`.
- **The pinned ffmpeg is wired** (`ctx.deps.ensureFfmpeg()`), which this addon
  never called — the same miss D616 found one provider over.

## Consequences

- **`chooseClipPath` is now unanimous, and that is worth pricing rather than
  celebrating.** Reolink, Hikvision and Amcrest all implement
  `dialClipStream`, so its `file` branch is unreachable and its `stream` branch
  is correct for every provider *by coincidence*. The defect D612 named is
  still there: `streamDialWired` is a property of the broker's closure, not of
  the provider answering, so the next provider that implements only
  `readClipBytes` is routed `stream` and refused `stream-unavailable` — with
  its own honest `file` declaration sitting unread. **The fix is for the broker
  to read the provider's declared `transport` (`getPlaybackOptions`, already a
  per-provider fact, already cached, 0.15 s) instead of its own closure.** It is
  a change to `clip-path-choice.ts` and it moves every provider at once, so it
  is not slipped in beside a vendor slice; it is one record of its own, and it
  costs a cap call on the feeder-build path plus the absence branch (a provider
  that does not answer has not restricted anything — D612's own rule).
- **The viewer does not see any of this yet.** `resolveClipTap` maps every
  native clip to `kind: 'file'` and never reads `transport`, so 3836 keeps
  playing through the `<video>` element and keeps paying the 75 s until the
  viewer routes a `stream` transport to the embed player. The hub now declares
  honestly; the viewer draws what it always drew. That is D612's rollout order
  reached from the other side, and it is why this record ships the declaration
  and the producer together rather than waiting.
- **Audio is an encode on both asks.** The archive is AAC-LC 8 kHz mono and no
  WebRTC session speaks it, so `opus` and `pcmu` are both a transcode — where
  Hikvision's µ-law archive makes `pcmu` a copy. D600 verbatim.
- **`check-ffmpeg-primitive` was RED at `1104f812` and is green again.** Five
  clip spawn sites (Reolink ×1, Hikvision ×3, Amcrest ×1) had no allowlist
  entry; this record adds all six with their reasons rather than amnestying its
  own and leaving the guard red.
- **The 106 MB clip is still unplayable and now says so.** Nothing here repairs
  a damaged recording; `/cam/playback` over its window answers 200 and delivers
  almost nothing, so the stream path fails it differently rather than better.
  What changed is that the operator is told which camera and which card.
- **The clip stream dial is a bound loopback port.** `onShutdown` closes it; a
  runner respawn that skipped that would leave it bound.

## Enforcement

`packages/addon-provider-amcrest/src/clips/__tests__/` — 203 tests. Every gate
below was proved by removing it, watching the named count fail, and restoring
the file `cmp`-identical.

| gate | disarm → failing |
| --- | --- |
| the media route carries the refusal's reason and a status that is not 404 | 2 |
| a re-index that fails after a byte-exact fetch names the CAMERA | 1 |
| the lane refuses by name rather than dialling a camera it already holds | 1 |
| nothing reaches the peer before the mux has produced a byte | 2 |
| the mux tells ffmpeg not to probe an input that has stated itself | 1 |
| the mux closes a fragment on a half second and flushes it | 1 |
| the provider declares the transport it implements, capped at realtime | 3 |
| the dial's reason header goes through `clipReasonHeaderValue` | 1 |
| a `DESCRIBE 404` is never reported as this clip being gone | 1 |
| a replay URL in a log line carries no credential | 2 |
| the dial token is ONE shot | 1 |
| the drain gate honours `write()`'s return (D447) | 1 |

**One disarm came back GREEN and that is the finding worth keeping.** The
404 gate originally asserted two phrases were PRESENT in the refusal sentence.
Prepending `"this clip is gone."` to the honest text — which is exactly the
regression the gate exists for — left it green, because a presence-only
assertion cannot see a claim being ADDED. It now asserts the sentence's opening
as well, and both disarm shapes go red.

**Not enforced, and worth knowing:** nothing checks that the broker's routing
and the provider's declaration agree. They agree today because one person
changed both in one commit. Until `chooseClipPath` reads the declaration, that
is review only.
