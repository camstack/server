# Hikvision onboard clips — what the fleet has, and what the protocol gives

> Status: MEASURED against the live fleet on 2026-09-22, read-only. This was an
> investigation; it has since been BUILT —
> [D605](../decisions/adr-0605-a-hikvision-camera-serves-its-own-clips-through-a-replay-client-the-provider-owns-and-every-ask-is-answered-with-the-one-copy-it-archives.md)
> is the record, and the corrections below are marked inline where building it
> contradicted a measurement here. The `videoclips`
> contract it is measured against is
> [`videoclips.cap.ts`](../../packages/types/src/capabilities/videoclips.cap.ts)
> and the Reolink shape that fills it is D597 / D599 / D600.
>
> Written down because re-acquiring these numbers costs a probe against every
> camera, and two of them contradict the vendor's own specification.

## The fleet: 3 of 19 can serve clips today

`provider-hikvision` owns 32 devices, of which 19 are cameras. All mains-powered.
Read with `GET /ISAPI/ContentMgmt/Storage` and `GET /ISAPI/ContentMgmt/record/tracks`.

| Device | Name | Model | Card | Motion schedule |
| --- | --- | --- | --- | --- |
| 1436 | hallway cantina | I91DN | 238 GB | yes |
| 1439 | garage | I91DN | 238 GB | yes |
| 3833 | sala feste | I91DN | 244 GB | yes |
| 1441 | retro casa | I91EV | **none** | **yes** |
| 3831 | mansarda | I91DD | **none** | **yes** |
| 14 others | DS-2CD* / DS-2DE* | — | none | no (`enableSchedule=false`) |

> **Added while building (D605), and worth an operator's eye:** **1439 has
> recorded nothing since 2026-09-20T18:27:39Z** — card `status ok`, motion
> schedule on, and a dense archive for the fortnight before that. Neither of
> the two `GET`s above can see it; only a `search` over a wide window can.

**1441 and 3831 are motion-recording to a card that is not there.** That is an
operator-facing defect with nothing to do with clips, and it is the reason the
two `GET`s above are worth surfacing as camera status whether or not clips are
ever built: they work on 100 % of the fleet and turn "no clips" into "no card".

`ClipSourceAvailabilitySchema` already carries `'no-storage'` for exactly this.

**Free space is NOT a proxy for "has footage."** 1436 and 1439 both report
11776 MB free — 11.5 GiB exactly — because that is the fixed loop reserve a
card converges on once `LoopEnable` has wrapped. 3833 reports 128000 MB only
because it has not wrapped yet. A camera at loop steady state reports the same
number whether it recorded yesterday or stopped a month ago. Availability is
answered by a SEARCH, never by `freeSpace`.

## The protocol: search works, and seeking is specified

`POST /ISAPI/ContentMgmt/search` (digest, `CMSearchDescription`) answers 200 on
all three. The `403 invalidOperation` this firmware returns for
`search/profile` and `Storage/mountList` does NOT extend to search itself — the
`ContentMgmt` tree is thinner than mainline, not absent.

One real match, verbatim, from 1436:

```xml
<timeSpan><startTime>2026-09-21T18:33:21Z</startTime><endTime>2026-09-21T18:33:40Z</endTime></timeSpan>
<codecType>H.264-BP</codecType>
<playbackURI>rtsp://<hub-ip>/Streaming/tracks/101/?starttime=20260921T183321Z&amp;endtime=20260921T183340Z&amp;name=ch01_00000000135001301&amp;size=10258788</playbackURI>
<metadataDescriptor>recordType.meta.std-cgi.com/motion</metadataDescriptor>
```

`starttime`/`endtime` (not `offset`), no `/ISAPI` prefix, a trailing slash
before the query, and `name`+`size` embedded. The `name` counter is monotonic
and rolls, so it is a file id: treat the whole URI as an opaque handle.

### Three places the hardware contradicts the 2014 RaCM spec

1. **`NO MATCHES` arrives with `responseStatus` = `true`.** The specification
   and every OSS client say `false`, and warn against treating it as an error.
   Here a parser written to the documentation would turn a genuinely empty day
   into a failure — the absent-vs-unknown confusion D315 exists to prevent.
   **Key off `responseStatusStrg` and `numOfMatches`, never `responseStatus`.**
2. **The empty `<matchList>\r\n</matchList>` body is real here**, not folklore.
3. **`codecType` says `H.264-BP` and it is LYING — the media is H.265.**
   Settled by pulling the stream: the replay SDP says `H265/90000`, the RTP
   payloads carry NAL type 32 (a VPS, which does not exist in H.264 at all),
   and ffprobe on the reassembled file says `hevc, Main, 3840x2160`.
   `ContentMgmt/record/tracks` gets it RIGHT. **The decode decision reads
   `record/tracks`, never `search`.**
4. **`record/tracks`' `framerate=2.26 fps` is wrong too** — measured 12.55 fps.
   Do not budget bitrate or frame counts from that field.
5. **`PreRecordTimeSeconds` is 10.** A segment's media can begin before the
   `startTime` the search reports, which compounds with the keyframe snap
   below.

Also measured: both `searchResultPostion` (the vendor's misspelling) and the
correct spelling are accepted; results come back OLDEST-first, so paging is
required to reach recent footage; the namespace is `std-cgi.com/ver20`, so
parse namespace-agnostically.

> **Added while building (D605).** `numOfMatches` is the size of THIS PAGE, not
> of the result: a 48 h window on 1436 answered 40, 40, 6 across three pages
> with `responseStatusStrg` = `MORE`, `MORE`, `OK`, and `maxResults: 10` gave
> ten pages of ten. Combined with oldest-first ordering, a reader that stops at
> one page answers with yesterday's footage and no sign that it did. **`MORE`
> is the only terminator.**

### Segment sizes vs `readClipBytes`

Motion-sized, not camera-chosen blocks. Segments abut exactly where motion is
continuous, which is what caps them.

| Device | Items | Duration min/med/max | Size max | Bitrate |
| --- | --- | --- | --- | --- |
| 1436 | 20 | 6 / 40 / 83 s | **42.7 MB** | 4.1 Mbps |
| 3833 | 9 | 13 / 19 / 22 s | 11.6 MB | 4.4 Mbps |

`VIDEOCLIPS_MAX_READ_BYTES` is 50 MiB. The worst segment in 24 h is **81 % of
the ceiling**, and a motion event 20 % longer blows it — 100 seconds at
4.1 Mbps. The bound is on raw bytes; the answer is base64, so 50 MiB raw is
~66 MiB on the wire.

## Against the Reolink shape

**Fits:** the day catalog (one search per window, and `dailyDistribution` gives
a cheap "which days have anything" that Reolink has no equivalent of);
`'no-storage'` availability; the D599 `served`/`downgraded` honesty mechanism.
Audio is EASIER — the archive is G.711u, which *is* `pcmu`, so a µ-law session
is a copy rather than a transcode (D600's "µ-law cannot go in MP4, use `mov`"
applies unchanged).

**Does not fit:**

- **No twins — and the way this fails is a trap.** `record/tracks` lists 101
  and 103 only *(correction, D605: that is **3833**. On **1436** it lists ONE
  track, 101, and only 101 on 3833 carries `trackType=video` — 103 is not a
  second copy. "The first enabled track" reads one of these two cameras on a
  track with no picture; take the enabled VIDEO one.)*. But track 102 is not merely absent: `DESCRIBE` on it answers
  **200, with an SDP advertising `x-dimensions:1280,720`**, and then `PLAY`
  delivers **byte-identical output to track 101** — the 4K main stream, same
  packet count, same bytes. A provider that probed for a twin by DESCRIBEing
  102 and trusting the advertised dimensions would conclude it had a sub-stream
  archive and silently ship ~33x the bytes. That is the D599 invisible-upgrade
  shape with a concrete mechanism. **Twin availability is decided by
  `record/tracks`, or by bytes delivered — never by advertised dimensions.**
- **`readClipBytes`' bounded by-handle read.** `ContentMgmt/download` returns
  the whole camera-chosen segment and ignores the requested range — the
  vendor's own words. The export seam would have to go through RTSP replay
  with a closed `Range`.
- **`transport: z.literal('forward-only')`** — see below.

## What it would change in the shared contract

1. **`transport` is a `z.literal`.** D597 froze forward-only as a fleet-wide
   truth, and it is a REOLINK fact: the operator's packet capture proved that
   camera offers no seek inside a recording. Hikvision's spec gives absolute
   clock repositioning (`Range: clock=`), variable rate (`Scale`) and
   as-fast-as-transport delivery (`Rate-Control: no`). A provider that can seek
   has no way to say so. Widening to an enum with `forward-only` as the default
   is the minimum (D382: an unstated ask is zero).
2. **`dialClipStream` has no start offset and no way to reposition an open
   stream.** Neither exists today.
3. **`served`/`downgraded` has no room for an UPGRADE.** D599 built the
   honesty field around substituting DOWNWARDS. Hikvision as configured does
   the opposite: ask `low`, get the 4K main at ~33× the bytes — and D599's rule
   that the line fires only on a downgrade makes that cost **invisible by
   design**. That is the D382 shape: a cost paid by a caller who never stated
   the ask.

## Seeking: MEASURED on 1436, and it works

Probed 2026-09-22 with a raw RTSP client (interleaved RTP-over-TCP, digest) —
ffmpeg and restreamer cannot emit these headers. One session, five sequential
`PLAY`s, no re-`SETUP`:

| re-`PLAY` `Range: clock=` | pkts | first RTP | delivered from |
| --- | --- | --- | --- |
| +0 s | 8131 | 141 ms | 0.00 s |
| +10 s | 4812 | 133 ms | **8.32 s** |
| +5 s | 6226 | 115 ms | **4.32 s** |
| +15 s | 3351 | 114 ms | **12.32 s** |
| +0 s (**backward**) | 8131 | 157 ms | 0.00 s |

Byte-identical packet counts to fresh sessions opened at the same offsets. The
session, SSRC and sequence numbers survive; one session can even scrub across
segment boundaries into a different recording an hour earlier.

- **Time to first frame at a new position: 114–157 ms.**
- **The seek snaps BACK to the preceding keyframe**, by 0.7–2.7 s. It never
  skips requested content, and it must be reported: "you asked +15 s, you got
  +12.32 s".
- **`Rate-Control: no` → 3.97x**, lossless — identical packets and NAL
  histogram, just paced faster. 2.06 MB/s.
- **`Scale`**: 0.5 / 2.0 / 4.0 honoured and echoed. **4x is the hardware
  ceiling.** `Scale: 8.0` answers 200 and echoes `8.0` while **silently
  corrupting** the stream (packets missing, timestamps non-monotonic) — so cap
  at 4.0 rather than trusting the echo.
- **Audio is `PCMU/8000`, 20.36 s covering the whole segment, real sound
  (−53 dB mean).** A COPY on the µ-law path, not a transcode.

> **Correction (D605).** A **`SETUP` on the session-level `a=control`** — the
> aggregate URL before the first `m=` — answers **415**, and the camera then
> closes the socket. One wrong SETUP costs the whole session, so only
> media-level controls may ever be addressed.
>
> **And the one this note could not have known: a played-out replay does NOT
> close its socket.** On 3833 a 19 s segment delivered 246 access units and
> 10.3 MB in 18.9 s and then went QUIET with the socket open until the camera's
> own 60 s timeout. With no end marker and zero RTCP, quiet after media is the
> only end-of-segment signal there is — and a single idle rule therefore files
> every COMPLETE clip as a failure. Also: **a replay is paced at 1x**, so a
> clip costs its own duration to fetch, and the first byte reaches a consumer
> at ~4.3 s rather than the 183–284 ms the Reolink stream manages.

### The operational hazard: a 500 is terminal

`Scale: -1.0` (reverse) → **500**, and the session is dead: the next `PLAY` got
no response and the peer closed the socket. **A seek into a recording GAP does
the same.**

> **Correction (D605): a 500 on `SETUP` is a different animal and is NOT about
> this clip.** This firmware serves ONE playback session per camera, and a
> session nobody tore down blocks every later `SETUP` with a 500 while
> `ContentMgmt/search` keeps answering normally. Measured: an abandoned ffmpeg
> held 1436 for three hours and the camera looked wedged; killing it by pid
> restored `SETUP 200` instantly. So a `SETUP` 500 says nothing about whether
> the clip exists, it is never retried, and every exit must `TEARDOWN`. There is no recovery short of a full reconnect, so seek targets
must be clamped to segments the catalog returned, in the provider, before the
wire — and a reconnect path has to exist for when it happens anyway.

### And there is NO position feedback

The `PLAY` response carries no `Range`. `RTP-Info` is boilerplate — identical
`seq=1;rtptime=0` on every re-`PLAY`, including ones that demonstrably
repositioned. Sequence numbers and SSRC do not reset. **Zero RTCP packets** on
every run, so never gate readiness on a sender report. The only in-band marker
of a new position is the VPS/SPS/PPS + IDR burst. A consumer's position is what
it asked for plus a snap it must be TOLD about; nothing in the media says.

## What this settles

Widening `transport` to an enum buys real capability, not a hypothetical:
scrubbing inside a clip, and a 4x lossless export that brings the worst 83 s /
42.7 MB segment down from 83 s to ~21 s. But **the provider must own its RTSP
client** — ffmpeg emits neither header and restreamer ignores playback ranges
entirely (AlexxIT/restreamer#1785).

The widening must carry three things or the capability is a trap:
`forward-only` stays the default (D382 — only this provider has been measured);
a seek reports where it LANDED, not where it was asked; and targets are clamped
to catalog segments, because a gap seek destroys the session.

**Scope:** measured on **1436 only** *(D605 added 3833, which is where every
media measurement in the built provider comes from — 1436 spent the build
holding a stale session of our own)*. 1439 and 3833 are the same I91DN so the
same behaviour is expected, not observed. 1441 and 3831 are different models
with no card and nothing here speaks to them.
