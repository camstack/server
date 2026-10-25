---
title: Serving a native Reolink clip as a STREAM — what the library really has, what it costs per topology, and the trade
last-verified: 2026-09-20
covers:
  - packages/addon-provider-reolink/src/clips/clip-mux.ts
  - packages/addon-provider-reolink/src/clips/clip-data-plane.ts
  - packages/addon-provider-reolink/src/clips/reolink-videoclips-provider.ts
  - packages/types/src/capabilities/videoclips.cap.ts
---

> Status: **investigation, 2026-09-20. Nothing implemented, in either repo.**
> **§ 8's recommendation is WITHDRAWN by [§ 9](#9-re-measured-2026-09-20-late-evening--8-is-withdrawn),
> which re-measured the same clips against `0.7.10` and found the 5× to be an
> artefact of two different completion rules. Read § 9 before acting on § 3 or
> § 8; the inventory in § 1, 2, 5, 7 still holds.**
> Required reading first: [D549](../decisions/adr-0549-an-external-clip-catalog-is-another-videoclips-provider-served-by-the-devices-owner-and-listed-beside-the-others.md)
> (points 6 and 17), [D555](../decisions/adr-0555-a-source-whose-library-method-does-not-exist-is-a-listed-source-that-says-so.md),
> [D561](../decisions/adr-0561-listsources-measures-the-state-it-reports-and-an-empty-list-from-a-source-that-cannot-answer-is-a-named-refusal.md)
> and [2026-09-20-external-videoclips.md](2026-09-20-external-videoclips.md) § 6.
> No ADR was written: nothing was chosen to build. § 8 names the choice the
> operator has to make; ADR 566 belongs to the slice, not to this note.

The operator's hypothesis: *"la libreria supporta già il playback delle clips su
una socket interna apposita, non dobbiamo fare molto."* [the library already supports clip playback over a
dedicated internal socket, we do not have to do much.] This note tests it.
Half of it holds — and the half that does not is the half the motivation rested
on.

## 1. What the library really has

`reolink-baichuan-js` @ `dde69bb` (0.7.7 tagged; the tree carries the 0.7.8 work).

**The replay primitive is real and it does work.**
`ReolinkBaichuanApi.startRecordingReplayStream` (`src/reolink/baichuan/ReolinkBaichuanApi.ts:7127`)
dispatches to `…Standalone` (:6743) or `…Nvr` (:6932) on channel count, and
returns `{ msgNum, stream: BaichuanVideoStream, stop }`. Both halves carry
PCAP-derived constants (`BC_CLASS_MODERN_24`, `channelIdOverride` as an
incrementing session counter, no extension XML, `xmlChannelId=0` for
standalone) with the capture hosts named in the comments. Teardown sends
`FileInfoListStop` and is armed off `close`/`error` on both the stream and the
client. It answered on the first attempt on both topologies (§ 3).

**"A dedicated internal socket" is literally true.** The session key is
`replay:<deviceId>:ch<N>`, and `resolveSocketTag` (:1834) routes every key
matching `^replay:` to a pool tag of its own; `acquirePooledSocket` (:1907)
opens a **second TCP connection to the host** and logs in on it. That is the
feature — concurrent replay without disturbing live — and it is also the
problem on a hub (§ 4).

**There is more built on top than the brief assumed.** Four consumers, all
written, none exercised:

| symbol | file | what it produces | callers |
| --- | --- | --- | --- |
| `getRecordingVideoViaStreaming` | `ReolinkBaichuanApi.ts:9183` | a whole MP4 `Buffer` collected off the replay stream | **none** |
| `createReplayHttpServer` | `src/rfc/replay-http-server.ts:57` | an ephemeral HTTP server serving fMP4 (`frag_keyframe+empty_moov`) | **none** |
| `createRfc4571TcpServerForReplay` | `src/rfc/rfc4571-server.ts:1719` | an RFC4571 TCP server (video + AAC audio) | **none** |
| `createRecordingReplayMp4Stream` | `ReolinkBaichuanApi.ts:16855` | a `Readable` of fMP4, MPEG-TS-muxed for PTS | `endpoints-server.ts:430` (`/replay/stream.mp4`) |
| `createRecordingReplayHlsSession` + `HlsSessionManager` | `:17413`, `src/reolink/baichuan/HlsSessionManager.ts` | on-the-fly `.ts` segments + `.m3u8`, TTL-cached sessions | `HlsSessionManager` only |

`endpoints-server.ts` is a helper server inside the library; the manager app at
`app/src/server.ts` (HTTP 3010, RTSP 8554) does **not** run it and exposes no
replay route. `grep` over `test/` finds **zero** tests naming any of these
symbols. So the previous session's "never exercised" was right about the
evidence and wrong about the volume of code: the pieces are there, nobody has
ever run them.

**The part the motivation rested on does not exist.** `ReplaySeek` — cmd 123,
the thing that makes the Reolink app seek instantly — is `BC_CMD_ID_REPLAY_SEEK = 123`
in `src/protocol/constants.ts:402` **and nothing else**. No payload builder, no
sender, no caller. The only other references in the repo are a `@deprecated`
alias and a test asserting the rename. Seek is named, not wired.

**Two leftovers that describe the right design and are false.**
- `createRecordingReplayMp4Stream` carries `// NOTE: Replay streams now use the
  "general" socket (same as commands/events).` (:16905). `resolveSocketTag`
  says otherwise for every `replay:*` key. The comment describes the behaviour
  D549 17 needs; the code does the opposite.
- `BaichuanVideoStream` has **no end-of-replay detection** — `close` never
  fired in any of the seven runs below. What it does have is a live-stream
  watchdog (`idleRestartMs` = 30 s on TCP, `:591`) that **restarts the native
  stream** when it goes quiet. On a replay that has simply finished, holding
  the session past 30 s re-requests the clip. Any held replay session must
  disarm that watchdog.

## 2. What the file path costs today, and why

`clips/clip-mux.ts` states the reason in its own header and it is correct:
*"Nothing on the wire marks the end of a cmd 5 download — no 201, no trailing
frame, no size that matches `sizeL` — so completion is an idle window."* The
operator's two seconds are **mostly a timeout, not bandwidth**.

The cheap alternative that would kill this whole investigation — end the
download when the received byte count reaches the listed `sizeL` — is closed by
measurement: the listing's `sizeBytes` and the received raw byte count do not
agree (695 125 listed / 471 288 received; 1 026 310 / 814 328; 863 668 /
603 944). The header already said so. There is no cheap fix to the 2 s.

## 3. Measured, 2026-09-20 evening, read-only, LAN

**592** — E1 Outdoor PoE v3.1.0.5223, mains standalone, direct TCP,
<hub-ip>. Clips of the preceding six hours. `COLD` = first replay of the
process (new pooled socket + login); `WARM` = a later replay reusing that
pooled socket. `first KF` is measured from the `startRecordingReplayStream`
call, not from the socket.

*sub stream (`low`/`mid` twin), clips of 30–42 s:*

| | bytes | start | first keyframe | whole clip transferred |
| --- | --- | --- | --- | --- |
| cmd 5 download (**today's path**) | 471 288 / 814 328 / 547 984 | — | — | **2352 / 3048 / 2507 ms** |
| replay COLD | 161 989 (video) | 4914 ms | **+4936 ms** | 236 ms |
| replay WARM | 330 959 / 229 128 | 187 / 153 ms | **+206 / +162 ms** | 430 / 402 ms |
| `createRecordingReplayMp4Stream` WARM | 314 906 (fMP4 out) | — | first byte **+828 ms** | ≈ 900 ms |

*main stream (`high` twin), clips of 30–43 s:*

| | bytes | start | first keyframe | whole clip transferred |
| --- | --- | --- | --- | --- |
| cmd 5 download (**today's path**) | 20 024 352 / 34 535 192 | — | — | **6602 / 9412 ms** |
| replay COLD | 19 691 166 | 2270 ms | **+2360 ms** | 3587 ms |
| replay WARM | 33 976 838 / 28 910 828 | 610 / 589 ms | **+709 / +678 ms** | 6781 / 5928 ms |

**639** — Home Hub v3.3.0.456, <hub-ip>, child on ch 0, one 19 s sub clip
of 863 668 B. One probe, one clip, session closed:

| | value |
| --- | --- |
| a SECOND Baichuan socket to the hub | **accepted** (hub reported 9 sessions total, 5 from this IP) |
| replay start / first frame | 355 ms / **+390 ms** |
| whole clip transferred | 889 ms, 434 180 B of video |
| cmd 5 download, same file | **3041 ms** |

**Three things these numbers settle.**

1. **The camera BURSTS a replay; it is not a 1× realtime feed.** 635 frames of
   a 42 s clip in 430 ms. So "a live session for the whole of playback" is
   false: the session lasts as long as the *transfer* — ~0.4 s for a sub clip,
   ~6 s for a 35 MB main clip — after which it is an idle socket someone has
   to close. This is the single most important correction to the framing.
2. **Cold is a trap.** A replay on a fresh pooled socket costs **4.9 s** on 592
   — twice the download it is meant to beat. The mode is only fast on a socket
   that is already up, which means holding the replay socket warm per device,
   which means holding a second connection to the camera when nobody is
   watching. On 592's main stream cold was 2.3 s (the general socket was warm
   by then and only the dedicated one was cold); the variance is login, not
   the camera.
3. **The replay stream carries AUDIO.** 668 `audioFrame` events, 346 692 B, on
   a 42 s sub clip of 592. `clip-mux.ts` is video-only today and says why —
   *"the library's demuxer hands back Annex-B VIDEO … 0.7.8 has no API that
   [returns audio]"*. The replay path already emits it, and
   `createRfc4571TcpServerForReplay` already handles it (`aacAudioHint`).
   `createRecordingReplayMp4Stream` does not. This is a gain the file cannot
   have until the download side learns to demux audio.

## 4. Per-topology honesty

**Mains standalone (592, 618) — honest.** 162–206 ms to a first keyframe on
sub, 678–709 ms on main, against 2.4–3.0 s and 6.6–9.4 s. The second TCP
connection is to a mains camera on PoE; 107 already carries 7 admin sessions
from three IPs without complaint. The conditions are: keep the replay socket
warm or lose to the file (§ 3.2), and disarm the 30 s restart watchdog.

**Hub child (3628, 3629, 3825 via 639) — NOT honest as the library stands, even
though it worked.** The probe measured the best result of the day (+390 ms to
first frame against a 3041 ms download) and it got there by opening a second
socket to the hub. D549 17 forbids exactly that: *"Every Baichuan call for every
child, both sources, the calendar, the listing, the stills, the bytes and the
prefetch goes through the ONE existing `parent.getApi()` session. No new
connection for clips."* The record's evidence is 27 × `ECONNRESET` from a second
session, and its own correction — that the failure is a *budget*, not a refusal
— is what my probe re-confirms: today the budget had room. A budget with room
today is not permission to spend it. And `startRecordingReplayStream` **cannot**
comply: `resolveSocketTag` routes every `replay:*` key to a dedicated tag with
no override. Making it honest on the hub is a library change (a way to pin
replay to the general socket), after which the replay *serializes against every
other hub call for the duration of the transfer* — 0.9 s for a 19 s sub clip,
seconds for a main one, in front of a three-child listing and a prefetching
thumbnail queue. That is a worse thing to hold than the download, which at
least the queue already accounts for.

**Standalone battery (640, 4263) — refuse.** A replay session keeps the radio
up for the whole of playback *and* is a second socket on top of the wake. The
file path fetches once and lets the camera sleep; the LRU then serves every
re-watch for free. The ranking is unambiguous and the mode should not be
offered. (Nothing was run against a battery camera for this note. 4263 is at
8 %.)

## 5. The transport, and what of it exists

A replay stream is neither `hls` nor `mp4`, so § 6's `ClipPlayback { format }`
does not stretch to cover it. Three candidate transports, in order of how much
is already built:

**(a) An ephemeral cam-stream through the broker, played by the LIVE player.**
The Reolink provider already hands the broker a live elementary stream this
exact way: it stands up a local RFC4571 TCP server and publishes a
`pull-rfc4571` descriptor with a `lazy:rfc4571:` sentinel materialised at dial
time (`packages/addon-provider-reolink/src/reolink-camera.ts:6762`, `:6787`,
`materializeStreamSocket:7048`, `ensureRfc4571Server:7156`). The library's
`createRfc4571TcpServerForReplay` is the replay twin of that server, written and
uncalled. The WebRTC cap already takes an arbitrary handle:
`WebrtcStreamTargetSchema` = `{kind:'cam-stream', camStreamId}`
(`packages/types/src/capabilities/webrtc-session.cap.ts:43`), resolved by
`makeSourceBrokerId(deviceId, camStreamId)`
(`stream-broker/device-scoped-providers.ts:379`). So a clip would be published
as a synthetic cam-stream under the camera that owns it — `replay:<clipKey>` —
and played by `CameraStreamPlayer` as if live.
*New:* an ephemeral publish/retract lifecycle in the provider's stream-catalog
(a broker key is `(deviceId, camStreamId)`; there is no non-device handle, and
the reconcile sweep retracts anything the provider's catalog does not claim —
`brokerOwned` is internal and not on the cap wire); a third `ClipPlayback`
variant naming a `camStreamId`; a `StreamPanel` branch, which today is strictly
*"`playbackUrl` set → `HlsVideo`, else the live player"* and would gain *"live
player, but pinned to this cam-stream"*.

**(b) The library's fMP4 `Readable` over the addon's existing data plane.** The
smallest diff: `createRecordingReplayMp4Stream` → the same
`/addon/provider-reolink/clip/...` route `clip-data-plane.ts` already serves,
`Transfer-Encoding: chunked`, `format: 'mp4'` unchanged, `HlsVideo`'s `mp4`
branch unchanged. Measured first byte 828 ms warm.
*Cost:* fragmented MP4 has no `moov` up front — **no duration, no seek bar, no
Range**, so the player shows it as an open-ended stream and the D549 22 gain
(*"`+faststart` … so the player knows the duration before the bytes arrive and
seeking works over the Range route natively"*) is lost. Video-only. And it puts
an ffmpeg per viewer in the provider process.

**(c) The library's HLS session.** `createRecordingReplayHlsSession` +
`HlsSessionManager` produce segments and a playlist; `HlsVideo`'s `hls` branch
plays them with no client change at all. But the repo's only segmenter is the
recorder's VOD-from-disk (`recorder/playlist.ts`, `#EXT-X-PLAYLIST-TYPE:VOD` +
`#EXT-X-ENDLIST`), so this would be the first EVENT-type playlist in the
system, served from a library-owned temp dir, with a TTL cache nothing else in
CamStack uses — and § 6 already rejected per-clip HLS as *"more server work for
no user-visible gain"*. Segment duration 4 s also throws away most of the
latency win.

**Against D549 6.** `clip-mux.ts`'s header states the rule this mode breaks:
*"The broker owns LIVE sessions; a stored file has none, and inventing one to
play yesterday's clip would hold a camera open for a file that is already on a
disk."* The measurement changes the premise but not the whole of it: the
session is held for the **transfer**, not for the playback, because the camera
bursts. What justifies the break, if anything does, is (a) the `high` twin —
35 MB that never has to land in a 200 MB scratch — and (b) audio. It is not
"instant seek", which does not exist (§ 1).

## 6. What it gains that the file does not

1. **First frame before the bytes exist.** sub: 162–206 ms vs 2352–3048 ms
   (≈ 12–15×). main: 678–709 ms vs 6602–9412 ms (≈ 10–13×), and the file path
   pays a mux on top of that.
2. **A `high` twin that never touches the scratch.** `CLIP_SCRATCH_MAX_BYTES_PER_DEVICE`
   is 200 MB over 10 files; one main clip of 592 measured 20–35 MB, so six of
   them fill it and each admission evicts a neighbour. A stream stores nothing.
3. **Audio** (§ 3.3) — the one user-visible capability the file path cannot
   currently have at all.
4. **A clip the fetch cannot complete.** The retry loop gates on "did bytes
   LAND" under `CLIP_FETCH_MAX_ATTEMPTS = 3` / `CLIP_MUX_TIMEOUT_MS = 60_000`;
   a clip that never lands is unplayable forever. A stream shows what arrives,
   as it arrives, and a truncated playback is a better answer than a named
   failure.
5. **A clip bigger than the mux bound.** Same bound, different symptom.

## 7. What it loses, plainly

- **No file.** No download link (today the playback URL *is* the download,
  D549 22), nothing to hand the export subsystem
  (`2026-09-20-clip-export.md`), nothing in the HKSV tee's reach.
- **Nothing cached.** The second viewer pays the camera again, in full. The
  file path's LRU serves it for free, and a prefetch can warm it before anyone
  asks.
- **No duration, no seek bar** under (a) and (b). The one thing D549 22
  bought — a seekable source with a known duration, cheaply, from
  `+faststart` — is exactly what a stream cannot give.
- **No end-of-clip signal.** `close` never fired in seven runs; the session
  ends on an idle heuristic, and past 30 s the watchdog re-requests the clip.
  The player stalls at EOF rather than ending.
- **A second socket per watching viewer**, held warm to be fast at all.
- **A per-viewer ffmpeg** under (b) and (c), in the provider process.

## 8. Recommendation, with the trade named

**Build it as an additional FAST-PREVIEW mode, on mains standalone cameras
only, defaulting to the `high` twin, with the file path unchanged and still
doing the work whenever the clip is kept.** Transport (a): the ephemeral
cam-stream, because it reuses the live player, the live WebRTC session, the
broker and the provider's own RFC4571 hand-off, and because it is the only one
of the three that does not put an ffmpeg per viewer in the provider.

**The trade, stated:** the operator trades *the file* — download, export, cache,
duration, seek bar, and a second viewer served for free — for *a first frame in
0.2–0.7 s instead of 2.4–9.4 s, a 35 MB clip that never enters the scratch, and
sound*. On a `low` clip of 30 s, where the file lands in 2.4 s and then seeks
instantly and forever, that trade is bad. On a `high` clip of 43 s, where the
file costs 9.4 s plus a mux plus a sixth of the device's scratch, it is good.
That asymmetry — not the topology — is what should decide which mode a row
offers, and it is why this is a mode and not a replacement.

**And *"non dobbiamo fare molto"* is half right.** What is genuinely done: the
replay primitive, verified today on both topologies, first try, with audio; an
RFC4571 replay server, an fMP4 stream, an HLS session manager; a broker that
already ingests this provider's RFC4571; a WebRTC cap that already takes an
arbitrary cam-stream handle. What is not: **cmd 123 seek does not exist**, so
the feature the Reolink app's instant seeking comes from is not in the box; no
line of the replay code has a test or a production caller in either repo; the
socket policy contradicts D549 17 and a comment claims otherwise; there is no
end-of-clip signal and the watchdog will restart a finished replay. Server-side
it is all new: an ephemeral cam-stream lifecycle, a third `ClipPlayback`
variant, a `StreamPanel` branch, and a refusal path for the two topologies that
must not have it. **A week, not a day** — but a week whose riskiest question,
*does the camera actually replay on demand*, is already answered yes, twice, on
hardware.

**If the honest answer is "not now":** the same measurements say the file path's
biggest single win is elsewhere. The 2 s on a sub clip is an idle timeout, and
audio is missing because the *download* demuxer drops it while the *replay*
demuxer keeps it. Teaching `downloadRecording` to return audio packets is a
library change of the same order as the socket-pinning one, benefits every
clip, every topology and the export subsystem, and costs no live session at all.

---

## 9. Re-measured, 2026-09-20 late evening — § 8 is withdrawn

> Written by a later session against `@<github-account>/nodelink-js@0.7.10`
> (§ 1–8 measured the `dde69bb` tree). Read-only, one session per device, 107
> and 639 only; no battery camera woken. Record:
> [D568](../decisions/adr-0568-a-clip-is-fetched-by-cmd-5-and-completion-is-a-short-idle-window-the-replay-stream-is-not-a-faster-fetch.md).
> **Everything in § 1–8 about what EXISTS still holds. The numbers in § 3, and
> therefore the recommendation in § 8, do not.**

The hypothesis under test was stronger than § 8's: if a replay hands over a
whole clip in 430 ms, it is not a way to WATCH a clip, it is a way to FETCH
one, and the honest move is to swap the transport under the file path rather
than add a mode beside it. The premise survived; the arithmetic did not.

### 9.1 The premise holds: it is the same file, twice

For every clip measured, on both topologies, the two transports handed back
**byte-identical content** — same access-unit count, same keyframes, same
codec, same AAC frame count, same audio bytes:

| clip | AUs | KF | audio frames | audio bytes | both transports |
| --- | --- | --- | --- | --- | --- |
| 592 sub 34 s | 501 | 9 | 530 | 275 070 | identical |
| 592 sub 31 s | 475 | 8 | 501 | 260 019 | identical |
| 592 sub 52 s | 770 | 13 | 811 | 420 909 | identical |
| 592 main 31 s | 751 | 16 | 477 | 247 563 | identical |
| 639 child sub 22 s | 331 | 12 | 344 | 178 536 | identical |

So a replay really is a second transport over the same stored file, not a
rendering of it. That is the part of the hypothesis that is true.

### 9.2 The 5× was two different completion rules, not two different speeds

§ 2 is right that nothing on the wire ends a cmd 5 download. **The replay has
no end marker either** — across nine replays `close` never fired on its own; it
fired only when the caller called `stop` (once at +75 s). § 1's finding is
confirmed and it cuts both ways: *both* transports end on an idle heuristic, so
the honest comparison gives both the same one. § 3 compared the replay's
transfer against the download's transfer **plus the library's 2 000 ms idle
window**.

`idleTimeoutMs` is already a parameter of `downloadRecordingDemuxed` and
already declared on this repo's `ClipMediaApi`; nothing passes it. Sweeping it,
same clip, same session:

*592, sub clip of 34 s (listed 855 071 B, received 637 304 B):*

| idle window | 2 000 (default) | 800 | 400 | 200 |
| --- | --- | --- | --- | --- |
| wall to last byte | 2 361 ms | 1 631 ms | 1 220 ms | **1 040 ms** |
| bytes / AUs / audio | identical at every setting |

*592, main clip of 30 s, 20.4 MB — six repetitions at 200 ms, two at 100 ms:*

| | default 2 000 | 200 ms ×6 | 100 ms ×2 |
| --- | --- | --- | --- |
| wall | 6 373 ms | 2 851 / 2 858 / 2 835 / 2 835 / 2 899 / 2 829 ms | 2 714 / 2 686 ms |
| content | 20 430 752 B in, 636 AU, 13 KF, 409 audio packets — **identical, 8/8** |

*639 hub child ch 0, sub clip of 22 s:* 3 384 → 2 260 → 1 876 → **1 668 ms**,
byte-identical.

Matched on the same 200 ms completion window, the whole trade looks like this:

| | cmd 5 today | cmd 5 @200 | replay (last frame + 200) | replay advantage |
| --- | --- | --- | --- | --- |
| 592 sub 31–34 s | 2 361 – 2 726 ms | **1 040 – 1 062 ms** | 530 – 670 ms | ≈ 0.4 s |
| 592 main 30 s, 20–24 MB | 6 373 – 7 195 ms | **2 829 – 3 571 ms** | 2 730 – 3 050 ms | ≈ 0.3 s |
| 639 child sub 22 s | 3 384 ms | **1 668 ms** | 1 200 warm / 1 550 cold | ≈ 0.1 s, or none |

The wire really is faster on replay — 592 main moved 24 MB at ≈ 9 MB/s against
the download's ≈ 7.2 MB/s, and on sub the replay's transfer is about twice as
quick (330–470 ms against ~840 ms). But that is a 25–50 % transport difference,
not 5×, and the parameter that is already there buys more than the transport
swap does, on every topology, with no second socket.

### 9.3 Is a short window SAFE? The row already knows the answer

§ 2 closed the cheap completion test because the listed `sizeL` and the
received byte count never agree — re-confirmed (855 071/637 304;
815 675/596 464; 987 399/731 352). But the **decoded duration** matches the
catalog row's own window to about a second on every clip measured: 33.856 s for
a 34 s row, 32.017 for 31, 30.537 for 31, 21.951 for 22. A truncating idle
window therefore cannot hide: a pass that comes back materially short of the
row is a truncated fetch, and that is a check the fetch path can make on data
it already has. 8/8 identical at 200 ms and 100 ms says the window has margin;
the duration check is what makes spending that margin honest.

### 9.4 The three risks: which actually bit

1. **A new socket — CONFIRMED, exactly as feared.** `resolveSocketTag` has no
   override and `lsof` counted the established connections going 2 → 3 on the
   first replay, on 592 *and* on 639, with a distinct `BaichuanClient` connect
   line each time. On a hub child that is D549 17's forbidden second session.
2. **Cold — PART of it bit, and it is a different part than § 3 said.** § 3's
   4 914 ms was read as the cost of a cold pooled socket. It is not: it is the
   cost of the FIRST replay of a process, and it is topology-specific. On 639 it
   reproduced twice in two separate runs (**4 735 / 4 763 ms** to start), while
   steady-state cold replays on the same hub cost **245 / 317 ms** and on 592
   **107 – 189 ms**. Warm means *within 10 s* — `SOCKET_POOL_KEEPALIVE_MS` —
   which a clip fetch in a provider's real lifetime essentially never is, so
   "cold" is the number that counts. Cold is cheap on 592; on a hub the first
   one of the process costs more than three downloads.
3. **The watchdog — did NOT bite, and the note's warning is wrong for the code
   as written.** The timer is armed, but `restartNativeStream` returns on
   `if (!this.api) return`, and neither replay construction site passes `api`
   (`ReolinkBaichuanApi.ts` :6799 standalone, :6991 NVR). Measured: a finished
   replay held **75 s** — 2.5× the 30 s `idleRestartMs` — delivered exactly one
   copy (431 AUs), no gap in the frame stream, no restart log. A held replay
   session does not re-request the clip. It also never tells you it is done.

### 9.5 Audio is settled, and it is settled on the file path

`0.7.10`'s `downloadRecordingDemuxed` returns an AAC track, and it is the same
track: 811 frames / 420 909 B on the 52 s sub clip of 592, 344 / 178 536 on the
hub child, byte-for-byte what the replay emitted. So § 3.3 and § 6.3 are spent
— audio is no longer a reason to prefer the replay, and D567 has already put it
in the mux. **And the sub-stream files DO carry audio** (501–811 AAC packets on
592's sub clips, 344 on the hub child's): the answer to the question asked in
parallel from the provider side is yes, on both topologies, on `subStream` as
well as `mainStream`.

### 9.6 The recommendation, replacing § 8

**Keep cmd 5. Do not swap the transport, and do not build the fast-preview
mode.** What is left of the replay's advantage after both sides are given the
same completion rule is 0.3–0.5 s on a mains standalone camera and nothing on a
hub, bought with a second TCP session that D549 17 forbids on a hub child and
with a first-of-process cost that on 639 is worse than three downloads. Against
that, the idle window is a parameter the library already exposes and the repo
already declares, worth 1.3 s on a sub clip and 3.5 s on a main one, on every
topology, holding nothing open.

The one thing the file genuinely cannot do is paint a frame before the fetch
completes — replay showed a first keyframe at 66–280 ms warm, 118–278 ms cold.
Against a sub clip that now lands whole in ~1.0 s and then seeks instantly and
forever, that is not worth a transport. § 8's asymmetry argument survives only
in the sense that the `high` twin is still the expensive case: 20–35 MB through
a 200 MB scratch. If that ever becomes the pressure, the answer is the scratch
or a range fetch, not a live session.
