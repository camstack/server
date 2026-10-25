---
title: How the reference NVR stores an archive — and which of it survives contact with our recorder
last-verified: 2026-08-29
---

# How the reference NVR stores an archive

This document describes a **third-party product**, not camstack code. It carries
neither `covers:` nor `applies-to:` deliberately (D145): it claims no file in
this tree and vouches for none, so it must not arm the staleness ratchet. Its
subject is the recording, retention and detection-storage model of the
**The reference NVR plugin**, read from the shipped artefact, and what of that model
is worth anything to us.

**Why it was written.** `docs/design/2026-08-29-recorder-index-at-scale.md`
established that our recorder keeps a whole-archive, per-segment index resident
(~294 k rows today, projected 8 M–100 M at 30 TB), that boot replays the whole
archive synchronously, and that GC is ~49 % of the runner's CPU. It proposed a
residency split. Before committing to that shape it is worth knowing how a
mature commercial NVR on the same box answers the same questions — especially
the ones our document listed as undetermined.

**Relation to the media-plane documents.**
`docs/design/2026-08-29-media-plane-memory-comparison.md` covers the *live*
plane: prebuffer, decode, detection orchestration, and the licence boundary per
the reference NVR directory. This document covers only the *recorded* plane and the
detection **storage** that hangs off it. Where the two touch — the fork model,
what crosses a process boundary — this one adds the recorded-path evidence and
does not restate the live-path findings.

## 0 · Licence boundary and what that permits here

The reference NVR is a **paid, closed-source commercial plugin**. Nothing below is
code, identifiers, type names, function names, file names, comments or
constants from that product. Everything is a behavioural description in our own
words and our own vocabulary. Where a magnitude matters to an argument it is
given as an order ("about a minute", "a few seconds"), never transcribed as a
value to adopt. Nothing here may be pasted into camstack source, and no
proposal in §5 depends on reproducing their implementation — each is a design
position we would have to write from scratch, and several are things we should
**not** write at all.

## 1 · The artefact, and how much of it is actually readable

What was examined (`~/Desktop/NVR`, read-only, unmodified):

| File | Size | State |
| --- | --- | --- |
| main bundle | ~900 KB | **minified identifiers, pretty-printed on disk** |
| three per-function worker bundles | 34–243 KB | minified, single line |
| four `.map` files | — | `sourcesContent` is **`null`** in all four |
| product README | 62 KB | ~40 lines of prose, the rest a changelog |
| a browser bundle + a small WebAssembly module | — | the plugin's own web UI and its pixel-diff kernel |

**The premise that original sources were recoverable is false.** Every source
map ships `sourcesContent: null`, so no TypeScript was recovered. What the maps
*do* give is the **source-file inventory** (206 modules for the main bundle, 6–94
for the workers) and the original identifier list — enough to know what modules
exist and roughly what each is called, not enough to read them.

Two consequences shaped the method:

- The worker bundles are still single-line, so their maps are usable: a small
  VLQ decoder attributes byte ranges of the bundle to source modules exactly.
  Those regions were sliced out and beautified, and are genuinely readable
  (minified locals, intact strings and control flow).
- The main bundle was pretty-printed **after** the map was generated (its
  mtime is later; the map declares a single generated line). Its map is
  therefore unusable for it. The main bundle was read directly: string
  literals, log messages, settings metadata and control flow survive
  minification intact, and the archive layer turned out to be almost entirely
  string-driven, so this cost less than feared.

All line numbers below refer to the **pretty-printed main bundle as it sits in
that folder**; anyone re-deriving them must use that same copy.

## 2 · The seven questions, answered

### 2.1 · What is resident, and what is queried

**There is no archive index in memory at all.** Not per segment, not per hour,
not per day. Nothing is loaded that describes what footage exists.

The only long-lived structures the recorded path keeps are three caches, all
lazily filled and none of them archive-shaped:

1. **A directory-listing cache** (main bundle line 13705): every `readdir`
   result is memoised as a name→kind map keyed by absolute directory. Single
   entries are removed when a file is created or deleted; **nothing expires it
   wholesale and there is no size cap** (the only `delete` calls are on a failed
   read and on file-level invalidation — lines 13659, 13675, 13724). Its
   occupancy is O(directories actually visited), which for a browsing operator
   is O(hours viewed) and for the write path is a handful of directories per
   rotation.
2. **A file-content cache** for the small JSON sidecars (line 13624), expired
   not by LRU but by **hourly cohorts**: everything cached during the same
   wall-clock hour is dropped together after a fixed multi-day delay. The
   changelog confirms this window was deliberately lengthened at some point
   ("increase fs cache duration to 3 days", README line 2070).
3. **A free-space cache** with a sub-second lifetime (line 13743).

Everything else is asked of the filesystem at the moment of the question.

"Which file covers this instant" is answered by descending the tree and, at
each level, choosing the last child whose name (an epoch) is ≤ the target —
implemented as read-directory, parse names as integers, sort, pick (line
14140 for the picker, line 14160 for the descent). Coverage is then
**bounds-checked against the neighbour**: the candidate is rejected if the
target lies more than one segment-duration outside it, or beyond the end time
recorded in the segment's own sidecar (line 14113). A gap is discovered by that
rejection; there is no gap index.

"What footage exists in this window" is answered the same way, one level
coarser (line 20609): list the per-camera session directories, skip any whose
span misses the window — **the span's end is inferred from the next sibling's
name** — then list that session's hour directories and read each one's rollup.
Availability is not stored: session boundaries are turned into synthetic
online/offline markers injected into the same event stream the timeline already
renders. Clips are not stored either — the clip list is a **fold over that event
stream computed per request** (line 20489).

### 2.2 · Where the durable index lives

**The filesystem layout is the index.** No SQLite, no LevelDB/LMDB, no JSON
manifest of the archive. Confirmed negatively: a search of every shipped
JavaScript file for `better-sqlite3`, `sqlite3`, `node:sqlite`, any `level*`
package, `lmdb`, `rocksdb`, `nedb`, `lowdb`, and for the substrings `CREATE
TABLE`/`CREATE INDEX`/`SELECT ` returns **zero hits**.

The shape is a per-camera tree, one level per time granularity, every directory
named by the epoch at which its span starts, and the leaf files named by the
epoch at which the segment starts. Three things ride alongside:

- a **per-session descriptor** written once when the session opens, holding the
  stream description needed to play any file in it (line 19677);
- a **per-segment sidecar** written when the segment closes, holding its end
  time, the detection/sensor events that occurred inside it, and a
  **byte-offset table** (below);
- a **per-hour rollup** holding the hour's events, written by the writer when
  the hour closes (line 19686) **and lazily rebuilt by the reader** from the
  per-segment sidecars if it is missing, then persisted (line 20648) — but only
  for hours that are closed, never for the live one.

Derived media is also stored **inside the archive**: a requested thumbnail is
keyed by a short hash of (instant, detection id, crop/resize) and written into
the same hour directory as the events it belongs to (line 20842). Resolution
order is hashed variant → the detection's own still → an exact-instant still →
decode from video. The cache therefore has no lifetime, no eviction policy and
no orphan sweep of its own: it dies when the hour directory is removed.

**Seek cost.** A scrub tick costs one directory read per level, and the cache
above makes the second tick in the same hour free. It never costs a database
query, and it never costs a memory lookup because there is no memory to look
in.

**Within a segment**, seeking does not parse the container. The recorder is not
the writer (§2.6): it asks the writer how large the file currently is on a
fixed short interval and appends the answer to an array. That array — a sampled
map from elapsed time to byte offset — is what the sidecar stores, and playback
seeks by opening a read stream at the offset for the requested bucket (line
14846). The within-segment index is a by-product of polling, at zero parse
cost.

### 2.3 · Retention and cleanup

Three mechanisms, with different jobs.

**(a) The write path pays for its own space.** Immediately before rotating to a
new segment, the recorder walks for the single best deletion candidate and
hands its path to the writer in the same request that creates the new file
(line 19728). One new file, one old file reclaimed. The walk is a lazy
oldest-first generator and it **breaks after the first candidate**, so this is
O(1) directory reads per rotation, not a scan.

The candidate order encodes a fairness policy, in four passes: anything
belonging to a camera that no longer exists; then, having established the
globally oldest file, files of *this* camera and stream that are both older
than the retention horizon and within about a day of that global oldest; then
any file of that stream class within the same distance; then anything. The
effect is that no camera can run far ahead of the fleet's oldest footage, and
a removed camera's footage goes first.

**(b) A periodic sweep, every five minutes, in a disposable process** (line
21165). It computes an age cutoff if the operator chose a days-based retention
mode, otherwise it works purely from free space. It consumes the same lazy
oldest-first generator and removes whole **hour directories** (line 14043) —
never individual files — rechecking free space after each removal and stopping
the moment the target is met. With an age cutoff the walk is bounded to hours
older than the cutoff; without one it is bounded by how much space it had to
free. **Nothing scans the whole archive on a timer.**

**(c) The metadata plane is trimmed to follow the video** (line 13971): the
event/metadata tree keeps sessions only as far back as the oldest surviving
video session, so detections never outlive the footage they annotate.

Two free-space watermarks, an absolute floor plus a percentage, with the
write-path reclaim targeting the higher one and the periodic sweep the lower —
so the sweep is the safety net and the write path is the steady state. The
absolute floor scales with the number of cameras being recorded (line 21332).
There is also a hard refusal: below a small percentage free, recording stops
rather than filling the disk. The changelog corroborates the design ("make the
10-15% low watermark absolute regardless of disk size", README line 604;
"make file rotation check for free disk space", line 693).

Retention modes offered are: use all space and delete only to make room; delete
when full; or a days-based horizon with a floor of a few days.

**Storage tiering is explicit and static**, not a migration: directories are
classed as large, fast, or read-only archives, and *stream classes are assigned
to classes of disk* — the high-resolution continuous stream to large disks, the
substream/remote/metadata streams to fast disks (line 13795). Read-only
archives are excluded from both writing and every deletion path. Writers
round-robin across the eligible directories (line 13817). There is no
background rebalance and no per-device quota — the only quota is free space per
volume.

### 2.4 · Restart

**Boot is O(1) in archive size.** Startup does no enumeration of recordings at
all: it checks each configured directory's total size for an "is this disk big
enough" warning (line 21738), starts the five-minute sweep, and starts one
recording session per camera per stream class. A session does not resume the
previous one — it opens a **new** session directory named by the current instant
and starts writing. Discontinuity across a restart is therefore represented by
the directory structure itself, and shows up in the timeline as the synthetic
offline/online pair described in §2.1.

Nothing is replayed, nothing is rebuilt, and the first sweep — which is the only
thing that walks — runs in a process that is thrown away (§2.5). This is the
sharpest single contrast with our recorder.

### 2.5 · Memory ceilings

**The artefact sets none, and it needs none.** Searched across every shipped
JavaScript file: no `--max-old-space-size`, no `--max-semi-space-size`, no
`--expose-gc`, no `NODE_OPTIONS`, no `MALLOC_ARENA_MAX` / `MALLOC_TRIM_THRESHOLD_`,
no `UV_THREADPOOL_SIZE`, no `jemalloc`/`tcmalloc`, no call to `gc()`, no
`v8.setFlagsFromString`, and no `process.memoryUsage` telemetry. Three
`FinalizationRegistry` references exist and all three are inside the vendored
the reference NVR SDK's RPC layer, not in NVR's own code — that is the mechanism our
session already examined and rejected, and it is not present here as a plugin
practice.

**This is a real fact and it wants an explanation, not an endorsement.** The
plugin needs no ceiling because nothing it holds is a function of the archive:

- the archive index does not exist (§2.1);
- the two caches that could grow are bounded by *what was visited*, and one of
  them expires in cohorts;
- every walk that could touch the whole archive runs in a **short-lived worker
  that is terminated in a `finally`** (line 21825 and line 21836) — the
  directory cache that walk builds dies with it;
- the per-object tracker keeps only its last handful of observations (line
  17798 truncates the history on every append);
- the recognition database is bounded by clustering, not by detection count
  (§2.7);
- and the *bytes* — the thing that would actually need a ceiling — never enter
  this process at all (§2.6).

So the operator's position survives this evidence: a commercial NVR recording
continuously to a multi-disk array runs its plugin with stock V8 settings.
But the reason is structural. The absence of a ceiling is a *consequence* of
holding nothing O(archive) and of exiling every unbounded walk to a process
that dies; it is not an independent choice that could be copied on its own. A
camstack runner that floats 1.4–1.8 GB with a 66 MB retained archive would not
become safe by deleting `--max-old-space-size=3072`; it would become
unsurvivable sooner. The ceiling is the *symptom*; §5 says which of the
structural causes we can actually remove.

### 2.6 · Why fork per function, and what crosses

**The recorded path has no fork and no frames.** The continuous recording is
not written by this plugin. The plugin opens an RTSP session against the
rebroadcast layer, and issues a write command whose headers name (a) the file
the writer should write into and (b) the file the writer should reclaim (line
19728, §2.3a). It then polls the writer for the current file size on a short
interval (line 19755). **Media bytes never enter the recorder process** — it
moves file paths and integers. Our hardest constraint ("frames never cross a
process boundary at frame-rate", D9/D18) is not something they solved; it is
something the recorded path never poses.

The forks exist for the *analysis* path, and the split is by **function**
because the function is what determines placement. Each fork carries placement
labels — this one requires a compute-capable host, that one prefers an
accelerator-bearing one, the face worker asks for a host with a specific
inference backend installed. In a clustered install, a fork is therefore also a
*machine* choice. The decoder fork's assigned worker id is read back and passed
into the motion fork's request (line 15904) so that the two land on the **same
worker**, which is exactly the co-location argument our `detection` group makes,
expressed as a scheduling hint instead of a static group.

What crosses the analysis boundary, read from the worker bundles:

- **A frame is a handle, not pixels.** The decoder fork yields RPC-proxied frame
  objects; the consumer re-binds each one to a direct peer connection and holds
  a reference (`connectRPCObject`, motion worker region). A crop/resize is a
  *new handle describing a view* — no pixel work happens until someone asks for
  bytes (libav worker region, the view class).
- **When bytes are asked for, the reduction happens on the producer side.** The
  materialising call takes format, crop and target size, and the owning process
  runs the scale/convert in its filter graph — hardware-accelerated when the
  frame is on a GPU surface — and returns only the small result. The motion
  consumer asks for a **downscaled, often single-channel** buffer, capped at a
  few hundred pixels wide (motion worker region).
- **When the frame is on an accelerator, the computation is pushed to the
  frame.** If the frame reports a hardware device type, the motion consumer
  invokes the diff *through the handle* and only bounding boxes come back; it
  falls back to pulling a buffer only when that path fails (motion worker
  region). The pixel-diff kernel itself is a WebAssembly module loaded from the
  plugin's own volume.
- No `SharedArrayBuffer`, no `MessagePort`, no explicit transfer lists anywhere
  in the four bundles. The whole mechanism is the SDK's object-proxy RPC.

So the cost is paid, but at a *reduced* rate: one small buffer per analysed
frame, or zero when the accelerator path holds, and both endpoints are steered
onto the same host. The changelog is consistent with this having been hard-won
("set detection affinity to decoder cluster worker", README line 1342; "fixup
codec copy going to cluster worker", line 820; a long tail of frame- and
thread-leak fixes).

### 2.7 · Detection retention

**Per detection.** Every object/motion/sensor event is appended to two in-memory
arrays: the current segment's and the current hour's. The segment array is
written to the segment sidecar when the segment closes; the hour array to the
hour rollup when the hour closes (line 19686, line 19656). **Nothing is
retained in memory beyond the open hour**, and nothing is written anywhere else
— there is no detection table, no events database, no per-detection row.

**Per track.** The tracker keeps, per tracked object, only its last handful of
observations — the history array is truncated on every append (line 17798) —
plus first/last-seen scalars. Occlusion and motion state are decided from that
window and expire on short timers (lines 17920, 18993).

**Images.** One still per detection id is fetched and written into the events
hour directory; the motion path takes at most one per segment. Derived crops
are cached beside them under a hash key (§2.2). All of it is deleted by the
same directory removal that deletes the hour.

**Embeddings.** Per-detection embeddings live inline in the sidecars on disk —
i.e. their lifetime is the footage's lifetime. The *recognition* database is
different: it is a single JSON blob in the plugin's own settings storage, loaded
into the face worker when it starts and written back after updates (line
18044). It is bounded by **clustering, not by detections**: observations are
clustered per person, only a small number of representatives per cluster are
kept, unknowns get a larger but still fixed budget, and clusters whose
centroids are too close across two identities are discarded outright (face
worker region). Search over past detections has no index — it is a scan of the
event stream for the window being searched.

**Retention of detections is therefore not a policy at all.** It is a
consequence of where they are stored: they are inside the archive, so archive
retention removes them, and §2.3c makes sure they never outlive it.

## 3 · What camstack does, put beside it

Only the differences that matter to the index question. Our side is documented
in `docs/design/2026-08-29-recorder-index-at-scale.md`; nothing here restates
its numbers.

| Question | The reference NVR | camstack |
| --- | --- | --- |
| Resident archive description | none | every segment, whole archive, in `RecordingIndex` plus a full mirror in `packages/addon-pipeline/src/durable/durable-ledger.ts` |
| Durable index | the directory tree, plus tiny sidecars and a per-hour rollup | the tree **and** an hour ledger in the settings-store SQLite (`packages/addon-pipeline/src/recorder/addon/segment-hour-ledger.ts`), each hour row carrying its full path list |
| Segment length | about a minute | ten seconds — so ~6× the rows for the same footage |
| Within-segment seek | a byte-offset table sampled by polling the writer's file size | `mfra`/`tfra` parsed from the file tail (`packages/addon-pipeline/src/recorder/mfra-index.ts`) — exact keyframe offsets, no extra state, no writer cooperation |
| "Which file covers this instant" | descend directories, pick last child ≤ target, bounds-check the neighbour | binary search a materialised sorted view of the resident index |
| "What exists in this window" | list two directory levels, read the hour rollups | resident index; plus the calendar cache in `packages/addon-pipeline/src/recorder/addon/calendar-index.ts` |
| Archive-wide aggregates (bytes per device, oldest per device, placement demand, rebalance piles) | **not asked** — the only volume question is free space | asked on the usage page and by placement/rebalance; today several still walk RAM |
| Deletion trigger | the write path, one unit per rotation, plus a five-minute sweep | quota-driven eviction plus a retention sweep |
| Deletion granularity | a whole hour directory | individual segments |
| Where the sweep runs | a worker process that is terminated afterwards | in the recorder runner |
| Boot | nothing loaded, nothing replayed | one whole-collection ledger query, then a synchronous archive replay |
| Heap ceiling | none set | `--max-old-space-size=3072` on the runner |
| Detections | inline in the archive, hour-bounded in RAM | pipeline/track storage in SQLite, outside the recorder |
| Derived thumbnails | inside the archive hour directory, evicted with it | `packages/addon-pipeline/src/recorder/still/still-source.ts` and the still service, separate lifetime |

Two things we do that they do not, which the table must not hide:

- **We answer questions they never ask.** Per-device bytes and oldest, per-volume
  accounting, multi-location placement demand, rebalance piles, an eviction
  domain spanning several locations, per-device retention policies. Their model
  can afford to have no index precisely because their only archive-wide
  question is "how much free space", which `statfs` answers in constant time.
- **Our segments carry their own metadata in the filename** — start, duration,
  bytes, encoded by `packages/addon-pipeline/src/recorder/segment-path.ts:45`
  under a device/profile/Y/M/D/H tree. We already have their index; we simply do
  not rely on it, because we also built two copies of it in RAM.

## 4 · What is genuinely transferable

Each item states the mechanism, why it works for them, and whether the reason
holds for us.

### 4.1 · Adopt — the archive walk should not run where the heap must stay small

**Their mechanism.** Every unbounded walk — the periodic sweep and the
metadata trim — runs in a worker spawned for that call and terminated in a
`finally`. The directory cache the walk builds cannot outlive it.

**Why it works for them.** They have no database, so an archive-wide question
is *always* a walk; making the walk's memory disposable is the only bound
available.

**Does the reason hold for us?** Only partly, and that partial answer is the
useful one. The right camstack version is not a disposable process — it is that
**the walk should not happen**, which is exactly what stages 2–4 of the
index-at-scale plan do by turning archive-wide questions into SQL. Where a walk
genuinely remains (the operator-armed footprint rescan; the ledger reconcile
after a trusted walk), the disposable-worker idea is worth having in reserve,
and camstack already has the vehicle: `pipelineRunner.runStatelessStep` is
node-pinned, bounded work over stored media. **Verdict: adopt the principle
(transient bulk memory must not accumulate in a long-lived runner), reject the
mechanism (we should not spawn processes — D2 — when a query removes the need).**

### 4.2 · Adopt — the reader should repair the durable index it just rebuilt

**Their mechanism.** When a reader wants an hour's rollup and finds it missing,
it rebuilds it from the per-segment sidecars **and writes it back**, but only
for hours that are closed. The next reader pays nothing.

**Why it works for them.** The past is immutable, so a rebuilt rollup for a
closed hour is correct forever.

**Does the reason hold for us?** Yes, and we do not do it. Our readdir
fallback (`packages/addon-pipeline/src/recorder/addon/roots.ts:388`) feeds the
in-memory index via `packages/addon-pipeline/src/recorder/recording-index.ts:317`
and stops there — nothing upserts the hour row it just reconstructed. In the
tiered design that gap becomes load-bearing: a cold hour that has no ledger row
would pay a readdir on *every* eviction of its detail tier, forever. The fix is
small and belongs with stage 3: when the storage fallback builds a closed hour,
upsert it. It must be gated on "closed", exactly as theirs is, and it must not
turn a read into a durable write on the live hour.

### 4.3 · Adopt — derived artefacts belong inside the thing that gets evicted

**Their mechanism.** A generated thumbnail is written into the same hour
directory as the events it depicts, under a hash of its parameters. It has no
lifetime, no eviction policy, no orphan sweep: the hour's removal removes it.

**Why it works for them.** Deletion granularity is the hour directory, so
co-location is automatic.

**Does the reason hold for us?** The principle does; the placement needs
thought. We delete individual segments, so "inside the hour directory" is not
automatically safe — an hour directory that still holds one live segment must
not be removed. But the invariant worth importing is: **a derived artefact
should be addressed under the same key as the source it derives from, so the
retention decision that removes the source removes it too.** Every derived cache
with an independent lifetime is a future orphan sweep. This is worth checking
against the still/thumbnail tier before it grows.

### 4.4 · Consider, with named costs — segment duration is a free multiplier on our index

**The observation.** Their segments are about six times longer than ours. Row
count is `writers × days × (seconds-per-day ÷ segment-seconds)`; nothing else in
the index-at-scale scaling law changes. A longer segment divides every number in
that document's §2 projection by the same factor, on both the resident and the
durable side.

**Why they can afford it.** Their within-segment seek is a sampled byte-offset
table, so a longer file costs nothing at seek time.

**Does the reason hold for us?** *More* strongly, and that is the point. Their
seek table is sampled and approximate; ours (`mfra`) is exact keyframe offsets
read from the file tail, so a longer segment costs us nothing at seek time
either. The reason our segments are short is not seek resolution.

**But this is not free, and must not be proposed as if it were.** Named costs,
each of which needs its own answer before anyone changes a number:

- **Timeline gap resolution.** The index-at-scale document is explicit that an
  hour hiding a long gap must not render solid. Availability resolution is
  currently a segment; lengthening the segment coarsens it.
- **Eviction granularity.** Reclaim currently rounds up to one segment; it would
  round up to a longer one.
- **Loss on an ungraceful stop.** A segment that never finalises is a segment's
  worth of footage at risk, not ten seconds'.
- **Export and redundancy sweeps** both work in segment units.

**Verdict: a legitimate lever, quantified here for the first time, and out of
scope for the tiering work.** It should be evaluated on its own, against those
four costs, and never as a substitute for the residency bound — the residency
bound must hold at *any* segment length.

### 4.5 · Confirms our direction — boot must load nothing proportional to the archive

Their boot enumerates nothing and replays nothing; a restart opens a fresh
session and the discontinuity is *represented*, not repaired. That is
independent evidence for stage 2 of the index-at-scale plan, and for the
strongest form of it: the honest answer to "what happened before I started" is
the tri-state's `unknown`, and an NVR that ships to paying customers is content
to derive it from the directory tree on demand.

## 5 · What only works because of a design choice we have not made

These are the ones to refuse, and the reason to refuse each.

**No database at all.** Their tree is the index *because* the only archive-wide
question they ask is free space. The moment a product asks "how many bytes does
camera 102 hold, and what is its oldest footage", a directory tree stops being
an index and becomes a full scan. We ask that on the usage page, in placement,
in rebalance, in per-device retention and in the eviction domain. Removing our
durable index to imitate them would convert every one of those into an
archive-wide walk on the media array — which we have measured at hundreds of
milliseconds per hour directory under load
(`packages/addon-pipeline/src/recorder/addon/calendar-index.ts`). **The correct
conclusion from their design is the opposite of imitation: keep the database,
and stop keeping a second copy of it in the heap.**

**No heap ceiling.** §2.5 establishes the fact and the mechanism. The mechanism
is "hold nothing O(archive) and exile every walk", not "omit a flag". Removing
`--max-old-space-size` from our runner before the residency and churn work
lands would replace a bounded abort with an unbounded one. **The flag is a
symptom to be *earned* out of existence, not a patch to delete first.** If
stages 1–3 land and the measured heap floor is tens of megabytes independent of
archive size, the ceiling stops doing anything and can go; that ordering is not
negotiable in the other direction.

**Deletion by whole hour directory.** It is what makes their `rm -rf` cheap and
their thumbnail co-location automatic. It also means retention granularity is an
hour. Our per-segment eviction is what lets the quota nibble continuously
instead of dropping an hour of every camera at once. Do not trade it.

**A sampled byte-offset table produced by polling the writer.** Elegant given
that a *different process* owns the file, and strictly worse than reading
`mfra` from the tail when you own the writer, as we do. It also creates a
dependency on the writer answering a size query at rate. **Reject.**

**Victim selection that deviates from oldest-first for fairness.** Their
four-pass candidate order exists because they have no global view — they cannot
ask "which is the oldest segment in this domain", so they approximate it with
per-camera passes anchored to a rough global oldest. We *can* ask, in one
statement (`packages/addon-pipeline/src/recorder/evict-select.ts:6` and its
byte-target sibling), and strict oldest-first across the eviction domain is both
simpler and fairer than their approximation. **Reject; ours is better and the
reason is that we have the index they lack.**

**Static stream-class-to-disk-class assignment with no rebalance.** It suits a
product that will not migrate footage. We already run a relocation engine and a
placement-demand model; adopting their static scheme would delete capability.
Their *tiering intuition* — put the plane an operator scrubs on the fast device
and the bulk plane on the slow one — is already ours
(`docs/design/2026-08-26-low-events-storage-migration-to-ssd.md`).

**A per-request fold as the clip list.** Clips are recomputed from the event
stream on every query, which is affordable only because the event stream is
small, local, and the query is window-bounded. Our tracks are first-class,
queryable, enriched and cross-referenced. Not a model to move toward.

## 6 · What could not be determined

- **Anything that requires reading their TypeScript.** All four source maps carry
  `sourcesContent: null` (§1). Every statement above is inferred from minified
  control flow, string literals and settings metadata. Where a policy has a
  branch I did not exercise, I have not guessed at it.
- **What the writer actually does with the file it is told to reclaim.** The
  header names it as a truncation target. Whether the RTSP writer unlinks it,
  truncates it, or reuses the inode happens in the rebroadcast layer, which is
  **not in this artefact**. The behavioural fact — one new segment costs one old
  segment, chosen by the recorder — holds either way.
- **Whether the directory-listing cache is bounded in practice.** The code has
  no cap and no wholesale expiry, and removing a directory does not remove that
  directory's own cache entry (only its entry in the parent's listing). Whether
  this matters depends on browsing patterns and process lifetime, neither of
  which the artefact shows. It is stated as an observation, not as a defect.
- **The exact free-space watermarks and segment/poll intervals** were read and
  are consistent with the README changelog, but are deliberately not transcribed
  here (§0) and no proposal above depends on their values — only on their
  relative ordering (write-path target above sweep target) and their order of
  magnitude.
- **Whether the periodic sweep has always run in a disposable worker.** The
  changelog contains an entry removing a prune fork at an old version (README
  line 1606) while the shipped code clearly has one. It was removed and later
  reinstated; the intervening reasoning is not visible.
- **How search over past detections performs at scale.** The mechanism (scan the
  event stream for the searched window) is clear; whether it is usable across a
  month of an active fleet is not something a static artefact can show.
- **Whether their analysis forks would still avoid pulling full frames on a host
  with no accelerator.** The fallback path materialises a downscaled buffer per
  frame; the accelerated path returns only boxes. Which one runs on a given
  install is a runtime property, and the artefact only shows that both exist and
  which is preferred.
- **Nothing here was measured.** This is a code-and-artefact reading, not a
  benchmark. Where the media-plane documents give measured comparisons, they
  measured them; this document adds no numbers of its own about their product.
