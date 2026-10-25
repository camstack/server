---
title: How the reference NVR serves a scrub — teardown, honest comparison, ordered plan
covers:
  - packages/addon-pipeline/src/stream-broker/recorded/**
  - packages/addon-pipeline/src/recorder/**
status: analysis + plan
date: 2026-08-25
---

# How the reference NVR serves a scrub

> Source studied: `~/Desktop/NVR` (the reference NVR plugin 0.12.x, commercial).
> **Nothing was copied.** The bundle was read to recover the *approach*; every
> proposal below is our own code on our own constraints.
>
> Method note, because it bounds confidence: `main.nodejs.js` on disk is a
> **beautified** copy of a minified bundle, and `main.nodejs.js.map` has
> `sourcesContent: null` and generated columns that do not align with it (map
> dated Dec 31, js dated Jan 4). Original TypeScript is therefore **not
> recoverable**. What *is* recoverable, and what everything below rests on:
> the `sources` list (206 modules with their real paths), and the map's `names`
> array attributed per source file and original line — which reconstructs each
> module's function/variable skeleton. Bodies were then located in the
> beautified bundle by string search. So: **file attributions and identifier
> names are from the sourcemap; control flow and constants are read directly
> from the shipped code.** Line numbers cited as `L…` are bundle lines in
> `main.nodejs.js`.
>
> Companions, not restated:
> [`2026-08-25-scrub-advanced-analysis.md`](2026-08-25-scrub-advanced-analysis.md)
> (where our time goes, measured),
> [`2026-08-25-media-plane-comparison.md`](2026-08-25-media-plane-comparison.md)
> (process/memory/transport),
> [`2026-07-29-recorded-read-path-strategy.md`](2026-07-29-recorded-read-path-strategy.md)
> (discovery/location/delivery).

---

## 0. Two premises in the brief that the code contradicts

Both were stated as fact and both are wrong; correcting them changes the plan.

**"Scrub thumbnails" do not exist in either system.** the reference NVR has no filmstrip,
no sprite sheet, no per-position image fetch. Dragging their timeline pushes
**decoded video keyframes down the transport that is already open**. We do the
same thing (D42). The `/thumbnail/<id>/<time>.jpg` route in their bundle is the
*event* thumbnail on cards and the timeline overlay — not the drag. Our sprite
tier was built, served zero frames in production, and was deleted on 2026-07-24
(D41 amendment); `cleanupLegacyThumbsDirs()` in
`packages/addon-pipeline/src/recorder/addon/index.ts:1345` (called at :1267)
still rm -rf's the corpse at boot. **So the architecture question is not "precomputed vs on
demand". Both systems generate on demand. The question is what one frame
costs.**

**"In thirty minutes of traffic the scrub path produces not one log line" is
false as of the current tree.** `RecordedFeeder` emits `scrub-feeder:drag-end`
(≈60 scalar fields, `ScrubDragLogFields` in `scrub-drag-stats.ts:102`), plus
`pushed`, `parked`, `no-footage`, `snapped`, `slow-locate`, `ack-timeout`,
`tick-failed`, `warm-start`/`warm-done`. Wired to `sessionLogger.info` at
`broker-webrtc-server.ts:1726`. The 48 h census in the companion doc was built
from exactly these lines. What is genuinely dark is listed in §5 — and it is a
short, specific list, not the whole path. **I could not verify whether those
lines reached Loki during the operator's thirty minutes**; that needs a query,
not a code read.

---

## 1. How the reference NVR serves a scrub

### 1.1 Storage layout, and where the seek table comes from

`src/recording-files.ts`, `src/recorder-session.ts`.

```
<disk>/the reference NVR-<deviceId>[.<destination>]/<sessionStartMs>/<hourStartMs>/<timeMs>.rtsp
                                                                          <timeMs>.json
```

- Four destinations: `local-recorder` (main), `low-resolution` (substream),
  `remote`, `events`.
- `getAllRecordingsDirectories(destination)` (L13800) routes
  **`low-resolution`, `remote` and `events` to `fastDisks`** (`/mnt/nvr/fast/*`
  or the `fastDisks` localStorage list) and main video to `largeDisks`
  (`/mnt/nvr/large/*`). This is not a tuning knob — it is the first branch of
  the function.
- **There is no database.** Directory names *are* the index; retention is
  `rm -rf` of the oldest directory.
- `Xc = 60000` → **one 60-second file per segment**. `Jc = 2000` →
  **`videoSeekPointsInterval = 2000 ms`**. Both at L14177.
- The `.rtsp` file is the raw RTSP interleaved byte stream — `$`, channel,
  16-bit length, RTP packet — exactly what came off the wire. No container, no
  remux, no transcode at ingest. Codec parameters live as an SDP string in the
  session-level JSON (their changelog: *"move sdp into json. elimate 1 scrub
  read"*).

The part worth stealing is **how the seek table is produced** (L19700ff):

> The reference NVR does not write the recording. The upstream RTSP source (the
> Rebroadcast plugin) does, over two custom RTSP verbs. The NVR sends `WRITE`
> with `x-`the reference plugin`: <path>` to open/rotate a file, and `WRITESIZE`
> every 2 seconds; the response header `x-`the reference plugin` is pushed
> straight onto `videoSeekPoints`. A tick every 2 s; every 30th tick
> (`l % 30 == 0`, i.e. 60 s) rotates the file and flushes the segment JSON.

So the seek index is literally *"how many bytes have you written so far,
sampled every 2 s"*. Zero parsing, zero decode, zero keyframe detection at
ingest, and the offsets are guaranteed packet-aligned because the writer only
ever flushes whole packets. Retention piggybacks the same request
(`x-`the reference plugin`).

Per-segment JSON:
`{ endTime, recordedEvents, videoSeekPoints: number[], videoSeekPointsInterval: 2000, segmentWritten }`
— 30 numbers per minute of video.

### 1.2 The seek itself

`src/session-stream.ts`, `getNvrSessionStream`:

1. resolve disk/session/hour/segment by **comparing directory names** to the
   requested epoch;
2. `eventsFile = immutableReadFileJson(segment.eventsFilename)` (cached);
3. `skipCount = Math.floor(seek / videoSeekPointsInterval)`;
   `readPosition = videoSeekPoints[skipSeekIndex]`;
4. `fs.createReadStream(segment.rtspFilename, { start: readPosition })`;
5. re-parse the packets with `RtspServer(stream, sdp).handleRecord()`; playback
   time is derived from RTP timestamps with rollover accumulation, anchored to
   `segmentStart + seekPointIndex × 2000`.

**Cost of a seek: one cached JSON read, one array index, one `pread`.** No
scan, no demux, no RPC, no index.

`src/rtsp-reader.ts`, `getSyncFrame(generator, searchDuration, keyframeOnly)`:
reads start at **`target − 4000 ms`**, scan forward for an IDR with a search
window of **8000 ms when keyframe-only, 16000 ms otherwise**, and throw if not
found. `H264Repacketizer`/`H265Repacketizer` synthesise STAP-A / AP packets
carrying SPS/PPS(/VPS) so the decoder can be configured at *any* keyframe
without having read the head of the file.

**Cost of the first frame after a seek: one sequential read of at most one GOP,
from a file on SSD.**

### 1.3 The scrub gesture

Two implementations of the same shape — `Fu.scrub`/`scrubInternal` (L20199ff,
the WebCodecs path) and `gd.smoothChangeStream` (L14996ff, the RTSP/WebRTC
path). Constants: `Pu = 1000` (animation window ms), `ku = 33` (frame budget
ms), `Ou = 30` (step ms), frames = `round(1000/30)` = **33**.

```
scrub(targetTime, destination):
    smoothChangeTargetTime = targetTime
    smoothChangeEnd        = now + 1000
    this.scrubbing ||= scrubInternal()          # SINGLE FLIGHT
```

Everything important is in those three lines plus the loop:

- **Single flight, latest-wins, retargeting.** A new pointer position does not
  start a second animation and does not queue. It overwrites the target and
  extends the deadline of the loop already running.
- **Fixed total cost.** ≤33 frames, ~30 ms apart, inside a 1000 ms window —
  *whether the user drags one minute or one week*. The visible timeline span
  does not enter the calculation anywhere.
- **A minimum media-time step of 4000 ms.** `step = delta / framesRemaining`,
  clamped so `|step| ≥ 4000`; the loop breaks when the remaining delta drops
  below 4000. Two scrub frames are never closer than 4 s apart in media time,
  so no two reads in a gesture can land in the same GOP.
- **Every frame has a hard deadline equal to the remaining animation window.**
  `await Z(smoothChangeEnd - now, this.getKeyFrame(t))`. On expiry: `continue`
  (skip that frame) or `break`. **A frame that cannot be produced in time is
  dropped, never awaited.**
- On finish, `changeStream(targetTime)` opens the real playback stream with
  `highWaterMark: 8388608` (8 MB read-ahead).

`getKeyFrame(time, destination = 'low-resolution')` — note the default —
returns one self-contained buffer: a 10-byte header (RTP timestamp u32,
payload type u8, `isKeyFrame` u8, time-in-seconds u32) followed by Annex-B
NALs, parameter sets first. It is emitted on `callback.onScrubFrame(...)`, a
channel distinct from `onKeyFrame`/`onPredictedFrame`, so scrub frames do not
disturb playback decoder state.

**Short forward moves never touch the disk** (`smoothChangeStream`):

| forward delta | what happens | disk seeks |
| --- | --- | --- |
| < 16 s | `setPlaybackRate(max(1, delta/1000))` on the **already-open** stream, `waitEnd(target)`, restore | 0 |
| 16–60 s | switch the open session to `destination: 'low-resolution', neverTranscode: true`, fast-forward at `delta/1000`, switch back to main res | 0 new random seek — the open fd reads forward |
| > 60 s, or backwards | the 33-step keyframe animation on `low-resolution` | ≤33, deadline-bounded |

`yd(id, time, destination)` is an explicit ordered fallback: a segment whose
`segmentStart` is more than **300000 ms** from the requested time counts as
*not found*, and the destination degrades `low-resolution → remote → local`.

### 1.4 The client half

`fs/dist/assets/index.es-*.js` (Vue, minified, no map — read by string search;
lower confidence than the backend, but the shape is unambiguous).

The recording stream is requested with `container: "webcodec"` and decoded with
`VideoDecoder` + `EncodedVideoChunk`. **`scrub(time, destination)` is a method
on the already-open recording stream** — no HTTP request, no new connection, no
image fetch. Before it ever calls the server:

```
if (time === lastTime) return;                    // dedupe
delta = target - current;
if (0 < delta < 30000) {
    if (delta < 4000) return changeTime(target);  // plain seek
    B = undefined; U = target; m.flush();         // let the open stream FF,
    return;                                       // flush the decoder only
}
H = w.scrub(target, dest);
V ||= H.finally(() => { V = undefined; });        // SINGLE FLIGHT client-side too
return H;
```

So there is a single-flight guard on *both* ends, and a 30-second forward
window that is served entirely by decoder-side flushing.

### 1.5 Event thumbnails and the timeline index

`fetchRecordingStreamThumbnail` (L20841), served at
`GET …/hotlink-ok/thumbnail/<deviceId>/<timeMs>.jpg?detectionId=&width=&height=&left=&top=&right=&bottom=`
with **`Cache-Control: max-age=31536000`** — the browser HTTP cache *is* the
client cache. Resolution ladder:

1. disk memo: `sha256(`${time}-${detectionId||'none'}-${JSON.stringify(options)}-v1`).hex.slice(0,8)`
   → a `.jpg` **in the same hour directory**, so retention deletes derived
   crops for free and there is no eviction policy to write;
2. the detection JPEG written at detection time → resize/crop → memoised
   fire-and-forget;
3. the snapshot JPEG named by exact time → same;
4. last resort, **and it logs**:
   `console.warn("thumbnail generator using video stream", { time, detectionId })`
   → decode one frame, 5000 ms timeout.

`getRecordedEvents` (L20603) builds the timeline: it prunes whole sessions and
whole hours by **interval overlap on directory names**, reads **one rollup JSON
per closed hour**, and when a rollup is missing reads the 60 per-minute JSONs,
concatenates, and writes the rollup — self-healing compaction, only once the
hour is closed. The current hour comes from the recorder's in-memory array.
Coverage bars are synthesised (`nvr-synthesized-online-*`) from directory
boundaries, not stored.

`src/immutable-fs.ts` underpins all of it: file contents and `readdir` results
cached with **no invalidation** (closed hours are immutable), writes are
write-through (`immutableEnsureCache` inserts the new dirent into the parent
dir cache), and eviction is coarse — entries bucketed by `clippedToHour`, one
timer drops the whole bucket.

---

## 2. Answers to the five questions, side by side

| | the reference NVR | CamStack |
| --- | --- | --- |
| **Preview frames precomputed?** | No. Decoded on demand from `low-resolution`. | No. Demuxed on demand from `low`. **Same answer.** |
| **Granularity** | ≥4 s media-time between frames, ≤33 frames per gesture, fixed 1 s window | sweep = frame-granular within 4 s; jump = 1 keyframe; rate bounded by credit cap 2 and 33 ms coalesce |
| **Does density change with a 1-day window?** | **No.** Nothing in the scrub path reads the visible span. | No for frames either; only the activity-bar bucket scales (`pickBucketMs`, span/240). |
| **Seek** | `videoSeekPoints[floor(dt/2000)]` → `pread`. In-process, cached JSON. | `recording.locateSegment` — a **cross-process tRPC call** broker → hub-main → recorder, against a 3.5–5.9 M-row RAM index (717 MB–1.3 GiB). p50 6–9 ms, p90 300 ms, max 618 ms; 1–8 s on a saturated hub. |
| **First frame after seek** | one sequential read ≤1 GOP from SSD | whole 230 KB `low` segment (or 3 ranged reads) from a **5400 rpm SMR USB disk**: **531 ms p50 cold, 9.2 s max**; 28 ms warm |
| **Prefetch signal** | none. Read-ahead is `highWaterMark: 8 MB` on the settle stream, and short forward moves are fast-forward not seek. | directional prefetch (2 same-direction deltas, ≤2 in flight, suppressed when median of last 5 reads ≥600 ms) + ±15 min idle warm at 250 ms gaps |
| **Storage format** | raw RTSP/RTP `.rtsp`, 60 s files, 2 s byte-offset table in JSON, no DB | fragmented MP4 `.m4s`, 10 s files, `tfra` keyframe table in RAM with a 26 h TTL, no DB (RAM index derived from filenames) |
| **Event thumbnails** | plain HTTP URL, `max-age=31536000`, disk-memoised by content hash inside the hour dir | **base64 inside tRPC JSON, through hub-main's single event loop.** Uncacheable by the browser, +33 % size, JSON-stringified on the busiest loop in the system. |

---

## 3. Where we are more expensive, and why

Ordered by how much of the operator's complaint each one explains.

**3.1 The medium, not the algorithm.** the reference NVR's design *places* the
substream and the event data on fast disks — it is the first branch of
`getAllRecordingsDirectories`, not a setting. Our `roots.ts` already routes
`low` to a `recordingsLow` location and the hub already has
`recordingsLow:default` — pointed at the same 5400 rpm SMR USB spindle as
everything else. We measured the gap ourselves: **531 ms cold vs 28 ms warm,
19×**. Every other item below buys headroom on a disk that is 99–100 % busy
whenever anything reads. **Only this one closes the gap**, and it is the
precondition of the design we are being compared to. The operator froze it; the
plan below therefore leads with what works without it, but the honest headline
is that we are comparing a design that assumes SSD against a spindle.

**3.2 We have no deadline on a scrub frame.** Ours is
`SEGMENT_TIMEOUT_MS = 8000` per RPC. The reference NVR's is *the remaining animation
window*, ≤1000 ms, after which the frame is abandoned. With a cold read p95 of
1.4–2 s and a max of 9.2 s, our feeder spends the gesture *waiting* where
theirs would have dropped four frames and drawn the fifth. This is the
mechanism behind "quasi zero frame": not that we ask for too many, but that we
wait too long for each one. **Cheapest high-value fix in the document.**

**3.3 Locate is an IPC round trip; theirs is an array index.** We cross the cap
boundary (broker runner → hub-main → recorder runner) to answer "which file
holds instant T", and hold 717 MB–1.3 GiB of RAM to make it fast. The reference NVR
answers it from directory names plus a 30-number array, with an unbounded
immutable cache. We are not going to delete the index this week, but the ratio
matters: their locate is free and ours is the second-biggest term in a cold
tick.

**3.4 A 60-second forward scrub touches six files for us and one for them.**
Their 60 s file plus the fast-forward branch means a ≤60 s forward move is a
*sequential* read on an open fd. Our 10 s segments turn the same gesture into
six random seeks — the single worst access pattern for the disk we are on.

**3.5 Event/track media goes base64 through hub-main.** Their thumbnails are
plain URLs the browser caches for a year. Ours are base64 inside tRPC JSON,
MsgPack over UDS, then `JSON.stringify` on hub-main's loop. This is almost
certainly the "pagina eventi lenta" and it is **independent of scrub and
independent of the disk**. Note we already do it right *somewhere*: the still
route answers `private, max-age=31536000, immutable` — and no viewer code calls
it.

**3.6 Our destination fallback silently disables three optimisations.** Their
`yd()` degrades `low-resolution → remote → local` explicitly. Ours falls back
to `high`, and because `SCRUB_WHOLE_SEGMENT_PROFILE`, the entry warm and the
48 MB cache budget are all gated on the exact string `'low'`, a momentary hole
in `low` turns scrub into 3-seek GOP reads over ~5 MB segments with a 2 MB
budget — and the client cannot repair it (D49). Three cameras have no `low` at
all; cold high-GOP read there measured **2642 ms**.

**3.7 The velocity mapping the whole design depends on is parked on a branch.**
`feat/scrub-velocity-mapping` in the viewer submodule (`7919ca8`, 937 + 592
tests green). Without it the census reads **282 jumps vs 3 sweeps in 48 h** and
`mapUnknown = 167/167`. At ~8.8 s/px a careful three-pixel move is a 26-second
jump — outside the 4 s sweep window — so *every* tick is a cache miss and a
cold read. The reference NVR has no equivalent because their fast-forward branch makes
short moves free regardless of how the finger maps to time.

---

## 4. Format: what to take and what to leave

The operator is open to changing the storage format. My verdict: **do not adopt
`.rtsp`, and take two specific things instead.**

Against adopting raw RTP: no player opens it, every export/download/HKSV/HLS
path would need a full RTP→MP4 remux, and we get keyframe-cut self-contained
fragments free today from ffmpeg's `segment` muxer. The previous strategy doc
rejected a format migration; I agree, and now with the mechanism-level reason.

What is actually valuable in their format is not the container:

**(a) The seek table is a by-product of the WRITE, never re-derived by the
reader.** They sample the writer's byte count. We already capture `tfra` at
finalize (`mfra-capture.ts`) from page cache — but hold it in RAM with a
**26-hour TTL**, so anything older costs an extra random tail read on the
worst-behaved disk in the system. **Persist it.** A ~30-byte-per-segment
sidecar (or an extra field in the filename, which already encodes
`startMs-durMs-bytes`) removes the re-derivation entirely and survives restart —
which also removes the 9-minute window after a deploy where the index is empty.

**(b) 60-second segments.** Their `Xc = 6e4` against our
`DEFAULT_SEGMENT_SECONDS = 10`. Six times fewer index rows (3.5 M → ~104 k),
six times fewer file opens per unit of timeline, and it is what makes a
sequential-forward strategy possible at all. **Caveat that must be designed
around, not discovered:** `SCRUB_WHOLE_SEGMENT_MAX_BYTES = 1_500_000` was tuned
on a ~230 KB 10-second `low` segment. A 60 s native `low` is ~1.4 MB — right at
the edge; a 60 s *derived* `low` after the GOP fix would be ~4.8 MB and would
silently fall back to GOP reads. The read unit has to become a byte budget over
the `tfra` table, not "the whole file".

Not worth taking: their per-hour rollup JSON and directory-name index are
elegant and would cut ~1 GiB of RAM, but that is a memory and boot-time win,
not a scrub win, and it is a large change. Park it behind everything below.

---

## 5. What is genuinely dark on our path

Named because CLAUDE.md's rule is "a branch that DROPS work silently logs it",
and each of these drops work silently today:

- `scrub-fragment-cache.ts` — `get`, `covering`, `put` and **eviction** have no
  logging at all. Hits/misses survive only as `coverMemo`/`coverCache`/
  `coverMiss` on the drag aggregate; **evictions are not even counted**. With a
  48 MB budget and a 15–17 minute working set, an eviction storm is invisible.
- `timeline-session.ts` — the entire control dispatch (`handleControl`,
  `enterRecorded`, `playAt`, `resolveProfile`, `goLive`) is silent. This is
  where the `low` pin is lost (3.6) and nothing says so.
- `recording-provider.ts` — `locateSegment` and `readSegmentBytes` log nothing,
  including the disk-hydrate branch.
- `demux-off-thread.ts` — worker spawn failure, worker `error`/`exit` (which
  fails *every* pending job) and both ffmpeg fallbacks are silent. A missing
  `demux-worker-child.js` in `dist` silently moves mp4box back onto the live
  event loop with no line.
- `fmp4-keyframes.ts` — every null-on-garbage path is silent, including the
  250 ms `readTrack` settle timer.

Compare the reference NVR's discipline: their expensive last-resort thumbnail path emits
`console.warn("thumbnail generator using video stream", …)` precisely because
it is the branch you need to know about.

**Leftovers to delete in the same pass** (each currently reads as verification
of a design that does not exist):

- `RecordingConfigSchema.scrubThumbnails` (`'minimal'|…|'max'`) —
  round-tripped by `getDeviceConfig`/`setDeviceConfig` and rendered by
  `recording-config-form.ts`, **zero consumers in the recorder**. A knob the
  operator can turn that writes a store nobody reads (D62).
- `still-source.spec.ts:3` type-imports `ScrubSegmentRow` from
  `../../scrub/scrub-pack-service.js` — a module that no longer exists.
- `extractKeyframes()` in `fmp4-keyframes.ts:185` — no production caller.
- `camstack/embed/src/scrub/drag-mapping.ts` — referenced only by its own spec;
  `EmbedPlayerPage` calls `retarget(epochMs)` with no hint. (The parked branch
  fixes exactly this.)
- `onScrubDrawn` — plumbed end to end from `EmbedPlayerPage.tsx:752` to
  `LiveViewWebView.tsx:688`, and **no component passes the prop**. The client
  therefore has no timestamped record of "first scrub frame painted", which is
  the one number the hub cannot see.

---

## 6. Ordered plan

Ordered by gain ÷ risk, and deliberately front-loaded with work that helps on
the disk we have, since the SSD move is frozen.

### P0 — ship `feat/scrub-velocity-mapping` (viewer + embed)

Already written, 937 + 592 tests green, parked in a worktree. It converts a
careful drag from a 26-second jump into a ≤3.5 s sweep, and a sweep is served
from the **already-demuxed** AU run (0.6–35 KB, zero new read) instead of a
cold 531 ms segment read. It also turns on the census fields (`mapFine`,
`velPxPerS`) without which none of P1–P3 can be judged.

- Gain: the largest single change available without touching the disk.
- Risk: low — client mapping and a hint field the server already parses.
- Ship chain (all four, the embed page changed): `npm run update:patch` →
  `npm run sync:embed` → `npm run build:orchestrator` →
  `camstack deploy packages/addon-pipeline-orchestrator` → pin the submodule.
- Verify: `scrub-feeder:drag-end` with `mapFine > 0` and `sweeps ≫ jumps`;
  `recorded:warmed` present on timeline open.

### P1 — give a scrub frame a deadline (server)

In `RecordedFeeder.scrubTick`, bound the whole tick (locate + read + demux) at
a **scrub budget of ~700 ms**, not `SEGMENT_TIMEOUT_MS = 8000`. On expiry:
abandon the frame, do **not** retry, return the credit, count it as a new
`tickDeadlineMisses` field on the drag aggregate. This is the reference NVR's
`Z(smoothChangeEnd - now, getKeyFrame(t))` reproduced on our constraints.

Second half, same change: a **minimum media-time step between successive
jump-mode pushes**, so a gesture cannot spend two cold reads inside one GOP.
Their number is 4000 ms and it matches our `SCRUB_SWEEP_WINDOW_MS`.

- Gain: converts "nothing for 9 seconds" into "a frame whenever the disk
  cooperates". Directly targets the operator's "quasi zero frame".
- Risk: low-medium. It *drops* frames by design — the drag census must show
  `ticks` roughly constant with `firstPushMs` p90 falling, otherwise we made it
  worse.
- TDD note: write the deadline test first, then **remove the deadline and
  confirm the test fails** — this repo has twice shipped a green test that
  passed because the fake supplied what production forgot.

### P2 — take event/track media off hub-main and off base64

Serve event and track media from the owning runner via `ctx.dataPlane` as URLs
with `Cache-Control: private, max-age=31536000, immutable` for closed windows —
i.e. do everywhere what `serveStill` already does at
`recorder/addon/index.ts:1390`. Fixes the events page, is independent of scrub
and of the disk, and removes a base64 `JSON.stringify` from the busiest event
loop in the system.

- Gain: the second of the operator's three complaints, in full.
- Risk: medium — it is a transport change across several consumers.

### P3 — the short-forward branch, and the `low` pin

Two smaller server changes that only pay off after P0:

(a) When a forward target is inside `ScrubFragmentCache` coverage or within one
segment of it, serve it without `locateSegment` — we already hold the demuxed
segment; the miss is the RPC, not the bytes. This is the cheap half of
The reference NVR's fast-forward branch. I am **not** proposing their full
playback-rate fast-forward: their win comes from a sequential read on a 60 s
file, which we do not have until §4(b).

(b) Make the destination fallback explicit and *reported*: when `low` is
unavailable, log it with `tags: { deviceId }` and either keep the scrub budget
or refuse, rather than silently reverting to `high` with a 2 MB cache. Add the
missing logs from §5 in the same commit.

### P4 — persist the keyframe table, then 60-second segments

§4(a) then §4(b), in that order — the sidecar is small and independently
useful (it removes the post-deploy blind window); the segment-duration change
needs the byte-budget read unit designed first.

### P5 — the disk

Repoint `recordingsLow` (and event media) to SSD, and move the two 07:06
timelapse exports off the morning. Everything above is headroom; this is the
gap. Predicted: cold read 531 ms → ~5–15 ms, cold tick ≈ 50 ms p50.

---

## 7. What I could not verify

- **Whether the scrub lines reach Loki.** The code emits them; the operator's
  "not one line in thirty minutes" was not tested against a Loki query in this
  session. If they are missing there, the fault is shipping/scope filtering,
  not instrumentation — check `ALWAYS_SHIP_SCOPES` on the viewer side and the
  session logger level on the hub.
- **the reference NVR's original TypeScript.** `sourcesContent` is null and the
  beautified bundle does not align with the map's columns. Module boundaries
  and identifier names are from the sourcemap and are reliable; anything I
  attribute to a *specific line of their source* is an inference from the
  bundle, not a quotation.
- **Their frontend in detail.** `fs/dist/assets/index.es-*.js` ships without a
  sourcemap. The client-side scrub gating in §1.4 is read from minified code;
  the constants (4000, 30000) and the single-flight shape are unambiguous, the
  surrounding control flow less so.
- **Their measured latency.** Nothing here is a benchmark of the reference NVR. The
  operator's "≥20 fps vs our ~3" is the only comparative number we have and it
  predates the current tree.
- **`low` profile resolution/bitrate as a constant** — it is per-camera encoder
  config; the ~190 kbps / ~230 KB per 10 s figures are from comments and field
  samples, not from a definition.
- **Whether `demux-worker-child.js` is present in the deployed `dist`.**
  `existsSync` gates it and the fallback is silent (§5). Worth one byte-level
  check on the hub before trusting any `demuxMs` number.
