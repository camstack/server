# Clips, events and heatmap — the plan for what is missing

> Status: PLAN. Nothing here is implemented. Written 2026-09-21 after the
> validation of D592 on server 1.2.367, at the operator's request
> ("pianifica solo" [plan only]). Every number is measured on the live hub that day, not
> estimated. Companion to [`2026-08-17-videoclips-implementation.md`](./2026-08-17-videoclips-implementation.md),
> [`../architecture/post-analysis.md`](../architecture/post-analysis.md) and
> D549 / D554 / D563 / D567 / D568 / D572 / D575 / D592.

## 0. Where we start from — the measured point

On server 1.2.367, with the mandatory provider pin and the collection mount
corrected (D592):

| call | outcome |
| --- | --- |
| `readClipBytes` + `provider: provider-reolink` | 1,083,954 bytes, `video/mp4`, `served: low`, `durationMs: 51411` |
| same id + `provider: recorder` | refusal **by name** — *"is an analytics visit … no file behind it"* |
| id that no source claims | `catalog-miss` |
| `listClips` with `provider` | 3 rows from a single source (before: 6, the union) |

Delivery latencies, same day:

| camera | topology | cold | warm (scratch) |
| --- | --- | --- | --- |
| 592 | standalone mains | **1.3 s** for 506 KB / 26 s of video | — |
| 3628 | hub child | **6.5 s** for 1.33 MB / 46 s of video | **0.2 s** |
| 3628 | `listClips`, 3 rows | **0.8 s** | — |

That is: ~390 KB/s on its own socket, ~205 KB/s through the hub's single
session. **The bottleneck is the download from the camera, not the mux and not
the transport to the client.** Any work that does not touch that download
will not make a clip perceptibly faster.

---

## 1. Speeding up the delivery of Reolink clips

### 1.1 Today's shape, and why it is slow

`readClipBytes` is unary and total. `clip-service.ts` → `produceTwin`:

1. `fetchVerifiedClipBytes` — Baichuan cmd 5, **the whole file**, on the
   session the camera shares with everything else;
2. the D568 completion rule — an idle window of 300 ms, one retry at
   2,000 ms if the decoded one is short;
3. write to scratch, **ffmpeg mux with `+faststart`** (a second pass
   over the file);
4. re-read the whole thing into memory;
5. **base64** (×1.33) inside a unary tRPC response, held whole in the
   provider *and* in the caller.

None of these steps produces a byte before the last one has arrived. The
first frame cannot appear before `download + mux` are complete.

### 1.2 What must NOT be done

- **Do not raise the 50 MiB** of `VIDEOCLIPS_MAX_READ_BYTES`. The ceiling exists
  because the envelope is unary and this hub has already gone OOM (D9/D18, D576).
  Raising it is the patch, not the cure.
- **Do not silently substitute the `main` twin with the `sub`** when the main
  overshoots: the 33× substitution is exactly what the refusal by name
  prevents today.
- **Do not add a second fetch** next to `produceTwin`. It is the only place
  where the D567/D568 rules exist; a second one would make it a second
  authority.

### 1.3 The plan, in order of yield per cost

**(a) Targeted prefetch of the `sub`, from the list.** The warm scratch is 0.2 s
against 6.5 s: 32×, and the machinery to fill it already exists
(`clip-prefetch.ts`, today driven by `clip-refresh.ts` for the *stills*). The
move is: when a surface opens a camera's list, the first N *playable* rows
queue the production of their `sub`, behind the same
`hostBusy` that already yields to interactive work. Cost: the camera's
bandwidth for N files that perhaps nobody looks at — hence N small (3) and
**only** on the `sub`, never on the `main`.
Risk: on a hub child the prefetch and an operator tap compete for the
same session. The `hostBusy` gate must be asked *per file*, not per
tick.

**(b) `readClipBytes` in slices (`offset` + `length`).** The cap already names it
as the thing that removes the `too-large-to-transfer` refusal. Contract:
`offset` and `length` **both mandatory when either one is present**
(an absence is not zero — D382), response with `totalBytes` and `served`, and the
per-slice bound stays 50 MiB. The produced file is already on scratch, so the
slices are file reads, not re-downloads from the camera: it costs one slice of
memory instead of the whole, and it unblocks the main twins (11.3% of 592's mains
fall in the refused band).
Note: it does **not** speed up the first frame — production stays total.

**(c) The first frame without waiting for the last.** The only intervention that
really touches perceived time. The player already has a true Range route
(`/addon/provider-reolink/clip/<dev>/<key>.mp4`, `createReadStream().pipe`,
native backpressure, D447): the step is to make that route servable
**while** `produceTwin` is still writing, i.e. a progressive mux onto a file
and a 206 that follows the tail. It is the biggest piece and the riskiest: a
`+faststart` moves the `moov` to the front *at the end of the mux*, so either
faststart is given up for a fragmented fMP4, or one accepts that the first frame
arrives anyway once the mux has finished. **A decision to take before writing
code**, not during.

**(d) The D568 retry must be visible.** The long 2,000 ms window is
paid on every truncated clip and today is only readable in the log. It must go into the delivery
record (`ClipBytes`) as "this delivery cost a second round",
otherwise a systematic slowdown on one camera stays invisible.

**Recommended order:** (a) → (b) → (d) → (c). (a) and (b) are small and
measurable; (c) is a project in itself.

---

## 2. An events cap from the camera itself

### 2.1 The reader already exists and is not wired

`packages/addon-provider-reolink/src/clips/clip-event-catalog.ts` — cmd
516/517/518, the hub's cross-child event feed. It is **kept on purpose**,
tested, and imported by nothing: `clip-event-path-is-not-wired.spec.ts` verifies
it. It was retired as a *clip catalog* (D565) for two measured reasons —
`FileInfoList` is faster (137–514 ms against 678–950 ms) and the grain was
wrong (an event is not playable on its own: 28 rows out of 29 had to be joined
to a file anyway).

**Neither reason applies to an events cap**, because there the right grain
*is* the event and no file is needed behind it. The document already says so:
*"il feed eventi dell'hub è una domanda DIVERSA dal catalogo clip di una
camera"* [the hub's event feed is a DIFFERENT question from a camera's clip
catalog].

### 2.2 What it would buy

Today the heatmap is filled only by what **our** pipeline has
deduced by decoding the stream. A sleeping battery camera produces
nothing for us, but it woke itself up, recorded, and wrote into its
own event log. That log is history that we throw away today.

### 2.3 The shape, and the traps

- **A new cap**, not a branch inside `videoclips`. A cap that answers
  "what happened" and one that answers "what can I play" are two
  questions, and D565 is the record of what happens when they are merged.
- **The camera's events are not our events.** They go into a declared
  source (`source: 'camera'`), never mixed into the same table without
  a row saying who produced it — otherwise a threshold of ours and a
  threshold of the firmware become the same number.
- **Topology, as for the catalog** (the table in `clip-refresh.ts`): standalone
  mains reads by itself, hub child reads *through* the parent with the
  child's uid (65 ms, the child does not notice), **standalone
  battery is not read by a timer** — ever. An events cap that ignored
  this table would wake 640 and 4263 on every tick.
- `bHasRecFile: false` is the honest answer "for this event there is no
  clip", not a row to hide nor one to show as playable
  (D549 10).
- Measured over 20 days: 3628 → 222 rows, 0 orphans; 3629 → 1,059 rows, 0
  orphans; 3825 → all orphans (uid never persisted). **A surface built
  on one of the two extremes is wrong on the other.**

### 2.4 Order

First the **per-camera reader** with the topology matrix and a test that
proves a standalone battery camera is never touched. Then the cap. Then
the write into the store. The surface last.

---

## 3. Linking events and clips — the hole that keeps the two stories apart

`Clip.eventIds` exists in the schema and is filled from **a single place**:
`packages/addon-pipeline/src/recorder/addon/videoclip-visits.ts:237` — the
recorder's analytic visits, i.e. CamStack's clips.

A native Reolink clip carries `nativeTypes: ["md","dog_cat"]` and `labels:
["animal"]` (read from `clip-alarm-labels.ts`), and **zero `eventIds`**. Therefore:

- by tapping a native clip one cannot open the corresponding event;
- the heatmap and the clip list tell two stories that never meet,
  on the same camera and in the same minute.

The link is by **temporal containment**, exactly as
`clip-event-catalog.ts` already joins event → file (`[start, end]` inside
`[fileStart − 3 s, fileEnd + 3 s]`, 28/29 on the measured day). Two caveats:

- the join must be done **at read time**, not written into the catalog row: the
  camera's catalog is a projection of the camera, and writing our ids into it
  makes it a second authority;
- the `MAX_CLIP_EVENT_IDS = 24` ceiling stays: `eventIds` was 99% of the payload
  of a camera-day when it was absent (2,345 ids), and that is why
  `eventCount` exists next to it.

---

## 4. Checking the continuous recordings

Today `recording` exposes `getAvailability`, `getAvailabilityBatch`,
`getDaysWithRecordings(+Batch)` and `RecordingConfig.enabled`. They are all
questions that *a surface asks when someone is looking*. **There is nothing
that asks the question by itself.**

The missing question is a single one: *for each camera with
`RecordingConfig.enabled`, is the coverage of the last N hours continuous?*

Proposed shape:

- a **periodic verifier**, not a surface: it walks the enabled
  cameras, asks for the availability of the window, and produces a verdict per
  camera with the **gaps**, not a percentage;
- **a failed measurement is `null`, never `0`** (D393): a camera that did not
  let itself be queried is not a camera without coverage, and the two things
  produce opposite actions;
- **a switch that is off is reported off** (D62): a camera whose recording is
  disabled by the operator must never appear as broken;
- **every line carries `tags: { deviceId }`**, because the question is always
  per-camera ("why does 102 have gaps and 101 does not?");
- the verdict goes where the operator already looks, and the gaps must be **named** —
  a gap without a cause next to it (writer restarted, location in `drain`,
  disk not readable, camera unreachable) is an alarm that nobody can
  close. The candidate causes are already names this repo has:
  `storage-location-mode`, `PlacementCapacity.error`, the `CrashSupervisor`.

It is not a big job; it is a job that **does not exist at all** today, and it is
the reason a 3-hour blackout was diagnosed by hand.

---

## 5. Recommended overall order

1. **§1 (a)** prefetch of the `sub` from the list — 32× on the case the operator
   really touches, and the machinery is there.
2. **§4** the continuous-recording verifier — small, and it closes the hole
   that has already cost an unseen blackout.
3. **§3** the event ↔ clip join at read time — unlocks the heatmap and the clip
   list as a single thing.
4. **§2** the events cap from the camera — the piece that adds *new history*,
   but which must be done after §3, or we end up with two sources of events before
   having a place that knows how to join them.
5. **§1 (b)/(d)**, then **§1 (c)** as a project in itself.

## 6. Things still open, not planned here

- Exiting clip mode: to the list or to live? (not decided
  by the operator; the recommendation stays *to the list*).
- The three `ClipsSurface` fields not consumed — `playhead`, `transport`,
  `stepsClips` (`clips-surface-consumed.spec.ts`).
- The provider ignores the `since`/`until` window of `listClips`.
- `latest-mac.yml` is x64 only.
