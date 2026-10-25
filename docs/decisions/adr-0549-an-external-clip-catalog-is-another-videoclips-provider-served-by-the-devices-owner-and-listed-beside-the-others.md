---
id: D549
title: An external clip catalog is another `videoclips` provider, served by the device's owner, listed BESIDE the others — never a second capability and never a swap
status: accepted
date: 2026-09-20
supersedes:
applies-to:
  - packages/types/src/capabilities/videoclips.cap.ts
  - packages/addon-pipeline/src/recorder/addon/videoclips-provider.ts
  - packages/addon-provider-reolink/src/reolink-camera.ts
  - packages/addon-provider-reolink/src/raw-read.ts
  - packages/addon-export-hap/src/hksv/recording-delegate.ts
---

## Context

The operator asked for the clips CamStack did NOT record — the ones a Reolink
camera keeps on its SD card, the ones a Reolink Home Hub keeps for its
children, and later the ones HomeKit Secure Video is sent — to appear in a
camera's device details, with thumbnails, behind a provider picker. Reolink
first. The plan is `docs/design/2026-09-20-external-videoclips.md`; this
record holds the rules it rests on.

**What was measured, 2026-09-20, read-only, on the live cluster** (no battery
camera logged into; every call `nativeOnly`):

- A standalone Reolink (592, E1 Outdoor PoE v3.1.0.5223) lists 546 clips of one
  day in 2.0 s over Baichuan cmd 14/15/16, yields a 640×360 I-frame in 254 ms
  (cmd 298) and its bytes over cmd 5. Its UID comes from cmd 114 in 7 ms. A
  zero-length window is refused with 400.
- A Home Hub (639, v3.3.0.456) lists, thumbnails and downloads clips of its
  children (ch 0, 1, 3) from its own storage while every child stays asleep —
  `battery.getStatus` read `sleeping:true` with an unmoved `lastContactAt`
  before, between and after, and the hub log carried no line for those ids.
  The child UID is needed per request; CamStack already persists it in
  `deviceMeta.metadata.uid`, and the hub's cmd 145 push arrives ~12 s after
  `subscribeEvents()`, not on login.
- Nothing marks the end of a cmd 5 download: no 201, no trailing frame; a
  101 s / 1.8 MB clip fully arrived in 1.7 s with a 59 ms largest gap and the
  library then waited a fixed 15 s. Every recording timestamp on the wire is
  the camera's wall clock with no offset. Both are library defects, fixed in
  nodelink-js 0.7.8 with fixtures taken from these captures — the surface had
  none.
- `getDayRecords` (cmd 142, "which days have footage") answered 400 because
  the library sent no body. The operator's app captures gave the body — a
  calendar month plus `{ channelId, uid }` per channel — on a standalone AND
  on a hub child (the "laundry" capture is the hub connection, child ch 0);
  the library then verified it live on hub channels 0/1/3 and three channels
  in one request. On the hub the UID selects the camera.
- The same captures show the app using THREE listing families:
  `FileInfoList` (files), `findAlarmVideo` 272/273/274 (event windows inside
  files, with `alarmType`, joined by `fileName`), and on the hub only
  `findEventLog` 516/517/518 (events across children, multi-day, newest
  first, `bHasRecFile`, no file name). Three families and no stated rule is
  the two-authorities defect arriving on the wire.
- HKSV has no read-back: HDS `dataSend` is push-only, and the accessory never
  sees a stored clip again. `Fmp4FragmentPlane` was built dual-use for exactly
  a clip tee and has no second subscriber.

**What the repo already says, and what had gone stale:**

- `videoclips` is a `scope:'device'` + `kind:'wrapper'` cap whose class doc
  already names a native provider substituting "for its device", whose
  `ClipSchema.source` is `'analytics' | 'native:<vendor>' | …`, and whose
  viewer model (`camstack/src/clips/clip-model.ts`) keeps `ClipSourceId` open
  with `native:` and `hksv` reserved. Its mount, however, still resolves the
  GLOBAL singleton: `setWrapperActive` persists and is never read (D62 shape).
  `docs/architecture/capabilities.md` § "Wrapper mounts must resolve per
  device" ends with *"Do not add a second provider first."*
- `docs/design/2026-08-17-videoclips-implementation.md` § 3.2 and § 7.4 and
  `packages/addon-pipeline/src/recorder/addon/directory-handler.ts` still
  claimed that a capability may not gain a method (the `AppRouter` expansion
  cliff). That has been false since 2026-07-30 (`scripts/generate-api-types.ts`
  derives cap procedures from Zod). The three leftovers read as verification
  and would have shaped the cap; they are corrected in place with this record.

**The staging that was rejected.** The plan first offered a per-camera SWAP —
bind Reolink's provider to a camera and the analytics visits step aside on
that camera — as a cheaper first ship. The operator rejected it because it
loses a source (*"voglio poter decidere quali clips vedere senza perdere
niente"* [I want to be able to decide which clips to see without losing anything]), not because it was harder. A picker that hides one producer behind
another is the two-authorities defect this repo keeps paying for (D62, D113,
D544), arriving through the UI.

## Decision

1. **One capability.** External clip catalogs are additional providers of
   `videoclips`, `source: 'native:reolink'` (later `'hksv'`), never a sibling
   cap. Schema changes are additive on `ClipSchema` (`thumbnailMint`,
   `thumbnailUnavailable`) plus an optional `sources` filter on `listClips`.
2. **Collection, not swap.** The cap moves to `mode: 'collection'` over the
   device's bound providers: `listClips` fans out and merges by
   `(startMs, endMs, id)`; `getClipPlayback` dispatches by the id's provider
   prefix. The section's picker is a SOURCE FILTER — every source a camera has
   is listed, and unselecting one hides it in the view only. Stage A (per-camera
   swap) is not shipped, not even as an interim.
3. **The mount fix is a hard gate.** Nothing downstream — the Reolink provider,
   the thumbnail route, the section, playback, HKSV — lands before the
   per-device wrapper mount of `docs/design/2026-08-17-videoclips-implementation.md`
   § 2 (M1–M6) and the collection dispatch. Slice order: 0 → 1 (mount) →
   6 (collection) → 2 → 3 → 5 (playback) → 4 (admin section, the proving
   ground) → 4v (viewer, only once proven) → 7.
4. **The device's owner serves the catalog** (D224). The Reolink provider
   lives in `addon-provider-reolink`; a hub child is served through the
   parent's mains-powered socket with the child's persisted UID
   (`servedByParentHub`, as `raw-read.ts` already does for battery); a
   standalone battery camera is NEVER logged into by a read — it lists its
   cached catalog with `thumbnailUnavailable.reason: 'sleeping'` and an age,
   and only the explicit "Wake and refresh" gesture (refused below 15 %
   charge) reaches it. The clip path is Baichuan-only; the hub's existing CGI
   channel/battery summary is left exactly as it is.
5. **A thumbnail is vouched or absent-with-reason.** `thumbnail` is emitted
   only for a JPEG already on disk; `thumbnailMint` names a route that MAY
   produce one (used for on-screen rows only, 204 with a named reason on
   overflow or sleep); `thumbnailUnavailable` says why no mint will succeed
   now. Sub stream. Stored in the addon's data dir under a per-device LRU
   (2 000 files / 64 MB) — a derived artifact, outside the `eventMedia` class
   and outside the post-analysis retention sweep.
6. **Clip bytes travel by handle.** `getClipPlayback` fetches over cmd 5 into a
   bounded per-device scratch (10 clips / 200 MB, LRU), muxes video AND audio
   into MP4 once with one bounded ffmpeg, and serves it with Range over the
   addon's own data-plane route. Never through the broker (no live session for
   stored media), never RTMP (credentials in the URL, port-enable side effect).
7. **The camera's wall clock is explicit.** The provider passes the camera's
   zone to the library (`recordingsTimeZone`) and asserts at boot that it
   matches the camera's own clock, logging a warn per device when it does not;
   the container's `Europe/Berlin` is not relied on.
8. **The day index is `getDayRecords`** (nodelink-js 0.7.8), asked once per
   hub per month for every bound child (`getDayRecordsForChannels`) and once
   per standalone camera; listing runs only on days the index names. Verified
   on both topologies; the per-day listing loop is not kept as a fallback.
10. **One catalog primitive.** A clip IS a file: `FileInfoList` 14/15/16 is
   the catalog, `fileName` is the id, bytes (cmd 5) and stills (cmd 298) are
   addressed from it. `findAlarmVideo` is the LABEL source, joined by
   `fileName` (the file's `recordType` CSV is the interim label until the
   library method lands — it agreed with the event union on 164 of 167 files).
   `findEventLog` is never used to build the catalog: it names events, not
   files, and is reserved for a hub-wide event feed where its `bHasRecFile` is
   the honest "no clip" for that feed. `FileInfoList` was not the wrong first
   choice; it was the right primitive without its label and day-index
   companions.
11. **SUPERSEDED 2026-09-20 by the operator's own later decision — see
   [D555](adr-0555-a-source-whose-library-method-does-not-exist-is-a-listed-source-that-says-so.md).**
   This decision rested on a premise it states explicitly: that `onboard` and
   `hub` might hold DIFFERENT sets, with the measurement informing "the
   default filter and the labels, never whether there are two sources".
   Implementing it disproved the premise — the hub's uid addresses no catalog
   at all, the child's addresses all of it, cmd 5 serves identical bytes under
   either, and on 3628 the views cover each other (29 events, 28 inside the 20
   listed files, all 20 files carrying an event). Two VIEWS of one store.
   Shown that, the operator collapsed them to ONE source that picks the best
   API for what the camera is. **The decision below is kept, not deleted**: it
   was the right shape while the sets were unknown, and the alternative it
   rejected — an automatic best-source pick with a merge — is still rejected,
   because what replaced it is not a merge of two sources but a single source
   with one honest reader. What follows is the reasoning as it stood.

   **A Reolink camera behind a hub exposes TWO sources, `onboard` and
   `hub`, side by side; a standalone camera exposes `onboard` only.**
   Operator's decision, 2026-09-20: *"Mi va bene averli divisi, non c'è
   bisogno di complicare. Due entry della collection, onboard e hub."* [I am fine with having them split, no need to complicate. Two entries of the collection, onboard and hub.] The
   alternative — one source per camera with an automatic best-source pick and
   a merge by start time / `fileName` — was put to him explicitly, with the
   objection that two rows for one question is the D62/D113/D544 defect if
   the sets are identical, and rejected in favour of two plainly separate
   entries. Consequences stated now, not discovered later: a clip present in
   both storages appears **twice**, once per source, and every row carries
   `source` (`native:reolink:onboard` | `native:reolink:hub`) so a duplicate
   reads as "the same clip, in two places", never as two clips; the picker is
   the filter, each source filterable on its own, no dedup. Each source
   reports its own availability with a reason (`listSources({deviceId})`,
   additive cap method): `onboard` on a sleeping camera is `sleeping` with
   `catalogAsOf`, never an empty list. `onboard` on a hub child is a DIRECT
   read and stays opportunistic (cache + awake transition + "Wake and
   refresh", never a timer); `hub` refreshes freely on the interval.
   **What each holds — measured as far as the fleet allowed**, with the
   operator's authorisation, on 3628 (Argus 3E, ch 0, 100 %, `charging: dc`,
   192.168.x.x) at 09:38–09:40: three BCUDP local-direct discovery rounds
   of 15 s (51 KB sent each, 0 replies), login failed at 51.0 s, no session;
   cost none — `battery.getStatus` `sleeping: true`, `lastContactAt`
   unchanged (1789889400000) before, +0, +60, +120 s. A hub-paired child does
   not answer on the LAN while asleep, so `onboard` on a hub child could not
   be read and its content is **unknown**; `hub` answered the same minute:
   calendar `[1…11, 13…19]`, 20 / 6 / 2 / 1 sub clips on 16–19 September.
   Default filter for a hub child is therefore `hub` (the source that is
   known to answer), with `onboard` listed as `unreachable` until a direct
   read succeeds. CORRECTED the same day, from the operator's own capture
   (design § 1b–1c): a hub child's files are read through the ONE hub session
   addressed with the CHILD's uid — the official app never opens a session to
   a child, and a child refuses one (3628 `login failed: empty reply`; 3825
   login accepted then 400 to everything — recorded as "a child refuses its
   own session", not as the verdict on `onboard`). Measured on 3628 and 3629,
   same channel, same days: the hub's uid addresses NO catalog (142 → empty,
   14 → 0, 272 → 0), the child's uid answers everything, and cmd 5 serves the
   same bytes under either uid. One store per child on the hub, two views:
   `onboard` = the child's files (142 + 14/15/16, child uid), `hub` = the
   hub's event list (516/517, child in `<devices>`, `bHasRecFile`) — 28/29
   events inside a listed file, 20/20 files with an event, on 3628 day 16.
   Neither view costs a wake. A standalone battery camera without an SD card
   (640, `mount 0` as measured on the morning of 2026-09-20 — the operator
   fitted a card later that day, so the rule keeps its example and the fleet
   keeps no live instance of it) is `no-storage`. The shape is not provisional: the operator reaffirmed it ("hub e camera
   possono essere insiemi diversi. Bisogna implementare semplicemente 2
   sorgenti diverse" [hub and camera can be different sets. We simply have to implement 2 different sources]); the measurement informs the default filter and the
   labels, never whether there are two sources.
15. **A clip's resolution is `auto` through the scale the system already
   has — and `auto` for a stored file is answered on the viewer, not by the
   broker.** The scale is ONE: `StreamQuality = 'auto' | CamProfileSchema`
   (`high | mid | low`, `packages/types/src/capabilities/schemas/streaming-shared.ts`),
   mapped by `camstack/src/live/quality-target.ts` `qualityToTarget` to a
   `WebrtcTarget` — `{ kind: 'adaptive' }` for `auto`, which the BROKER
   resolves per live session (`webrtc-session.cap.ts`), or
   `{ kind: 'profile' }`. A stored clip has no broker session, so the
   adaptive tier cannot be reached from it; what the viewer already has for
   that case is the embed's `/adaptive-probe` bandwidth hint
   (`camstack/embed/src/pages/EmbedPlayerPage.tsx`). Rule: the catalog row
   carries BOTH file identities resolved once at listing time — `streams:
   { sub?: { id, bytes }, main?: { id, bytes } }` (the main twin matched by
   start time within 3 s, § 14) plus `supportSub` — and
   `getClipPlayback({ clipId, profile })` takes a `CamProfileSchema` value:
   `low | mid` → the sub file, `high` → the main twin. `auto` is the viewer's
   `StreamQuality` setting resolved to a profile by the same rule it uses
   for live (`auto` → the adaptive probe's class → a profile), never a
   per-clip knob and never a second ladder. A clip with one stream only
   answers with `served: 'sub' | 'main'` and the viewer says so; a missing
   twin is never served silently as the other. No re-search on a quality
   change: both ids are in the row.
16. **The periodic refresh also PREFETCHES thumbnails, bounded, and the
   interactive mint always wins.** *Amended by [D577](./adr-0577-the-still-prefetch-is-wired-to-the-catalog-refresh-budgets-mints-rather-than-rows-and-backs-away-from-a-host-that-is-not-serving.md):
   it was never wired, the bound is now on MINTS and is 60, a standalone
   battery camera is never prefetched in EITHER mode (not "opportunistic"),
   and a pass stops at the first refusal under a doubling per-device quiet
   ladder — the queue's 400 backoff does not see a camera that merely times
   out. Read D577 for the rule that holds today.* As originally decided:
   same timer and topology rule as decision
   12 (free on a hub child, opportunistic on a standalone battery camera).
   Per refresh per device: the newest **20** clips without a cached JPEG,
   newest first; a prefetch never evicts — it stops when the device's LRU has
   under 10 % free (eviction happens only on an interactive mint), so a
   prefetch can never push out what the operator is about to open. The
   library's CoverPreview lane is one-in-flight per host with a 50-deep FIFO
   and a process-wide host-keyed 400 backoff; a FIFO cannot express
   priority, so the provider keeps TWO queues of its own (interactive,
   prefetch), hands the library at most ONE CoverPreview per host at a
   time, drains interactive before prefetch, and re-checks between every
   prefetch mint; while the library's backoff for a host is open the
   prefetch is skipped entirely and only interactive requests may probe it.
18. **The fleet map and the three end-to-end cases are part of the record.**
   Design § 1b lists, per device, which of the three listing families,
   cmd 142, CoverPreview (both streams) and cmd 5 (both twins) answer or
   refuse, verbatim, with oldest and newest held; § 1c proves the operator's
   three cases: a standalone lists 171 clips in 712 ms and mints 3/3
   thumbnails; a hub child's own files list 20 in 503 ms with 3/3 thumbnails
   and 455 KB of bytes over the hub session; the hub's event view lists 29
   events with 2/3 thumbnails (the third event sat outside every file). The
   battery baby monitor (640) had no SD card at the time of this reading and
   listed nothing — its `onboard` is `no-storage`, honestly, not "no clips"
   (a card was fitted on 2026-09-20 after these numbers were taken; the state
   stays in the vocabulary, its only live example does not). Three facts change
   what a slice may assume: cmd 142 needs the uid on
   the hub (400 without) and ignores it on a standalone; CoverPreview `main`
   is not honoured on the E1 Outdoor PoE; and 618's onboard index answers
   nothing after 5 September while its calendar marks every day — the
   provider reports that as `index-empty` per day, never as "no clips".
19. **SUPERSEDED 2026-09-20 by
   [D565](adr-0565-the-file-list-is-the-clip-catalog-on-every-topology-and-the-class-is-joined-onto-it.md).**
   `FileInfoList` is the catalog on EVERY topology; a clip IS a file. This
   decision rested on two measurements, and both were re-measured the same
   day and neither held. **The speed argument reversed**: on 3628 ch 0,
   `searchEventLog` answered in **950 ms** (day 16, 29 rows) and **678 ms**
   (day 9, 38 rows) against `FileInfoList` sub **137 ms** / **514 ms** — the
   293 ms below is not reproducible and the 503 ms is 3.7× slower than the
   same command answers now. **The class found a cheaper home**:
   `searchAlarmVideos` answered the same child in **247–306 ms** and joins to
   those same files by the file's start stamp, so the file list carries the
   class too (`clip-alarm-labels.ts`). What remained was the grain, and the
   operator named it: an event window is not playable on its own, so every row
   had to be joined to a file before anything could be downloaded — 28 of 29
   on the day below, with the 29th needing a `playable: false` row that
   existed only because the grain was wrong. **The decision below is kept, not
   deleted**: it was the right call on the numbers it had, it is the reason
   `clip-event-catalog.ts` exists and still works, and the events view remains
   the honest answer for a hub-wide event FEED (decision 10's own reservation)
   — it is simply not the catalog. What follows is the reasoning as it stood.

   **On a hub child the catalog is the events view, because it was
   measured faster and it carries the class.** 3628 ch 0, day 16, one hub
   session: `findEventLog` 516/517 → 29 events in **293 ms**, `alarmType` on
   every row; `FileInfoList` 14/15/16 → 20 files in **503 ms**, no class
   (`recordType none` on the hub). The file is resolved at playback from the
   day's file list (28 of 29 events inside a file, ±3 s). An event inside no
   file is a row with `playable: false, reason: 'no-file-for-window'` — one
   of 29 on that day, and the hub refused its CoverPreview too — never
   dropped and never shown as playable. A standalone keeps `FileInfoList`
   (it answers `findEventLog` with an empty body). Both numbers are in the
   record so this is not reversed on intuition.
20. **A native type reaches the operator's OWN filters, mapped in the open;
   an unknown type stays unknown and stays visible.** The class on a
   standalone row defaults to the file's `recordType` (free, identical to
   the per-window `findAlarmVideo` union on 164 of 167 files; the 14 that
   differ are scheduled files with no event); `findAlarmVideo` is the
   per-window upgrade for the clip detail. The mapping is into the served
   event-kind taxonomy the viewer already filters with (`person | vehicle |
   animal` macros, built-in `motion` / `audio`, `package`, `pir`, `doorbell`)
   and is the table in design § 3b: `people`/`face` → `person`, `vehicle`/
   `nonmotorveh` → `vehicle`, `dog_cat` → `animal`, `package` → `package`,
   `md`/`pir` → `motion` (not a class), `cry` → `audio`, `visitor` → `person`
   + `doorbell`; `crossline`/`intrude`/`loitering` are BEHAVIOURS carried
   beside a class, never instead of one, and do not filter; `sched`,
   `manual`, `io`, `legacy`, `loss`, `answer`, `tamper`, `lmsg`, `other`,
   `none` are recording reasons with no label, shown raw. Anything else is
   `unknown:<raw>`, rendered under an "Other (camera)" node, never dropped —
   `labels` is a string, not an enum, on purpose; every raw type also
   travels in `nativeTypes`. A closed enum that throws on the first
   disagreeing camera is the defect, not the camera.
21. **Admin UI first; the viewer opens only when the sources are proven
   there.** Operator, 2026-09-20. "Proven" is written down (design § 7b):
   in the admin section, on the live cluster, 592's list with real
   thumbnails and a playing clip; a hub child's own files through the hub
   session; the same child's events view with classes in the operator's
   filter vocabulary and the orphan event shown `playable: false` — plus
   the honest states (`no-storage`, `catalogAsOf`, `index-empty`). A
   criterion nobody wrote down is a criterion nobody meets.
22. **Clips play in the SAME player recordings use — and that player is
   HLS-only today, so the plain-URL branch is the one change.** The
   recordings path is `RecordingTimeline` → `VodPlaybackProvider`
   (`vod-playback.tsx`) → `PanelContent` → `StreamPanel` → `HlsVideo`
   (hls.js `loadSource` + Bearer `xhrSetup`; Safari-only native branch keyed
   on the HLS MIME); `recorded-playback.tsx` is the broker's frame-push
   datachannel on the live session and does not play files;
   `EventDetailPanel.openClip` opens `getClipPlayback().playbackUrl` in a
   tab. A progressive MP4 does not drop in. Decision: keep the MP4 (what
   cmd 5 + one `+faststart` mux yields; the viewer's `{ kind:'url' }` already
   models it) and add `format: 'hls' | 'mp4'` to `ClipPlaybackSchema` and
   `VodPlaybackRequest`, with an `mp4` branch in `HlsVideo` (`video.src`,
   no hls.js). No clip player is built; a native clip arrives through
   `getClipPlayback` like any other. **No token in the URL — the session
   cookie authenticates the plain `<video>` request, established from the
   code:** the hub's `/addon/<id>/<prefix>` data-plane proxy
   (`server/backend/src/main.ts`, the `gateAddonJwt` call site) reads the
   credential from `request.headers.authorization` OR
   `request.cookies[SESSION_COOKIE]` — `const token = authHeader ? … :
   cookieToken` — and the admin UI upgrades its tRPC JWT to that cookie at
   login (`auth-context.tsx:89`, `POST /api/auth/session`; cleared on
   logout at :294). The recorder's own plane is `access: 'authenticated'`
   (`recorder/addon/index.ts`) and its manifest URL carries NO token
   (`${base}/${deviceId}/master.m3u8?from=&to=`; the cap comment "carries
   the scoped playback token in its path" in `recording.cap.ts:144` is
   stale). `HlsVideo` sends both because hls.js XHR CAN set a header
   (`xhrSetup` Bearer, belt and braces) and `withCredentials` lets the
   cookie ride — its own comment says the native Safari branch, which
   cannot set a header, "still authenticates" that way. `authed-media.ts`
   fetches `<img>` bytes with a Bearer and a blob URL for the same reason
   hls.js does, not because the cookie is refused. So the clip route is
   registered `authenticated` like the recorder's, the `mp4` branch sets
   `video.src = url` with nothing appended and `crossOrigin` unset (same
   origin), and the URL is never a credential: it may sit in history, in a
   `Referer` or in a shared log and open nothing. A long-lived session
   token in a path is not the plan and never was to be; a short-lived
   single-clip handle (the D47 shape `data-plane-access.ts` documents for
   the notification planes) is not needed because the cookie suffices, and
   would only matter for a surface with no hub session — the viewer app
   sends its Bearer on `fetch` and, for its `<video>`, already has the
   token-in-path form the recorder's playback contract will need to state
   honestly when that slice opens.
17. **One socket to the hub, for everything.** Every Baichuan call for
   every child, both sources, the calendar, the listing, the stills, the
   bytes and the prefetch goes through the ONE existing `parent.getApi()`
   session (`reolink-hub.ts`, "returns the already-logged-in api"). No new
   connection for clips, no per-child session, no dedicated prefetch
   connection. Evidence as reported by the coordinator: a second library
   session to this Home Hub earlier today produced 27 failures, all
   `ECONNRESET`. Stated for the record: the probes of this session opened
   additional admin sessions to the hub from a second IP and were answered
   (with a transient "socket closed" on the first command in two of three
   runs), so the failure mode is not "always refused" — it is a session
   budget the hub enforces, and the addon must never spend it. Concurrency
   is therefore bounded by that single session's lanes, which is why
   decision 16 states its priority rule.
12. **A battery camera's catalog is refreshed on a configurable interval —
   free where the hub serves it, opportunistic where a read would be a
   wake.** Per-device Reolink setting `clipCatalogRefreshMinutes` (global
   default + per-device override, cascaded like `stationary-settings.ts`,
   default 15), whose description says both things: on a hub child the
   timer calls the HUB (list + calendar + new thumbnails, the child asleep);
   on a standalone battery camera the timer only marks the catalog STALE
   (`catalogAsOf`), and the refresh runs when the camera is awake for its
   own reasons — hung off the awake transition `reolink-camera.ts` already
   observes (a stream, an operator action, an event) — which is also the
   operator's "refresh again when it wakes". A forced periodic wake is a
   separate per-device opt-in, `clipCatalogForcedWake`, OFF by default, whose
   description states the cost. The number the operator is owed: at the
   15-minute default a forced timer is **96 wakes/day** (24 at 60 minutes);
   the measured natural rate on this fleet is **1–20 clips/day** (3628, 16–19
   September; 3825 2/day) and a standalone battery camera's clips are its
   wakes — so a forced timer would multiply the daily wake count by roughly
   5–100×, and stays off.
13. **Thumbnails live in the addon data dir; a stale catalog says so.**
   `<dataDir>/addons-data/provider-reolink/clip-thumbs/<deviceId>/<clipKey>.jpg`,
   immutable, per-device LRU 2 000 files / 64 MB, outside the `eventMedia`
   class and the retention sweep. The operator offered "or as artifacts if
   simpler"; declined — an artifact is an operator-authored export with an id
   and an expiry, and a thumbnail cache is neither; the file store already
   designed is the simpler of the two. With a persisted catalog and persisted
   stills, `catalogAsOf` becomes load-bearing: every `listClips` answer
   carries it, the section shows it whenever it is older than the interval,
   and a list is never drawn as current when its refresh is old.

   **Amended 2026-09-21.** The Admin UI surface for this is gone. The
   per-source diagnostics table (Source / State / Reason / Catalog read) was
   removed at the operator's request — *"non è necessaria e confusa"*: four
   columns on every camera, restating what the body says in context, reading as
   a wall of faults on a fleet where most cameras legitimately hold no clips of
   a given kind. `catalogAsOf` is still on the wire and still carried by every
   answer; what has no surface is its AGE. A sleeping source that contributed
   rows from its persisted catalog now shows those rows with nothing saying how
   old the read is. Recorded rather than quietly dropped: one line above the
   list is the cheap way back, and `clips-section-states.test.tsx` names the
   gap where the assertion used to be.
14. **`FileInfoList` is the catalog — the app's two hub screens prove it.**
   The playback capture (child ch 0) and the Events capture (the hub's own
   screen) send byte-identical `FileInfoList` opens for the same child and
   differ only in what they ask on top: playback adds cmd 142 and 574, Events
   adds 516/517/518 and 185 CoverPreviews — and the Events screen resolves an
   event to its file by searching `FileInfoList` over the EVENT's own 15 s
   window (18:35:53–18:36:08), so a sub-day search is valid and the one-day
   clamp is an upper bound, not a grain. Recordings live per child in the
   hub's own directory `/mnt/sda/U10<uid>-<name>/` — confirmed for ch 0
   (…142G), ch 1 (…14UB) and ch 3 (…1AUT, sparse footage); a child with NO
   footage was not observed. Two further facts the catalog must honour:
   (a) a search names ONE stream (`subStream` | `mainStream`); the app runs
   both, and the sets are twins with different names whose start seconds
   differ by 0–4 s (168 of 170 within 3 s on 592, 20 September; main ≈ 33×
   the sub's bytes) — so a clip row is the SUB file with its main twin
   matched by start time, never by name; (b) the app's filter is 16 record
   types plus a 19-item `<fileRecordType>` list — a narrower filter returns
   fewer files silently; nodelink-js 0.7.8 sends the app's filter by default.

## Consequences

- `@camstack/types` and `@camstack/system` change (mount kind, collection
  dispatch, additive schema) — a framework train — before any addon deploy
  shows anything. The first visible slice is later than a swap would have been;
  that is the accepted price of never hiding a source.
- The admin section is framework-derived (`deviceConfig.ui = { kind:'widget',
  widgetId:'host/clips-browser', tab:'clips', topTab:true }`, D14/D526), so
  `DeviceDetail.tsx` is not edited; the aggregator must be verified to emit a
  derived section for a WRAPPED binding, which only native bindings have
  exercised so far.
- `addon-provider-reolink` pins nodelink-js 0.7.8 (published by the operator).
  Until then `getVideoclipThumbnailJpeg` cannot carry a hub child's `uid`,
  every download costs ~15 s, and no timezone can be named.
- The viewer needs no release for slices 1–5; it already models `{kind:'url'}`
  playback and open source ids. It gains native sources through its existing
  `clipSources` filter later.
- Every provider log line about a camera carries `tags: { deviceId }`, and
  every branch that drops work (`sleeping`, `uid-missing`, `camera-refused`,
  `pages-truncated`) logs it.

## Enforcement

- `scripts/check-device-scoped-wrapper-mounts.ts` (design § 2, M6), wired into
  `.github/workflows/ci.yml`'s guard list: fails when a `scope:'device'` +
  `kind:'wrapper'` cap resolves to a singleton mount, when the server's
  `getLocalProvider` switch carries no `case 'device-scoped'`, and when a
  device-scoped cap's generated mount still reads `getSingleton`. Landed with
  slice 1 on 2026-09-20 together with the mount itself ([D552](adr-0552-a-device-scoped-wrapper-mount-dispatches-only-the-methods-that-name-a-device.md)).
- The two-provider router spec under `server/backend/src/__tests__/cap-routers/`
  (design § 2.3): two `videoclips` providers bound to one camera both appear in
  `listClips`, and `getClipPlayback` routes each id to its own provider. Revert
  the mount or the dispatch and it must go red.
- Library side, already in place: `test/lib/recordings-*.test.ts` in
  nodelink-js pin the header rule, the `<uid>` on a hub child, the widened
  zero-length window, the cmd 114 discovery, the idle-window completion and
  the zone-explicit timestamps against the captured fixtures.
- Nothing yet checks "a read never logs into a standalone battery camera" for
  the clip path; slice 2 adds a provider spec with a fake that records logins
  and asserts zero while `sleeping`, and that the interval timer on such a
  camera changes `catalogAsOf` staleness and nothing else.
- The two-sources shape has a consequence a guard cannot catch — duplicates
  are by design — so the section's test asserts a clip present in both
  sources renders twice with two different `source` labels, and never once.
- Slice 2's provider spec asserts every hub child call resolves to the
  parent's api object (`toBe(parentApi)`), and that no `ReolinkBaichuanApi`
  is constructed by the clip path.
- Settings guard: `check-settings-key-has-reader` already fails a setting no
  code reads; `clipCatalogRefreshMinutes` and `clipCatalogForcedWake` must
  each have a reader in the provider before they are declared.
