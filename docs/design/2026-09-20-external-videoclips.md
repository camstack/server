---
title: External video clips — the camera's own catalog (Reolink first) and HomeKit's, as `videoclips` providers listed beside the analytics visits
last-verified: 2026-09-20
covers:
  - packages/types/src/capabilities/videoclips.cap.ts
  - packages/addon-provider-reolink/src/clips/**
  - packages/addon-pipeline/src/recorder/addon/videoclips-provider.ts
  - packages/addon-provider-reolink/src/reolink-camera.ts
  - packages/addon-provider-reolink/src/reolink-hub-session.ts
  - packages/addon-provider-reolink/src/raw-read.ts
  - packages/addon-export-hap/src/hksv/recording-delegate.ts
  - packages/addon-export-hap/src/hksv/fragment-source.ts
  - packages/types/src/ffmpeg/fmp4-fragment-plane.ts
---

> Status: **plan, 2026-09-20.** Nothing in `camstack-server` is implemented.
> The library side (nodelink-js 0.7.8: fixes and fixtures) is done and awaits
> the operator's publish. Decision record: [D549](../decisions/adr-0549-an-external-clip-catalog-is-another-videoclips-provider-served-by-the-devices-owner-and-listed-beside-the-others.md).
> Required reading: [2026-08-17-videoclips-implementation.md](2026-08-17-videoclips-implementation.md)
> § 2 (the mount fix) and § 8 P7 (collection mode); `docs/architecture/capabilities.md`
> § "Wrapper mounts must resolve per device".

## 0. What the brief got wrong, and what changed since the last design

- **102 and 101 are Hikvision** (`provider-hikvision`), not Reolink. The
  mains-powered Reolink devices on this fleet are **107** (E1 Outdoor PoE, TCP,
  SD card), **618** (E1 Outdoor Pro, TCP) and the **Home Hub 639** (TCP,
  <hub-ip>). Hub children: 3628 (ch 0), 3629 (ch 1), 3825 (ch 3). Standalone
  battery: 640, 4263. Every probe below used 592 and 639.
- **The viewer no longer consumes `videoclips.listClips`**
  (`camstack/src/components/camera/clips/__tests__/clip-surface-wiring.spec.ts`
  forbids it; the theater derives clips from `listTracks` clusters). The only
  consumer today is admin-ui `EventDetailPanel.getClipPlayback`. The viewer's
  clip vocabulary is still open by design (`camstack/src/clips/clip-model.ts`:
  `CLIP_SOURCE_NATIVE_PREFIX`, `CLIP_SOURCE_HKSV`, `ClipPlaybackRef {kind:'url'}`).
- **A capability may gain a method again** since 2026-07-30
  (`scripts/generate-api-types.ts`, Zod-derived). The 2026-08-17 doc and
  `recorder/addon/directory-handler.ts` said otherwise; corrected in place.
- **The per-device wrapper mount (2026-08-17 § 2, M1–M6) LANDED 2026-09-20**
  (slice 1; it was not landed when this was written —
  `grep device-scoped packages/types/src/capabilities/capability-definition.ts`
  returned nothing). The derivation moves **eight** caps, not two, and applies
  per METHOD: only a method whose input declares a required numeric `deviceId`
  is dispatched per device. Record:
  [D552](../decisions/adr-0552-a-device-scoped-wrapper-mount-dispatches-only-the-methods-that-name-a-device.md).
- **Operator decisions (2026-09-20)**: collection mode first, never a
  per-camera swap; sub stream for thumbnails; on-demand muxed MP4 with audio,
  served by the addon; addon data dir with per-device LRU at the bounds below;
  a read never wakes a standalone battery camera, explicit "Wake and refresh",
  refused below 15 %; HKSV deferred until collection mode lands; explicit
  timezone in the library plus a boot-time assert in the provider; the clip
  path is native-only and the hub's CGI channel/battery summary stays as it is;
  the day index waits for the operator's app capture.

## 1. What is VERIFIED on hardware (2026-09-20, read-only, `nativeOnly`)

Probe scripts stayed in the session scratchpad; the decrypted wire is now the
library's fixtures (`reolink-baichuan-js/test/fixtures/recordings/`).

| Capability | Standalone 592 (ch 0) | Hub 639 → children | Library call |
| --- | --- | --- | --- |
| List one day | **verified** — 169 clips today 634 ms; 546 yesterday 2.0 s; 40 per page, 14 pages, no `<bFinished>` | **verified** ch 0 (1), ch 1 (4), ch 3 (0, accepted) 140–470 ms; served from the hub's storage | `getVideoclips({channel, uid, start, end, timeZone})` cmd 14/15/16 |
| List a range | **missing by design** — one camera-local day per call | same | caller loops per day |
| Which days have footage | **verified** — cmd 142 with the app's month body: 592 answers 19 days in 50 ms; an empty month is `[]` | **verified** — hub ch 0/1/3 individually (50–60 ms), three channels in ONE call (393 ms); the app's own hub capture used it on ch 0 | `getDayRecords({year, month, channel, uid})`, `getDayRecordsForChannels(...)` — 0.7.8 (§ 10) |
| Thumbnail (I-frame) | **verified** — cmd 298, 640×360 @15, 254 ms; JPEG 30 KB via ffmpeg; 2 concurrent OK; `end == start` → 400 | **verified** ch 0 and 1 (896×512 @30, 453 ms; main 3840×2160 in 116 ms); needs `<uid>` in the body | `getVideoclipThumbnail({channel, uid, isNvr, time, endTime, timeZone})`; JPEG wrappers carry `uid` since 0.7.8 |
| Clip bytes | **verified** — cmd 5, elementary BcMedia (video+audio), 35 KB in 183 ms of data | **verified** ch 1 — 666 KB, 203 video + 253 audio packets, 10 keyframes | `downloadRecording({channel, uid, fileName, idleTimeoutMs})` → BcMedia; `downloadRecordingDemuxed` → Annex-B |
| Direct read of a hub child | n/a | **measured, not reachable** — 3628 answered none of three 15 s BCUDP discovery rounds; login failed at 51 s; no wake cost (`lastContactAt` unchanged, `sleeping:true` at +0/+60/+120 s) | — |
| Stream a clip (replay) | unverified (PCAP-attributed code) | unverified | `startRecordingReplayStream` |
| Playback URL | rejected — RTMP with credentials in the query, enables the RTMP port | rejected | `getRecordingPlaybackUrls` |

**UID**: standalone via cmd 114 (7 ms; the library now does it itself in
native-only mode). Hub child: CamStack already persists it in
`deviceMeta.metadata.uid` (present for 3628, 3629 and 3825 — 3825's config
field is absent); the hub's cmd 145 push is a second source and arrives ~12 s
after `subscribeEvents()`, not on login. The hub reports `channelNum=1`, so the
provider calls `setIsNvr(true)` for a hub.

**Sleep witness (indirect, stated as such)**: `battery.getStatus` for
3628/3629/3825 read `sleeping:true` with an unmoved `lastContactAt` before,
between and after every hub-child listing, thumbnail and download; the hub log
had no line for those ids. No radio-level witness was available.

**Download completion**: no end marker exists (rc 200 on the 32-byte stream
header, 0 on every chunk, never 201, no trailing frame of any cmdId). A 101 s /
1.8 MB clip fully arrived in 1 702 ms with a 59 ms largest gap; the fixed 15 s
idle window then made every download cost ~15 s. 0.7.8 makes the window
configurable, default 2 000 ms.

**Timezone**: every recording timestamp is the camera's wall clock with no
offset. The hub container runs `TZ=Europe/Berlin` (verified) — the same offset
as the cameras by configuration, not by design.

**Unverified and stated so**: replay streaming; thumbnail throughput above two
concurrent requests (the library's own 2026-02-23 artifact scored 0/60 under
load on an H.265 standalone); a standalone battery camera's catalog (never
logged into); a hub child with a busy day (the captured hub days had ≤ 4
clips).

## 1b. Fleet map — every Reolink device, 2026-09-20 (wakes authorised by the operator)

Read-only mapping over the 0.7.8 library. One socket to the hub for its three
children. Wakes: 3628 twice and 3825 once through the product's own path
(`snapshot.getSnapshot` `force: true`, a JPEG back in ≤ 6 s), 640 twice (a
standalone battery login IS the wake). Every session closed. Charge before and
after: 3628 100 % dc → 100 % dc (`sleeping:false` after the second wake);
3825 100 % dc → 100 % dc (`sleeping:false`); 640 100 % dc → 100 % dc (its hub
slice has not refreshed since 08:00, so no sleep witness); 3629 not woken
(same generation and pairing as 3628, nothing new to learn); **4263 not
woken: 8 %, no charger**. Day probed: 16 September.

| device | via | cmd 318 | cmd 142 (uid / no uid) | 14/15/16 sub / main (day 16) | 272/273/274 | 516/517/518 | 298 sub / main | cmd 5 sub / main | oldest → newest held |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 592 E1 Outdoor PoE v3.1.0.5223 (mains, SD 238 GB) | direct TCP | answers, no `VersionInfo` fields (cmd 80 has them) | 19 days / same 19 (uid ignored) | 288 / 287, 282 twins ≤ 3 s | 473 rows (16 pages) / 572 rows (20 pages), labels `md, people, dog_cat` | open answers 200 with an EMPTY body — no handle | 640×360 / **640×360 again** (main not honoured) | 92 KB / 2.29 MB for 5 s | 2026-09-02 → 2026-09-20 (≈ 18 days on a 238 GB card) |
| 618 E1 Outdoor Pro v3.1.0.5714 (mains, SD 249 GB, 177 GB free) | direct TCP | as 592 | 18 days (3–20) / same | days 3/4/5 list 4/110/206; **days 6–20 list 0** on both streams, both filters, a hand-built 10–20 window too | open OK, **0 rows** on day 16 | empty body | day 4 OK 640×360; **day 16 and 19 rejected 400** | not reached (no clip after 5 Sep) | 2026-09-03 → **listing dead after 2026-09-05** while the calendar marks every day to the 20th |
| 639 Home Hub v3.3.0.456 (mains, HDD 62.5 GB, 2.8 GB free) | direct TCP, one socket | hub answers 318 per child | — | — | — | hub-wide, `chnbits 0` + `<devices>` list | — | — | — |
| 3628 Argus 3E v3.0.0.3623 | **hub** | `Argus 3E`, `BIPC_NT1BNO23MPW3C10H` | 18 days / **400 empty body without uid** | 20 / 22, 18 twins | 28 / 29 rows, one page, `other, people, dog_cat` | 29 rows, 29 `bHasRecFile` | 640×360 / 2304×1296 | 455 KB / 4.41 MB for 16 s | 2026-04-29 → 2026-09-19 |
| 3628 | **direct** (after product wake, LAN answers ping, TCP 9000 open) | — | — | — | — | — | — | — | BCUDP discovery: 0 replies ×3; TCP login with hub credentials: `login failed: empty reply` (with and without uid) |
| 3629 Argus PT Ultra v3.0.0.3911 | hub | `BIPC_560MIX16M35SD938MP` | 19 days / 400 without uid | 6 / 6, 4 twins | 6 / 6 rows | 6 rows, 6 with clip | 896×512 / 3840×2160 | 1.21 MB / 5.07 MB for 16 s | 2026-04-29 → 2026-09-19 |
| 3825 Argus MagiCam v3.0.0.6176 | hub | `BIPC_C1BNO22MPW6C15V1`, name `Magicam` | 7 days (1–5, 7, 9) / 400 without uid | 0 / 0 (day 16; day 9 has 2 / 2) | 0 rows | **17 rows, 0 with clip** (events without footage) | day 9 available (not probed) | — | 2026-06-07 → 2026-09-09 |
| 3825 | **direct** (after product wake, TCP 9000 open) | 400 | 400 | 400 | — | — | — | — | TCP login with hub credentials **accepted in 240 ms**, then every command (102, 80, 318, 114, 142, 14) answers `400, empty body` |
| 106 Argus 3E v3.0.0.3623 (standalone battery, UDP) | direct (login = wake, 2.9–6.2 s) | answers | **400 / 400** | **400 / 400** | open answers empty | empty | not reached | — | **no SD card at 10:20** (`HddInfo mount 0, capacity 0`) — nothing to list. **SUPERSEDED the same day: the operator fitted a card on 2026-09-20** ("La 106 adesso ha la card" [The 106 now has the card]), un-measured — every 400 in this row was read against the card-less camera and none of it has been re-taken |
| 4263 Video Doorbell (standalone battery) | — | not woken: **8 %, `charging: none`** | | | | | | | |

**What the fleet supports today versus what the plan assumes:**

- `FileInfoList` + `DayRecords` + CoverPreview + cmd 5, sub and main: **yes** on
  592 and on every hub child through the hub. The plan's catalog path stands.
- `findAlarmVideo` (labels): **yes** on 592 (hundreds of rows) and through the
  hub for every child (one page each). `findEventLog`: **hub only** — a
  standalone answers an empty body; the plan already reserves it for the hub
  feed. 3825 shows why `bHasRecFile` matters: 17 events, 0 clips.
- **A hub child's own files are read through the HUB session addressed with
  the CHILD's uid — never through a session to the child.** The earlier
  "cannot be read directly" was answering the wrong question: a child refuses
  its own Baichuan session (3628: `login failed: empty reply`; 3825: login
  accepted, then 400 to every command), which is what the official app also
  never attempts. The app stays on the one hub session and changes who a
  request is addressed to (verified in both hub captures: the child's
  playback screen carries the child's uid on cmd 5/14/142/272; the Events
  screen carries the hub's uid on cmd 5/272, the children's uids on 14/298
  and lists the children in `<devices>` on 516). Measured on one hub session,
  3628 and 3629, same channel, same days (§ 1c): **the hub's uid addresses no
  catalog** — cmd 142 answers an empty month, cmd 14 lists 0 files, cmd 272
  0 rows, on both children and both streams — while the child's uid answers
  everything; cmd 5 serves the bytes under either uid (identical sizes,
  455 008 / 4 414 168 B), even under the wrong child's uid: bytes are
  addressed by the file path. So there is ONE file store per child on the
  hub (`/mnt/sda/U10<child uid>-<name>/`), and the two sources the operator
  asked for are two VIEWS of it: `onboard` = the child's files (cmd 142 +
  14/15/16 by child uid), `hub` = the hub's event list (cmd 516/517 with the
  child in `<devices>`, rows with `bHasRecFile`). No direct session, no wake.
- **A standalone battery camera without an SD card has no catalog at all**
  (640, as measured 2026-09-20 10:20): `onboard` answers `no-storage` from
  `getHddInfoList`, and the plan's cheap-question-first rule applies — never
  search a camera whose card is not mounted. 4263 is unmapped (8 %).
  **This is no longer a live example.** The operator fitted a card in 640 later
  the same day. The `no-storage` RULE stands unchanged — a card-less camera is
  a state the code must report, and reporting it as "no clips" is the defect
  this plan exists to end — but **the fleet now has no camera to prove it
  against**, and 640's catalog becomes real the next time it is awake for its
  own reasons. Nothing above this line was re-measured after the card went in;
  treat every 106 number in §§ 1b/1c as a reading of the card-less camera,
  taken before 11:00 on 2026-09-20.
- **cmd 142 needs the uid on the hub and ignores it on a standalone.** The
  provider always sends it.
- **CoverPreview `main` is not honoured on the E1 Outdoor PoE** (same 640×360
  frame back); it is on the hub (2304×1296, 3840×2160). Thumbnails are sub
  stream anyway (operator's choice); playback `high` still gets the main twin
  over cmd 5, which does work on 592.
- **108 is a real defect on the camera, not in the plan**: three listing
  families and CoverPreview by time all answer nothing after 5 September while
  the calendar marks every day and the card has 177 GB free. The provider must
  show this honestly — calendar says footage, listing says none — as a
  per-day `unavailable` with reason `index-empty`, never as "no clips".
- Retention differs by storage: the hub keeps its children from 29 April
  (62.5 GB HDD, 2.8 GB free); 592 keeps ≈ 18 days on 238 GB (12 GB of main
  stream per busy day). The catalog's oldest day comes from the calendar walk.
- Wake cost, measured: a product wake answers in ≤ 6 s and the hub reports
  the child awake within a minute; no charge change was observable on
  dc-powered cameras. On a battery-only camera the cost is unmeasured here
  (4263 was the only one, and it is at 8 %).

## 1c. The operator's three cases, end to end (2026-09-20, 10:20–10:24)

Same shape for all: list timed and counted, three thumbnails minted from the
newest clips (raw I-frame → ffmpeg → JPEG on disk, decoded with ffprobe),
every refusal verbatim, every session closed.

| case | device / route | list | thumbnails | bytes | refusals |
| --- | --- | --- | --- | --- | --- |
| 1a standalone mains | 592, own TCP session | calendar 19 days (38 ms); day 20 sub: **171 clips in 712 ms** | **3/3**: 24 587, 37 299, 30 933 B, `mjpeg 640×360`, 192–492 ms each | (cmd 5 verified in § 1b: 92 KB / 2.29 MB) | none |
| 1b standalone battery (card-less; a card was fitted later the same day — not re-measured) | **106 "Baby monitor"** (Argus 3E, the only camera so named), 100 % dc before and after, product wake `snapshot.getSnapshot force` → JPEG, then own UDP session (login 693 ms) | cmd 102: `mount 0, capacity 0` — **no SD card**; cmd 142 → `responseCode 400, empty body`; cmd 14 → same | 0 — nothing to thumbnail | — | the two 400s above, verbatim: "Baichuan request failed (responseCode 400, empty body). Possible causes: expired session, invalid username/password, or unsupported command on NVR/Hub." |
| 3 hub child, its OWN files | 3628 ch 0, hub session, **child uid** | calendar 18 days (65 ms), oldest month reached 2026-04-30 (455 ms walk); day 16 sub: **20 clips in 503 ms** | **3/3**: 47 388, 49 351, 35 741 B, `mjpeg 640×360`, 194–530 ms | cmd 5, 16 s clip: **455 008 B in 3.3 s** | none |
| 2 hub child, the HUB's list | 3628 ch 0, same session, **hub uid** on 142/14 → `[]` / 0 files; then 516/517 with the child in `<devices>` | day 16: **29 events (29 `bHasRecFile 1`) in 293 ms**, types md 10 / people 18 / dog_cat 1 | **2/3**: 39 605, 36 524 B `mjpeg 640×360`; third (event 06:51:42–…) → "Baichuan CoverPreview request rejected (cmdId=298 reqChannelId=0 rspChannelId=0 reqStreamType=0 rspStreamType=0 msgNum=0 responseCode=400 payloadOffset=0)" | (same files as case 3) | the 298 above; the hub-uid calendar/list are not refusals — they answer 200 with nothing |

**Case 2 vs case 3, same child, same channel, same day:** 20 files vs 29
events; **28 of 29** events with a clip fall inside a listed file, **20 of
20** files carry at least one event; the bytes are the same files under
either uid. Oldest reachable: files 2026-04-30 via the calendar walk; the
event list takes an unbounded descending window (the app sends `endTime`
1970). The one event whose CoverPreview was refused is the one event whose
window did not sit inside a listed file — the join, not the camera, said no.
Verdict: **one store, two views**, proved on the hardware; the operator's
two-entry shape stands as files-view and events-view, and a clip appears in
both (it always will, 20/20), each row saying which view it came from.

Thumbnail files: `scratchpad/thumb-c{1,2,3}-*.jpg` in this session's
scratchpad (private frames; not committed).

## 2. nodelink-js 0.7.8 — done, awaiting publish

In `<repo-parent>/reolink-baichuan-js` (no version bump,
no publish, no `.npmrc` — operator's chain):

1. `uid` (+ `isNvr`, `endTime`, `timeZone`) on `getVideoclipThumbnailJpeg` /
   `JpegRaw` — a hub child without the push cache got 400 through the wrappers
   while the raw call succeeded.
2. Native-only standalone UID via cmd 114 inside `ensureUidForRecordings`,
   cached; never on an NVR/Hub.
3. The dead `headerChannelIdOverride` in `getVideoclips` removed; the header
   rule (channel in the body only, header 250 on both topologies) stated where
   it is enforced and pinned by test.
4. `getDayRecords` implemented from the operator's app captures and verified
   live on both topologies (§ 10).
5. `recordingsTimeZone` constructor option and per-call `timeZone` through the
   request builders, the response parser and the file-name parser
   (`utils/wallClock.ts`; DST gap/overlap handled); host-local when omitted.
6. `idleTimeoutMs` on `downloadRecording` / `sendBinary`,
   `DEFAULT_RECORDING_DOWNLOAD_IDLE_MS = 2 000`; a 201 still finishes early.
7. Fixtures from the captures (`test/fixtures/recordings/{standalone,hub}/`,
   README there) and five test files (34 tests). `documentation/baichuan-api/recordings.md`
   rewritten from the code (it documented `startTime`, `filename`,
   `{year, month}` and `{rtmpUrl, httpUrl}` that do not exist).

Also fixed: a zero-length CoverPreview window is widened to 10 s.

**Workspace copies**: `addon-provider-reolink` resolves and bundles its own
nested 0.7.7 (`externals: 'self-contained'`; `node_modules/@<github-account>/nodelink-js/dist/index.d.ts`
present next to it), so its typecheck is against 0.7.7, not the root copy. The
root 0.6.7 is hoisted for `addon-provider-dreame` (`^0.6.7`, one RFC 4571
import). Nothing breaks today; bumping dreame to the same range lets npm
dedupe to one copy — the operator decides at pin time.

## 3. The capability — extend `videoclips`, collection mode

- **No sibling cap.** The class doc, `source: 'native:<vendor>'`,
  `kind: 'native'` and the viewer's open `ClipSourceId` already name this case;
  a second cap answering "what clips does this camera have" is the D62/D113/D544
  defect.
- **Mount** (2026-08-17 § 2, M1–M6): `device-scoped` mount kind in
  `resolveCapMount`, `requireDeviceScoped` in `cap-router-runtime.ts`, builder,
  `generate-cap-mounts.ts`, codegen, CI guard. Then **collection** (§ 8 P7):
  `mode: 'collection'` over the device's bound providers; `listClips` fans out
  with a bounded concurrency and merges by `(startMs, endMs, id)`;
  `getClipPlayback` dispatches by the id's provider prefix. A provider that
  fails leaves the others' rows in place and is reported per source.
- **Additive `ClipSchema` fields**:
  - `thumbnailMint?: string` — a URL that MAY produce the still; the surface
    asks it for on-screen rows only and latches a failure to the instant.
  - `thumbnailUnavailable?: { reason: 'sleeping' | 'camera-refused' | 'no-keyframe' | 'unsupported' }`
    — set when the provider already knows no mint will succeed now.
  - `catalogAsOf?: number` — when the listed catalog was last confirmed
    (a sleeping standalone battery camera lists its cached day with an age).
  - `labels` already exists: `md,people,dog_cat` → `person`, `animal`.
- **`listClips` input**: `sources?: string[]` — a view filter, ignored by a
  provider with one source. `limit` per provider, applied before merge.
- **Streams on the row** (D549 15): `streams: { sub?: { id, bytes },
  main?: { id, bytes } }` and `supportSub`, both resolved at listing time by
  running the sub and the main search for the day and pairing twins by
  start time within 3 s (§ 10). `getClipPlayback({ clipId, profile })` with
  `profile ∈ CamProfileSchema`: `low | mid` → sub, `high` → main; the answer
  carries `served` and the viewer states it when the asked twin is missing.
  `auto` is the viewer's `StreamQuality` resolved to a profile the way live
  does — through the existing `/adaptive-probe` class — never a per-clip
  setting; a stored file has no broker session, so `{ kind: 'adaptive' }`
  cannot be asked of the broker for it.
- **`getClipPlayback`** otherwise unchanged in shape; a native clip's
  `playbackUrl` is a progressive MP4.
- **Two sources per hub child, one per standalone** (operator, D549 11):
  `native:reolink:onboard` (the camera's own SD, direct read) and
  `native:reolink:hub` (the parent's storage). Listed side by side, each
  filterable, no merge, no dedup — a clip in both storages appears twice and
  each row's `source` says where it came from. `listSources({deviceId})`
  (additive cap method) returns `[{ source, label, availability:
  { state: 'ok' | 'sleeping' | 'unreachable' | 'no-storage', reason?,
  catalogAsOf? } }]`; the picker draws it from the wire. Default filter on a
  hub child: `hub` (measured to answer); `onboard` shows `unreachable` until
  a direct read has succeeded once.
- **Ids**: `native:reolink:<source>:<channel>:<base64url(fileName)>` —
  self-contained, so playback and thumbnail routes never re-list and the
  source is part of the identity.

## 3b. Which list is the catalog, and how a native type reaches our filters

> **SUPERSEDED 2026-09-20 by
> [D565](../decisions/adr-0565-the-file-list-is-the-clip-catalog-on-every-topology-and-the-class-is-joined-onto-it.md).**
> `FileInfoList` is the catalog on EVERY topology — a clip IS a file. The two
> grounds below were re-measured the same day and neither held: on 3628,
> `searchEventLog` took **950 ms** (day 16) and **678 ms** (day 9) against
> `FileInfoList` sub **137 ms** / **514 ms** (reversed), and
> `searchAlarmVideos` answered the same child in **247–306 ms**, joining the
> class onto those same files by the file's START STAMP — not by `<name>`,
> which is a full path on the library's `RecordingFile` and joins 0 of 539.
> A hub child's files really are `recordType: none`; that half was right. The
> class-mapping TABLE below is unchanged and still authoritative; only "which
> list is the catalog" changed. The events view is kept and NOT wired
> (`clip-event-catalog.ts`).

**On a hub child the catalog is the events view** (operator, 2026-09-20:
"utilizziamo la lista più veloce in caso di hub" [let us use the fastest list in the case of a hub]). Measured on one hub session,
3628 ch 0, day 16: `findEventLog` 516/517 **29 events in 293 ms** with
`alarmType` on every row, against `FileInfoList` 14/15/16 **20 files in
503 ms** with no class. The file is resolved at playback time by the
window → file mapping (an event whose `[start, end]` lies inside a file's
`[start − 3 s, end + 3 s]`; 28 of 29 on that day), which needs the day's file
list once, cached with the catalog. **The event that sits in no file** — one
of 29, `bHasRecFile 1` and nothing coverable, whose CoverPreview the hub also
refused with 400 — is a row with `playable: false, reason: 'no-file-for-window'`
and the glyph tile; never dropped, never shown as playable and then failing.
On a standalone the catalog stays `FileInfoList` (a standalone answers
`findEventLog` with an empty body).

**Where the class comes from.** Standalone: two sources exist — the file's
own `recordType` CSV (free, on every catalog row; `union(alarmType) ==
recordType` on 164 of 167 files on 592, the 14 that differ are `sched`
files that carry no event) and `findAlarmVideo`'s per-window `alarmType`
(precise, one extra open + N pages: 473 / 572 rows on 592 for one day).
**Default: the file's `recordType`.** It is 98 % identical on the measured
day, it costs nothing, and the 2 % it misses are not wrong labels — they are
scheduled files with no event, which correctly show as `motion`-less
`sched`. `findAlarmVideo` is the per-window upgrade the label slice adds for
the clip DETAIL (which event, when, inside the file), not for the list. Hub
child: `alarmType` arrives on the event row, and the file's `recordType` is
`none` on the hub (measured), so the events view is the only class source
there — one more reason it is the catalog.

**The vocabulary, read from the captures** (app filter on 272/516 and rows):
`md, pir, other, package, io, people, face, vehicle, dog_cat, visitor, cry,
crossline, intrude, loitering, legacy, loss, answer, nonmotorveh, tamper,
lmsg`; on 14/15/16 `recordType` additionally `manual, sched, intrusion,
IPCInputOutput`. Observed on this fleet in rows: `md, people, dog_cat, other,
sched` (592/618) and `md, people, dog_cat, other, none` (hub children).

**The mapping is into the vocabulary the operator already filters with** —
the hub-served event-kind taxonomy (`pipeline-analytics.listEventKinds`,
`EventKindDescriptor { kind, label, parentKind, icon }`, macros
`person | vehicle | animal` from `FIRST_LEVEL_MACRO_CLASSES`, built-in kinds
`motion` and `audio`, icons from the closed `EventKindIconSchema`), and the
same `people → person`, `dog_cat → animal` rule `native-detection-mapping.ts`
already applies to live boxes. A clip row carries `labels` (≤ 3, dominant
first) in that vocabulary and, separately, `nativeTypes` (the raw strings, all
of them) so nothing is lost:

| native | `labels` entry | why |
| --- | --- | --- |
| `people`, `face` | `person` | a face is a person (the event taxonomy refuses `face` as a kind by design) |
| `vehicle`, `nonmotorveh` | `vehicle` | a bicycle is still the vehicle macro; `nonmotorveh` also kept raw |
| `dog_cat` | `animal` | as the live mapping |
| `package` | `package` | an existing icon and kind |
| `md`, `pir` | `motion` | "something moved" — the built-in motion kind, NOT an object class; `pir` is the same statement from a different sensor and keeps its own icon (`pir`) as a sub-kind of `motion` |
| `cry` | `audio` | the built-in audio kind (sub-kind `audio-cry`, added to the taxonomy the way `audioKindId` mints audio sub-kinds) |
| `visitor` | `person` + behaviour `doorbell` | a visitor is a person at the door; the doorbell kind exists (`nc-taxonomy` `doorbell`) |
| `crossline`, `intrude` / `intrusion`, `loitering` | **not a label** — `behaviours` field | what the subject DID; a clip carries it beside a real class (`people` + `intrude`), never instead of one; the section shows it as a chip, the class filter ignores it |
| `sched`, `manual`, `io`, `IPCInputOutput`, `legacy`, `loss`, `answer`, `tamper`, `lmsg` | **no label** — `nativeTypes` only | a recording REASON (schedule, manual, an I/O input, a two-way-audio answer, a tamper, a lost link), not a class; the row lists with its kind `native` and the reason shown raw |
| `other`, `none` | **no label** | the camera declined to classify; the row is `motion`-less unless `md` is also present |
| anything else | **`unknown:<raw>`**, VISIBLE | an unknown type is kept raw, shown under an "Other (camera)" node of the filter tree and never dropped — a newer firmware inventing a type must not vanish; `labels` is `z.string()`, not an enum, on purpose |

A clip's `kind` stays `native`; the class filter matches on `labels`, the
kind filter on `motion`/`audio` derived the same way, and `behaviours`
render but do not filter until the taxonomy grows a behaviour axis (not
invented here). Types with no home are said so above rather than forced.

## 4. The Reolink provider (`addon-provider-reolink`)

- Registers `videoclips` with `defaultActive: false`, `source: 'native:reolink'`.
  Bound per camera by the operator through `deviceManager.setWrapperActive`
  (the existing authority, D62/D113); availability from `getBindings` /
  `listWrappersForCap` on the wire (D544 — no client catalog). Declines a
  camera with no mounted storage (`getHddInfoList` `mount:0`) with a named
  reason, never silently.
- **One `ClipSource` resolver per device**: hub child →
  `parent.getApi()` (mains socket, `setIsNvr(true)`), `channel` from config,
  `uid` from `metadata.uid` with the push cache second, `servedByParentHub`;
  standalone → own `ensureApi()` behind the sleep gate, `uid` cached from
  cmd 114 in `deviceCache.uidSnapshot`.
- **Listing**: standalone — the month's day index from `getDayRecords`, then
  one cmd 14/15/16 pass per day that HAS footage inside `[since, until)`
  (`endOfWallClockDay`), ≤ 50 pages/day, newest first, `limit` cap, `labels`
  from the file's `recordType` (§ 3b). Hub child — `findEventLog` 516/517 with
  the child in `<devices>` over the window, newest first, 60/page, `labels`
  from each row's `alarmType`, plus the day's file list (14/15/16, child uid)
  cached for the window → file resolution at playback (§ 3b). Cache per `(device, day)` in provider memory: closed days
  immutable for 24 h, today `serve-and-revalidate` under
  `OPERATOR_WRITTEN_STALE_MS` (D224). Fail OPEN on the list from cache, CLOSED
  on every claim.
- **Timezone**: the provider passes the camera's zone as `recordingsTimeZone`
  and at boot compares it with the camera's own clock (`getNtp`/`getSystemGeneral`
  already in the raw-read catalog); a mismatch logs a warn per device with
  `tags: { deviceId }` and the catalog still lists.
- **Battery policy** (D549 decisions 11–12):
  - hub child, `hub` source: every read is served by the hub — calendar,
    list, thumbnail, bytes — the child's sleep is irrelevant (verified).
  - hub child, `onboard` source: a DIRECT read, opportunistic exactly like a
    standalone battery camera (below). Tried with the operator's
    authorisation on 3628: not reachable on the LAN while hub-paired and
    asleep (three 15 s discovery rounds, 0 replies, login failed at 51 s, no
    wake incurred). Until a direct read succeeds the source is listed as
    `unreachable` with the last `catalogAsOf` (none yet); the first awake
    read measures what it holds against `hub` and the record is amended.
  - standalone battery (640, 4263): a READ never logs in (login IS the wake).
    `listClips` answers the persisted catalog with `catalogAsOf` and
    `thumbnailUnavailable.reason: 'sleeping'`; the mint route answers 204
    `sleeping`; playback is refused with a named reason. **Wake and refresh**
    goes through the existing proactive-wake path and is refused below 15 %.
- **Catalog refresh** (operator, 2026-09-20; D549 decision 12): setting
  `clipCatalogRefreshMinutes` (global default 15, per-device override, the
  `stationary-settings.ts` cascade) with a description that names both
  behaviours. Hub child: on the timer, ask the hub — `getDayRecordsForChannels`
  for the month, `getVideoclips` (sub) for today and any day whose calendar
  entry changed, mint thumbnails for new clips — the child asleep throughout.
  Standalone battery: the timer marks the catalog stale; the refresh itself
  runs on the awake transition `reolink-camera.ts` already observes (stream,
  operator action, event wake) and on "Wake and refresh". `clipCatalogForcedWake`
  is a per-device opt-in, OFF, described as "wakes the camera every N minutes
  (96/day at 15)". Mains standalone (592, 618): the timer refreshes directly.
  A persisted catalog per `(device, day)` in the addon data dir, `catalogAsOf`
  on every answer. **The same refresh prefetches thumbnails** (D549 16): the
  newest 20 clips without a JPEG, newest first, stopping when the device's
  LRU has under 10 % free — a prefetch never evicts. Two provider queues
  (interactive, prefetch), one CoverPreview in flight per host, interactive
  drained first, prefetch skipped while the library's per-host 400 backoff is
  open. **Every hub call — both sources, calendar, listing, stills, bytes,
  prefetch — goes through the one `parent.getApi()` session** (D549 17); the
  clip path constructs no `ReolinkBaichuanApi`.
- **Logging**: every line `tags: { deviceId }`; one info per `listClips`
  `{days, clips, truncated, thumbsVouched, thumbsUnavailable:{reason:count}}`;
  a warn for every dropped branch (`sleeping`, `uid-missing`,
  `camera-refused`, `pages-truncated`, `tz-mismatch`).

## 5. Thumbnails

- **Why serialised**: the camera rejects concurrent CoverPreview with 400
  (library commit `e2910b4`): one in flight per API, a queue of 50 that throws
  past that, and a process-wide host-keyed backoff doubling on 400 — one hub's
  channels share a lane. cmd 298 is addressed by time (`time = startTime`,
  `endTime = endTime`).
- **Route**: `/addon/provider-reolink/clip-thumb/<deviceId>/<clipKey>`
  (authenticated tier, unguessable key, `Cache-Control: immutable`), owned by
  the vendor addon (D224; the cap's own rule: "other providers mint their own
  stills", vouched never fabricated). On a miss it mints: hub child through the
  parent (`uid`, `isNvr: true`), standalone through its own API behind the sleep
  gate; sub stream; raw I-frame → one bounded ffmpeg → JPEG.
- **Cache**: `<dataDir>/addons-data/provider-reolink/clip-thumbs/<deviceId>/<clipKey>.jpg`,
  key = sha of `(channel, fileName)`, per-device LRU **2 000 files / 64 MB**,
  files immutable. Outside the `eventMedia` class and outside the post-analysis
  retention sweep — a derived artifact of a catalog whose retention is the
  camera's. Confirmed by the operator 2026-09-20; "as artifacts" was offered
  and declined (an artifact is an operator-authored export with an id and an
  expiry; a cache is neither). Thumbnails for a battery camera are minted on
  the catalog refresh (§ 4), so a sleeping camera's tiles are the ones minted
  while it was awake, labelled with `catalogAsOf`.
- **Bounds**: the route keeps ≤ 8 pending per host and answers **204 +
  `X-Camstack-Reason`** rather than waiting (the recorder still route's
  contract: ≤ 3 concurrent, queue 8, 204 on overflow).
- **Never blank**: a clip without a vouched JPEG carries `thumbnailMint` or
  `thumbnailUnavailable.reason`; the tile shows the glyph and the reason.

## 6. Playback — the same player recordings use, and what it needs

**The recordings path in admin UI, by symbol.** `RecordingTimeline.tsx`
(`packages/ui-library/src/composites/cap-settings/`, line 317) asks
`recording.getPlaybackManifest` and calls `vod.play({ url: manifest.playbackUrl, label })`
on `VodPlaybackProvider` (`packages/ui-library/src/contexts/vod-playback.tsx`,
`VodPlaybackRequest { url, label? }` — "master `.m3u8` URL through the hub
data-plane"). `PanelContent.tsx` (`packages/addon-admin-ui/src/components/device/`,
line 128–160) consumes the request and hands `StreamPanel`
(`packages/ui-library/src/composites/stream-panel.tsx`) `playbackUrl` +
`playbackAuthToken`; `StreamPanel` (line 935) swaps the live WebRTC player for
`HlsVideo` (`packages/ui-library/src/composites/hls-video.tsx`): **hls.js**
`loadSource(url)` + `attachMedia(video)` with `xhrSetup` adding
`Authorization: Bearer` and `withCredentials`; the only non-hls.js branch is
Safari's native `video.src = url` when `canPlayType('application/vnd.apple.mpegurl')`.
The other context, `recorded-playback.tsx` (`RecordedPlaybackProvider`), is
the frame-push `camstack-control` datachannel on the LIVE WebRTC session —
broker-backed, not a file player, not applicable to a stored clip.
`EventDetailPanel.tsx` (line 522), today's only `videoclips` consumer, calls
`videoclips.getClipPlayback` and `window.open(playback.playbackUrl)` — it too
assumes an HLS master URL.

**The gap, stated.** The recordings player is **HLS-only**. A progressive MP4
served by the addon over a Range route does NOT drop in: hls.js will try to
parse it as a manifest and fail; the Safari branch keys on the HLS MIME. So
"same player" and "MP4 to avoid the broker" conflict as planned.

**The smallest honest change (chosen):** keep the MP4 (it is what cmd 5 + one
mux produces, and the viewer's `ClipPlaybackRef { kind: 'url' }` already
models a plain URL) and teach the ONE player to play a plain media URL:
1. `ClipPlaybackSchema` (`videoclips.cap.ts`) gains `format: 'hls' | 'mp4'`
   (additive; the analytics provider says `hls`, the Reolink provider `mp4`);
   `playbackUrl`'s doc stops saying "HLS master".
2. `VodPlaybackRequest` gains `format?` (default `hls`).
3. `HlsVideo` branches on it: `mp4` → `video.src = url`, no hls.js, **nothing
   appended to the URL** — the hub's `/addon/…` proxy accepts the session
   cookie (`main.ts`: `authHeader ? … : request.cookies[SESSION_COOKIE]`),
   which the admin UI sets at login (`auth-context.tsx:89`), so a same-origin
   `<video>` arrives authenticated exactly as `HlsVideo`'s own native branch
   does today. The clip route is `access: 'authenticated'` like the
   recorder's plane; the URL is never a credential (D549 22). `StreamPanel`
   passes the format through unchanged.
4. `EventDetailPanel.openClip` keeps working: an `mp4` URL opens in a tab too.
Not chosen: serving the native clip as HLS (segmenting + a playlist per clip
is more server work for no user-visible gain, and the viewer would still get
a URL). What the player then needs from a native clip, and what the MP4 gives:
a seekable source with a known duration — the mux runs with
`-movflags +faststart` so `moov` is first and duration is known before the
bytes arrive, and the route honours `Range`, so seek works natively.

**A native clip arrives through the existing shape**, not a parallel one:
`getClipPlayback({ deviceId, clipId, profile })` → `ClipPlayback { playbackUrl, format, served }`.

**Server side, as before:**

`getClipPlayback` → cmd 5 into a bounded per-device scratch (retried until it
lands, under a bound — D58; **10 clips / 200 MB**, LRU) → one bounded ffmpeg
muxes the Annex-B video and the audio packets into MP4 → served with Range on
`/addon/provider-reolink/clip/<deviceId>/<clipKey>.mp4`; the same URL is the
download. The viewer plays `{kind:'url'}`. Not through the broker (no live
session for stored media), not RTMP. Cost per clip: the transfer (LAN: ≈ 2 s
for 1.8 MB) plus the 2 s idle window; the UI shows "preparing" with elapsed
time, never a bare spinner.

## 7. The admin section (cameras only)

`videoclips` passes D526's test (three intended providers) → declare
`deviceConfig: { ui: { kind:'widget', widgetId:'host/clips-browser', tab:'clips', topTab:true, label:'Clips' } }`
on the cap and let the aggregator derive the section (D14; precedent
`ptz.cap.ts` `host/ptz-panel`). `DeviceDetail.tsx` is not edited. **Verify
first** that `deriveDeviceConfigContribution` emits a section for a WRAPPED
binding entry — only native entries have exercised it.

The widget: **source picker** (rows from `listSources`, each naming the addon
that serves it in `ClipSource.addonId` and, where it had a choice of API, the
one it resolved to in `ClipSource.via`; a Reolink camera shows ONE row
whatever the topology, since D555's collapse). **The switch is PERSISTENT and
keyed by SOURCE** (D555, lifting D557's view-filter-only staging): one call,
`deviceManager.setWrapperActive({ deviceId, capName: 'videoclips',
wrapperAddonId: row.addonId, sourceId: row.source, active })` — the authority
D556 already established, at the grain the rows actually have: `listSources`
answers one row per SOURCE, so a per-row switch keyed by anything coarser can
lie about what it did. Unset still means every source,
nothing is deduped, and a source is never hidden — only its clip rows
disappear. **Settled** (D556, amended 2026-09-20): `listSources` keeps
every source the camera has and MARKS the switched-off ones
(`ClipSource.switchedOff` — a boolean beside the availability, not a sixth
`state`), so the row an operator un-ticks from is always there. A switched-off
source contributes no clips, is never asked for a catalog, and shows no
`catalogAsOf`; a camera with every source off answers an empty clip list, not
"not registered". Draw the row as OFF, never as empty. Day navigation, newest-first list with tiles
(vouched JPEG → mint URL for on-screen rows → glyph + reason), four states
(loading / empty-with-cause per source / degraded per source / sleeping with
`catalogAsOf`), **Wake and refresh** only on a standalone battery camera (with
the 15 % refusal shown), and a clip panel with play/download. Presence through
`useCapabilityPresence` (D315), never a boolean.

## 7b. Delivery order — admin UI is the proving ground; the viewer waits

Operator, 2026-09-20: *"Per le clip iniziamo con la view in admin UI per le
varie sorgenti. Quando sono provate andiamo invece su Viewer."* [For the clips let us start with the view in the admin UI for the various sources. Once they are proven we move to the Viewer instead.] The admin
section (§ 7) is where the sources are exercised against real cameras; no
viewer work starts before it is proven. **"Proven" means, in that section, on
the live cluster, all three measured cases (§ 1c) working end to end:**

1. **592 (standalone mains)** — the source row lists the day's clips (≥ 100
   on a busy day), every visible tile carries a real thumbnail minted through
   the addon route, and a clip plays in the hero `StreamPanel` through the
   `mp4` branch with seek and a known duration.
2. **A hub child's own files** (3628, `onboard` view) — same, through the one
   hub session with the child's uid; bytes through the hub.
3. **The same child's events view** (`hub`) — the events list with classes in
   the operator's filter vocabulary (§ 3b), thumbnails by time, and the one
   event outside every file shown as `playable: false` with its reason, not
   as an error.
Plus the honest states: a card-less camera's `onboard` shows `no-storage`; a
sleeping standalone battery camera shows its cached list with `catalogAsOf`;
618's dead days show `index-empty`; and a hub child with no persisted uid —
**3825 today** — shows `uid-missing` on both rows rather than "no recordings".

**`no-storage` has no live camera to prove it against.** 106 was the fleet's
only card-less camera and the operator fitted a card on 2026-09-20, hours
after the measurement. The state is exercised by
`reolink-videoclips-provider.spec.ts` against a fake whose `getHddInfoList`
answers `mount 0` (`CARDLESS_CAMERA` — named for the SHAPE, deliberately not
for a device id, because that is exactly the claim that just evaporated). So
when this section is signed off, **`no-storage` is verified in the suite and
NOT on hardware**; nobody may later read "all states verified on hardware" off
this page. The other four remain provable live: `sleeping` and `index-empty`
on 106 and 108, `unreachable` on any camera that refuses, `uid-missing` on
3825.

**Status 2026-09-20, after slices 2/3/5:** all three cases are met AT THE
PROVIDER, measured live and read-only through the provider's own modules —
592 lists 209 clips in 6.0 s (546 in 4.3 s with 529 twins) and mints real
thumbnails; 3628's own files list 28 in 717 ms; 3628's events view lists 38 in
267 ms, classed (`people` / `md` / `dog_cat` where its files carry none), 38/38
joined to a file, with a 62 869 B thumbnail through the child's uid. **The bar
this section sets is not met until the operator sees them HERE**, which is
slice 4's, and nothing has been deployed. Two numbers that change the section:
one child's events for ONE day is 267 ms and for 20 days is 3.6–5.4 s, so the
day is the default and a range is a deliberate wait; and the orphan-event rate
is a PER-CAMERA fact (0 of 1 281 rows on 3628 and 3629 over 20 days, while the
orphans D549 19 names live on 3825, which is `uid-missing`), so the section
must not be built around either extreme.

Only when those are seen by the operator in the
admin section does the viewer slice open — and it reuses the same
`getClipPlayback` shape and the `{ kind: 'url' }` player it already has.

## 8. HomeKit — deferred to after slice 6

HAP has no read-back (HDS `dataSend` is push-only); a clip HomeKit stored is
never CamStack's. What exists: HKSV fully built and on by default
(`packages/addon-export-hap/src/hksv/`), a permanent per-camera fMP4 child
feeding `Fmp4FragmentPlane` with an 8 s / 16 MB RAM prebuffer, built dual-use
and with no second subscriber. What it takes: a second
`plane.subscribe({tag:'clip', withPrebuffer:true})` opened in
`handleRecordingStreamRequest` and closed at `isLast`/`acknowledgeStream`,
writing `init + fragments` to a file; a storage owner and retention for those
files; a cross-runner hand-off (export-hap is hub-only in its own runner); a
thumbnail minted from the saved fMP4 and vouched; a `videoclips` provider
`source:'hksv'`. Coverage: only H.264 ≤ 1080p, GOP ≤ 8 s. Duration: whatever
iOS pulled. It becomes the third source on the same seam once 1–6 exist.

## 9. Sequence — collection-first, each slice independently shippable

| # | Slice | Ships as | Test that must go red on revert |
| --- | --- | --- | --- |
| 0 | This document, D549, the two stale claims fixed, nodelink-js published and pinned — **0.7.9** since the events/label parsers landed | docs + library | `recordings-*.test.ts` (52 tests) |
| 1 | Per-device wrapper mount: 2026-08-17 § 2 M1–M6 + CI guard | framework train | the two-provider router spec (§ 2.3) |
| 6 | Collection mode: fan-out, merge by `(startMs, endMs, id)`, dispatch by prefix, per-source degradation — **LANDED 2026-09-20** ([D554](../decisions/adr-0554-a-per-device-wrapper-that-becomes-a-collection-stays-per-device-and-its-sources-are-fanned-out-not-picked.md)); `listSources` is on the cap, the per-device COLLECTION FILTER is what the router reads (`setWrapperActive`'s store cannot hold two), and the picker that writes it is slice 4 | framework train | two providers on one camera both appear; each id plays through its own provider; a throwing source is `unreachable` with its reason and the others still list |
| 2 | Reolink provider: catalog only, both topologies, sleep policy, tagged logs, additive `ClipSchema` fields — **LANDED 2026-09-20** ([D555](../decisions/adr-0555-a-source-whose-library-method-does-not-exist-is-a-listed-source-that-says-so.md)). BOTH sources answer: `onboard` on both topologies, and the hub EVENTS view on nodelink-js **0.7.9**'s `searchEventLog`, with an event joined to its file by window containment and a row that cannot play saying which of `no-rec-file` / `no-file-for-window` it is. The TZ assert has its comparator and tests (`clip-timezone.ts`) and no caller yet | `types` + `camstack deploy provider-reolink` | provider spec with fakes shaped from the fixtures; "zero logins while sleeping"; live check on 592 and 639 |
| 3 | Thumbnail route + LRU cache + vouching + 204-with-reason — **LANDED 2026-09-20** | addon deploy | mint once, serve from disk after; 204 `sleeping`; overflow → 204 not wait |
| 5 | Playback: fetch + mux (`+faststart`; **video only** — 0.7.9's `downloadRecordingDemuxed` still returns Annex-B video; the audio is reachable through the exported `BcMediaAnnexBDecoder`, and `getRecordingVideo` is refused because its `frag_keyframe+empty_moov` MP4 loses the seek and the duration this player needs, D555) + Range route + `getClipPlayback { format:'mp4' }`; `HlsVideo` `mp4` branch + `VodPlaybackRequest.format` (§ 6) — **LANDED 2026-09-20** | addon deploy + ui-library | mux spec on a captured cmd 5 dump; Range route; bound/LRU; `HlsVideo` plays an `mp4` request without hls.js |
| 4 | Admin section: derived widget, source filter, tiles, four states, wake action with the 15 % refusal — **the proving ground (§ 7b)** | `types` + admin-ui | aggregator emits the section for a wrapped `videoclips` binding; four-state render; `check-absent-claim-is-answered`; the three § 7b cases seen live |
| 4v | Viewer: native sources through `clipSources`, `{ kind:'url' }` player — **opens only after § 7b is met** | OTA | plays a `format:'mp4'` clip; shows `playable:false` rows |
| 7 | HKSV tee (separate plan) | — | — |

## 10. The day index — implemented (0.7.8), and the three listing families

The operator's app captures (2026-09-20: `laundry.json`, `cameretta
person-c.json`, `hub events.json`) settled cmd 142. **One label was wrong:**
"laundry" is not a standalone capture — it is the Home Hub connection with
child channel 0 selected (cmd 145 pushes, cmd 114 answering the hub's own UID,
cmd 318 probing channels). So the app's own evidence covers a standalone (592)
AND a hub child (ch 0), and the library's live probe extended it to hub
channels 1 and 3, three channels in one request, and a uid/channel mismatch.

**What the library sends now** (`nodelink-js` `utils/dayRecords.ts`): a
calendar-month window plus one `<DayRecord>{ index, channelId, uid }` per
channel, as a body with no Extension. **What comes back**: `<dayType index>`
per day with footage, `index = day − 1`, absent = none (12 September missing on
3628, 1 September on 592, same month), `<dayTypeList />` for an empty month,
`type` an open vocabulary. On the hub the UID selects the camera — channel 1
asked with channel 0's UID answers channel 0's days — and the channel is
echoed; on a standalone the UID is ignored (the earlier 400 was the missing
body, not the UID). The provider therefore: asks `getDayRecordsForChannels`
ONCE per hub per month for every bound child, keys by channel, and never
trusts the echoed channel over the UID it sent. The per-day listing loop of
the earlier plan is deleted, not kept as a fallback.

**Three listing families, one rule** (D549 § Decision 10). The captures show
the app using three different commands for three different questions:

| family | what it lists | scope | carries | seen on |
| --- | --- | --- | --- | --- |
| `FileInfoList` 14/15/16 | FILES — the handle for bytes (cmd 5) and thumbnails (cmd 298) | one camera-local day, 40/page | `fileName`, `recordType` (a CSV of the file's event types), size, times | both; ours, verified |
| `findAlarmVideo` 272/273/274 | EVENT WINDOWS inside those files, one row per event, `alarmType` per row | one camera-local day, 30/page (standalone) or one page (hub); `streamType` 1 then 0 in every session | `fileName` (the join), `alarmType`, event `startTime/endTime` — all 387 windows of a day fell inside their file's window; a file has 1–10 of them; `union(alarmType) == file.recordType` on 164 of 167 files | standalone (107) and hub ch 0 in the app; no library method |
| `findEventLog` 516/517/518 | EVENTS across a hub's children, newest first, multi-day (Sep 20 → 1970, and Sep 10 → Sep 8), 60/page | `uid`, `logicChn`, `bHasRecFile`, `alarmType`, times — **no file name**; channel selection is a `<devices>{ uid, logicChnBitmap }` list, `chnbits` was 0 both times (its layout is NOT settled by the capture) | hub only (the app's Events screen, followed by 185 × cmd 298 by time) |

The two hub captures settle which family is the catalog: the child-playback
screen and the hub's Events screen send byte-identical `FileInfoList` opens
for the same child and differ only above it (playback: + cmd 142, 574; Events:
+ 516/517/518, 185 × cmd 298); the Events screen finds an event's file with a
`FileInfoList` search over the event's own 15 s window, so a sub-day window is
valid (the day is the maximum, not the grain) — the join `findEventLog` row →
file the provider will use for a hub-wide feed later. Recordings live per child under the hub's
`/mnt/sda/U10<uid>-<name>/` (ch 0, 1 and 3 confirmed; a child with no footage
not observed). A search names ONE stream: the app runs `subStream` and
`mainStream` back to back and the two sets are twins with different names,
start seconds 0–4 s apart (168/170 within 3 s on 592, 20 September; main ≈
33× the bytes) — the catalog row is the sub file, its main twin matched by
start time for full-resolution playback. The app's filter is 16 record types
plus a 19-item `<fileRecordType>` list; a narrower one returns fewer files
silently, and 0.7.8 sends the app's by default.

The rule: **the catalog primitive is `FileInfoList`** — a clip is a file, the
file name is the id, the bytes and the still come from it. `findAlarmVideo` is
the LABEL source: `ClipSchema.labels` is `union(alarmType)` of the event rows
joined by `fileName`, and the file's own `recordType` CSV is the fallback when
272/273/274 is not implemented yet (it agrees on 98 % of files and is already
in the listing). `findEventLog` is not a catalog primitive — it names events,
not files — and is reserved for a later hub-wide event feed; its `bHasRecFile`
is the honest "this event has no clip" for THAT feed, not a replacement for
the file catalog. `DayRecords` is the day index. Whether `findAlarmVideo`
lifts the one-day clamp is **settled and NEGATIVE** — measured 2026-09-20 on
hub child 3628 through 0.7.9's `searchAlarmVideos`: a two-day ask answered 39
windows all dated the START day, silently, and the library now clamps and
trace-logs it, so the DAY LOOP belongs to the caller; whether `streamType` 1/0
selects sub/main file sets is **still unsettled** (same 167 file names either
way, 90 differing rows — the day was in progress between the two calls), and
**re-measured the same day it stayed that way**: `0` → 39 windows, `1` → 37,
the SAME 28 file names either way (`0120260909093129`). It is NOT the file-set
selector it has been reported to be, at least not on this firmware. Those
names are also the short `<name>` form, not the `<Id>` path a byte handle
uses — the label-upgrade slice joins on `<name>`.

**Recommendation on scope (library):** `getDayRecords` is in 0.7.8. The
`findAlarmVideo` method (open/page/close, parser reusing the `alarmVideo`
blocks `parseRecordingFilesFromXml` already reads) and the `findEventLog`
method are the next library slice, not 0.7.8 — their fixtures are already in
`test/fixtures/recordings/` so the implementation is a parser and two
builders against captured wire, no new capture needed. The provider's slice 2
ships with `recordType`-derived labels and upgrades to `findAlarmVideo` labels
when that slice lands.

**Other findings from the captures, outside the clip surface:** the app's
hub CoverPreview carries `<desc>0</desc>` (the library comment claimed it is
never present; ours works without it — comment corrected); the app's
FileInfoList open also sends `<fileRecordType><i>…</i></fileRecordType>` and
a longer `recordType` list (ours works without them); cmd 123 is
`<ReplaySeek>{ channelId, seq, seekTime }` — the missing replay seek, now
named; cmd 318 per-channel `<VersionInfo>` was already used by
`getChannelInfo` as a literal, now named; cmd 33 `AlarmEventList` is a push
the client already handles, not a request; cmd 76 (network block) and cmd 192
(empty both ways) named, the latter as opaque.

## 11. Verification debts carried into the slices

- Thumbnail throughput above two concurrent requests, per host, measured before
  slice 3's bounds are final.
- A hub child with a busy day (≥ 40 clips) to see the hub paginate.
- A standalone battery camera's catalog, read only when it is awake for its own
  reasons (the "Wake and refresh" path in slice 4).
- The aggregator's derived section for a wrapped binding (slice 4, first).

## 12. The HKSV tee — LANDED, 2026-09-20 (supersedes § 8's "deferred")

§ 8 deferred all of HomeKit behind slice 6. Half of it could not wait, and the
reason is physical rather than a matter of priority: **HKSV is a sink, and a
stream nobody teed is gone.** HDS `dataSend` is push-only, so a clip iOS stored
is never readable again by the accessory; the only copy CamStack can ever have
is the one it kept of what it SENT, at the moment it sent it. A Reolink SD card
will still be there next week — a HomeKit recording that went untee'd today will
not. Record: [D550](../decisions/adr-0550-a-homekit-clip-is-ours-only-if-we-teed-what-we-sent-and-the-tee-may-never-touch-the-recording.md).

**What landed** (all inside `packages/addon-export-hap`, nothing framework-side):

| file | what it owns |
| --- | --- |
| `hksv/clip-writer.ts` | the tee: one extra `Fmp4FragmentPlane` subscription → `init + fragments` → a file. Never throws, never awaited by the delegate, `CLIP_TEE_QUEUE_CAPACITY = 2`. |
| `hksv/clip-store.ts` | `<location root>/homekit-clips/<deviceId>/<stem>.{mp4,jpg,json}`, the bounds, the in-flight guard, the orphan sweep, the atomic sidecar, and the VOUCH. |
| `hksv/clip-location.ts` | WHERE: the declared `homekitClips` storage location, resolved through the storage cap, mode-gated by `mayWriteToLocation`, doorbell-invalidated. |
| `hksv/clip-thumbnail.ts` | one bounded ffmpeg, seeking to the trigger instant; each refusal named. |
| `hksv/clip-record.ts` | `HksvClipRecordSchema` — the sidecar a later provider lists from. |
| `hksv/clip-tee.ts` | the seam; `createClipTeeFactory` is what `build-recording.ts` passes to the delegate. |

**What the later slices still need, and what they will find.** The provider
(`source: 'hksv'`), the per-device wrapper mount, the collection fan-out and the
cross-runner hand-off are untouched — `export-hap` is hub-only in its own runner
and D549 decision 3's gate stands. When they land:

- `HksvClipStore.listRecords(deviceId)` returns `HksvClipRecord[]`, newest
  first: self-contained ids (`hksv:<deviceId>:<startedAtMs>-<streamId>`),
  `startedAtMs`/`endedAtMs`/`durationMs`, `bytes`, `fragments`,
  `prebufferSpanMs`, `truncated?`, `acknowledgedByHomeKit`, `width`/`height`,
  `schemaVersion`.
- `thumbnailFile` is present only when the JPEG is on disk; otherwise
  `thumbnailUnavailable.reason` — map it straight onto `ClipSchema`'s field of
  the same name (§ 3), no translation needed.
- Playback must be a Range route over the file (D9/D18: bytes by handle, never
  inline through a cap call), exactly like the Reolink route of § 6. The fMP4 is
  `ftyp+moov` followed by `moof/mdat` and plays as-is.
- The hand-off is the only genuinely new work: the store lives in the exporter's
  runner, so listing and serving must reach it from wherever the `videoclips`
  provider is mounted.
- **Where the bytes are** (amended 2026-09-20, operator's ask): NOT
  `<dataDir>`. They sit on the DECLARED `homekitClips` storage location —
  `single`, `local-path`, `defaultsTo: 'recordings'` — under its
  `homekit-clips/` subtree, and the operator repoints it to choose the disk.
  A provider must therefore resolve the root through the store (or the cap),
  never compose a path, and must handle "no writable location" as a listed
  source with a reason rather than an empty catalog.
- **Retention is per camera** (`clipRetentionDays`, global default 14 days,
  per-device override) with fixed rails at 256 MB/clip, 200 clips + 512 MB per
  camera and 4 GB overall; and **keeping clips at all is a per-camera switch**
  (`keepClips`, absent means ON). A camera with the switch off has no clips by
  choice — the source must say so, not report nothing.

**Coverage and duration, stated rather than discovered.** Only a camera with an
enabled H.264 slot, preferably ≤ 1080p, with a GOP ≤ 8 s records at all — the
three refusals `buildHksvRecording` already logs; a camera with no clips here is
a camera HKSV never recorded. A clip's duration is the prebuffer replay plus
however long the hub kept the HDS stream open — never a window CamStack chose.
The advertisement log line carries `clipsKept` (the conjunction) and
`clipsSwitchedOn` (the operator's half), so "he turned it off" and "there is no
writable clips location" are different lines.
