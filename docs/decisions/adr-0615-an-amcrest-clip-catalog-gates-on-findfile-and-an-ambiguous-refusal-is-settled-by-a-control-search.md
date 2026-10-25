---
id: D615
title: An Amcrest clip catalog gates on findFile, and its ambiguous refusal is settled by a control search — not by the status line
status: accepted
date: 2026-09-23
supersedes:
applies-to:
  - packages/addon-provider-amcrest/src/clips/**
---

## Context

The operator fitted a memory card in device 3836 (IP4M-1041B, `2.800.1ENN001.0.R`)
and asked for onboard clips. The
[re-measurement of the same day](../design/2026-09-23-amcrest-clips-remeasured.md)
retired every protocol objection the feasibility study had raised, and named
seven traps. Building against it found an eighth, and it is the one that
decides the shape of the catalog.

**`mediaFileFind` cannot tell an EMPTY WINDOW from a MALFORMED SEARCH.** Both
are `result: false`, `code 285409284`, `message ""`. Measured four ways on the
live camera:

| condition | what it really is | answer |
| --- | --- | --- |
| `Channel: 99`, garbage times | malformed | `false / 285409284 / ""` |
| `Channel: 1` (this camera has only 0) | malformed | `false / 285409284 / ""` |
| `Flags: ["Timing"]` on an event-only card | nothing matched | `false / 285409284 / ""` |
| 2026-09-22, a day with no footage | **nothing matched** | `false / 285409284 / ""` |

The re-measurement's trap 2 is still correct and still mandatory — after a
`findFile` that FAILED, `findNextFile` answers `{"result":true,"found":0,
"infos":null}`, an authoritative-looking "this camera has no clips" from a
search that never ran, so the enumeration can never be the gate. But obeying
that rule alone inverts the defect: **every quiet Tuesday becomes
`unreachable`**, and the surface draws "this camera could not be reached" over
an ordinary empty day. That is D315 (*not-yet-known must never look like
not-installed*) reached from the other side — a plain ABSENCE about to look
like a fault.

Two further things were found while building, neither of them in the trap list:

- **45 of 60 rows an unfiltered `Flags: ["Event"]` search returns are single
  JPEG snapshots** — `Duration: 0`, `StartTime === EndTime`, ~250 KB each. A
  catalog without a `Types` filter is three-quarters unplayable rows with a
  zero-length window. `Types: ["dav"]` returns exactly the 15 recordings.
- **`Type` on a row is an ECHO of the filter, not a fact about the file.** The
  same recording — identical `FilePath`, which really ends `.mp4` and really is
  an ISO MP4 — comes back as `Type: "dav"` when the search asked `["dav"]` and
  `Type: "mp4"` when it asked `["mp4"]`. The re-measurement recorded `"dav"`
  because its probe asked for `dav`.

And `mediaFileFind` has no working CGI form on this firmware: `factory.create`
answers `200 result=<handle>`, but `findFile` answers **400 `Bad Request!`** on
five different condition encodings — and `findNextFile` then answers
**`200 found=0`**, reproducing trap 2 over the second protocol. So the addon
grows an RPC2 client, and only for this.

## Decision

**`findFile`'s own `result` is the only gate on an Amcrest clip search, and a
refusal from it is settled by a CONTROL search over an unbounded window before
it is reported as anything.**

- Control ANSWERS ⇒ the camera and the condition shape are both fine, so the
  narrow refusal means the window is empty. Return `[]`, source stays `ok`, and
  log the branch.
- Control REFUSES too ⇒ the index answers nothing anywhere while storage reads
  healthy. That is `index-empty`, and the report names BOTH windows that were
  asked.

The control costs one RPC pair, only on the refusal path, and was measured at
361–384 ms. It is never run on a listing that found something.

Four rules travel with it, each of them a measurement:

1. **`mediaFileFind.getCount` is never called.** 501 over CGI; over RPC2 it
   answers `{"count":0,"result":true}` on a find object that then enumerates
   rows. The terminator is `found < count`, confirmed over 31 pages at
   `count: 2` across 60 rows.
2. **`Types: ["dav"]` and `Flags: ["Timing","Event","Manual"]`.** The type
   filter is what keeps the JPEGs out; the wider flag set is what keeps a
   camera scheduled for CONTINUOUS recording from reporting an empty card.
   `Type` is never carried onto a row.
3. **`Summary` is never read.** Every row carries a fabricated
   `Summary.TrafficCar` — `PlateNumber: " "`, `Speed: 60`, on a camera with no
   ANPR licence. `Events` and `Flags` are the only things read about what
   happened.
4. **Every time crosses through ONE measured offset.** `global.cgi?action=
   getCurrentTime` against our own clock, bracketed by the round trip and
   corrected for the camera's whole-second truncation. The offset is RAW, not
   rounded to a timezone: a camera whose clock has drifted stamps its files
   with the drift, and carrying it is what makes the window the operator sees
   and the window the camera serves the same window. A clock that could not be
   read is `null` and the source is `unreachable` — never a zero offset, which
   is the same shape as "this camera runs on UTC" and would move the whole
   archive by the timezone it really has.

**Clip identity is the TIME WINDOW** (`native:amcrest:onboard:<startSec>-<endSec>`),
because `/cam/playback` accepts nothing else — `?filename=<FilePath>` and the
bare path form both 404. `FilePath` is what `RPC_Loadfile` accepts and stays a
property of the row.

**Every ask is served the one archived copy and `served` says `high`**, for
every profile including an absent one. `Record[0].Stream = 0`, `subtype=1`
answers 400 over a window that definitely holds footage, and 60 of 60 rows say
`VideoStream: "Main"`. The upgrade is logged ONCE per camera per asked profile
rather than per clip.

**`served` is NOT moved to `ClipPlaybackOptions`.** The re-measurement proposed
a per-provider "one copy only" field beside `rates`. It is not taken: the
viewer's quality picker is already driven by the ROW (`Clip.streams`), and
`camstack/src/clips/clip-export-quality.ts` states in as many words that it
deliberately does not read `getPlaybackOptions`, because that envelope
describes how a clip is DRIVEN while the copies that exist are a property of
the recording. Adding the fact there would put a second authority beside the
one the viewer just finished consolidating onto, and the viewer would go on
ignoring it. The shipped contract already has the expression — a `streams`
block holding only `main`, plus `supportSub: false` — and this provider sets
both. The gap the re-measurement found is real and it is a missing READER of
the ladder in the upgrade direction, not a missing field.

## Consequences

- **The addon now speaks two protocols.** Digest CGI for everything it already
  did plus storage and the clock; RPC2 for `mediaFileFind` and nothing else.
  The RPC2 client holds a session for 30 s and re-mints it rather than running
  a `keepAlive` timer — a listing is an operator-driven read and a timer is
  something a run arms that outlives it (D604).
- **A storage read is not added.** `recording-onboard` (D614) already reads
  `storageDevice.cgi?action=getDeviceAllInfo` through `parseOnboardStorage`,
  and the clip source maps that same parse into its own three states. One
  reader, one meaning.
- **`Type` may never be trusted on a Dahua catalog row** — on this family or
  any other. It is a filter echo.
- **The camera's own forward-only replay is NOT wired, and that is a slice, not
  an oversight.** See *"What this deliberately does not do"* below.
- **Half of the evidence base is still one camera and one day.** The zero-sample
  list from the re-measurement is now shorter — a 31-page search terminated on
  `found: 0`, and an empty day and a bogus channel were both exercised — but
  `Events` has still only ever carried `VideoMotion`, no clip has been recorded
  under IR, and `OverWrite` eviction has never been provoked on a card at
  0.54 %.

### What this deliberately does not do

`dialClipStream` over `/cam/playback` is not wired. It is buildable — measured
today, `ffmpeg -rtsp_transport tcp -i rtsp://…/cam/playback?channel=1&
starttime=…&endtime=… -c:v copy -c:a libopus -f mp4 -movflags frag_keyframe…`
serves, first byte at 2 735 ms, 9 MB in 20 s — but three things must be settled
first and none of them is code:

1. **The camera's exhaustion refusal is a `DESCRIBE` 404**, byte-identical to a
   bogus path and to an evicted clip. A provider must own its own slot count
   (measured: exactly 3) and refuse by name. An abandoned socket frees its slot
   instantly, so there is no wedge to sweep.
2. **The stream is realtime-bound** — ffmpeg reported `speed=1.04x`, matching
   the 0.97× drain measured over RTSP — so `CLIP_PLAYBACK_OPTIONS.stream`'s
   `rates: CLIP_BROKER_PACED_RATES` (up to 4×) cannot be delivered from it, and
   the camera's own `Scale` is accepted, never echoed, and drops the audio
   entirely. Offering the `stream` envelope unchanged would be the lie D612
   exists to end. An honest `stream` for this camera needs a THIRD entry in
   `CLIP_PLAYBACK_OPTIONS` with `rates: [1]` — a cap change.
3. **The delivered seek position is still unverified.** The camera honours a
   repositioning `PLAY Range` and SAYS where it landed, but nobody has decoded
   the RTP timestamps back to a wall-clock offset to check that the answer is
   true. This repo has been lied to by a declared field twice.

Until then the provider answers `CLIP_PLAYBACK_OPTIONS.file` and means it: one
bounded by-handle fetch of a whole, `stbl`-indexed MP4.

**Point 2 may already be solved elsewhere.** A sibling session was, at the time
of writing, adding a THIRD `CLIP_PLAYBACK_OPTIONS` entry for a realtime-bound
stream (`CLIP_REALTIME_SOURCE_RATES`, `[0.25, 0.5, 1]`) against the same
constraint reached from a Hikvision replay measured at 1.01× realtime. If that
lands, the Amcrest replay slice needs only points 1 and 3 — the slot gate and
the delivered-position measurement — and names that entry rather than minting
one.

### Provenance of the numbers in this record

Two sessions measured device 3836 on 2026-09-23 and this record mixes them, so
it says which is which.

**Re-measured while building the provider, against the live camera:** the
ambiguous `findFile` refusal (four conditions), the 45-of-60 JPEG rows, the
`Type` filter echo, the 31-page walk terminating on `found: 0`, the CGI
`findFile` 400 across five encodings, the wide control window (3 runs,
361–629 ms), the clock offset and its round-trip bias, the whole provider path
end to end (availability → catalog → empty window → index-empty), the
`RPC_Loadfile` fetch and re-index (34 518 701 bytes byte-exact in 10.4 s,
re-indexed in 355 ms, `moov` in the first 4 KB, 42.75 s of h264 2560x1440 +
aac against a 43 s row window), the bare socket close on a path the camera does
not hold, and `ffmpeg -rtsp_transport tcp` against `/cam/playback`
(first byte 2 735 ms, `speed=1.04x`, non-monotonic DTS on both tracks).

**Taken from [the re-measurement note](../design/2026-09-23-amcrest-clips-remeasured.md)
and NOT independently re-checked here:** the three RTSP playback slots and the
`DESCRIBE` 404 that a fourth gets, the free-seek behaviour, the `Scale`
results, `getCount`'s RPC2 zero, `factory.destroy`'s `Method not found`, the
ten-clip size distribution, `subtype=1` answering 400, and
`Record[0].Stream = 0`. Every one of those is load-bearing for the slice that
did NOT ship, which is one more reason it did not.

## Enforcement

`packages/addon-provider-amcrest/src/clips/__tests__/` — 167 tests, every gate
in this record disarmed and confirmed red before it was restored:

| gate | tests that go red when it is removed |
| --- | --- |
| `findFile` is the only gate | 4 |
| the control search settles an ambiguous refusal | 4 |
| `close` + `destroy` release the find object | 2 |
| `Types: ["dav"]` | 1 |
| a zero-length window is not a clip | 2 |
| `Length: 0` → `null` | 1 |
| `Summary` never reaches a row | 1 |
| an unreadable clock is `null`, not `0` | 1 |
| the measured offset, not the process timezone | 8 |
| a zero-length window is not a clip id | 1 |
| `served` is what is on the wire | 2 |
| the upgrade line is said once | 1 |
| `catalog-miss` for a row nobody listed | 1 |
| the offer bound caps the caller | 1 |
| a refused source is not flattened to `[]` | 1 |
| the listing is narrowed to its window | 1 |
| `-f mp4` on a `.part` output | 1 |
| a zero container duration is not a measurement | 1 |
| the media route refuses a traversal segment | 1 |
| the artifact store refuses an unsafe key | 2 |

`getCount` and `factory.destroy` are pinned negatively — a test asserts the
walk never calls either.

Two of these were NOT caught by the suite until the live run found them, which
is the part worth remembering: `-f mp4` (ffmpeg infers the muxer from the
extension, and the output is a `.part` file, so it exited 234 and wrote
nothing) and the round-trip bracket on the clock read. A test that reads an
argument list back cannot see the first, and a fake clock cannot see the
second.
