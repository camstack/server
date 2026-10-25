---
title: An onboard SOURCE for recordings, motion and events — the analysis, the rulings that overruled it, and the cap cut they require
date: 2026-09-24
status: DESIGN. Part I is the opening analysis (unchanged, one recommendation superseded). Part II is the design the operator's rulings require. Nothing implemented. ADRs are owed when Part II is executed — number assigned by the operator, per convention.
covers:
  - packages/types/src/capabilities/recording.cap.ts
  - packages/types/src/capabilities/motion.cap.ts
  - packages/types/src/capabilities/videoclips.cap.ts
  - packages/types/src/capabilities/recording-onboard.cap.ts
  - packages/types/src/interfaces/recording-config.ts
  - packages/addon-pipeline/src/recorder/addon/index.ts
  - packages/addon-provider-reolink/src/clips/**
  - packages/addon-provider-hikvision/src/clips/**
  - packages/addon-provider-amcrest/src/clips/**
  - camstack/src/clips/clip-sources.ts
  - camstack/src/data/use-recording.ts
  - camstack/src/store/camera-prefs-store.ts
---

# DECISIONS — 2026-09-24

The operator read Part I and decided against two of its recommendations, then
went further. These are RULINGS. They are recorded verbatim, with the advice
they overruled left standing below rather than deleted — a record that hides
the advice that lost is worth nothing later, when we find out who was right.

### D-a — a timeline is a RENDERING of whatever coverage a source has

> *"Non importa se una camera registra in continuo o ad eventi, recordings deve
> avere lo stesso un modo per dipingere la timeline continua. Il provider deve
> solo aderire alla cap comune ed estesa se necessario"*
>
> [It does not matter whether a camera records continuously or on events,
> recordings must still have a way to paint the continuous timeline. The
> provider only has to adhere to the common cap, extended if necessary.]

Part I §4.1(b) is **superseded**. Sparse coverage is still coverage; a card
that holds only event clips paints a sparse timeline, and that is a correct
timeline, not a broken one. The measurements stay — they are true, and they
size what the operator will see (§9.1).

### D-b — it is a picker, on the viewer page, and OURS is always the default

> *"Per ora serve un altro selettore sulla pagina viewer. Default SEMPRE al
> nostro sistema, se selezionata una sorgente diversa si va su quella sorgente"*
>
> [For now we need another selector on the viewer page. Default ALWAYS to our
> system; if a different source is selected we go to that source.]

Part I §7.1's *"build the comparison, not the picker"* is **superseded**. It is
the picker, exactly as clips have it. Not "the first row", not "last used":
**ours, always**, and a different source only when explicitly chosen. §12 makes
that structural rather than a sort order.

### D-c — `recording` itself becomes a collection, and so do `events` and `motion`

> *"trasformiamo recording allora in una collection, cosi come events e motion.
> Il default va SEMPRE su quello attuale di sistema. Emula lo stesso identico
> meccanismo che abbiamo progettato per le videoclips"*
>
> [Let us then turn recording into a collection, like events and motion. The
> default ALWAYS goes to the current system one. Emulate the exact same
> mechanism we designed for the videoclips.]

One mechanism, not three variations of it. Part I §4.1(a) called the split of
`recording.cap.ts` *"the real work item… a large refactor"*: that stands as a
description of the size, and is no longer an argument against doing it. §9
shows the cut is clean — the 33 methods fall into two groups that barely touch.

### D-d — a half-converted fleet during a deploy is acceptable

> *"non fa niente se rimaniamo a meta' durante un deploy"*

One release. No compatibility shim, no dual-registration period, no two-release
dance. §16 says what the window looks like — and what that ruling does **not**
cover: nothing may be permanently lost, and a transient failure must be
legible.

### D-e — events, triaged

Reolink: definitely implementable. Hikvision: *"la events call non ha senso
dato che non emette certi eventi"* [the events call makes no sense since it
does not emit certain events]. Amcrest: unknown to him. §14.

On the plan as a whole: *"e' chiaro, perseguilo"* [it is clear, pursue it].

### D-f — EVERY call that returns recording data goes to the selected source

> *"Tutte le chiamate che tornano dati recording devono andare sulla sorgente
> selezionata"* — 2026-09-24, answering step 1's finding. [All calls that return
> recording data must go to the selected source.]

**Step 1 is closed, and the answer is no.** `device-collection-dispatch.ts`
takes `deviceId`, singular; there is no `deviceIds` anywhere in it, and the
provider pin is one addon at a time — its own docblock records the operator
settling that on 2026-09-20 (*"l'utilizzatore è uno solo"* [there is only one user]). So a collection
call cannot narrow by provider over an array of devices, which confirms §9.3's
placement of `getAvailabilityBatch` / `getDaysWithRecordingsBatch` on the
archive singleton rather than refuting it.

I proposed the narrow reading — that the picker binds only the single-camera
page, and multi-camera views stay on ours. **He ruled wider**: the selection
follows the data everywhere. So the multi-camera path must honour a per-camera
choice that the batch route cannot express, and the shape that follows is:

**Partition by selected source, then ask each the only way it can be asked.**
Cameras resolving to `camstack` go to the archive's batch, one call, exactly as
today. Every other camera is a per-device call to the collection. The batch is
therefore a fast path for ONE source, never the general route — and it must
never be reached for a camera whose choice is not ours, or the operator is
shown our footage under another source's name.

**The cost is real, it lands on the multi-camera views, and it is declared
rather than discovered.** A grid of N cameras on onboard sources is N reads;
where the source declares `exclusive: true` (§13) the surface must serialise
them, and on a realtime 1.01× transport with one replay slot that is slow by
construction. The precedent is in this document: one screen of Hikvision
thumbnails consumed fifteen minutes of that camera's only session. The
`getPlaybackOptions` envelope is what lets a grid decide to draw a source's
bars lazily, or on demand, instead of learning the cost in production — and
**this is now the reason that envelope has to be asked by the grid too, not
only by the single-camera page.**

Consumers to work through, measured 2026-09-24: `use-recording.ts` sends the
singular call for one camera and the batch from two up (`ask.asked.length > 1`),
and `use-timeline-activity.ts` / `timeline-scope-read.ts` are the scope readers
above it. Those three are where the partition lands.

---

# Part I — the opening analysis

> Unchanged from the first draft except for the SUPERSEDED markers, which point
> at the ruling that overruled each piece. Everything measured here is still
> true and is still load-bearing for Part II.

## 0. The ask, and the one sentence this document exists to test

> *"vorrei fare esattamente come per le clips, avere una sorgente diversa (in
> questo caso onboard) per le recordings, motion, events. Fai una analisi
> iniziale e partiamo da qui"* — operator, 2026-09-24. [I would like to do exactly
> as for the clips, have a different source (in this case onboard) for
> recordings, motion, events. Do an initial analysis and we start from there.]

The instruction is precise and it is the right instinct: clips are the one
surface in this system where the CAMERA's own store is a first-class peer of
ours, picked by the person looking, never blended. This document asks the same
question of three more subjects and answers it separately for each, because
**they are three different problems wearing one word.**

The short answer, stated up front so nothing below reads as suspense:

> **SUPERSEDED by D-a, D-b, D-c** for `recordings` and `motion`. The table
> below is what was recommended on the evidence in §2–§5; the operator decided
> otherwise on 2026-09-24. Part II builds what he decided.

| subject | does the clips model transfer? |
| --- | --- |
| **recordings** (the continuous timeline) | **No** — and not for a protocol reason. Measured on this fleet, **not one camera records continuously onboard**. There is no continuous timeline on any card to serve. |
| **motion** | **No, as posed.** There is no historical motion on any camera, from any of the three vendors. `motion` is a live binary cap with no history to have a source for. |
| **events** | **Yes, and this is the one that should be built.** It buys history the hub never saw, the reader for Reolink already exists and is deliberately unwired, and the shape was already designed in §2 of the 2026-09-21 roadmap. |

Everything after this is the evidence, and where I think the *"exactly like
clips"* instruction should be varied — §7.

---

## 1. The target shape, restated so we are judging the same thing

Read against `videoclips.cap.ts`, `camstack/src/clips/clip-sources.ts` and
`camera-prefs-store.ts`, the model the operator wants copied is five rules, not
four. The brief listed four; the fifth is the one that does most of the work.

1. **`listSources(deviceId)` answers one row per SOURCE**, each row naming the
   ADDON that serves it (`ClipSource.addonId`, D555/D557 § 4) and carrying its
   own `availability` — `ok | sleeping | unreachable | no-storage |
   index-empty` — so an empty list is never ambiguous (D561).
2. **The operator picks ONE row, per camera, stored viewer-side.**
   `CameraPref.clipProvider` holds the SOURCE id; absence is stored as absence
   and means the default. It writes no server state and claims no authority
   over whether a provider runs — *"a second knob over somebody else's decision
   is the failure D62 describes"*.
3. **Every later call carries the provider EXPLICITLY.** `listClips.provider`
   is `z.string().min(1)`, required in the schema. Absence was measured to buy
   the union it exists not to be (592, 2026-09-20: `limit: 3` answered six rows
   from two sources).
4. **Two sources are never drawn together.** *"Mai mischiate provider
   diversi."* `ClipDerivation` is `'derived' | 'cap'` and exactly one of them
   fills the body, ever.
5. **The two sources answer the SAME QUESTION in the same shape.** This is the
   rule nobody wrote down, because clips never had to state it: a CamStack
   analytics visit and a Reolink SD-card file are both *"a playable time window
   on this camera, with a still and some labels"*. `ClipSchema` is one schema
   and both sources fill it. The picker is honest precisely because the choice
   changes WHO ANSWERS and not WHAT WAS ASKED.

Rule 5 is the load-bearing one for this analysis. **Where the onboard answer is
a different object from the hub answer, the picker stops being a source picker
and becomes a disguised mode switch** — and a mode switch that calls itself a
source is worse than two clearly separate surfaces.

There is one more structural fact that shapes everything below. `videoclips` is
`scope: 'device'`, `mode: 'collection'`, `kind: 'wrapper'`. That combination is
what makes a per-camera source list *possible*: the mount stays per-device, the
device's sources ARE its bindings (`getBindings`, D554 amended), and the
collection dispatcher fans out. **None of the three target caps has that
shape.** See §2.4.

---

## 2. What exists today, per subject

### 2.1 Recordings

`recording.cap.ts`, line 453: **`scope: 'system'`, `mode: 'singleton'`, 37
methods, declared by `recorder` alone** (`docs/reference/capabilities.md:169`).
It is not a device cap with a system helper; it is the recorder's whole control
surface — storage locations, retention, relocation, rebalance, the ops log —
with three per-camera READS bolted onto it behind a `deviceId` gate:

- `getAvailability({deviceId, fromMs, toMs, profile?})` → `{ deviceId, ranges:
  [{profile, startMs, endMs}], profilesWithFootage }`. Plus
  `getAvailabilityBatch`, whose per-row `read: 'read' | 'unreadable'` is the
  D393 discipline made structural: *"a timeline that renders the second as the
  first tells an operator there is no footage when the truth is that nobody
  looked."*
- `getDaysWithRecordings({deviceId, fromMs, toMs, tzOffsetMinutes})` → local-
  midnight epochs. The date-picker's day dots.
- `getPlaybackManifest({deviceId, fromMs, toMs})` → an **HLS master playlist
  URL** on the recording node's playback server, plus LAN/remote alternates,
  carrying a scoped token in the path.

Beside those sit the byte-level reads a scrub and an export use —
`locateSegment` (segment / gap, with `nearestEdgeMs` and `prevEndMs`),
`readGopBytes`, `readWindowBytes` (which REFUSES `spans-multiple-segments`
rather than splicing). These are the primitives the whole recorded-playback
experience is built on: frame-step, scrub, GIF render, clip render, export.

The viewer's side: `camstack/src/data/use-recording.ts:300` calls
`recording.getAvailability`; `trpcClient.recording.getPlaybackManifest` is the
one direct call in `camstack/src`. `camstack/src/timeline/coverage.ts` and
`recording/recording-availability.ts` turn ranges into the bar.

**What the viewer assumes:** that a recording is *our* MP4 segment tree on
*our* disk, that any instant inside `ranges` is seekable, that a GOP can be cut
by byte range from a `mfra` index, and that `getPlaybackManifest` returns HLS.
Every one of those is a property of the recorder, not of the concept
"recording".

### 2.2 Motion

`motion.cap.ts`: `scope: 'device'`, `deviceNative: true`, one method
`isDetected`, one event `onMotionChanged`, and a `runtimeState` slice
`{ detected, lastDetectedAt, autoClearAfterMs }` with `durability: 'session'`.

**It has no history and no window parameter.** It is the current state of a
binary sensor. `MOTION_CLOSE_AFTER_MS = 15_000` closes the episode.

Historical motion in the product is not this cap at all. The viewer's motion
lane (`camstack/src/components/camera/theater/ActivityLanes.tsx`,
`src/timeline/density-bands.ts`) is fed from density buckets derived from
`pipeline-analytics` detections — i.e. **from what our decoder saw**, which is
exactly the thing the operator is trying to get an alternative to.

All three providers already register `motion` natively and push live from the
camera (`source: 'onboard'`): Reolink `handleSimpleEvent` (`reolink-camera.ts:
10887`), Hikvision `handleMotionEvent` off the `alertStream` (`hikvision-camera
.ts:3839`), Amcrest `eventManager.cgi?action=attach` with a
`MOTION_KEEPALIVE_MS = 10_000` re-emit because Dahua fires one `Start` for a
whole window. **So onboard motion is ALREADY the source for the live signal on
this fleet.** There is no second source to pick between.

### 2.3 Events

Two facts, and the second is the interesting one.

**`events.cap.ts` has no provider anywhere.** `scope: 'device'`, `mode:
'singleton'`, three methods (`getEvents`, `getEventThumbnail`,
`getEventClipUrl`), `Declared by: —` in the generated reference
(`docs/reference/capabilities.md:53`). Grepping `eventsCapability` across
`packages/*/src` and `server/*/src` finds only codegen output and the
definition itself. Measured on the live hub, 2026-09-24:

```
$ node scratchpad/hub.mjs GET events.getEvents '{"deviceId":1436,...}'
ERROR  Capability "events" provider not available   (412 PRECONDITION_FAILED)
```

The viewer's `use-events.ts` still calls it and swallows the 412 into `[]`
(*"Cap unavailable / provider error → no highlights (graceful)"*). Nothing
renders from it — `theater/event-highlights.ts:258` says outright: *"This
replaces the old `useEvents`-sourced markers"*. **`events.cap.ts` +
`use-events.ts` are a leftover that describes the right design and is not
wired**, which this repo's own working-style rule names as worse than nothing.
Deleting them is a prerequisite, not a side quest: otherwise the first thing
any onboard-events work will do is implement a cap that already looks
implemented.

**What the operator actually calls "events" is TRACKS.** The Library tab
(`app/(app)/(tabs)/events.tsx` → `LibraryScreen`) and the theater heatmap are
fed by `pipeline-analytics` (`scope: 'device'`, `mode: 'singleton'`, `kind:
'wrapper'`): `listTracks`, `getKeyEvents`, `getKeyEventsBatch`. A `KeyEvent` is
`{ id, trackId, timestamp, className, ...TieredLabelFields, importance,
bestEventId, windowMs, ...TrackFlagFields, ...TrackRetrainFields }` — a track
with an importance score, a tiered label, face/plate identity, and retraining
state.

---

## 3. What each provider could actually serve onboard

Everything in this section is read out of the provider packages, whose comments
carry the measurements. Where a fact is missing I say so rather than infer it.

### 3.1 The decisive measurement — what is ON the cards

Read from the live hub, 2026-09-24, via `recordingOnboard.getStatus` — the cap
that reports the camera's own recording schedule (D608, and per D62 it stores
nothing: every value is read from the camera).

| device | vendor | storage | schedule triggers, all 7 days | segment |
| --- | --- | --- | --- | --- |
| 592 | Reolink, mains standalone | card present, **879 MB free of 243 983** (cycling) | `motion` ×7 | 5 min |
| 3628 | Reolink, hub child | `unknown` — *"footage lives on the Hub's disk, not on a card of its own"* | `person` ×7, `vehicle` | 60 min |
| 1436 | Hikvision | card present, 11 776 MB free of 238 800 (the loop reserve) | `motion` ×4 (tracks 101 + 103) | not exposed on V5.7.1 |
| 3836 | Amcrest | `/dev/mmc0:/mnt/sd`, 112 366 MB free of 127 985 | `motion` ×4, `alarmInput` ×3 | 5 min |

**Not one window on any of the four cameras carries the `continuous` trigger.**
On 3836 this is independently confirmed by the D614 bitfield read: the weekday
mask is `393222 = 0x60006`, bits 1, 2, 17, 18 — **bit 0, `continuous`, is
CLEAR**. (Bits 17 and 18 have no name this repo can defend and are counted as
`unreadableWindows`, never guessed: 14 windows shown, 16 unreadable.)

The corroborating number from the Hikvision side: **a 24 h `ContentMgmt/search`
on 1436 returns 20 rows spanning 898 seconds** — fifteen minutes of footage in
a day. That is an event archive, not a timeline.

This is the fact the whole "recordings" half of the ask turns on, and it is not
a protocol limitation — it is how these cameras are configured, and the config
is readable, writable and already surfaced by `recording-onboard`.

### 3.2 What the protocols expose, per subject

| | Reolink (Baichuan) | Hikvision (ISAPI) | Amcrest (Dahua) |
| --- | --- | --- | --- |
| **clips — implemented?** | yes, 7 methods, source `native:reolink:onboard` | yes, 7 methods, `native:hikvision:onboard` | yes, 7 methods, `native:amcrest:onboard` |
| **file/segment index** | `FileInfoList` cmd 14/15/16, sub+main twinned | `POST /ContentMgmt/search` (`CMSearchDescription`), 40/page, 40 pages max | RPC2 `mediaFileFind` (CGI form is broken: `findFile` → 400), 64/page × 64 |
| **day calendar** | **YES — `getDayRecords` cmd 142.** Read internally by `readDayIndex` (`clip-catalog.ts:203`); **never reaches the cap surface** | **NOT FOUND.** The code says so: *"this firmware exposes no day CALENDAR to contradict"* | **NOT FOUND.** But `mediaFileFind` accepts an arbitrary window — `1970…2100` measured accepted, `findFile` true in **361 ms**; a 30-day `findFile` measured **629 ms** |
| **minute-grain availability / holes** | NOT FOUND | NOT FOUND | NOT FOUND |
| **own event log, historical** | **YES — `searchEventLog` cmd 516/517/518.** Reader written, tested, and DELIBERATELY UNWIRED (`clip-event-catalog.ts`; `clip-event-path-is-not-wired.spec.ts` enforces it). Hub-only: a standalone answers an empty body | **NOT FOUND.** No `logSearch`, no event history, no after-the-fact event picture | **NOT FOUND.** No `log.cgi`, no `getEventIndexes` |
| **own event log, live** | `onSimpleEvent` push (motion + AI classes) | `/Event/notification/alertStream`, multipart | `eventManager.cgi?action=attach`, multipart |
| **historical motion** | NOT FOUND | NOT FOUND | NOT FOUND |
| **per-file event metadata** | `recordType` CSV on the file (592: `md 498 / dog_cat 118 / people 108 / sched 40` over 546 files); `searchAlarmVideos` cmd 272/273/274 joined by the 14-digit start stamp when the file carries none | `recordType.meta.std-cgi.com` per row → `recordTypes` (`motion`, `timing`, …) | `Events` / `Flags` per row — **`VideoMotion` on 60 of 60 measured rows** |
| **replay transport** | cmd 5 chunked transfer, **49–62× realtime** | RTSP replay, **1.01× realtime measured** (1436, 176 AUs in 14 274 ms at 12.5 fps), **ONE replay slot per camera** | RTSP `/cam/playback`, **~1.1×**; whole-file `RPC_Loadfile` = **74 475 ms for a 42.5 MB clip** |
| **seek inside a replay** | `<ReplaySeek>` before every replay (0.11.1) | **NO.** A window-narrowed search returns a row and a `playbackURI`, opens 200, and the burned-in OSD reads the SEGMENT HEAD every time. *"The window is accepted and silently ignored."* | `/cam/playback` honours a repositioning `PLAY Range` (npt 17.500 → 17.000) — **observed but unverified**, which is why `seek` is declared `'forward'` |

### 3.3 What is unmeasured

Named explicitly, because a plan whose first step is a measurement is a good
plan and these are the measurements:

- **Whether a `Timing` (continuous) row even comes back from any of these
  cameras.** Amcrest's `CLIP_FIND_FLAGS` includes `Timing` precisely so a
  continuously-recording camera would match — *"Measured: a three-flag
  condition returns the same 15 rows an `Event`-only one does on this camera"*
  — but 3836 does not record continuously, so a `Timing` row has never been
  observed on this fleet, from any vendor.
- **Hikvision's `trackDailyDistribution`** (the ISAPI day-calendar endpoint the
  official clients use). Never called here. Whether this firmware serves it is
  UNKNOWN.
- **What a card-full camera's retention span actually is.** `HddInfo` /
  `ContentMgmt/Storage` are read for mount + capacity only. Hikvision free
  space is measured NOT to be a proxy for footage (1436 and 1439 both report
  11 776 MB free = the loop reserve).
- **Amcrest `PLAY Range` reposition**, above.
- **Reolink `searchEventLog` on a standalone camera.** Measured only on hub
  children (3628 → 222 rows / 0 orphans over 20 days; 3629 → 1 059 / 0; 3825 →
  all orphans, uid never persisted). A standalone answers an empty body, which
  may mean "not supported" or "wrong call shape". UNKNOWN.
- **Whether any camera on this fleet holds footage our recorder does not.**
  Nobody has run the containment comparison. This is the single measurement
  that decides whether the recordings work is worth anything at all — §6.1.

---

## 4. The shape mismatch, per subject

### 4.1 Recordings — the clips model LOOKS like it transfers, and does not

Four separate breaks, in increasing order of severity.

**(a) The cap has the wrong shape, and fixing that is not cosmetic.**
`videoclips` is `scope:'device'` + `mode:'collection'`; `recording` is
`scope:'system'` + `mode:'singleton'` with 37 methods, 34 of which are about
OUR storage — relocation, rebalance, eviction, placement, the ops log. A camera
provider cannot become a second `recording` provider without either
implementing 34 methods it has no business implementing, or the cap being split
into a device-scoped read collection and a system-scoped recorder control
surface. **That split is the real work item**, and it is a large refactor of
the most load-bearing cap in the system, touching the recorder, the broker, the
scrub path, the export path and the admin UI.

**(b) The onboard object is not a continuous timeline.** — **SUPERSEDED by
D-a.** The measurement is right and the conclusion drawn from it was not: a
99%-empty bar is what a card that records on events HAS, and the fix is to draw
it as sparse coverage rather than as holes in a continuous recording. §10.3
makes `coverage: 'continuous' | 'sparse'` a declared provider fact, which is
what stops it reading as a broken recorder. The paragraph is kept because it
names the failure mode the rendering must avoid.

`RecordingRange` is
`{profile, startMs, endMs}` — a contiguous span our writer produced. An onboard
"range" would be a discrete event clip, with real gaps between clips that are
not holes in a recording but the absence of one. Rendering 20 rows spanning
898 seconds as a 24-hour availability bar produces a bar that is 99% empty and
looks exactly like a broken recorder. That is D393's failure mode
(`unreadable` rendered as `read`) arriving through a door nobody opened.

**(c) The transport cannot serve a scrub, and on Hikvision it cannot serve a
timeline at all.** The recorded timeline's gestures are: drag the playhead
anywhere, frame-step backward, jump to an instant. Those are
`locateSegment` + `readGopBytes` over a `mfra`-indexed local file. Onboard:

- **Hikvision** delivers at **1.01× realtime**, from **one replay slot per
  camera**, **always from the segment head** — seek is accepted and silently
  ignored. A scrub over this source is not a slower scrub; it is not a scrub.
  This is already why `CLIP_REALTIME_SOURCE_RATES = [0.25, 0.5, 1]` exists
  (D616), and why `CLIP_PLAYBACK_OPTIONS.realtimeStream` declares
  `seek: 'forward'`, `stepBack: false`, `scrub: false`. **The clips work
  already measured this and already declared the answer.** A timeline source
  over it would have to declare the same thing — a timeline you cannot scrub.
- **Amcrest** has one replay lane per camera from this node (measured session
  budget: 10 asked → 9 granted; 12 asked → 8 granted) and 2 s lane wait.
- **Reolink** is the one that could plausibly do it: 49–62× transfer, in-clip
  seek since 0.11.1 (D-record `2026-09-23-reolink-in-clip-seek.md`). Even there
  every seek is a new cmd-5 transfer over the session the camera shares with
  everything else.

Cost of getting this wrong is already on the record for exactly this reason:
filling one screen of Hikvision thumbnails at 1.01× cost **fifteen minutes** of
the camera's only playback session, shipped in 1.2.126 and reported within
minutes. A timeline is a screenful of reads by construction.

**(d) The picker would change what the operator is looking at, not who answers
it.** Rule 5 of §1. Picking "SD card" on the Recordings tab would swap a
scrubable 24-hour bar for a sparse list of motion clips you can only play
forward — which is **the Clips section, which already exists, on the same tab,
already source-picked**. The `videoclips` deviceConfig puts the clips browser
at `tab: 'recording', order: 100` precisely so that *"footage the camera itself
holds is the same question, asked of a different store"*.

**Verdict: does not transfer.** See §7.1 for what I think should be built
instead.

### 4.2 Motion — the model does not apply because there is no second source

`motion` is a live binary with a runtime-state slice. It has no history, no
window argument, and its onboard source is already the one in use. There is
nothing to pick.

If the ask is really *"let the motion LANE on the timeline be fed by the camera
instead of by our decoder"*, then the object being sourced is a **history of
motion**, and:

- **No vendor here exposes one.** Reolink `getMotionAlarm`/cmd 46 is
  enable+sensitivity config, not history. Hikvision has no event history at
  all. Dahua has no `log.cgi` wired and no event index.
- The only historical motion trace that exists on any camera is **the
  `recordType` on a recorded file** — i.e. *"the camera recorded because it saw
  motion here"*. That is not a motion history; it is the event archive, one
  field of it, and it is already carried on `Clip.nativeTypes` / `Clip.kind`.

So "motion from onboard" is not a third subject. It is a **column of the events
subject**, and it should be built there or not at all.

**Verdict: does not transfer, as posed.** Nothing is lost by saying so: the
useful half of it arrives free with §4.3.

### 4.3 Events — transfers, and is the one worth doing

Here the two sources answer the same question in the same shape, and the onboard
answer contains things ours cannot:

- The object is *"something happened on this camera at time T, of type X"*. A
  camera event has a timestamp, one or more native type strings, and a claim
  about whether a recording exists for it (`bHasRecFile`). That is a coherent
  row, independent of any file.
- It is **history our pipeline never saw.** A battery camera that woke itself,
  recorded, and went back to sleep produced nothing for us — the roadmap's own
  words: *"Quel log è storia che oggi buttiamo via."*
- The transport is cheap and already measured: Reolink `searchEventLog` at
  **678–950 ms** per day on a hub child.
- The availability vocabulary transfers verbatim: `sleeping`, `no-storage`,
  `unreachable` mean the same things about an event log as about a clip
  catalog.

Two warnings that are already on the record and must not be rediscovered:

- **Not a branch inside `videoclips`.** D565 is the record of what happens when
  "what happened" and "what can I play" are fused. The roadmap states it: *"Una
  cap nuova, non un ramo dentro `videoclips`."* [A new cap, not a branch inside `videoclips`.]
- **A camera's events and ours never share a row without saying who produced
  it.** Otherwise *"una soglia nostra e una soglia del firmware diventano lo
  stesso numero."* [a threshold of ours and a threshold of the firmware become the same number.]

And one shape difference that must be faced rather than papered over: a
`KeyEvent` carries `importance`, tiered labels, `bestEventId`, face/plate
identity and retraining flags — **all of which are products of our pipeline and
none of which a camera event has.** The Library's sort is by importance; its
cards open a track detail. A camera event can fill none of that. So the picker
on the Library/heatmap surface is honest only if the surface degrades
explicitly — an onboard row says "camera event", carries `nativeTypes`
verbatim, and offers no track detail — rather than rendering as an empty track.
That is `ClipSchema.playable: false` / `unplayableReason` one surface over: the
row is SHOWN, never dropped, and never offered as something it is not (D549 19).

### 4.4 The cross-cutting mismatch: nobody is asking the question on a schedule

`videoclips` is a PULL surface: a camera's catalog is read when somebody looks
at it (plus the bounded prefetch in `clip-refresh.ts`, whose topology table is
the thing that keeps a battery camera from being woken by a timer). That is
fine for clips.

An events source that is to fill a heatmap is a different animal — the heatmap
is drawn for a window the operator scrolls through, and a camera-side log read
per scroll is a camera read per scroll. **The topology table in
`clip-refresh.ts` is the existing answer and must be honoured by anything new**:
mains standalone reads itself, a hub child reads THROUGH the parent with the
child's uid (65 ms, the child never notices), **a standalone battery camera is
never read from a timer.** A source that ignored it would wake 640 and 4263 on
every tick.

---

## 5. What the operator actually gains, per subject

Concretely, and where the answer is "nothing measured yet" I say that.

**Recordings.** On this fleet as configured: **nothing, and it costs a lot.**
Every card holds event clips triggered by motion/person/vehicle, and those
clips are ALREADY served, already source-picked, already playable, on the same
tab. A second path to the same footage is a cost with no gain. The gain becomes
real in exactly one case — **a camera whose card holds footage our recorder
never captured** — and that case is currently hypothetical because nobody has
measured it (§6.1). The two ways it could become real:

1. the operator switches a camera to `continuous` onboard (the control exists —
   `recordingOnboard.setSettings`; Hikvision has `CMR`, Reolink has `Normal`,
   Amcrest has bit 0), and turns OUR recorder off for it, to save hub disk;
2. our recorder had a gap — a writer restart, a `drain` location, a 3-hour
   blackout — and the camera did not.

Case 2 is the genuinely valuable one, and note what it wants: **not a source
picker. A comparison.** "Where our timeline has a hole, the card has 40
seconds" is a repair, and a repair is worth more than a second bar the operator
has to switch to and remember to switch back from.

**Motion.** Nothing, as posed — there is nothing to serve. What the underlying
wish probably is — *"the lane should show what the CAMERA saw, not only what our
decoder deduced"* — is delivered by the events source (§4.3) at no extra cost,
because a camera motion event is one of the event types.

**Events.** Real and specific:

- history from cameras that sleep through our pipeline entirely;
- the camera's own classification beside ours, which is how you find out that
  the firmware saw a person where we saw nothing (or the reverse) — today those
  two opinions never meet;
- on Reolink, `bHasRecFile: false` is an honest *"the camera saw this and kept
  no clip"*, which is a real answer the product cannot give today;
- measured density: 3628 → 222 rows / 20 days; 3629 → **1 059 rows** / 20 days.
  *"Una superficie costruita su uno dei due estremi è sbagliata sull'altro."* [A surface built on one of the two extremes is wrong on the other.]

---

## 6. The order of work, cheapest real gain first

> **SUPERSEDED by §17**, which is the order the rulings require. Steps 0, 1 and
> 2 here survive into it unchanged; steps 3–5 are replaced.

Every step names its measurement, and steps 0–2 are measurements.

### Step 0 — Delete the leftover. (no measurement; it is a removal)

`events.cap.ts` has no provider (412, measured), `use-events.ts` swallows the
412, and nothing renders from either. Both read as verification of a design
that does not exist. They go before anything named "events" is built, or the
first act of the new work is to reimplement something that already looks
implemented. Same pass: decide whether the NEW cap may reuse the name `events`
(it should not — `camera-events` or similar; a cap name that once meant
something else is a trap for exactly one reader, at exactly the wrong moment).

### Step 1 — MEASURE: does any camera hold footage we do not?

The question that decides whether §5's recordings paragraph is right. For each
of 592, 3628, 1436, 3836, over one week:

- ask `recording.getAvailability` for our ranges;
- ask the provider's own catalog (`listClips`, which already exists on all
  three) for the camera's rows;
- report, per camera: **camera-minutes with no overlapping hub range**, and the
  reverse.

Read-only, uses only methods that exist, no code shipped. Costs one catalog walk
per camera-day — measured: Reolink standalone 0.3–6 s/day, hub child 65 ms;
Hikvision three ISAPI reads; Amcrest one `findFile` (629 ms over 30 days).
**Do not run it against a battery camera on a timer.**

If the answer is "zero, on every camera" — which §3.1 predicts — the recordings
half of this work is closed with evidence, and §7.1's proposal is what remains.

### Step 2 — MEASURE: what a Reolink event log holds on a STANDALONE camera.

`searchEventLog` (cmd 516/517/518) is measured only through a hub. 592 is a
mains standalone. If a standalone answers an empty body, the events source is
hub-children-only on Reolink and the design must say so from the start rather
than discovering it at integration. The reader exists
(`clip-event-catalog.ts`); this is a scratchpad call, not a deploy.

### Step 3 — The camera-events cap, per §4.3 and roadmap §2.

Order inside it is already written and I would not change it: **reader with the
topology matrix first** (with a test that proves a standalone battery camera is
never touched), **then the cap**, **then the store**, **then the surface.**
Reolink only at first — it is the only vendor with a historical event log. The
cap's `listSources` answers `[]` for Hikvision and Amcrest, which is the honest
answer and the one the collection model already handles.

Measurement before shipping the surface: **rows per camera-day across the
fleet**, because 222 and 1 059 are a 5× spread and the surface must survive the
high end.

### Step 4 — Join camera events to clips, in READ. (roadmap §3)

`Clip.eventIds` is filled from exactly one place (`videoclip-visits.ts:237`),
so a native clip carries zero. The join is temporal containment, done at read
time, never written into the catalog row — *"il catalogo della camera è una
proiezione della camera"* [the camera's catalog is a projection of the camera]. `MAX_CLIP_EVENT_IDS = 24` stays.

### Step 5 — The continuity verifier. (roadmap §4; NOT a source)

This is where the recordings energy should go. See §7.1.

**Motion gets no step.** It is a column of step 3.

---

## 7. Where I think *"exactly like clips"* should NOT be followed

Presented as recommendations with the evidence. It is the operator's call.

### 7.1 Recordings: build the COMPARISON, not the picker. — SUPERSEDED by D-b

> The operator read this and decided for the picker. Kept verbatim because the
> objection it rests on is real and the design in §13 has to answer it: a bar
> that cannot be scrubbed on two of three vendors is still what the operator
> asked for, and the surface's job is to say so rather than to pretend
> otherwise. The continuity verifier this section proposes is NOT cancelled —
> it is simply not what the source picker is for.

A source picker on the Recordings timeline says: *"you may look at ours, or at
the camera's, one at a time."* Applied to this fleet that offers the operator a
bar that is 99% empty, cannot be scrubbed on two of three vendors, and shows
footage that is already on the same screen in the Clips section.

What the underlying wish is worth, is the opposite gesture: **our timeline,
annotated where the camera has something we do not.** Concretely —
`recording.getAvailability` answers as it does today; a hole in it is asked of
the camera's catalog once; a hole the camera can fill is DRAWN as fillable and
plays through the clip path that already works.

That is: not two bars, one bar that knows more. It composes with the continuity
verifier the roadmap already proposes (§4 there), which is the piece that *"non
esiste affatto oggi, ed è il motivo per cui un blackout di 3 ore è stato
diagnosticato a mano"*. It needs no split of `recording.cap.ts`, no second
`getAvailability` provider, no scrub over a 1.01× transport, and it has a
failure mode the operator can act on instead of a switch he has to remember.

Against it: it is NOT the clips model, so it is a second pattern in the system
for "the camera's store", and this repo is right to be suspicious of second
patterns. My answer is that the clips model is a PICKER because clips are a
CHOICE of catalogue; recordings are one timeline with a possible repair, and a
repair is not a choice.

### 7.2 Motion: do not make it a subject. — STANDS, see §14.2

> D-c puts motion through the same mechanism. It already is through it: one
> provider per device, resolved by binding, and no vendor on this fleet exposes
> a motion HISTORY to be a second source of. §14.2.

Adding a motion source picker means adding a motion HISTORY surface, which
means inventing a store for something no camera here can answer. The honest
move is to say so and deliver the useful half through events.

### 7.3 Events: follow the clips model exactly — except the cap name and the row degradation.

Here I would follow it verbatim: `listSources` per camera with availability,
one pick stored per camera viewer-side, `provider` required on every call,
never two sources drawn together. Two deviations: a new cap name (§ step 0), and
an onboard row that **declares what it cannot offer** rather than rendering as
an impoverished track — the `playable: false` / `unplayableReason` discipline,
one surface over.

### 7.4 Do not put any of this behind one "onboard mode" switch.

Three subjects, three answers, three different truths per camera. One global
switch would make a camera whose card is genuinely useful for events (3629,
1 059 rows) also claim a timeline it does not have. The per-subject, per-camera
source pick is right; it is the SET of subjects that should shrink.

---

## 8. Open questions I could not answer

> **SUPERSEDED by §18**, which carries these forward and marks the two that
> today's measurements answered.

1. **Does any camera on this fleet hold footage the recorder does not?** Step 1.
   Everything in §5 and §7.1 hangs on it and it is unmeasured.
2. **Does the operator want a camera to record continuously onboard?** If yes
   — e.g. to shrink hub storage for one camera — the recordings analysis
   changes materially and §7.1 becomes weaker than a real source. The controls
   exist today (`recordingOnboard.setSettings`); nobody has been asked.
3. **Does Hikvision serve `trackDailyDistribution` on V5.7.1?** Never called.
   If yes, it is a day calendar on the one vendor that has none.
4. **Does Reolink `searchEventLog` answer a standalone camera?** Step 2.
5. **What do Hikvision bits 17/18 and the 16 unreadable Amcrest windows mean?**
   D614 names them unreadable rather than guessing. A schedule that cannot be
   fully read cannot be fully trusted to say "this camera records on events".
6. **How far back does each card go?** Retention span is not read on any
   vendor, and free space is measured NOT to be a proxy for it.
7. **Where does the camera-events surface LIVE?** The Library tab is tracks and
   the theater heatmap is per-camera. A camera-events source is per-camera by
   nature (its availability is per-camera), so the heatmap is the natural home
   and the Library is not — but that is a product decision, not a technical one.
8. **`sleeping` for an event log.** A clip catalog serves a persisted list
   while a camera sleeps and reports `catalogAsOf` (D549 13). An event log has
   no such persisted copy yet; whether one is kept, and where, is step 3's
   store question and is not decided here.

---

# Part II — the design the rulings require

> Everything below is new, written after the rulings in DECISIONS. Part I's §6
> order of work is superseded by §17.

## 9. The cut, and why it is clean

### 9.1 What the operator will actually see — measured today

The ruling D-a settles that a sparse bar is a correct bar. It does not settle
how sparse. Measured 2026-09-24 on the live hub, one 24 h window, ours read
through `recording.getAvailability` and the card's through
`videoclips.listClips` at the vendor's own provider:

| device | vendor | OURS: ranges / seconds | THE CARD: clips / seconds | ours, as % of the 86 400 s day |
| --- | --- | ---: | ---: | ---: |
| 592 | Reolink, mains standalone | 11 / **85 362** | 406 / 21 388 | **98.8 %** |
| 3628 | Reolink, hub child | 6 / 4 711 | 5 / 132 | 5.5 % |
| 1436 | Hikvision | 12 / 1 025 | 18 / 836 | 1.2 % |
| 3836 | Amcrest | 217 / **72 671** | 222 / 19 104 | 84.1 % |

Two things fall out of this that Part I did not have.

**Our own bar is not "continuous" either, and on two of four cameras it is
sparser than the card's.** Part I read the cards' schedules and concluded there
is no continuous timeline to serve. True — and the same is true of our side on
1436 (1.2 % of the day) and 3628 (5.5 %). So `coverage: 'continuous' | 'sparse'`
is not an onboard-only concession: it is a fact about a (source, camera) pair
that OUR source has to declare too, per camera, and the recorder already knows
it — `deriveRecordingMode` computes exactly `off | events | continuous` from the
authored bands (`recording-config.ts`). That is the single strongest argument
for D-c's *"one mechanism"*: the property the picker needs is not "is this a
camera or is this us", it is "how much of the window does this source cover",
and both sides answer it the same way.

**The containment question Part I §6 step 1 asked is now BOUNDED, on totals
alone.** Ours covers 98.8 % of 592's day, so at most **1 038 s** of the card's
21 388 s can lie outside our coverage — 4.9 % of what the card holds, and the
true figure is ≤ that. Same arithmetic per camera:

| device | upper bound on card footage OUTSIDE ours |
| --- | ---: |
| 592 | ≤ 1 038 s |
| 3628 | ≤ 132 s |
| 1436 | ≤ 836 s (the whole card) |
| 3836 | ≤ 13 729 s |

**Unmeasured:** the actual interval intersection. Totals bound it, they do not
compute it. On 1436 the bound is the whole card, so containment there is
completely open and the onboard source may be buying real history; on 592 it is
almost closed. §17 step 1 is the intersection, and it is now a cheap step rather
than the pivot of the plan.

### 9.2 The 33 methods, cut in two

Counted by reading `recording.cap.ts` (the generated `docs/reference/capabilities.md`
says 37 — that count includes the auto-injected status surface, and the
discrepancy is not investigated here). They fall into two groups that barely
touch each other:

**SOURCE — per device, about COVERAGE and PLAYBACK (5 methods).**
What the picker drives. Every source must be able to answer these or it is not
a source:

`getAvailability` · `getAvailabilityBatch` · `getDaysWithRecordings` ·
`getDaysWithRecordingsBatch` · `getPlaybackManifest`

**OUR BYTE PLANE — per device, and unimplementable by a camera (6 methods).**
`locateSegment` · `readSegmentBytes` · `readGopBytes` · `readWindowBytes` ·
`renderGif` · `renderClip`

**STORAGE + INTENT — system-wide or about OUR archive (22 methods).**
`getStorageUsage` · `getDeviceConfig` · `setDeviceConfig` · `rescanStorage` ·
`pruneFootage` · `deleteFootprint` · `listOpsLog` · `pauseForStorageMigration` ·
`resumeForStorageMigration` · `refreshStorageLocationsForMigration` ·
`startStorageMigrationMove` · `getStorageMigrationMoveStatus` ·
`cancelStorageMigrationMove` · `relocateFootage` · `listRelocateJobs` ·
`getRelocateResidue` · `reconcileLedgerAgainstDisk` · `cancelRelocateJob` ·
`planStorageRebalance` · `startStorageRebalance` · `getPlacement` ·
`setDevicePlacement`

5 + 6 + 22 = 33. The cut is clean because the three groups share no schema and
no call site (§15 confirms this: the broker calls only byte-plane methods, the
viewer calls only source methods plus `getDeviceConfig`).

### 9.3 Two judgement calls, stated rather than assumed

**`getDeviceConfig` / `setDeviceConfig` are STORAGE, not SOURCE.** They read
and write `RecordingConfig` — `enabled`, `bands`, `retention`, `profiles`,
`segmentSeconds`, `deviceDecision`. Every field is an instruction to OUR
recorder about what to capture and keep. Nothing in it describes the camera, and
a camera provider asked for it could only answer nonsense. It is also the
authority D62 names for the per-camera Recording switch
(`CameraSwitch.authority`, `switch-authorities.ts`, `camera-function-writes.ts`),
and moving an authority into a collection where several providers could answer
it is precisely the "two knobs over one decision" D62 forbids. So it stays a
system singleton method, and the cap it lands in has to have a name that does
not lie about holding it — §11.

**The 6 byte-plane methods stay on the singleton, and this DIVERGES from the
cut I was handed.** The brief grouped them with SOURCE because they carry a
`deviceId`. They should not move, for three reasons that are measured rather
than aesthetic:

1. Their only callers are FEEDERS in other addon processes — the stream broker
   (`stream-broker/addon.ts` L806/808/882/899) and the replay-clip source
   (`benchmark-addon.ts` L536/554). No surface, no picker, no viewer. They are
   `auth: 'admin'` for exactly that reason.
2. They are defined by `mfra` byte ranges over our own MP4 segment tree
   (`ReadGopBytesResultSchema`, `ReadWindowBytesResultSchema`). There is no
   vendor-neutral statement of them. An onboard provider could only stub six
   methods, which is the "singleton wearing a costume" failure one level down.
3. When an onboard source ever does need bytes, the answer already exists and is
   measured: the `videoclips` stream path for that vendor (§10.5). Building a
   second byte transport for onboard footage would duplicate D597/D616/D617.
   `getPlayback` delegates instead.

`renderGif` and `renderClip` are in that group and they are **dead**: the
call-site sweep found zero invocations anywhere outside the schema, the
provider implementation and generated code, although the schema says they were
"built for notification attachments". They move with the byte plane, and §17
step 0 asks whether they should be deleted instead. A leftover that describes
the right design is worse than nothing.

## 10. `recording` — the device-scoped collection

Per D-c the NAME stays on the collection: the surface the operator picks a
source on keeps calling `recording.*`, which also keeps every viewer path
unchanged (§15).

```ts
export const recordingCapability = {
  name: 'recording',
  scope: 'device',
  mode: 'collection',        // several sources per camera, listed beside each other
  kind: 'wrapper',
  defaultActive: true,       // auto-bind, exactly as videoclips does
  deviceTypes: [DeviceType.Camera],
  methods: { … },            // §10.2
} as const satisfies CapabilityDefinition
```

Those five lines are copied from `videoclips.cap.ts` deliberately: `scope:
'device'` + `mode: 'collection'` is what makes `resolveCapMount` keep the
PER-DEVICE mount while the collection dispatcher fans out, and a device's
sources are then its BINDINGS (`deviceManager.getBindings(deviceId)`, D554
amended) rather than "every addon that registered the cap somewhere".
`exposesDeviceSettings: true` does **not** come along — it belongs with the
config methods, in §11.

### 10.1 What each provider is actually signing up for

The onboard implementations are thin, and that is the point. They already hold
everything the collection asks for:

| method | what a vendor provider does |
| --- | --- |
| `listSources` | one row, its own, with the availability it already computes for `videoclips.listSources` |
| `getAvailability` | its existing clip catalog for the window, each clip's `timeRange` mapped to a `RecordingRange` — no new camera read; the catalog is already fetched and cached (`clip-catalog.ts`, `clip-catalog-cache.ts`) |
| `getDaysWithRecordings` | Reolink: `getDayRecords` cmd 142, which `readDayIndex` (`clip-catalog.ts:203`) already reads and which has never reached a cap surface. Hikvision / Amcrest: derived from the catalog, or `read: 'unreadable'` (§10.4) |
| `getPlayback` | hand back the clip id covering the instant — the existing `videoclips` transport does the bytes (§10.5) |
| `getPlaybackOptions` | a constant per vendor, exactly as `CLIP_PLAYBACK_OPTIONS` already is (§10.3) |

No new protocol work on any vendor. That is what makes this affordable, and it
is the concrete meaning of *"il provider deve solo aderire alla cap comune"* [the provider only has to adhere to the common cap].

### 10.2 The methods

```ts
listSources: method(
  z.object({ deviceId: z.number() }),
  z.array(RecordingSourceSchema).readonly(),
  { kind: 'query', auth: 'protected' },
)

getAvailability: method(
  z.object({
    deviceId: z.number(),
    provider: z.string().min(1),          // REQUIRED — see below
    fromMs: z.number(),
    toMs: z.number(),
    profile: z.string().optional(),
  }),
  RecordingAvailabilitySchema,            // + `read`, §10.4
  { kind: 'query', auth: 'protected' },
)

getDaysWithRecordings: method(
  z.object({
    deviceId: z.number(),
    provider: z.string().min(1),
    fromMs: z.number(),
    toMs: z.number(),
    tzOffsetMinutes: z.number(),
  }),
  RecordingDaysSchema,                    // + `read`
  { kind: 'query', auth: 'protected' },
)

getPlayback: method(
  z.object({
    deviceId: z.number(),
    provider: z.string().min(1),
    fromMs: z.number(),
    toMs: z.number(),
    profile: CamProfileSchema.optional(),
  }),
  RecordingPlaybackSchema,                // discriminated union, §10.5
  { kind: 'query', auth: 'protected' },
)

getPlaybackOptions: method(
  z.object({ deviceId: z.number(), provider: z.string().min(1) }),
  RecordingSourceOptionsSchema,           // §10.3
  { kind: 'query', auth: 'protected' },
)
```

**`provider` is required, in the schema, on every method that is not
`listSources`.** This is D554-amended's rule, and it was learned the expensive
way on 592: `listClips` with an optional provider and `limit: 3` answered SIX
rows from two sources, merged, because the device-collection dispatcher left the
fan-out un-narrowed and absence bought the union the method exists not to be.
An un-narrowed `getAvailability` would do the same thing to a timeline — our
ranges and the card's clips unioned into one bar, which is the "two sources
never drawn together" rule broken in the one place it matters most. Required in
the schema means the generated types make it unomittable, not merely
discouraged.

It carries the `addonId` a `RecordingSourceSchema` row supplies, never a source
id, never a list — same as `listClips.provider`. A provider the device is not
bound to is refused BY NAME (D552's `rejectUnresolvedAddonPin`), never answered
by another one.

**`getPlaybackManifest` becomes `getPlayback`.** The rename is not cosmetic: a
"manifest" is an HLS master playlist, which is a property of our recorder and
of nothing else. Keeping the name would make every onboard implementation a lie
in its signature. The old name and shape survive inside the union's `hls` arm
(§10.5), so the recorder's implementation is unchanged behind it.

**The two BATCH methods do not come.** `getAvailabilityBatch` takes
`deviceIds: number[]` with no single `deviceId`, and a device-scoped mount
routes through `getProviderForDevice(deviceId)`. There is nothing for it to
route on. They stay on the singleton, ours-only, serving the multi-camera grid
— which is right anyway, because ours is always the default and a grid does not
have a per-camera picker. **Open, and it is the first code-level question §17
step 2 must settle:** whether `device-collection-dispatch.ts` can narrow a
collection call by `provider` alone, with an array of device ids. If it can,
the batches can join the collection later; if it cannot, the grid is ours-only
and that must be stated in the UI rather than discovered.

### 10.3 `RecordingSourceOptionsSchema` — the constraint, DECLARED

This is D612's rule applied to a timeline: **the source declares what it can
do, and the surface draws what was declared — it never assumes and never offers
a gesture it will then refuse.** D612 exists because `8` and `16` were offered
as clip rates, the broker clamped them to `4`, and no line anywhere said so.

```ts
export const RecordingSourceOptionsSchema = z.object({
  /** How this source's media reaches the player.
   *  `archive` = our own indexed segment tree; `stream` = the provider's
   *  forward-only fMP4 (D597); `realtime` = a replay bound to wall clock. */
  transport: z.enum(['archive', 'stream', 'realtime']),

  /** What the BAR means. `continuous` = gaps are holes in a recording;
   *  `sparse` = gaps are the absence of one, and must be drawn as such. */
  coverage: z.enum(['continuous', 'sparse']),

  /** Where the playhead may be put.
   *  `free`    — anywhere, to the frame.
   *  `forward` — only ahead of the current position.
   *  `segment` — a position SNAPS to the head of the covering segment;
   *              a finer ask is accepted by the camera and silently ignored. */
  seek: z.enum(['free', 'forward', 'segment']),

  /** Frame-step BACKWARD is meaningful. */
  stepBack: z.boolean(),
  /** Whether the drag-scrub gesture is served, as opposed to refused by name. */
  scrub: z.boolean(),
  /** Deliverable rates, ascending, always containing `1`. The surface draws
   *  its picker from this and from NOTHING else (D612). */
  rates: z.array(z.number().positive()).min(1).readonly(),

  /** TRUE when a read of this source HOLDS the camera's only playback
   *  session. A surface with this set makes at most one read at a time and
   *  draws no strip, no prefetch, no hover preview. See §13. */
  exclusive: z.boolean(),
})
```

`seek: 'segment'` is the one value clips did not need, and it is the honest
name for the Hikvision measurement. `videoclips` declares Hikvision
`seek: 'forward'`, which is true of a CLIP — a clip starts at its head and
forward-from-head is the only motion there is. A TIMELINE asks a different
question: "put the playhead at 14:32:07". On this firmware that ask is
**accepted and silently ignored**. Measured on 1436, 2026-09-23, three long
clips: `ContentMgmt/search` narrowed to `[mid, mid+4s]` returns a row and a
`playbackURI`, the replay opens `200`, delivers media — and the burned-in OSD
of the first frame reads the SEGMENT HEAD every time (`12:30:19` where
`12:31:34` was asked, `12:34:57` for `12:35:59`, `12:33:17` for `12:34:07`)
(D616, `clip-first-frame.ts`). Calling that `forward` would tell the surface it
may move the playhead ahead within a loaded segment, which it may not.
`'segment'` says what actually happens, so the surface can draw it (§13).

The declared values, per source, from measurements already on the record:

| source | transport | coverage | seek | stepBack | scrub | rates | exclusive |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **ours (`camstack`)** | `archive` | per camera, from `deriveRecordingMode` | `free` | ✓ | ✓ | `CLIP_BROKER_PACED_RATES` | ✗ |
| Reolink onboard | `stream` | `sparse` | `forward` | ✗ | ✗ | `CLIP_STREAM_SOURCE_RATES` | ✗ |
| Hikvision onboard | `realtime` | `sparse` | **`segment`** | ✗ | ✗ | `CLIP_REALTIME_SOURCE_RATES` | **✓** |
| Amcrest onboard | `realtime` | `sparse` | `forward` | ✗ | ✗ | `CLIP_REALTIME_SOURCE_RATES` | **✓** |

Ours is the only row whose `coverage` is not a constant: 98.8 % of the day on
592 and 1.2 % on 1436 are the same recorder with different bands, and
`deriveRecordingMode(config)` is the one definition that already answers it.

Two reminders that are already paid for and must not be rediscovered. Hikvision
delivers at **1.01× realtime** (1436, 2026-09-23: 176 access units in 14 274 ms
at 12.5 fps — 14.08 s of media in 14.27 s) from **one replay slot per camera**.
Amcrest has one replay lane per camera from this node (10 asked → 9 granted;
12 asked → 8 granted) and a 2 s lane wait. Reolink's cmd-5 transfer lands the
same bytes at 49–62×, which is why it alone is not `exclusive`.

### 10.4 `read: 'read' | 'unreadable'` moves onto the singular answers

`RecordingAvailabilityForDeviceSchema` (the batch row) already carries it;
`RecordingAvailabilitySchema` and `RecordingDaysSchema` (the singular answers)
do not. In a collection that is no longer a nicety, it is the thing that keeps
a rollout legible and keeps D315 out of the timeline: **an empty answer during a
deploy, from an unreachable camera, or from a node on the old build must not be
drawn the same as "this source has no footage here."** The batch's own comment
already says it — *"a timeline that renders the second as the first tells an
operator there is no footage when the truth is that nobody looked"* — and the
singular reads are the ones the single-camera picker uses.

`RecordingSourceSchema` is `ClipSourceSchema` with one field renamed:

```ts
export const RecordingSourceAvailabilitySchema = z.object({
  state: z.enum(['ok', 'sleeping', 'unreachable', 'no-storage', 'index-empty']),
  reason: z.string().optional(),          // the camera's own words, verbatim
  coverageAsOf: z.number().optional(),    // ClipSourceAvailability.catalogAsOf
})

export const RecordingSourceSchema = z.object({
  source: z.string(),                     // 'camstack' | 'native:reolink:onboard' | …
  label: z.string(),                      // "CamStack recordings", "SD card"
  addonId: z.string().optional(),         // stamped by the dispatcher (D557 §4)
  availability: RecordingSourceAvailabilitySchema,
})
```

The five availability states transfer verbatim — they mean exactly the same
things about a coverage index as about a clip catalog, and `sleeping` in
particular is what stops a battery camera being woken to paint a bar.

### 10.5 `getPlayback` — a union, and the onboard arm delegates

```ts
export const RecordingPlaybackSchema = z.discriminatedUnion('kind', [
  // Ours. `RecordingManifestSchema` unchanged, so the recorder's
  // implementation and the HLS player path are untouched.
  z.object({ kind: z.literal('hls'), manifest: RecordingManifestSchema }),

  // An onboard source: the covering clip, played through the transport
  // `videoclips` already has for this vendor (D597 / D616 / D617).
  z.object({
    kind: z.literal('clip'),
    source: z.string(),                   // the videoclips source namespace
    clipId: z.string(),
    /** Where this clip actually STARTS. On a `seek: 'segment'` source the
     *  playhead lands here, not at the requested instant — the surface must
     *  be told, not left to discover it from a burned-in OSD. */
    startsAtMs: z.number(),
  }),

  // Nothing covers the instant. A reason, per D391: a branch that produces
  // no media names why.
  z.object({ kind: z.literal('none'), reason: z.string() }),
])
```

**No new media transport is built.** This is what keeps the work small and is
worth stating plainly: the onboard half of the collection is a PROJECTION of
`videoclips` for coverage and a DELEGATION to it for bytes. Everything
measured, argued and shipped for clips over the last week — the forward-only
fMP4 header, the rate ladders, the replay lanes, the truncation notice, the
incomplete-clip notice — is reused rather than re-derived.

## 11. `recording-archive` — the system singleton that stays

```ts
export const recordingArchiveCapability = {
  name: 'recording-archive',
  scope: 'system',
  mode: 'singleton',
  exposesDeviceSettings: true,           // moves here with the config methods
  status: { schema: RecordingStatusSchema, kind: 'command-driven' },
  methods: { …28 },
} as const satisfies CapabilityDefinition
```

It holds **30** methods: the 22 storage-and-intent, the 6 byte-plane, and the
two batch reads that cannot be device-routed (§10.2) — with
`getAvailabilityBatch` / `getDaysWithRecordingsBatch` duplicated in NAME between
the two caps but not in meaning: on the collection there is no batch, and on the
archive the batch is explicitly OURS. That duplication is deliberate and must be
written down where both are declared, or it becomes the drift CLAUDE.md warns
about.

**On the name.** `recording-storage` was the obvious choice and is wrong: the
cap also holds `getDeviceConfig`/`setDeviceConfig`, which are the recording
INTENT — bands, retention, the D62 switch authority — and a name that says
"storage" invites the next reader to move them out again. `recording-archive`
covers both halves honestly: an archive is a thing we keep, and what we keep it
under is a policy. It also sits in the existing family — `recording-onboard`,
`recording-export`, `recording-signal` — so the reference table reads as one
subject rather than two.

**What must NOT happen to it**: the archive stays a SINGLETON. It is registered
by `recorder`, which is `placement: 'any-node'` and runs on every recording
node; the hub dispatches to one of them. Turning it into anything else would
put the ledger, the placement table and the relocation jobs behind a fan-out,
and §16 names why that is the one genuinely dangerous move in this whole plan.

## 12. The default, structurally — "ours ALWAYS" with no way to say otherwise

D-b says ours is always the default. The clips resolver does **not** already do
this, and the difference matters:

```ts
// camstack/src/clips/clip-sources.ts:183 — the clips rule
const fallback =
  sources.find((s) => s.sourceId === CLIP_PROVIDER_CAMSTACK_SOURCE) ?? sources[0]
```

That `?? sources[0]` is the first-row accident, and it is not hypothetical.
Measured today, `videoclips.listSources({deviceId: 107})` answers
`native:reolink:onboard` FIRST and `analytics` second. If our row were ever
missing or late, the clips surface would silently fall to the camera. For clips
that fallback is right and was argued for — a camera full of onboard clips that
says "no clips" is the defect the work exists to end. **For a timeline it is
wrong**, and by exactly the measurement in §9.1: falling from our 85 362 s bar
to the card's 21 388 s of blocks on 592, silently, is the "99 % empty bar reads
as a broken recorder" failure arriving through a door nobody opened.

So the recordings resolver diverges, on purpose, and the divergence is what
makes D-b structural:

**1. A RESERVED source id.**

```ts
/** OUR recorder's source. RESERVED: no other provider may return it, and the
 *  absence of an operator choice MEANS this value — it is not a row that
 *  happened to sort first. */
export const RECORDING_SOURCE_CAMSTACK = 'camstack' as const
```

Reserved is enforced, not requested: the collection dispatcher refuses a
`listSources` row carrying this id from any addon other than the recorder, by
name, and a `scripts/` guard wired into CI fails the build on a provider that
spells it. A rule nothing checks has already been broken somewhere.

**2. Absence is a LITERAL, never a lookup.** The stored pick is
`CameraPref.recordingSource?: string` — absent means absent, exactly as
`clipProvider` does, writing no server state and claiming no authority over
whether a provider runs (D62). The resolver is total and returns no null:

```ts
type RecordingSourceChoice =
  | { kind: 'source'; sourceId: string; addonId: string; row: RecordingSourceRow }
  // Ours is the default and ours is not in the list. Say so. Never fall to
  // another source, and never draw an empty bar as if ours had answered.
  | { kind: 'ours-absent' }
  // Nothing has answered yet. Draw what we drew before, contradict nothing (D315).
  | { kind: 'pending' }

function resolveRecordingSource(input): RecordingSourceChoice {
  if (input.sources.length === 0) return { kind: 'pending' }
  if (input.chosen !== undefined && input.chosen.length > 0) {
    const picked = input.sources.find((s) => s.sourceId === input.chosen)
    if (picked !== undefined) return asSource(picked)
  }
  const ours = input.sources.find((s) => s.sourceId === RECORDING_SOURCE_CAMSTACK)
  return ours !== undefined ? asSource(ours) : { kind: 'ours-absent' }
}
```

There is no `?? sources[0]` and there is no place to put one: the function's
last expression is the reserved id or a named absence. A camera where our
recorder genuinely has nothing gets `ours-absent`, which the surface draws as
"CamStack has no recordings for this camera" with the other sources offered as
a CHOICE — never taken on the operator's behalf.

**3. A stored pick that names a source the camera no longer has** falls back to
ours and says so (`chosenMissing`), the way clips already does. A source that
disappears must not silently become a different source.

**4. It is per camera, and it is the viewer's.** One choice, stored viewer-side,
per D-b's *"un altro selettore sulla pagina viewer"* [another selector on the viewer page]. It writes nothing to the
hub. A second per-camera server-side authority naming a source is the D62 /
D554-decision-3 failure and is not built.

## 13. What the viewer does when the chosen source cannot seek

This is the part the ruling does not change and must not soften. D-b settles
that the operator may choose a Hikvision onboard source for the timeline. It
does not make that source scrubbable, and the surface has to be honest about it
frame by frame.

Driven entirely by `getPlaybackOptions`, asked once per (camera, source) before
anything is drawn — never by a constant the viewer keeps, which is the second
authority D612 exists to end:

- **`scrub: false`** — the drag gesture is not wired. Not wired-and-refused:
  not wired. The playhead is not draggable, and the bar carries a one-line
  statement of why, from the source. A control that undoes the operator's
  gesture reads as broken; one that is plainly absent reads as unavailable
  (D62).
- **`seek: 'segment'`** — a tap on the bar selects the SEGMENT containing that
  instant and plays it **from its head**. The playhead visibly SNAPS to
  `getPlayback().startsAtMs`, and the surface says what it did ("this source
  plays each recording from its start"). It never shows a playhead at the
  requested instant while the pixels are from 75 s earlier — that is the
  burned-in-OSD contradiction D616 measured, and a timeline makes it far more
  legible than a clip did, because the bar is right there claiming a position.
- **`seek: 'forward'`** (Reolink, Amcrest) — positions ahead of the playhead
  are live; positions behind it re-open from the covering segment's head, the
  same snap, announced the same way.
- **`coverage: 'sparse'`** — covered spans are drawn as discrete BLOCKS with
  the gaps styled as "no recording on this source", never as holes in a
  continuous bar, and the bar is labelled with the source's own name so the
  operator can see at a glance which store he is looking at. On 592 that is 406
  blocks in 24 h; the bar must survive that density — measured, not assumed,
  before it ships.
- **`exclusive: true`** — the surface makes **at most one read at a time** for
  that camera, and the following are DISABLED with the cost stated, not merely
  slow: the scrub-thumbnail strip, hover preview, prefetch of adjacent
  segments, and any background refresh. The precedent is exact and expensive:
  filling one screen of Hikvision thumbnails at 1.01× consumed **fifteen
  minutes** of that camera's only playback session, shipped in 1.2.126 and
  reported within minutes. **A timeline is a screenful of reads by
  construction**, so an un-gated timeline over an `exclusive` source is that
  incident again, larger.
- **`rates`** — the speed picker is drawn from the declared ladder and from
  nothing else. On a `realtime` source that is `[0.25, 0.5, 1]`: above 1× the
  pacer drains a buffer that does not exist yet, and the honest answer is not to
  offer the rate (D612, D620, D621).
- **`read: 'unreadable'`** — drawn as "nobody could look", never as "no
  footage". This is the same discipline as the batch rows and it is what makes
  §16's rollout window legible.

**The blunt summary the operator should have in hand:** choosing the Hikvision
onboard source on 1436 gives a bar of 18 blocks totalling 836 s in 24 h, where
each block plays from its own start, at 1× or slower, one at a time, with no
thumbnails and no scrub. That is a real and sometimes useful view of the
camera's own store — it is not a timeline in the sense our bar is one, and the
UI must not let it look like one.

## 14. `events` and `motion` in the same mechanism

D-c puts all three subjects through one mechanism. The mechanism is §10; what
differs is what there is to serve.

### 14.1 `events`

The existing `events.cap.ts` is deleted first, not converted. Re-verified today:

```
$ node scratchpad/hub.mjs GET events.getEvents '{"deviceId":1436,"limit":1}'
ERROR  Capability "events" provider not available   (412 PRECONDITION_FAILED)
```

No provider anywhere, the viewer's `use-events.ts` still calls it and swallows
the 412 into `[]`, and nothing renders from either. Converting a cap nobody
implements into a collection nobody implements would make the first act of the
new work look like a reimplementation of something that already looks
implemented. It goes (§17 step 0), and the new cap takes a different name —
`camera-events` — because a cap name that once meant something else is a trap
for exactly one reader at exactly the wrong moment.

Shape: identical to §10. `scope: 'device'`, `mode: 'collection'`, `kind:
'wrapper'`, `listSources` with the same five availability states, `provider`
required on every other method, ours (`pipeline-analytics` tracks) reserved as
`RECORDING_SOURCE_CAMSTACK`'s twin and always the default.

Per D-e:

- **Reolink — first and only, at the start.** The reader exists, is tested, and
  is deliberately unwired: `clip-event-catalog.ts` (`searchEventLog`, cmd
  516/517/518), with
  `packages/addon-provider-reolink/src/__tests__/clip-event-path-is-not-wired.spec.ts`
  asserting the provider neither imports nor calls it — verified today: the
  only two references to the module outside its own tests are doc comments in
  `clip-catalog.ts` and `reolink-videoclips-provider.ts`. Measured 678–950 ms per day on a hub
  child; density 222 rows / 20 days on 3628 against 1 059 on 3629, a 5× spread
  a surface must survive at both ends.
- **Hikvision — not built.** The operator's reason, recorded: *"la events call
  non ha senso dato che non emette certi eventi"* [the events call makes no
  sense since it does not emit certain events]. The code agrees — no
  `logSearch`, no event history, no after-the-fact event picture on this
  firmware. Its `listSources` answers `[]`, which the collection model already
  handles and which is the honest answer.
- **Amcrest — one measurement settles it.** The call to try is
  `RPC2 "log.startFind"` / `"log.doFind"` (the Dahua system-log RPC, the
  counterpart of the CGI `log.cgi?action=startFind` which is not wired here) on
  3836, asking for a 24 h window and reading whether the rows carry event
  types (`VideoMotion`, `AlarmLocal`) with timestamps. The RPC2 client already
  exists (`amcrest-rpc2-client.ts`) and the CGI form is known broken on this
  firmware, which is why the RPC is the one to try. If it answers rows,
  Amcrest joins Reolink; if it 400s or answers an empty body, it joins
  Hikvision with the reason recorded. **Unmeasured today.**
- The topology matrix in `clip-refresh.ts` is binding on anything new: a mains
  standalone reads itself, a hub child reads THROUGH the parent with the child's
  uid (65 ms, the child never notices), **a standalone battery camera is never
  read from a timer.** A source that ignored it would wake 640 and 4263 on every
  tick.
- Row degradation, per Part I §4.3: an onboard row says "camera event", carries
  `nativeTypes` verbatim, offers no track detail, and a row with no clip is
  SHOWN with `playable: false` + a reason rather than dropped (D549 19,
  `bHasRecFile`).

### 14.2 `motion`

The verdict from Part I §4.2 stands and D-c does not change the facts it rests
on: `motion` is a live binary with a `runtimeState` slice, no history and no
window parameter; all three vendors already push it natively with `source:
'onboard'`, so onboard motion is ALREADY the source in use on this fleet; and
**no vendor here exposes a motion HISTORY** — Reolink's cmd 46 is
enable+sensitivity config, Hikvision has no event history at all, Dahua has no
wired log. The only historical motion trace on any camera is the `recordType`
on a recorded file, which is one column of the events subject and is already
carried on `Clip.nativeTypes`. So `motion` gets the mechanism only in the sense
that it already has it — one provider per device, picked by binding — and there
is no second source to list. It gets no step in §17. If a vendor ever exposes a
motion log, it becomes a source on `camera-events`, not a fourth cap.

## 15. Blast radius — every call site of what moves

Swept across `packages/`, `server/`, `camstack/src` and `camstack/embed/src`,
excluding `node_modules`, `dist`, compiled bundles and the 48 stale worktree
checkouts. **43 real invocations in 16 hand-written source files**, plus 9
generated files and 20+ spec files. Doc-comment mentions of `recording.<method>`
number 100+ and are not call sites, but they are where the next reader looks, so
they are part of the work.

| surface | files | call sites | what changes |
| --- | ---: | ---: | --- |
| **Viewer** `camstack/src/data/use-recording.ts` | 1 | 6 | `getAvailability` ×2, `getAvailabilityBatch`, `getDaysWithRecordings`, `getDaysWithRecordingsBatch`, `getDeviceConfig`. Add `provider` to the 3 collection reads; repoint the 2 batch reads and `getDeviceConfig` at `recordingArchive` |
| **Viewer** `use-timeline-activity.ts` | 1 | 2 | `getAvailabilityBatch` (grid) → archive; `getAvailability` (single) → collection + `provider` |
| **Viewer** `camstack/embed/.../EmbedRecordingPage.tsx` | 1 | 1 | the only client `getPlaybackManifest` in the repo; becomes `getPlayback` and must handle the union. Its own header calls this path "legacy" |
| **Viewer** `use-storage-management.ts` | 1 | 3 | storage reads → `recordingArchive` (rename only) |
| **Admin UI** via `ui-library` `RecordingPanel.tsx` | 1 | 3 | `getDeviceConfig`/`setDeviceConfig` → archive (rename); `getAvailability` → collection + `provider: 'camstack'` |
| **Admin UI** via `ui-library` `RecordingTimeline.tsx` | 1 | 2 | `getAvailability` → collection; `getPlaybackManifest` → `getPlayback` union |
| **Admin UI** `PipelineQuickStats.tsx` | 1 | 1 | `getDeviceConfig` → archive (rename) |
| **Broker** `stream-broker/addon.ts` | 1 | 4 | `locateSegment`, `readSegmentBytes` ×2, `readGopBytes` → archive (rename only; these never become a collection) |
| **Recorder** `videoclips-wiring.ts` | 1 | 2 | `getAvailability` → collection with `provider: 'camstack'` (note: it goes through `ctx.api` on purpose — `recorder` is `any-node`, a local shortcut could answer from the wrong node's empty index); `getPlaybackManifest` → `getPlayback` |
| **Recorder** `recording-provider.ts` + `index.ts` | 2 | 13 methods | split into two providers, two `ProviderRegistration` entries. `videoclipsCapability` is already registered from the same array, so the collection registration is a copy of a line that exists |
| `pipeline-analytics/index.ts` | 1 | 4 | `getAvailability` ×3 → collection + `provider`; `getDeviceConfig` → archive. All four are behind injected "ports", so the downstream consumers (`recorded-clip.ts`, `timelapse-renderer.ts`, `nc-actions.ts`, `footage-coverage.ts`) do not change |
| `pipeline-orchestrator` `switch-authorities.ts`, `camera-switch-service.ts` | 2 | 2 | `getDeviceConfig`/`setDeviceConfig` → archive. **This is the D62 switch authority**: `CameraSwitch.authority` in `packages/types/src/interfaces/camera-switches.ts` NAMES the cap+method as a string and must move with it |
| `provider-homeassistant` `ha-export.addon.ts`, `camera-function-writes.ts` | 2 | 3 | same authority rename |
| `provider-dreame` `dreame-camera-device.ts` | 1 | 1 | `setDeviceConfig` → archive |
| `addon-benchmark` `benchmark-addon.ts` | 1 | 3 | `getDeviceConfig` → archive; `locateSegment`, `readWindowBytes` → archive |
| `system` `liveness-monitor.addon.ts` | 1 | 2 | `getAvailability` ×2 → collection + `provider: 'camstack'`. A KERNEL builtin: it must not gain a dependency on a picker |
| `server/backend` `scope-access.ts` | 1 | 0 | **No hand-written call site** — `getPlaybackManifest` appears only as the worked example in the F1 #3 device-reference gate's docblock (L187). The gate itself is driven by the GENERATED `method-device-selectors.ts`, so it follows codegen. But the move is not neutral for it: the five source methods stop being `scope: 'system'` methods that carry a `deviceId` (F1 #3's branch) and become device-scoped ones routed through `requireDeviceScoped` → `getProviderForDevice` (the branch `motion.cap.ts`'s `deviceNative` comment documents). **Both branches must be confirmed to refuse an out-of-scope camera**, with a test, before this ships — a read that silently changes which gate protects it is how a protected read loses its scope check |
| **Generated** (9 files) | 9 | ~60 | `generated-cap-routers.ts`, `generated-cap-mounts.ts` (L1327: `getSingleton('recording')` — the line that literally changes shape), `method-access-map.ts`, `method-device-selectors.ts`, `capability-router-map.ts`, `device-proxy.ts`, `system-proxy.ts`, `addon-api.ts`, `ui-library/src/generated/system-hooks.ts`. **`npm run codegen` is mandatory**; CLAUDE.md calls an un-regenerated `*.cap.ts` silent drift |
| **Tests** | 20+ | — | recorder timeline-batch, switch-authority, viewer scope-batch, cap-shape specs. The viewer specs define `AVAILABILITY_BATCH` / `AVAILABILITY_ONE` string constants mirroring the method names |

### 15.1 The hazard that is not in the table

**The viewer does not call `trpc.recording.<m>` — it calls
`capQuery(client, 'recording', '<method>', input)`,** a string-keyed dynamic
dispatch (`camstack/src/data/cap-query.ts`) used deliberately because the
viewer's SDK types may lag the backend. So **a cap rename in the viewer is not
type-checked.** `npm run ts-check` goes green on a viewer that will 412 at
runtime on every storage read. There are ~12 such string literals across
`use-recording.ts`, `use-timeline-activity.ts` and `use-storage-management.ts`.

The answer is a guard, not a paragraph: a `scripts/` check that extracts every
`capQuery(_, '<cap>', '<method>', …)` literal pair in `camstack/src` and fails
when the pair is not in the generated `method-access-map.ts`. Wired into
`.github/workflows/ci.yml`. It is worth writing for its own sake — it closes a
whole class of viewer defect this repo has no detector for — and it should land
BEFORE the rename, so the rename is the first thing it catches.

## 16. Migration — one release, and the two things the ruling does not cover

Per D-d a half-converted fleet during the deploy is acceptable. **One release.**
No compatibility shim, no dual registration, no two-release dance.

### 16.1 What the window looks like

`recording` is registered by `recorder`, which is `placement: 'any-node'` and
runs on **every recording node**; the hub dispatches to whichever one serves the
camera. So during the rollout the hub may be on the new build while a recording
node is still on the old one, or the reverse. Concretely:

- **New hub, old node.** The node registers the OLD system-singleton
  `recording`. The new hub's collection dispatcher asks `getBindings(deviceId)`
  and finds no device-scoped `recording` binding for cameras on that node →
  `listSources` returns rows for whatever onboard providers that camera has and
  **no `camstack` row**. The resolver returns `{ kind: 'ours-absent' }` (§12) and
  the surface says "CamStack has no recordings for this camera" — wrong, but
  NAMED, and it resolves the moment that node is deployed.
- **Old hub, new node.** The node registers the collection; the old hub's
  `getSingleton('recording')` (`generated-cap-mounts.ts:1327`) finds nothing and
  the cap answers `412 Capability "recording" provider not available` — the
  events-cap shape, which is exactly what a refusal should look like.
- **Mixed viewer.** An old viewer build calls `recording.getStorageUsage`, now
  on `recording-archive`, and gets a 404/412 per §15.1. Also transient.

Duration is the deploy's own: `camstack deploy packages/addon-pipeline` to the
hub and to each agent node, plus a `@camstack/server` install for the framework
half (`packages/types` travels inside the published server closure — a
framework fix is not live until a server containing it is installed).

### 16.2 What D-d does NOT cover, and must hold

**Nothing may be permanently lost or become unreachable.** Audited against the
22 storage methods, which are the only ones that write durable state:

- The 6 byte-plane and 5 source methods are **reads**. A half-converted fleet
  makes footage un-PLAYABLE for a window; it cannot make it un-RECORDED.
  Acceptable per D-d.
- **`getDeviceConfig`/`setDeviceConfig` are the real hazard and they are why
  they stay on a singleton.** They are the D62 recording authority. If a write
  reached a different provider than the read — which is what a fan-out over a
  collection would permit — two authorities would decide when one camera
  records, and the symptom (recording silently off, or a `bands` array
  clobbered by a partial write) is durable and silent. Keeping them a system
  singleton means the worst case in the window is a 412: the switch refuses to
  flip and SAYS so. **Do not move them into the collection, at any point, for
  any reason.**
- **The ledger, the placement table and the relocation jobs never fan out.**
  `reconcileLedgerAgainstDisk`, `relocateFootage`, `setDevicePlacement`,
  `pruneFootage`, `deleteFootprint` and the six migration-lease methods stay
  exactly where they are, on the singleton, unchanged in shape. The one move
  that could orphan footage or desynchronise the ledger from the disk is making
  any of them answerable by more than one provider, and this plan does not.
  **The rename is the only thing that touches them, and a rename is atomic per
  build.**
- An in-flight `relocateFootage` or storage-migration lease spanning the deploy
  is the pre-existing risk of restarting the recorder at all, not a new one from
  this cut — but a migration in flight is a reason to wait, and the plan should
  say so out loud: **check `listRelocateJobs` and
  `getStorageMigrationMoveStatus` are empty before deploying.**

**A transient failure must be legible.** This is the half of the window the
plan has to build for, per D391 and D315:

- A node that cannot answer the new shape **refuses by name** (412, the
  capability named) and never answers `[]`. An empty list during a rollout is
  indistinguishable from a camera with no footage.
- `read: 'unreadable'` (§10.4) on the singular answers is what carries that
  distinction into the bar. Without it the timeline has no vocabulary for
  "nobody could look", and `(data ?? [])` in the viewer turns the rollout into a
  fleet of cameras that appear to have lost their recordings.
- **No `?? []` and no `?? sources[0]`** anywhere on this path. `{ kind:
  'pending' }` and `{ kind: 'ours-absent' }` exist precisely so an unanswered
  query cannot be rendered as an answered one.
- Every refusal on the path logs with `tags: { deviceId }`, numeric, per
  CLAUDE.md — a rollout fault is asked per-camera or it cannot be asked at all.

## 17. The order of work

Cheapest real gain first. Each step names what must be MEASURED before it and
what would falsify it.

### Step 0 — delete the leftovers. *(a removal; no measurement)*

`events.cap.ts` (re-verified 412 today, no provider anywhere) and the viewer's
`use-events.ts`, which swallows the 412 into `[]` and renders nothing. Same
pass: decide `renderGif`/`renderClip`, which the sweep found have **zero
callers** outside the schema, the provider and codegen, although the schema says
they exist for notification attachments. Either a caller is owed or they are
dead; carrying two dead methods through a cap split is how they survive another
year.

*Falsified by:* finding a live caller of any of them. Then it is not a leftover
and the plan is wrong about it.

### Step 1 — MEASURE the intersection. *(≈1 hour, read-only, no deploy)*

§9.1 bounds it; nobody has computed it. For 592, 3628, 1436, 3836 over one
week: `recording.getAvailability` for our ranges, `videoclips.listClips` for the
card's, and report **camera-seconds with no overlapping hub range, and the
reverse**, per camera per day. Costs one catalog walk per camera-day — Reolink
standalone 0.3–6 s/day, hub child 65 ms, Hikvision three ISAPI reads, Amcrest
one `findFile` (629 ms over 30 days). **Never against a battery camera on a
timer.**

*Why it still matters although the picker is decided:* it sizes what the
operator gets. If 1436's 836 s are entirely outside our 1 025 s, the onboard
source on that camera is buying real, otherwise-lost history and the work is
worth doing first there. If it is contained, the source is a second view of the
same footage and the ordering should favour 3628/1436 over 592 anyway.

*Falsified by:* an intersection of ~100 % on every camera. The picker still
ships (D-b), but nothing about it is urgent.

### Step 2 — SETTLE the dispatcher question. *(a code read, no deploy)*

Read `server/backend/src/api/trpc/device-collection-dispatch.ts`, plus
`resolveCapMount` and `emitsCollectionSelector` in
`packages/types/src/capabilities/cap-router-predicates.ts`, and answer: **can a device-scoped collection method
be narrowed by `provider` alone, with an array of device ids?** The answer
decides whether `getAvailabilityBatch`/`getDaysWithRecordingsBatch` can ever
join the collection or stay ours-only on the archive forever (§10.2). It must be
answered before the cap files are written, because it changes what they contain.

*Falsified by:* discovering the dispatcher already supports it, in which case
the batches move and the grid gains a per-camera picker it does not currently
need.

### Step 3 — the `capQuery` guard. *(before the rename, not after)*

§15.1. A `scripts/` check that every `capQuery(_, '<cap>', '<method>')` literal
in `camstack/src` resolves against generated `method-access-map.ts`, wired into
CI. It costs an afternoon and it is the only thing that will catch the ~12
string literals the rename breaks, because `ts-check` will not.

### Step 4 — the cap split. *(one release, per D-d)*

In order, in one branch:

1. `packages/types/src/capabilities/recording.cap.ts` → the collection (§10);
   new `recording-archive.cap.ts` → the singleton (§11). New schemas:
   `RecordingSourceSchema`, `RecordingSourceAvailabilitySchema`,
   `RecordingSourceOptionsSchema`, `RecordingPlaybackSchema`, plus `read` on the
   singular availability/days answers.
2. `npm run codegen`, then `npm run typecheck`. The generated files in §15 are
   authoritative; a `*.cap.ts` touched without codegen is silent drift.
3. Split `recording-provider.ts` into two providers; two `ProviderRegistration`
   entries in `recorder/addon/index.ts` (the `providers` array at L1680) — the
   `videoclipsCapability` entry a few lines down in the SAME array is the
   working template for registering a device-scoped collection from this addon,
   including the `defaultActive` auto-bind.
4. The 43 call sites (§15), by surface. The `CameraSwitch.authority` strings in
   `packages/types/src/interfaces/camera-switches.ts` move with the config
   methods or the switch silently points at nothing.
5. **Prove the scope gate both ways** (§15, `scope-access.ts` row): a
   non-admin holding one camera must be refused the other camera's
   `recording.getAvailability` on the NEW device-scoped route, exactly as the
   old system-scope F1 #3 gate refused it. A green suite is not proof — remove
   the gate and confirm the test fails.
6. `npm run test`, `npm run lint`, `npm run docs:check`.

Ours declares `coverage` per camera from `deriveRecordingMode`, `seek: 'free'`,
`scrub: true`, `exclusive: false`, and takes the reserved source id.
**`listSources` must answer at this step even though no onboard provider
implements the collection yet** — one row, ours, and the picker renders with one
choice. That is the checkpoint: the mechanism lands and nothing visible changes.

*Falsified by:* the split proving not to be clean — a storage method that turns
out to need per-device dispatch, or a byte-plane method with a viewer caller.
§15 says neither exists; if one appears, stop and re-cut.

### Step 5 — the viewer picker. *(§12, §13)*

`resolveRecordingSource` with the reserved id and the total return type, the
stored `CameraPref.recordingSource`, the source row UI copied from the clips
picker, and the `getPlaybackOptions`-driven drawing rules of §13 — including
the `exclusive` gate that disables the thumbnail strip. With one source in the
list this is testable end to end before any onboard provider exists.

*Measure before shipping:* the bar at 406 blocks in 24 h (592's card density) —
the surface must survive it.

### Step 6 — Reolink as a second recording source.

The cheapest vendor: 49–62× transfer, in-clip seek since 0.11.1, not
`exclusive`, and `getDayRecords` cmd 142 already read internally by
`readDayIndex` gives it a real `getDaysWithRecordings` no other vendor has. Five
thin methods over the catalog it already caches (§10.1).

*Measure first:* step 1's intersection for 592 and 3628, to know what the second
row is worth on each.

### Step 7 — Hikvision and Amcrest as recording sources.

Hikvision is last on purpose, and it ships only with §13's gates proven: one
read at a time, no strip, `seek: 'segment'`, `[0.25, 0.5, 1]`. Amcrest beside
it, same gates.

*Falsified by:* the `exclusive` gate not holding — i.e. any path that can issue
two concurrent reads to one camera. If that cannot be guaranteed, this step does
not ship, because the failure mode is a camera whose only playback session is
gone for fifteen minutes.

### Step 8 — `camera-events`, Reolink only. *(§14.1)*

Reader with the topology matrix first, with a test proving a standalone battery
camera is never touched; then the cap; then the store; then the surface.
Hikvision and Amcrest answer `[]`.

*Measure first:* rows per camera-day across the fleet (222 vs 1 059 is a 5×
spread), and the Amcrest `log.startFind`/`log.doFind` probe on 3836 that decides
whether Amcrest is a third row or an empty one.

### Step 9 — join camera events to clips, in READ.

Unchanged from Part I §6 step 4: temporal containment at read time, never
written into the catalog row, `MAX_CLIP_EVENT_IDS = 24` stays.

**`motion` gets no step** (§14.2).

## 18. Open questions

Carried forward, updated by what the rulings settled and what was measured
today. Struck items are answered.

1. ~~Does any camera hold footage the recorder does not?~~ **Bounded** (§9.1):
   ≤ 1 038 s on 592, ≤ 836 s on 1436, ≤ 132 s on 3628, ≤ 13 729 s on 3836. The
   exact intersection is step 1 and is still open.
2. ~~Does the operator want a picker or a comparison?~~ **Answered: a picker**
   (D-b).
3. **Can `device-collection-dispatch.ts` narrow by `provider` with an array of
   device ids?** Step 2. Decides whether the grid timeline can ever show a
   non-default source.
4. **Does Amcrest answer `log.startFind`/`log.doFind` on 3836?** The one call
   that settles the operator's "non lo so" on Amcrest events (§14.1).
   Unmeasured.
5. **Does Reolink `searchEventLog` answer a STANDALONE camera?** Measured only
   through a hub (3628 → 222 rows / 0 orphans over 20 days; 3629 → 1 059 / 0).
   592 is a mains standalone and answered an empty body once, which may mean
   "not supported" or "wrong call shape". Unknown — and it decides whether the
   Reolink events source is hub-children-only.
6. **Does Hikvision serve `trackDailyDistribution` on V5.7.1?** Never called
   here. If it does, it is a `getDaysWithRecordings` on the one vendor with no
   day calendar.
7. **How far back does each card go?** Retention span is read on no vendor, and
   free space is measured NOT to be a proxy (1436 and 1439 both report 11 776 MB
   free = the loop reserve). A timeline that lets the operator scroll past the
   card's horizon will draw empty and cannot say why.
8. **Where does the `camera-events` surface live?** The Library tab is tracks,
   the theater heatmap is per-camera. A camera-events source is per-camera by
   nature, so the heatmap is the natural home — a product decision, not a
   technical one.
9. **`sleeping` for an event log.** A clip catalog serves a persisted list while
   a camera sleeps and reports `catalogAsOf` (D549 13). An event log has no such
   persisted copy; whether one is kept, and where, is step 8's store question.
10. **What do Hikvision schedule bits 17/18 and the 16 unreadable Amcrest
    windows mean?** D614 names them unreadable rather than guessing. It does not
    block this plan — `coverage` is now read from actual ranges, not from a
    schedule — but a schedule that cannot be fully read cannot be fully trusted.
11. **Does `recording-archive` need an ADR, or two?** The cap split, the
    reserved default id and the `seek: 'segment'` declaration are each a
    decision this repo records. Numbers are assigned by the operator per
    convention; the latest in `docs/decisions/` is 0624.
