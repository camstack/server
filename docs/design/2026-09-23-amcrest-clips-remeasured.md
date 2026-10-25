# Amcrest onboard clips, re-measured with a card in the slot

> Status: MEASURED against device **3836** (IP4M-1041B, <hub-ip>,
> `provider-amcrest`, firmware `2.800.1ENN001.0.R`) on 2026-09-23, read-only.
> **No provider code was written and no camera configuration was changed.**
> Credentials were read in-process from `deviceManager.getDevice` and never
> printed or persisted.
>
> This re-opens [the 2026-09-22 feasibility study](./2026-09-22-amcrest-clips-feasibility.md),
> whose conclusion — *do not build* — rested on one fact that has changed: there
> was no memory card. Its own recommendation said *"If he fits a card,
> re-measure before writing a line of provider."* He has. This is that
> re-measurement, and it answers the five questions that note left open,
> re-checks the three traps it named, and settles the two contract questions it
> flagged.
>
> The contract compared against is
> [`videoclips.cap.ts`](../../packages/types/src/capabilities/videoclips.cap.ts);
> the shape that fills it is D597 / D599 / D600 / D604 / D611 / D613.

## The answer first

**Every technical objection yesterday raised is gone, and three of the five
unknowns came back BETTER than either shipped provider.** `/cam/playback`
serves, with a *free* seek and a complete AAC track. `RPC_Loadfile` hands over a
self-contained, `moov`-indexed ISO MP4 at 2.9 MB/s, concurrently, with no
wedging. Real files are 33–73 MiB, inside D613's 500 MiB streamed offer with
2× headroom even on the worst structural case. And clip granularity is an
EVENT, not a 5-minute clock packet — yesterday's premise on that was simply
wrong once footage existed.

**The recommendation is still "not yet", but the reason has completely
changed.** It is no longer protocol risk; it is that this is a one-camera
provider whose entire evidence base is ten daylight `VideoMotion` clips from a
card that has been in the slot for seven hours. See
[Recommendation](#recommendation) — the decisive step is a 20-minute re-run of
these probes in a week, not new work.

## What is on the card now

`storage.getDeviceNames` → `{"list":["/dev/mmc0"]}`. `storage.getDeviceAllInfo`
now answers `result: true` (it was `result: false` with error `268959743`
yesterday — the failure yesterday's note correctly refused to fold into "zero"):

```
Name "/dev/mmc0"  State "Success"  LockState 0  LifePercent 0
Detail[0]: Path "/mnt/sd"  Type "ReadWrite"  IsError false
           TotalBytes 134202327040   UsedBytes 476708864  (0.355 %)
```

Recording config is unchanged from yesterday and was NOT touched:
`Record[0].Enable=true`, `Format=mp4`, `PreRecord=5`, `Stream=0`,
`TimeSection` mask `393222` (`0x60006` — bit 0 clear, so events not
continuous), `MediaGlobal.PacketLength=5`, `PacketSize=1024`, `OverWrite=true`.

`ClipSourceAvailability` for this camera would now be **`ok`**, where yesterday
it was the fleet's purest `no-storage`.

---

## Q1 — Does `/cam/playback` actually serve?

**Yes, emphatically.** Yesterday's 404 was a camera with no files, and the
control (`/totally/bogus/path` → 404) correctly proved nothing either way.

`DESCRIBE rtsp://…/cam/playback?channel=1&starttime=2026_09_23_10_23_27&endtime=2026_09_23_10_24_41`
→ **200**, and the SDP carries the clip's own length and BOTH tracks:

```
a=range:npt=0-74.000000            <- exactly the catalog row's Duration
m=video 0 RTP/AVP 96   a=control:trackID=0
  a=rtpmap:96 H264/90000
  a=fmtp:96 packetization-mode=1;profile-level-id=4D4032;
            sprop-parameter-sets=Z01AMqaAKAC1kAA=,aO48gAA=
m=audio 0 RTP/AVP 97   a=control:trackID=1
  a=rtpmap:97 MPEG4-GENERIC/8000
  a=fmtp:97 streamtype=5;profile-level-id=1;mode=AAC-hbr;
            sizelength=13;indexlength=3;indexdeltalength=3;config=1588
```

**Only the `channel + starttime + endtime` URI form exists.** Two plausible
alternatives were measured and both 404: `?channel=1&filename=<FilePath>` and
the bare path form `rtsp://…/mnt/sd/2026-09-23/001/dav/10/…mp4`. A provider
addresses a clip by its TIME WINDOW, never by the `FilePath` the catalog gives
it — which is a different identity from Hikvision's and worth stating in a
`clip-identity.ts` equivalent.

A full session, unloaded, on a 74 s clip:

| | measured |
| --- | --- |
| `SETUP` trackID=0 / trackID=1 (TCP interleaved) | 200 / 200 |
| `PLAY Range: npt=0.000-` | 200, `Range: npt=0.000000-74.000000`, `RTP-Info` for both tracks |
| Time to first RTP | **685–1090 ms** |
| Full drain | 40 064 video RTP + **528 audio RTP**, 56 749 945 bytes in **76.1 s** |
| Effective pace | **0.97× realtime**, 0.75 MB/s |
| `PAUSE` | 200, and it really stops — 0 video RTP in the following 1.5 s |

### Seek is FREE, not forward-only — this is a first for the system

`PLAY` with a repositioning `Range` is honoured and the answer states where it
landed:

| ask | `PLAY` | `Range` answered |
| --- | --- | --- |
| `npt=0.000-` | 200 | `npt=0.000000-74.000000` |
| `npt=5.000-` | 200 | `npt=5.000000-74.000000` |
| `npt=17.500-` | 200 | **`npt=17.000000-74.000000`** |
| `npt=40.000-` | 200 | `npt=40.000000-74.000000` |
| `npt=73.000-` | 200 | `npt=73.000000-74.000000` |
| `npt=200.000-` (past the end) | **500** | — |

Frames resume after every accepted seek (1 476 video RTP in the 2.5 s after the
`npt=40` reposition). Two things follow.

1. **`ClipPlaybackOptions.seek` for this provider is `free`.** Reolink is
   `forward` because the camera offers no in-recording seek (D597); Amcrest
   genuinely does. The camera is also the first to REFUSE an out-of-range seek
   by status rather than by silence — `npt=200` on a 74 s clip is a clean 500.
2. **The camera rounds a fractional ask down to the second** (`17.500` →
   `17.000`) and SAYS so in the `Range`. That is D605's rule — a seek says where
   it LANDED — served by the wire, with no provider bookkeeping needed.
   > **Measured vs inferred, because this repo has been lied to by a declared
   > field twice.** What is MEASURED is the `Range` the camera answers with, and
   > that frames resume afterwards. What is NOT measured is whether the first
   > delivered frame is actually at that position — the RTP timestamps were not
   > decoded back to a wall-clock offset. The answered `Range` is not a multiple
   > of the 4 s GOP, so it is *not* reporting a keyframe snap; whether it is
   > reporting the truth is the one thing a provider must verify before
   > believing it, and it is a 30-minute measurement nobody has done.

---

## Q2 — Does `loadfile.cgi` honour `Range`?

**No. Range is ignored outright, on both HTTP retrieval routes.** But the
question turned out to be the wrong one, because one of those routes hands over
a complete indexed file and the other is a byte stream that needs no index.

### Route A — `RPC_Loadfile`: the whole file, and it is a real MP4

`GET /cgi-bin/RPC_Loadfile/mnt/sd/2026-09-23/001/dav/10/10.23.27-10.24.41[M][0@0][0].mp4`

| | measured |
| --- | --- |
| status | **200** |
| `content-length` | **56 242 806 — byte-exact against the catalog row's `Length`** |
| `content-type` | `application/http` (sic — not a media type; a consumer must not trust it) |
| TTFB | 142–211 ms |
| throughput | 16.0 s for 56.2 MB ≈ **2.87–3.5 MB/s** |
| container | `ftyp isom` / `isomiso2avc1mp41`, 1 `free`, **2 581 `mdat`**, 1 `moov` |
| `moov` position | offset **56 210 094 of 56 242 806** — the LAST 32 712 bytes |

So the file is a genuine, self-contained, `stbl`-indexable MP4 — the shape
D575's file feeder wants. The catch is the `moov` is at the end and there is no
ranged read, so **there is no way to index it without pulling all of it.**

`Range` was measured twice and ignored both times — no `206`, no
`content-range`, no `accept-ranges`, and the full 56 242 806 bytes returned:

```
Range: bytes=0-4095            -> 200, 56242806 bytes
Range: bytes=1000000-1004095   -> 200, 56242806 bytes
```

### Route B — `loadfile.cgi?action=startLoad`: a time window, headerless

`?action=startLoad&channel=1&startTime=<local>&endTime=<local>&subtype=0` →
**200**, 54 699 283 bytes, TTFB 1 141 ms.

Its body is **2 523 bare `mdat` boxes and nothing else** — no `ftyp`, no `moov`,
no index. The `mdat` sequence is byte-identical to the file's for the whole
prefix (`129450, 25194, 26624, 277, 19790, 28940 …` in both) and ends earlier,
trimmed to the asked window. Practically: this is the file's payload without the
means to interpret it. `ffprobe` cannot open it; forced as raw H.264 it produces
`missing picture in access unit`. The ~528 small (<600 byte) boxes in the
sequence are the AAC frames, interleaved, with no codec configuration anywhere
to say so.

It also ignores `Range` (200, 54 699 283 bytes, no `content-range`).

**But it takes an arbitrary time window and it CROSSES FILE BOUNDARIES.** A
window spanning rows 0 and 1, which are separated by a 28 s gap:

```
10:23:27 .. 10:25:55  ->  200, 93 302 968 bytes
                          (the two rows' Lengths sum to 92 533 378)
```

That is a capability neither shipped provider's camera has, and it is what would
make a real scrub possible. Today it is unusable for lack of a header — but
`/cam/playback` takes the same arbitrary window over RTSP *with* an SDP, so the
window capability is reachable; it is only the HTTP expression of it that is
headerless.

### Everything else on the retrieval surface

| Probe | Result | Reading |
| --- | --- | --- |
| `loadfile.cgi?action=zzzBogus` | 501 `Not Implemented!` | control — the 400s below are meaningful |
| `loadfile.cgi…&filePath=<path>&offset=0&length=1024` | **400** | `filePath` is not an accepted selector; there is no offset/length read |
| `loadfile.cgi…startLoad…&subtype=1` | **400** | **no sub twin exists in the archive** (see contract Q1) |
| `loadfile.cgi…startLoad` over a window with no footage | **400** `Bad Request!` | byte-identical to a malformed request |
| `playBack.cgi?action=getCaps` | 501 | still absent on this firmware, card or no card |
| `playBack.cgi?action=zzz` | 501 | control |
| `RPC_Loadfile/<nonexistent path>` | **socket close, 0 bytes, `UND_ERR_SOCKET`** | yesterday's hazard, reproduced |

Two hazards for a provider, both confirmed:

- **A missing file closes the TCP socket with no HTTP status.** Yesterday this
  was observed against an empty camera and could have been anything; now a REAL
  path answers 200 on the same endpoint, so the socket close is specifically
  "not found". A client must survive a bare close and translate it to a named
  refusal, never to an absence (D611).
- **"No footage in this window" and "your request was malformed" are the same
  400 with the same 21-byte body.** The catalog is the only authority on
  whether a window holds anything.

---

## Q3 — One playback slot, or several?

**Two different answers for the two transports, and one of them is a trap.**

### HTTP retrieval: no limit found, no supersede, no wedge

Three simultaneous `RPC_Loadfile` pulls of three different files, all
completing with byte-exact lengths:

| | bytes | expected | TTFB | elapsed |
| --- | --- | --- | --- | --- |
| A | 56 242 806 | 56 242 806 | 303 ms | 37.8 s |
| B | 36 290 572 | 36 290 572 | 199 ms | 28.8 s |
| C | 76 397 277 | 76 397 277 | 177 ms | 45.3 s |

Aggregate ≈ 3.9 MB/s — they share bandwidth, they do not queue and they do not
supersede each other. A single pull of A immediately afterwards: 200, 56 242 806
bytes, 16.1 s — identical to the cold baseline. **Nothing wedged.** This is the
opposite of the Reolink behaviour D611 records.

### RTSP playback: exactly THREE slots, and the fourth is a 404

Opened one at a time, clean run, nothing else in flight:

```
session 0: DESCRIBE=200 SETUP=200 PLAY=200
session 1: DESCRIBE=200 SETUP=200 PLAY=200
session 2: DESCRIBE=200 SETUP=200 PLAY=200
session 3: DESCRIBE=404          <- refused, not absent
```

All three sustained delivery simultaneously (2 855 / 3 837 / 2 725 video RTP
over 5 s). Closing one freed the slot at once — the next session got 200 and
delivered 1 389 packets.

> **This is the single most dangerous finding in this note.** The exhaustion
> refusal is `404 Not Found` on `DESCRIBE`, which is **byte-indistinguishable
> from the control** (`/totally/bogus/path` → 404) and from a clip that has been
> evicted. A provider that reports a 404 as "this clip is gone" will, under three
> concurrent viewers, tell the operator that a clip which exists does not. That
> is D611 verbatim — *a refusal under load is not an absence* — and D315 —
> *not-yet-known must never look like not-installed*. **The provider must know
> its own slot count, gate on it, and name the refusal itself; it can never
> learn it from the status line.**

Good news on the other half of the question: **an abandoned session does not
hold a slot.** A session was opened, played for 2 s, then its socket was
destroyed with no `TEARDOWN`. Fresh sessions at t+0 s, +5 s, +15 s and +30 s all
answered `DESCRIBE=200 PLAY=200`. There is no reaper delay and no leak. The
Reolink failure mode that motivated this question — *a superseded transfer that
never settles wedges every later read of that clip* — does not occur here.

---

## Q4 — Does the archive carry the AAC track?

**Yes, complete, on both routes.** `ffprobe` on the file pulled by
`RPC_Loadfile`:

```
stream 0  h264   Main  2560x1440  yuv420p  30/1  has_b_frames 0
          nb_frames 2053  duration 68.433  bit_rate 6 553 238
stream 1  aac    LC    8000 Hz  mono  fltp  tag mp4a
format    isom / isomiso2avc1mp41   duration 68.433   size 56 242 806
```

And over RTSP the sound is not merely present but COMPLETE: the full drain
delivered **528 audio RTP packets**, against 528 small-`mdat` audio frames in
the file and ~578 expected for 74 s of 8 kHz AAC at 1024 samples/frame. Nothing
is dropped mid-clip.

**D600's transcode path applies verbatim and unchanged.** The archive is the
same AAC 8 kHz the live SDP advertises, no WebRTC session speaks it, so the
provider transcodes to `libopus` or `pcm_mulaw` exactly as Reolink does.
Hikvision's G.711u copy shortcut does not transfer, as yesterday predicted.

Two numbers a provider must carry:

- **`has_b_frames: 0`.** No reordering, so a demuxer's PTS/DTS handling is the
  easy case.
- **The container is 68.433 s where the catalog row says `Duration: 74`.** The
  row is the wall-clock window (`10:23:27 → 10:24:41`); the media is **7.5 %
  shorter**. D568's "materially short" completion check would fire on every
  single clip if it compared the delivered duration against the row naively.
  This must be measured per provider, not assumed.

---

## Q5 — Real file size at achieved VBR

72-hour search, all rows the card holds (it was fitted this morning, so this is
one partial day):

| MiB | duration | achieved | events |
| --- | --- | --- | --- |
| 72.9 | 92 s | 6.64 Mbit/s | VideoMotion |
| 53.6 | 74 s | 6.08 | VideoMotion |
| 49.1 | 65 s | 6.33 | VideoMotion |
| 47.3 | 64 s | 6.19 | VideoMotion |
| 42.4 | 56 s | 6.35 | VideoMotion |
| 38.9 | 51 s | 6.41 | VideoMotion |
| 35.6 | 46 s | 6.50 | VideoMotion |
| 35.6 | 45 s | 6.63 | VideoMotion |
| 34.6 | 46 s | 6.31 | VideoMotion |
| 33.4 | 43 s | 6.51 | VideoMotion |

- **443.4 MiB over 582 s of footage ⇒ aggregate 6.39 Mbit/s.**
- **Peak achieved 6.64 Mbit/s = 81 % of the 8192 kbps ceiling** — the same 81 %
  the Hikvision note measured on a completely different vendor, which is worth
  noting as a coincidence and not a law.
- Card at 476 708 864 of 134 202 327 040 bytes = **0.355 % after ~7 hours.**
  At this event rate the card is nowhere near a constraint.

### Against the two bounds

| | value | rows over it |
| --- | --- | --- |
| `VIDEOCLIPS_MAX_READ_BYTES` (inline, 50 MiB) | 52 428 800 | **2 of 10** |
| `VIDEOCLIPS_MAX_OFFER_BYTES` (streamed, 500 MiB, D613) | 524 288 000 | **0 of 10** |

And the worst STRUCTURAL case — a single continuous event that runs past the
5-minute `PacketLength` and is therefore cut at exactly 5 minutes, at the peak
achieved rate:

**5 × 60 s × 6.64 Mbit/s = 238 MiB.**

That is **4.8× over the inline bound and 2.1× under the streamed offer bound.**
D613 raised the ceiling in time: every clip this camera can physically produce
fits in a streamed offer, and none of them fits reliably inline. Yesterday's
estimate of ~300 MB used the VBR ceiling rather than an achieved rate and was
about 25 % pessimistic; the conclusion it drew ("a whole-file retrieval is not
viable") was right for `readClipBytes` and is now wrong for `offerClipBytes`.

> Caveat, stated plainly: **every clip above is daylight.** None was recorded
> with IR illumination on, and IR scenes are usually noisier and therefore
> larger at VBR. The 81 % figure is a daytime 81 %.

---

## The three traps, re-checked — and two new ones

### Trap 1 — `getCount`: CGI still 501, and RPC2 is WORSE

Yesterday's note recorded `getCount` as `501 Not Implemented`, so paging is
blind and the terminator must be `found < count`. **The CGI half is confirmed:**

```
GET /cgi-bin/mediaFileFind.cgi?action=getCount&object=…  -> 501 "Not Implemented!"
```

**But over RPC2 the method EXISTS and lies.** On a find object whose `findFile`
had just succeeded and from which seven rows were then enumerated:

```
mediaFileFind.getCount  ->  {"params":{"count":0},"result":true}
```

`result: true` with `count: 0`, against a search that holds rows. This is
strictly worse than the 501 the note recorded: a 501 is a refusal a provider
must handle, whereas this is an **authoritative-looking zero from a method that
answered successfully** — the exact D393 shape (*a measurement that FAILED is
`null`, never `0`*) produced by the camera itself. A provider must not call it
at all; the terminator remains `found < count`, and yesterday's conclusion
stands for a reason yesterday did not know.

> Not settled: the card holds only 10 rows, so a multi-page search could not be
> exercised. `found < count` is the terminator by construction, not by
> measurement, and one page is all that has ever been observed.

### Trap 2 — `findNextFile` answers cleanly after a `findFile` that FAILED

Reproduced exactly:

```
mediaFileFind.findFile  (Channel 99, garbage times)
   -> {"result":false,"error":{"code":285409284,"message":""}}
mediaFileFind.findNextFile {count:8}
   -> {"result":true,"found":0,"infos":null}
```

An authoritative-looking "this camera has no clips" from a search that never
ran. **`findFile`'s own `result` is the only gate**, and the error message is
still empty, so the refusal carries no reason a provider could pass on.

### Trap 3 — `factory.destroy` is absent; `destroy` works

```
mediaFileFind.factory.destroy -> {"error":{"code":268894210,
                                  "message":"Method not found!"},"result":false}
mediaFileFind.close           -> {"result":true}
mediaFileFind.destroy         -> {"result":true}
```

Confirmed, with one number yesterday could not supply: **12 find objects were
created concurrently without a refusal** (the loop's own cap, not the camera's).
So the pool is larger than "small and fixed" — but a leak is still a leak, and
`close` then `destroy` is the pair that works.

### New trap 4 — every row carries a fabricated ANPR summary

Every one of the ten rows, all of them plain `VideoMotion`, carries:

```json
"Summary": { "TrafficCar": { "PlateNumber": " ", "PlateColor": "Yellow",
                             "PlateType": "Yellow", "Speed": 60,
                             "VehicleColor": "White" } }
```

`PlateNumber` is a single space, `Speed` is a constant 60, and the camera has no
ANPR licence. This is uninitialised struct padding serialised as data. A
provider that surfaced `Summary` would invent a licence-plate read and a
60 km/h vehicle on every motion clip. **Read `Events` and `Flags`; never
`Summary`.**

### New trap 5 — the RTSP slot-exhaustion 404

Covered under Q3. It belongs in this list because it is the one a provider will
encode wrongly by default.

### Useful, and correct as recorded: the row shape

```json
{ "Channel": 0, "StartTime": "2026-09-23 10:23:27", "EndTime": "2026-09-23 10:24:41",
  "Duration": 74, "Length": 56242806, "CutLength": 56242806, "Type": "dav",
  "VideoStream": "Main", "Events": ["VideoMotion"], "Flags": ["Event"],
  "FilePath": "/mnt/sd/2026-09-23/001/dav/10/10.23.27-10.24.41[M][0@0][0].mp4",
  "WorkDir": "/mnt/sd", "Disk": 0, "Partition": 0, "Cluster": 0,
  "Compressed": false, "Redundant": false, "Overwrites": 0, "Repeat": 0,
  "PicIndex": 0, "SummaryOffset": 0, "WorkDirSN": 0 }
```

`Type` is `"dav"` and the extension is `.mp4` — the type field is a Dahua
family label, not the container. The container is ISO MP4, measured.

And yesterday's local-clock warning holds, re-verified today:
`global.getCurrentTime` → `2026-09-23 11:18:51` while the host's UTC was
`09:18:52`. `StartTime`/`EndTime` and the RTSP `starttime`/`endtime` are the
camera's LOCAL wall clock. A UTC window would be two hours off in summer, one in
winter, and would silently return the wrong footage rather than an error.

---

## Contract question 1 — what should `served` say when there are no twins?

**The measurement first, because yesterday inferred it and this note proves it.**
`Record[0].Stream=0` means the camera writes the main format only, and the
archive refuses the sub explicitly: `loadfile.cgi …&subtype=1` over a window that
definitely holds footage answers **400**, where `subtype=0` answers 200 with
54 MB. There is one copy, 2560x1440 at ~6.4 Mbit/s, and the live sub-stream
(640x480, 512 kbps) exists only live.

**What the provider should answer: `served: 'high'`, unconditionally, on every
method that carries the field — `getClipPlayback`, `readClipBytes`,
`offerClipBytes` and `dialClipStream` — for every asked profile including an
absent one.** That is the only truthful value; there is nothing else to serve.

**And D599's honesty mechanism will stay silent, which is the gap.** The broker's
line fires on a DOWNGRADE. Here every non-`high` ask is an UPGRADE: a `low` ask
is answered with a copy carrying **12.5× the bitrate** of the sub-stream the
caller was picturing (6.39 Mbit/s vs 512 kbps) and **12× the pixels**. Nothing
in the contract has an expression for that, so the cost is invisible — which is
the D382 shape ("a consumer is served the history it ASKED for, and an unstated
ask is zero") applied to quality instead of history.

Three candidate answers, in the order I would argue them:

1. **Do not widen `served`.** It already carries everything needed — the asked
   profile and the served one are both known to the broker. What is missing is a
   READER that looks at the ladder in *both* directions.
2. **Do not log the upgrade per clip either.** D599's reasoning for excluding
   `mid → sub` was that it is by DESIGN and a line on every ordinary clip means
   nothing. On a one-copy camera, `low → high` is by design in exactly the same
   way, and a per-clip line would be noise at exactly the same rate. The real
   discriminator is not the direction of the substitution but **whether the
   provider had a CHOICE**.
3. **So say it once, on the SOURCE, where it is a standing fact.**
   `ClipPlaybackOptions` is already per-provider, already the thing the viewer
   draws its controls from, and already the place D612 put `rates` for precisely
   this reason — a fact the provider declares once rather than re-asserting per
   call. A one-copy source declares it there; the viewer stops offering a
   quality picker it cannot honour, and the broker knows an upgrade is
   structural and does not file it as a defect. **That is a one-field addition
   to a schema that exists, and no change to `served`, `downgraded` or any
   per-clip payload.**

Amcrest is the second independent witness for this gap (Hikvision was the
first), and this is the first time the gap has a cheap, already-shaped home.

## Contract question 2 — clip granularity: the 5-minute packet, or an event?

**Yesterday's premise was wrong, and this is the finding that changes the
verdict most.** Every row on the card is an EVENT:

- `Flags: ["Event"]` on 10 of 10 rows; `Events: ["VideoMotion"]` on 10 of 10.
- Durations 43, 45, 46, 46, 51, 56, 64, 65, 74, 92 seconds. **Not one is five
  minutes.**
- Rows are separated by gaps (row 0 ends 10:24:41, row 1 begins 10:25:09).

`MediaGlobal.PacketLength=5` is a CAP on how long one file may run, not a clock
that slices a continuous stream — and because `TimeSection` has bit 0 clear
there is no continuous stream to slice. The packet length only bites when a
single motion episode runs past five minutes, which has not happened once.

**So: a provider presents one `Clip` per `mediaFileFind` row, unmodified.** That
row already IS what the operator means by a clip. `startTime`/`endTime` from the
row (local clock, converted via `global.cgi?action=getCurrentTime`), duration
from the row with the measured caveat that the container runs ~7.5 % shorter,
`source` something like `native:amcrest:onboard`, identity by TIME WINDOW rather
than by `FilePath` because that is the only thing `/cam/playback` accepts.

The one residual: an event longer than five minutes cuts into N rows that abut
exactly. A provider should **not** merge them into one `Clip` — that would mint a
clip the camera cannot address as one. But it does not have to, because
`/cam/playback` takes an arbitrary window and `startLoad` was measured crossing
a file boundary (93 302 968 bytes over two rows summing 92 533 378). If the
abutting case ever appears, the window is already playable; the row is still the
honest unit.

**This does not make the thing not worth building.** It was the strongest of
yesterday's "does not fit" objections and it was an artefact of having no
footage.

---

## What it would cost, if built

For scale: `addon-provider-hikvision/src/clips` is **4 907 non-test lines** (plus
1 947 of tests), of which 1 205 are its own RTSP replay client.

An Amcrest clip provider needs, in dependency order:

1. **An RPC2 client in the addon** (~150 lines). It does not exist today — the
   addon is CGI-only — and `storage.*` and `mediaFileFind.*` have no working CGI
   equivalent on this firmware. **This is also step 1 of yesterday's
   recommendation and is independently useful.**
2. **Catalog** (~250 lines): `factory.create` → `findFile` (gate on ITS result)
   → `findNextFile` paging on `found < count` → `close` + `destroy`. Local-clock
   window conversion. Never `getCount`, never `Summary`.
3. **`offerClipBytes` over `RPC_Loadfile`** (~200 lines): the one route that
   yields an indexed, self-contained MP4 with sound. Bounded by
   `VIDEOCLIPS_MAX_OFFER_BYTES`, which every measured and every structurally
   possible clip fits. Must translate a bare socket close into a named refusal.
   `readClipBytes` inline should refuse by name above 50 MiB — 2 of 10 real
   clips already exceed it.
4. **RTSP replay for playback** (~800–1 000 lines, largely the shape of
   Hikvision's `clips/rtsp/`): the one non-negotiable addition being a
   provider-owned 3-slot gate, because the camera's own exhaustion signal is a
   404 that means "gone".
5. **`dialClipStream` + audio transcode** (~400 lines): D600 verbatim, AAC
   8 kHz → opus/pcmu, one ffmpeg, `servedAudio` on the answer.
6. **`ClipPlaybackOptions`**: `transport: 'stream'`, **`seek: 'free'`**,
   `scrub: true`, `rates: [1]` (see below), `stepBack` per what the seek
   measurements support.

Call it **1 800–2 200 non-test lines**, roughly 40 % of the Hikvision provider,
because the camera does more of the work (free seek, boundary-crossing windows,
exact content lengths, no twin arbitration).

### On `rates` — offer `[1]` only

Trick rates were measured and the result is not clean. `PLAY` with a `Scale`
header answers **200 and echoes NO `Scale` header back** — measured for `0.5`,
`2.0`, `4.0`, `8.0` and `-1.0` alike. Delivery does vary with the value, so the
camera is doing *something*, but it never says what. Two cold full drains of the
same 74 s clip:

| | video RTP | audio RTP | elapsed | vs realtime |
| --- | --- | --- | --- | --- |
| no `Scale` header | 40 064 | **528** | 76.1 s | 0.97× |
| `Scale: 4.0` | 4 166 | **0** | 32.0 s | 2.31× |

So `Scale: 4.0` delivers 10 % of the packets in 42 % of the time — neither the
rate asked for, nor any rate it names, and **the sound is dropped entirely**.
Every non-unity run across three independent sweeps carried zero audio packets.

**D612's rule applies directly: a rate it cannot deliver is never offered**, and
without a `Scale` echo there is no way to report what was served even if it
could. `rates: [1]` is the only honest answer until someone measures this
properly against decoded timestamps on a quiet camera.

---

## Recommendation

**Do not build it yet — and every reason yesterday gave for that has been
retired.**

What changed: playback serves and seeks freely, retrieval works and yields an
indexed MP4, the archive carries complete AAC, concurrency does not wedge, sizes
sit inside D613's bound, and granularity is events rather than clock packets.
Four of the five open questions came back better than expected; the fifth (Range)
came back negative but was made irrelevant by D613 landing the day before.

What did not change, and is now the whole of the argument:

> **This is a one-camera provider, and its entire evidence base is ten daylight
> `VideoMotion` clips from a card that has been in the slot for seven hours.**

Yesterday called the one-camera problem "the riskiest unknown" and it is still
the riskiest, only now it is also the *only* one. Specifically, the following
have a sample size of zero:

- **Any event kind other than `VideoMotion`.** The schedule sets four bits
  (motion, alarm and two IVS types); the `Events` field has been observed with
  exactly one value. A provider's event mapping would be written against one
  string.
- **Any night footage.** The 81 %-of-ceiling figure is daytime.
- **`OverWrite: true` eviction.** The card is 0.355 % full. Nobody has seen what
  a search returns, or what `RPC_Loadfile` does, when the file being read is
  evicted mid-transfer. On a nearly-empty card this cannot be provoked.
- **A multi-page search.** Ten rows, one page. `found < count` is construction.
- **The >5-minute abutting-rows case.**

### Do this, in this order

1. **Ship the storage read now — unchanged from yesterday's step 1, and now it
   answers `ok`.** An RPC2 client in `addon-provider-amcrest` plus
   `storage.getDeviceNames` / `getDeviceAllInfo` / `configManager Record`.
   ~150 lines, no clip machinery, and it is step 1 of the clip provider too, so
   nothing is wasted either way. Read `getDeviceNames` (`result: true` +
   `list: null` ⇒ none) and never fold `getDeviceAllInfo`'s failure into zero —
   that distinction is now demonstrated in both directions, because the call
   that errored yesterday answers truthfully today.
2. **Re-run these probes in a week.** The scripts are in the scratchpad and the
   whole sweep is about 20 minutes. It settles every item on the zero-sample
   list above except the >5-minute event. **That is the decision point**, and it
   is measurement, not work.
3. **If week two looks like day one, build it** — in the order under
   [What it would cost](#what-it-would-cost-if-built), with the three
   non-negotiables: a provider-owned 3-slot gate (because the camera's
   exhaustion signal is a 404 that means "gone"), `offerClipBytes` rather than
   inline (because 20 % of real clips already exceed 50 MiB), and `rates: [1]`
   (because `Scale` is accepted without ever being echoed).

**And separately, worth raising whatever happens on clips:** the one-copy
upgrade has no expression in the contract, Amcrest is the second witness, and
`ClipPlaybackOptions` is a cheap place to put it. That is a contract
conversation, not an Amcrest one.

---

## Scope and method

Measured on device **3836 only**, 2026-09-23, between roughly 10:20 and 12:00
local. Read-only throughout: HTTP `GET` with digest auth, RPC2 reads
(`global.login` → read → `global.logout`), and RTSP `DESCRIBE` / `SETUP` /
`PLAY` / `PAUSE` / `GET_PARAMETER` / `TEARDOWN`. **No configuration was written**
— `Record`, `RecordMode`, `MediaGlobal` and `Encode` were read and not touched.
Every `mediaFileFind` object created was closed and destroyed. Credentials were
read in-process from `deviceManager.getDevice` and were not printed, logged or
persisted.

Probe scripts (scratchpad, not committed): `_amc-lib.mjs` (shared digest / RPC2 /
RTSP client), `_amc-storage.mjs`, `_amc-catalog.mjs`, `_amc-load.mjs`,
`_amc-fetch.mjs`, `_amc-stream.mjs`, `_amc-rtsp.mjs`, `_amc-play.mjs`,
`_amc-conc.mjs`, `_amc-slots2.mjs`, `_amc-slotrun.mjs`, `_amc-drain.mjs`,
`_amc-scale2.mjs`, `_amc-stats.mjs`.

One methodological note, because it changed a conclusion: **the first `Scale`
sweep was run back-to-back with 1.2 s gaps and produced numbers that were simply
load artefacts** — the `Scale=1.0` control delivered 513 video RTP in 20 s
against 40 064 in 76 s when measured cold, and reported zero audio where a cold
drain carries 528 packets. Concurrent RTSP sessions on this camera degrade each
other badly enough to invent a finding. Everything reported above as a rate or a
count was measured on an otherwise idle camera.
