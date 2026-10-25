# Amcrest onboard clips — one camera, no card, and what the firmware would give

> Status: MEASURED against the live fleet on 2026-09-22, read-only. This is an
> investigation and nothing has been built. It is the Amcrest counterpart of
> [the Hikvision note](./2026-09-22-hikvision-clips-feasibility.md), written to
> the same standard: every number below came off the wire, and anything that
> could only be read from a specification is marked as such.
>
> The contract compared against is
> [`videoclips.cap.ts`](../../packages/types/src/capabilities/videoclips.cap.ts);
> the shape that fills it is D597 / D599 / D600 / D604, and D605 is the most
> recent provider to do it.

## The answer first: there is no card, so clips are moot

**The fleet is ONE Amcrest camera, and the camera itself says it has no storage
device.** Nothing recorded, nothing to search, nothing to play back. Everything
below the inventory is about what the firmware WOULD give if a microSD card
were put in — useful for deciding whether to buy one, and not a plan to build
anything today.

## The fleet: 1 device, 1 camera

`provider-amcrest` owns exactly **one** device out of the 1012 on the hub
(`deviceManager.listAll`). For scale, the other camera providers: hikvision 32,
reolink 26, wyze 1. There is no second Dahua-family camera hiding under
`provider-onvif` or `provider-rtsp` — both own zero devices.

| Device | Name | Model | Power | Card | Recording |
| --- | --- | --- | --- | --- | --- |
| 3836 | Camera studio | IP4M-1041B | mains (PoE/DC turret, wired at <hub-ip>) | **none** | enabled, motion+alarm+smart, 24/7 |

- **Model / firmware**, from `magicBox.cgi?action=getSystemInfo` and RPC2
  `magicBox.getSoftwareVersion`: `IP4M-1041B`, internal `IPC-AW46WN-S2`,
  version `2.800.1ENN001.0.R`, build `2024-10-29`, web `V3.2.1.18144`,
  SoC `SSC327DE`.
- **Mains** is asserted from the device class and the fact that it answers CGI,
  RPC2 and RTSP continuously with no wake step. It is not on the battery list
  (4263, 640, 3628, 3629) and was never treated as one.

### "Does it have a card" — the addon cannot answer this today

`packages/addon-provider-amcrest` declares six capabilities —
`device-provider`, `stream-params`, `motion-zones`, `privacy-mask`,
`day-night`, `image-settings` — and its 4236 lines contain no storage,
recording or media-search code at all. `grep -i storage|record|mediaFileFind`
over `src/**` hits only `Record<K,V>` type annotations. **The addon has no
notion that the camera has an SD slot.** That is a finding, not an aside: the
one Amcrest camera on the fleet is motion-recording into nothing and the
system has no way to say so.

**The calls that WOULD answer it** — all read-only, all measured working on
this firmware:

| Question | Call | Answer here |
| --- | --- | --- |
| Is there a card? | RPC2 `storage.getDeviceNames` | `{"params":{"list":null},"result":true}` |
| Card detail (capacity/free) | RPC2 `storage.getDeviceAllInfo` | `result:false`, `info:null`, error `268959743` |
| Does the model have a slot at all? | RPC2 `storage.getCaps` | `IsLocalStore:true`, `SupportSDDetailInfo:true`, `AutoFormatUnknownSD:true` |
| Is recording on, and on what trigger? | `configManager.cgi?action=getConfig&name=Record` + `name=RecordMode` | see below |
| Where does footage go? | `configManager.cgi?action=getConfig&name=RecordStoragePoint` | every kind `Local=true`, `FTP/Remote/Redundant=false` |
| Is there a NAS/FTP fallback? | `...&name=NAS` | all four rows `Enable=false` |

**`storage.getDeviceNames` is the one to use, and the distinction between it
and `getDeviceAllInfo` is exactly D393/D315.** `getDeviceNames` answers
`result: true` with `list: null` — that is the camera *positively stating* the
set of storage devices is empty. `getDeviceAllInfo` answers `result: false`
with an error — that is a FAILURE, and a reader that folded it into "no card"
would be calling an unreadable answer a measurement of zero. The two must not
be conflated, and a `list: null` must be read as `[]` **only** because
`result` was `true`.

The CGI side is worse and should not be used for this: `storageDevice.cgi`
answers `501 Not Implemented` for `getCaps`, `getDeviceNames` and
`getDeviceStatus`, `400 Bad Request` for `getDeviceAllInfo`, and
`200 with a zero-byte body` for `factory.getCollect`. An empty body is the
absent-vs-unknown confusion in its purest form. `devStorage.cgi` and
`Storage.cgi` are 501 — they do not exist on this firmware.

### The camera is recording, 24/7, on events, to nowhere

`configManager.cgi?action=getConfig&name=Record`:

```
table.Record[0].Enable=true
table.Record[0].Format=mp4
table.Record[0].PreRecord=5
table.Record[0].Stream=0
table.Record[0].TimeSection[0..6][0]=393222 00:00:00-23:59:59
```

`RecordMode[0].Mode=0` (auto/schedule-driven). The schedule mask `393222`
(`0x60006`) has **bit 0 clear** — no continuous recording — and bits 1, 2, 17
and 18 set: motion, alarm and two intelligent/IVS record types, every day,
00:00:00–23:59:59.

> **Caveat.** The bit→trigger mapping is the Dahua convention, read from the
> vendor's own documentation, not measured. What IS measured is that bit 0 is
> clear and four other bits are set — so whatever the exact names, this camera
> records on EVENTS and not continuously.

`MediaGlobal.PacketLength=5`, `PacketType=0` → files are cut every **5
minutes** by time (or at `PacketSize=1024` MB). `recordManager.cgi?action=getCaps`
→ `Format[0]=mp4`, `MaxPreRecordTime=5`, `PacketLengthRange=[1,20]` minutes.

**This is the operator-facing defect, and it is the same one the Hikvision note
found on 1441 and 3831:** a camera configured to record 24/7 into storage that
is not there. `ClipSourceAvailabilitySchema` already carries `'no-storage'` for
exactly this, and the three reads that establish it work on 100 % of this
(admittedly one-camera) fleet.

### What a clip WOULD cost, from the encoder config

`configManager.cgi?action=getConfig&name=Encode`. `Record[0].Stream=0` means
the MAIN format is what gets written, and `MainFormat[1]` (the motion-record
format) is identical to `MainFormat[0]`:

| | Main (recorded) | Extra/sub (not recorded) |
| --- | --- | --- |
| Resolution | 2560x1440 | 640x480 |
| Codec | H.264 | H.264 |
| Bitrate | VBR, 8192 kbps ceiling | VBR, 512 kbps |
| FPS | 30 | 30 |
| GOP | 120 (= **4 s** between keyframes) | 120 |
| Audio | AAC, 8 kHz, 64 kbps, **enabled** | AAC, 8 kHz, enabled |

Two numbers matter to the contract:

1. **A 5-minute file at the 8192 kbps ceiling is ~300 MB.**
   `VIDEOCLIPS_MAX_READ_BYTES` is 50 MiB — **6x under** a worst-case file, and
   50 MiB is only ~52 s of footage at that ceiling. Hikvision's worst 24 h
   segment was 81 % of the ceiling; Amcrest's file boundary is a clock, not the
   event, so it can exceed it by design. A whole-file `loadfile.cgi` retrieval
   is **not** a viable `readClipBytes` here.
   *(Caveat: 8192 is the VBR ceiling, not the achieved rate. The achieved rate
   is unmeasurable without footage.)*
2. **GOP 120 at 30 fps = a 4-second keyframe interval.** Hikvision's seek
   snapped back 0.7–2.7 s; the equivalent snap here would be up to 4 s, on top
   of `PreRecord=5`. Both are reportable-not-hideable under the D605 rule that
   a seek says where it LANDED.

## The protocol: what this firmware implements, and what it does not

The firmware gives a clean discriminator: an **unknown action is `501 Not
Implemented`**, a known action that refuses is **`400 Bad Request`**. Verified
with a control (`/cgi-bin/mediaFileFind.cgi?action=totallyBogus` → 501,
`/cgi-bin/zzzNoSuch.cgi?action=getCaps` → 501). Everything below leans on that.

### Search — implemented, and it refuses because there is no storage

The `mediaFileFind` object lifecycle exists over **both** CGI and RPC2:

```
GET /cgi-bin/mediaFileFind.cgi?action=factory.create      -> 200  result=3024091136
GET ...action=findFile&object=…&condition.Channel=1&condition.StartTime=…  -> 400 Bad Request!
GET ...action=findNextFile&object=…&count=100             -> 200  found=0
GET ...action=close&object=…                              -> 200  OK
```

The same over RPC2 (the API the camera's own web UI uses), which gives a typed
error instead of a bare 400:

```
mediaFileFind.factory.create  -> {"result":3034328000}
mediaFileFind.findFile        -> {"error":{"code":285409284,"message":""},"result":false}
mediaFileFind.findNextFile    -> {"params":{"found":0,"infos":null},"result":true}
mediaFileFind.close           -> {"result":true}
mediaFileFind.destroy         -> {"result":true}
```

Five things came out of this that a provider would have to encode:

1. **`findNextFile` answers `result: true, found: 0` after a `findFile` that
   FAILED.** This is the Hikvision `responseStatus=true`-on-`NO MATCHES` trap
   with a different mechanism and a worse payload: a reader that checks only
   the enumeration call gets a clean, authoritative-looking "this camera has no
   clips" from a search that never ran. **`findFile`'s own result is the only
   gate.** (D315: absent must never look like not-installed.)
2. **`findFile`'s failure is uninformative on both transports.** CGI gives
   `400 Bad Request!` — byte-identical for a good request, a request with no
   condition at all, and a request against a bogus object id. RPC2 gives error
   code `285409284` (`0x11000004`) with an **empty `message`**. So the 400
   alone does not prove "no storage"; the proof is `storage.getDeviceNames`,
   and the two must be read together.
3. **`getCount` is `501 Not Implemented`.** On a Dahua NVR this is how you
   learn the size of the result set. Here you cannot: paging is blind, and the
   terminator has to be `found < count`. That is precisely the Hikvision
   "`numOfMatches` is the page, not the total" hazard, one notch worse —
   there is no total to ask for.
4. **The documented `factory.destroy` is `501`; the verb that works is
   `action=destroy`.** Over RPC2 it is `mediaFileFind.destroy`. A provider that
   followed the Dahua SDK naming would leak a find object per search, on a
   camera with a small fixed pool of them.
5. **Times are the camera's LOCAL clock, not UTC.** `global.cgi?action=getCurrentTime`
   → `2026-09-22 23:24:28`, matching CEST wall clock to the second, while UTC
   was 21:24:28. Hikvision's search speaks `…Z`. A window built in UTC would be
   two hours off here, in summer, and one in winter.

### Retrieval — `loadfile.cgi` exists, `playBack.cgi` does not

| Endpoint | Result | Reading |
| --- | --- | --- |
| `/cgi-bin/loadfile.cgi?action=startLoad&…` | **400** | implemented, refuses (no file) |
| `/cgi-bin/loadfile.cgi?action=zzz` | 501 | control — the 400 above is meaningful |
| `/cgi-bin/playBack.cgi?action=getCaps` | **501** | **not implemented on this firmware at all** |
| `/cgi-bin/playBack.cgi?action=zzz` | 501 | control |
| `/cgi-bin/RPC_Loadfile/<path>` | **socket closed, zero bytes** | see hazard below |
| `/cgi-bin/snapManager.cgi?action=getCaps` | 200 `SupportSnapSchedule=true` | implemented |
| `/cgi-bin/eventManager.cgi?action=getCaps` | 200, incl. `RecordEnable=true` | implemented |

So the retrieval surface is **`loadfile.cgi` (whole file) plus RTSP replay**,
with no CGI playback-control layer. Whether `loadfile.cgi` honours a `Range`
header — the thing that would make the 300 MB file problem tractable — **could
not be measured**: it needs a real file path to ask about.

**Hazard: `/cgi-bin/RPC_Loadfile/<anything>` closes the TCP connection with
zero bytes read** (`UND_ERR_SOCKET: other side closed`, 571 bytes written, 0
read). It does not answer 404 or 400. Any client that probes this path must
survive a bare socket close, not just an HTTP error. This is the Amcrest
equivalent of Hikvision's "a `SETUP` on the aggregate control answers 415 and
the camera closes the socket".

### RTSP — the replay route could not be confirmed to exist

`OPTIONS rtsp://…/` (digest) →

```
Server: Rtsp Server/3.0
Public: OPTIONS, DESCRIBE, ANNOUNCE, SETUP, PLAY, RECORD, PAUSE, TEARDOWN, SET_PARAMETER, GET_PARAMETER
```

`PAUSE` and `SET_PARAMETER` are advertised, which are the verbs a scrub needs.
**That is an advertisement, not a measurement** — this repo has twice been
lied to by a declared field, and the Hikvision note's own `codecType` is one of
them.

`DESCRIBE` on the live stream works and tells us what the archive would hold:

```
--- /cam/realmonitor?channel=1&subtype=0   -> 200 OK
  m=video 0 RTP/AVP 96
  a=framerate:30.000000
  a=rtpmap:96 H264/90000
  a=fmtp:96 packetization-mode=1;profile-level-id=4D4032;sprop-parameter-sets=Z01AMqaAKAC1kAA=,aO48gAA=
  m=audio 0 RTP/AVP 97
  a=rtpmap:97 MPEG4-GENERIC/8000
  a=fmtp:97 streamtype=5;profile-level-id=1;mode=AAC-hbr;…;config=1588
```

`subtype=1` (sub) describes 640x480 (`profile-level-id=4D401E`) — a genuinely
different SPS, not Hikvision's track-102 impostor. **But note that only says
the LIVE sub-stream is real. Nothing here speaks to archive twins**, and the
twin trap is the one to be most careful about if a card is ever fitted.

`DESCRIBE` on the replay route:

```
--- /cam/playback?channel=1&starttime=2026_09_21_10_00_00&endtime=2026_09_21_10_01_00  -> 404 Not Found
--- /cam/playback                                                                      -> 404 Not Found
--- /totally/bogus/path                                                                -> 404 Not Found   (control)
```

**The control is the point: a path the camera certainly does not have answers
404 too.** So the 404 on `/cam/playback` proves *nothing* — not that replay is
implemented and empty, not that it is absent. This is the D315 shape again, and
it is why the storage question had to be settled by RPC2 rather than inferred
from a media probe. If a card is fitted, this is the first thing to re-measure.

**Seeking, position feedback, `Scale`, `Rate-Control`, time-to-first-frame,
whether the archive carries audio, whether a session can cross a file boundary,
whether there is one playback slot — NONE of these are measurable without
footage.** The Hikvision note's most valuable half is exactly this material,
and it does not exist for Amcrest. Saying so is the honest answer; anything
else would be a spec citation dressed as a measurement.

### Auth and quirks

- **HTTP is digest**, `qop=auth`, and it works first try on every CGI endpoint.
  The realm is `Login to <32 hex>`.
- **RPC2 is a separate, two-step challenge login** over `POST /RPC2_Login`
  (`global.login` with an empty password → `{realm, random}` →
  `MD5(user:random:MD5(user:realm:pass))`, uppercase hex, both hops). It
  returns a session token used on `POST /RPC2`. **This is the only place some
  answers exist** — `storage.getDeviceNames` and `storage.getCaps` have no
  working CGI equivalent on this firmware. A provider that wants to answer "is
  there a card" needs an RPC2 client, which the addon does not have.
  Always `global.logout`.
- **RTSP digest: a stale nonce answers `400 Bad Request`, not `401`**, and
  carries a fresh `WWW-Authenticate` with it. A client that retries only on
  401 will treat a recoverable auth failure as a permanent protocol error —
  which is exactly what happened on the first pass of this investigation, and
  it cost a wrong conclusion about the replay route until a fresh socket was
  used per request.
- **RTSP session reuse across URIs does not survive a non-200.** After the
  stale-nonce 400 the connection stopped answering entirely. Measured
  behaviour: every probe here opens its own socket.

## Against the contract we built

**Fits, if a card were fitted:**

- `ClipSourceAvailabilitySchema`'s `'no-storage'` — and this camera is the
  purest instance of it on the fleet. That state is answerable *today*, with
  one RPC2 call, with no clip machinery at all.
- The D599 `served` / `downgraded` honesty mechanism. It would always read
  `high`, because `Record[0].Stream=0` means one copy exists.
- `ClipStreamAudioSchema`'s premise holds exactly: the archive would be **AAC
  8 kHz**, which no WebRTC session speaks, so D600's transcode path applies
  verbatim. (Hikvision's G.711u copy shortcut does NOT transfer.)
- The `mediaFileFind` object lifecycle maps cleanly onto a day-catalog search,
  the same shape as `ContentMgmt/search`.

**Does not fit:**

- **`readClipBytes`' 50 MiB bound.** A file is a 5-minute clock packet, up to
  ~300 MB. On Hikvision the ceiling was 81 % consumed by a worst case; here the
  worst case is 6x over it, and there is no known ranged read (`loadfile.cgi`
  Range unmeasured, `playBack.cgi` absent).
- **No twins, and not in Hikvision's ambiguous way — structurally.**
  `Record[0].Stream=0` records one stream. There is one copy, and a `low` ask
  can only ever be served as `high`. That is the D382 invisible-upgrade shape
  again: a caller that asks for the cheap twin pays 16x (2560x1440 vs 640x480)
  and D599's rule — the honesty line fires only on a DOWNGRADE — keeps that
  cost invisible. Amcrest is a second, independent witness for the same
  contract gap the Hikvision note raised.
- **A clip's granularity is a CLOCK, not an event.** Hikvision's segments abut
  where motion is continuous, so a segment ≈ an event. Amcrest cuts every 5
  minutes regardless. A `Clip` row derived from a file would be a 5-minute
  block that the operator did not ask about, and the event boundaries would
  have to come from the per-file event flags in the search result — which
  could not be inspected here.
- **`transport: z.literal('forward-only')`** — same objection as the Hikvision
  note. `PAUSE` is advertised; whether it repositions is unmeasured. The
  literal leaves no room to say either way.

**What it would change in the shared contract:** nothing new. Amcrest
corroborates two of the three widenings the Hikvision note already asked for
(`transport` as an enum, and an UPGRADE having no expression in
`served`/`downgraded`) and adds no fourth. It does add weight to a **fifth**
thing that is not in the contract at all: **`ClipSourceAvailability` is the
only place the system could ever say "this camera is recording into a slot with
no card in it", and today nothing computes it for Amcrest.**

## Recommendation

**Do not build Amcrest clips. There is nothing to build against.** One camera,
no card, and the two most valuable halves of the Hikvision investigation —
retrieval economics and seeking — are unmeasurable until one exists.

What IS worth doing, in order, and each independently useful:

1. **Answer the storage question.** An RPC2 client in
   `addon-provider-amcrest` plus `storage.getDeviceNames` / `storage.getCaps` /
   `configManager Record` turns "no clips" into "no card, and you are recording
   24/7 into it". That is ~150 lines, it needs no clip machinery, and it fixes
   a live operator-facing defect on the one Amcrest camera there is. Read
   `getDeviceNames` (`result:true`, `list:null` ⇒ none) and never fold
   `getDeviceAllInfo`'s failure into zero.
2. **If the operator fits a card, re-measure before writing any provider.** The
   decisive unknowns, in the order that would kill the idea:
   - Does `/cam/playback` actually serve? (404 proved nothing.)
   - Does `loadfile.cgi` honour `Range`? If not, `readClipBytes` cannot exist
     and every export goes through RTSP replay, as it did on Hikvision.
   - How big is a real file, and does the 5-minute packet hold at an achieved
     VBR rate? `PacketLength` can be lowered to 1 minute, which would bring a
     file inside 50 MiB at the ceiling — that is a config change and therefore
     out of scope for this read-only pass, but it is the cheapest fix if the
     numbers land badly.
   - Is there one playback slot, and does an abandoned session wedge it?
   - Does the archive carry the AAC track?
3. **Only then** decide whether one camera justifies a provider. On the current
   fleet it plainly does not: the same effort spent on Hikvision covers 3
   cameras with cards and 19 with the availability read.

**The riskiest unknown** is not any single protocol answer — it is that this is
a **one-camera provider**. Every measurement in this note has a sample size of
one, on one firmware, on one model. The Hikvision work could at least say "1439
and 3833 are the same I91DN so the same behaviour is expected, not observed".
Here there is no second camera to say that about, and a provider built on
`2.800.1ENN001.0.R` would have no evidence it generalises to anything.

## Scope

Measured on **3836 only**, 2026-09-22, read-only: CGI `GET`s, RPC2 reads
(`global.login` → read → `global.logout`), RTSP `OPTIONS` and `DESCRIBE`. No
`SETUP`, no `PLAY` — there was nothing to play. No configuration was written.
Every `mediaFileFind` object created was closed and destroyed.
