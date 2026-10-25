---
title: The native frame hold — why a lifetime-scoped hold is the right shape, and why holdFrames is not the knob it looks like
last-verified: 2026-08-26
covers:
  - packages/addon-pipeline/src/session-decode/native-lease-store.ts
  - packages/addon-pipeline/src/session-decode/decode-worker-child.ts
  - packages/addon-pipeline/src/session-decode/frame-slot.ts
  - packages/addon-pipeline/src/session-decode/local-frame-registry.ts
  - packages/addon-pipeline/src/session-decode/retained-frame-store.ts
  - packages/addon-pipeline/src/session-decode/live-worker-admission.ts
  - packages/addon-pipeline/src/pipeline-runner/index.ts
  - packages/addon-pipeline/src/pipeline-runner/on-demand-retention.ts
  - packages/addon-post-analysis/src/pipeline-analytics/runtime/capture-scheduler.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/key-frame-persist.ts
  - packages/types/src/pipeline/native-lease.ts
---

# The native frame hold — lifetime vs count

> Follow-up to `2026-08-25` Task 0.2 (planning repo: sessions/sessions.md) (`nativeMiss` is
> 99.79% of key-frame failures; `holdFrames=8`) and to
> [`2026-08-13-native-lease-two-tier-redesign.md`](./2026-08-13-native-lease-two-tier-redesign.md).
> Read-only analysis on live traffic, 2026-08-26. No code changed, nothing
> deployed, no settings written.

**Window:** the 12 h ending 2026-08-26 ~00:20 local, 20 cameras, three detection
nodes (`hub`, `<agent-host>`, `agent-a`). Sources: Loki
metric queries (`sum/quantile_over_time … | json | unwrap …`, datasource
`befzniup0e77ka`), one 30-minute raw pull of `session-decode metrics`
(1 075 lines, 140 worker runs), and `pipelineRunner.getLocalMetrics` over tRPC.
No database access.

---

## 0. The four answers, in one page

1. **Where the ~1 s comes from.** Not transport, not encode, not the fetch. The
   fetch round-trip is **18 ms p50 / 120 ms p90**. The runner's own
   enqueue→emit is **239–328 ms avg** (p95 447–571). Everything else — **~70 %
   of the p50 age** — is spent on the hub between the inference-result event
   being emitted and post-analysis reaching `persistKeyFrames`, and **nothing
   measures that span**. The p90/p99 tail (7.9 s / 30.5 s) has a named
   contributor: the per-device capture lane saturates (`maxQueueDepth` reaches
   its 24 cap on 17 of 20 cameras; 33 % of all capture requests never run), and
   a `keyFrame` request carries **no `staleAfterMs`**, so it queues rather than
   being dropped and executes seconds late.

2. **The hold is not a window — it is an event, and the event fires before the
   request can exist.** `cutSubjectTiles()` runs on the runner's result
   callback **immediately before** `emitInferenceResult()`; it sends `cutTiles`
   to the worker, whose `finally` calls `leaseStore.release(frameId)`. The
   key-frame request is a *consequence* of that same emit. So **the release is
   always dispatched before the request that needs the frame is born.**
   `holdFrames=8` never governs the ordinary path. Every key frame that lands
   today lands off an **orphaned** lease entry — one whose release arrived
   while the frame was not yet in the store. Measured: **`holdOverflow` /
   `leaseAdmitted` = 0.667** and `leaseFrames` pinned at the bound of 8.

3. **A lifetime-scoped hold with a ceiling is already implemented — it is
   `budgetMb`.** `NativeLeaseStore` has no TTL and evicts oldest-first past
   `budgetBytes`. The only reason the ceiling never binds is that
   `holdFrames=8` binds first: 8 × 23.8 MB = **190 MB against a 512 MB
   budget**. Raising `holdFrames` until the budget binds *is* the operator's
   proposal, and it costs **no new RAM reservation** — the node's decode
   admission already reserves `budgetMb + tileBudgetMb + 350` per worker
   regardless of `holdFrames`.

4. **The RAM rung never serves a key frame, and it never could.** Two
   independent reasons, both structural: (a) `keyFrameAcceptsTier()` **refuses**
   `ram-fullframe` by design, and the rung's content is a ≤640 JPEG
   (`ON_DEMAND_JPEG_VIEW`), so a hit there would still write nothing; (b) the
   rung's backing pixels live in `localFrameRegistry`, a **process-wide
   24-frame LRU** whose entries become evictable the instant the runner
   releases the frame — a ~0.4–0.7 s window on a busy node, shorter than the
   ask. `CAMSTACK_CONTINUOUS_RETAIN` is the switch that would move hydration
   inside that window; it is **hydration, not admission** — and fixing it
   changes the thumbnail/zero-media defect, **not** the key frame.

---

## 1. Decomposing `nativeHandleAgeMs`

`handleAgeMs` is measured on the owning node as `Date.now() − registeredAt`,
and registration happens at frame **delivery**, in `onFrameRef`, *before*
`enqueueReservedDetectionFrame` (`pipeline-runner/index.ts:3616`). So it spans
delivery → the crop request landing back at the runner.

Key-frame population (`native full-frame miss`, `maxWidth=4096`), 12 h:

| p10 | p25 | p50 | p75 | p90 | p99 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 204 ms | 395 ms | **1 084 ms** | 3 607 ms | **7 881 ms** | 30 527 ms |

The same shape holds for the other full-frame callers, which are **16× the
volume** and were not in Task 0.2's frame:

| `maxWidth` | lines / 12 h | caller | p50 |
| ---: | ---: | --- | ---: |
| 3840 / 2560 / 2304 / 4256 | 31 859 | `native-frame-transport.ts:212` — `maxWidth: handle.width`, the detail-plane full-frame base | 1 232–2 620 ms |
| 4096 | 1 812 | `KEYFRAME_NATIVE_MAX_WIDTH` — the key frame | 1 084 ms |
| 960 | 4 945 | `SNAPSHOT_MAX_WIDTH` — boxed timeline tiles | 719 ms |
| `null` | 1 126 | unbounded full-frame resolve (skips the native rung entirely) | — |

### What the span is NOT

| Component | Measurement | Source |
| --- | ---: | --- |
| Fetch round-trip (hub asks → hub has an answer), incl. cross-node Moleculer, in-runner resolve, JPEG encode | **p50 18 ms**, p90 120 ms, p99 602 ms | `native subject crop miss` → `meta.roundTripMs`, 2 773 lines / 12 h |
| Runner enqueue → result emitted (queue wait + inference + emit) | avg **239 / 255 / 328 ms** (hub / mini / agent-a), p95 447–571 ms; 35–120 ms per camera in a quiet 40-min window | `pipeline stats` → `meta.e2e_avg`, `meta.stagesMs_*` |
| — of which queue wait | 5–8 ms | `stagesMs.queueWait` |
| — of which `resultToEmit` | 0 ms | `stagesMs.resultToEmit` |
| Frame staleness before inference | 5–7 ms avg | `frameAge` |

Cross-node transport is **not** the driver either. Grouped by the node that
owns the handle, the hub's own cameras are the *worst*:

| owning node | p25 | p50 | p90 | lines |
| --- | ---: | ---: | ---: | ---: |
| <agent-host> (agent) | 444 | 983 | 5 465 | 20 675 |
| agent-a (agent) | 543 | 1 330 | 21 008 | 11 833 |
| hub (local) | 503 | **1 959** | 10 631 | 7 580 |

### What is left

At p50: `1 084 − ~250 (runner) − ~9 (one-way out) ≈ 825 ms` on the hub,
between `emitInferenceResult` and the `persistKeyFrames` line at
`pipeline-analytics/index.ts:6425`. That path is
`eventBus → handleInferenceResult → processFrame` and contains, before any
media is dispatched: `bindingCache.isActive`, `resolveDeviceTrackingSettings`,
`resolveDeviceStationarySettings`, `resolveDevicePackageDropSettings`,
`getOrCreateProcessor`, `ensureProxy`, `deviceZones.resolve`,
`processor.process()`. **Every one of these is an `await` and none is timed.**
See UNKNOWN #1.

### The tail has a name: the capture lane

`persistKeyFrames` goes through `CaptureScheduler` (budget **3 execs per
device**, queue cap **24**, both compile-time constants — the scheduler is
constructed with no options at `index.ts:1786`). Under no contention `exec`
runs synchronously; under contention it queues. 12 h, fleet:

| requested | started | droppedStale | droppedOverflow | coalesced | max `maxQueueDepth` |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 41 839 | 28 189 | 8 405 | 4 197 | 874 | **24** (the cap) |

**33 % of capture requests never run**, and the lane reaches its queue cap on
**17 of 20 cameras**. A `keyFrame` request sets **no `staleAfterMs`**
(`index.ts:7669`), so it is never dropped stale — it waits and then runs late.
Per camera, key-frame landing rate against lane shed rate:

| dev | camera | attempts | landed | land % | sched shed % | max queue |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 3829 | esterno garage | 16 | 13 | **81 %** | 3 % | 5 |
| 1439 | garage | 5 | 4 | 80 % | 4 % | 2 |
| 3628 | laundry | 53 | 37 | 70 % | 14 % | 20 |
| 3839 | hallway p.terra | 160 | 110 | 69 % | 15 % | 24 |
| 103 | porch | 95 | 63 | 66 % | 10 % | 24 |
| 104 | hall | 609 | 344 | 56 % | 26 % | 24 |
| 1443 | sala da pranzo | 509 | 284 | 56 % | 22 % | 24 |
| 102 | parking | 275 | 131 | 48 % | 28 % | 24 |
| 3835 | capanno | 308 | 90 | 29 % | 40 % | 24 |
| 636 | garden | 416 | 115 | **28 %** | 42 % | 24 |
| 1438 | dispensa | 3 | 0 | 0 % | 86 % | 24 |

Fleet, 12 h: **3 142 attempts, 1 569 landed (49.9 %)**, `ramTier` **0** on
every single camera. Pearson r(land %, shed %) = **−0.580** over the 15 cameras
with ≥ 20 attempts. That correlation is **confounded** — a busy camera has both
a saturated lane and a slower hub path — so it is offered as a named
contributor with a mechanism, not as an apportionment. See UNKNOWN #2.

---

## 2. What the hold actually is today

Task 0.2's arithmetic (`holdFrames × frame gap ≈ 1.0–1.4 s`, which brackets
p50 1 055 ms) is numerically right and mechanically wrong. Three facts from the
code:

**(a) A frame enters the hold one frame LATE.** `captureNativeFrame` is called
only from `FrameSlot.reserveSlot()` (`frame-slot.ts`), on the *previously
reserved* frame, at the moment the next `pull` is answered. Frame `F` is put
into `leaseStore` roughly one delivered-frame gap (~128–170 ms) after `F` was
delivered.

**(b) The hold ends on the frame's own result, and that release is dispatched
before the request can be born.** `pipeline-runner/index.ts:1061`:

```ts
this.runner.onResult(async (deviceId, frame, result, _streamType, handle) => {
  this.retention?.noteInferenceResult(deviceId, handle, result)
  this.cutSubjectTiles(deviceId, result, handle)   // → cutTiles → leaseStore.release()
  this.emitInferenceResult(deviceId, frame, result, handle)   // ← the ask starts HERE
  …
```

`handleCutTiles` releases in a `finally`, **including when `bboxes` is empty**
— which is the majority of frames. So in the intended path the raster is gone
~`e2e` (250 ms) after delivery, and the ask arrives at 1 084 ms. The dispatch
is essentially never a race the frame can win.

**(c) So every key frame that lands, lands off an orphan.** A key-frame hit
cannot come from the tile tier (`serveFromTile` requires a tile to *contain*
the rectangle; a full frame is contained by nothing) and cannot come from the
reserved slot (`FrameSlot.toBuffer` resolves only the **newest** delivered
frame — eight frames back at 1 s). It can only come from a lease entry whose
release was a no-op: `release(F)` arriving while `F` was not yet in the store
(fact (a)), after which nothing will ever release it and it leaves only by the
hold bound.

Measured, 30 min, 140 worker runs, fleet:

| metric | value |
| --- | ---: |
| `leaseOffered` | 20 465 |
| `leaseAdmitted` | 16 391 (0.80 of offered) |
| `holdOverflow` | **10 936 = 0.667 of admitted** |
| `tilesCut` | 21 414 (1.31 per admitted frame — the cut *is* running) |
| `leaseUnmarkedCrops` | 0 |
| `leaseFrames` p50 / p90 / max | 0 / **8** / 8 |
| `leaseMb` p50 / p90 / max | 0 / **190** / 190 |
| MB per held frame | **23.8** (4K pinned RGB24) |
| `subject tile cut NOT dispatched` lines / 12 h, fleet | **2** (throttle is 60 s per device) |

Two thirds of admitted frames leave by the **bound**, not by their release,
while the cut itself is dispatched for essentially every result (2 non-dispatch
events in 12 h against a 60 s-per-device throttle). The store is bimodal —
empty, or pinned at the bound. This is the symptom §13 of the two-tier design
doc describes, after the cause it names (registry-LRU lookup for the cutter)
was already fixed; the cut now runs, and the hold still overflows.

> **⚠ A "cleanup" here would be a catastrophic regression.** Making
> `captureNativeFrame` decline a frame that has already been released — which
> is obviously correct, would drop `leaseFrames` to ~1 and give back ~190 MB
> per worker — would take the key-frame landing rate from 50 % to
> approximately **zero**, because the orphan is the only thing serving it.
> Do not tidy this without replacing the mechanism first.

### The corrected window arithmetic

The window is `holdFrames ÷ admission rate`, and the admission rate is not the
delivered frame rate: `admission: 'inferred'` plus the `activityMs` demand gate
cut it to 0.80 × delivered *while the gate is warm*, and to zero while it is
cold.

| | measured |
| --- | ---: |
| delivered fps | 6.0–8.3 |
| `leaseAdmitted / leaseOffered` | 0.80 |
| admitted fps, gate warm | **4.8–6.6 /s** |
| `leaseAdmitted / ageS` averaged over whole worker lives (gate warm ~30 % of the time) | p50 1.77 /s, p90 3.33 /s, max 7.10 /s |
| ⇒ orphan lifetime at `holdFrames=8` | **1.2–1.7 s** |

So Task 0.2's 1.0–1.4 s is right to within the width of the measurement. What
changes is *what it is the lifetime of*: not "the hold", but "the accident".

---

## 3. Would a session-scoped hold work?

### What bounds retention today

`NativeLeaseStore` (`native-lease-store.ts`) has **no TTL by design** (removed
2026-08-13). A frame leaves by exactly one of: `release()` (the result
arrived), the **count** bound `maxFrames`, the **byte** bound `budgetBytes`
(oldest-first), or `clear()` on re-dial/teardown. That is *already*
lifetime-scoped-with-a-ceiling. `budgetMb` has been documented as a "safety
ceiling" since 2026-08-13 — accurately, because `holdFrames=8` binds far below
it: **190 MB resident against a 512 MB budget, a 2.7× headroom that is never
used.**

### The RAM envelope, at the observed session durations

Decode-worker session lifetime (`ageS` at the last snapshot of each run, 140
runs / 30 min): **p25 20 s, p50 40 s, p75 70 s, p90 160 s, p99 1 542 s, max
8 890 s.** Worker spawns: **3 709 in 12 h** (one every 11.6 s cluster-wide).

At 23.8 MB/frame and the gate-warm admission rate of 4.8–6.6 /s, a hold that
truly ran to session close would retain:

| session length | frames | RAM, one camera |
| --- | ---: | ---: |
| p25 — 20 s | 96–132 | **2.3–3.1 GB** |
| p50 — 40 s | 192–264 | **4.6–6.3 GB** |
| p90 — 160 s | 768–1 056 | **18–25 GB** |
| p99 — 1 542 s | 7 400–10 200 | 176–243 GB |

The ceiling therefore binds essentially always — which means **"hold until the
session closes, capped at N MB" is behaviourally identical to "a byte-bounded
oldest-first FIFO of N MB"**, and that is what the store already is. The
operator's design does not need to be built. It needs `holdFrames` to stop
binding first.

### What each ceiling buys, in seconds

Window = `budgetMb ÷ 23.8 MB ÷ admittedFps`, at the gate-warm rate 4.8–6.6 /s:

| `budgetMb` | frames | window | `holdFrames` needed | worker footprint¹ | node ceiling² |
| ---: | ---: | ---: | ---: | ---: | ---: |
| **512 (today)** | 21 | **3.2–4.4 s** | ≥ 21 | 926 MB | **8** |
| 1024 (shipped default) | 43 | 6.5–9.0 s | ≥ 43 | 1 438 MB | 5 |
| 1536 | 64 | 9.8–13.4 s | 64 (schema max) | 1 950 MB | 4 |
| 4096 (schema max) | 172 | 26–36 s | — capped at 64 | 4 510 MB | 1 |

¹ `decodeWorkerFootprintMb = budgetMb + tileBudgetMb + 350`
(`live-worker-admission.ts`) **as it was when this table was computed —
`holdFrames` was not in it.** Since 2026-09-05 (D361) the formula charges
`min(budgetMb, holdFrames × 25) + tileBudgetMb + sceneBudgetMb + 350`: at the
shipped `holdFrames: 8` the frame count binds and the footprint is 662 MB,
ceiling 8. The rows above stay as the record of why.
² `floor(nodeDecodeBudgetMb 8192 / footprint)`, clamped by
`maxLiveDecodeWorkers = 8`.

Against the ask distribution (p50 1.08 s, p75 3.61 s, p90 7.88 s, p99 30.5 s):

- **today's 512 MB ceiling, with `holdFrames` raised out of the way, covers p50
  and roughly p75 and costs no new reservation.**
- covering p90 needs ~1 024–1 536 MB, which **halves** the node's concurrent
  decode ceiling from 8 to 4–5.
- covering p99 is not reachable: it needs > 64 frames, which the schema forbids,
  and > 4 GB per worker, which leaves the node room for one camera.

### The RAM that is already reserved and not used

Observed concurrency and resident cost, 30 min:

| node | concurrent workers p50 / p90 / max | Σ worker RSS p50 / p90 / max |
| --- | ---: | ---: |
| <agent-host> | 4 / 5 / **7** | 2 930 / 4 275 / **4 978 MB** |
| hub | 2 / 2 / 3 | 1 960 / 2 430 / 2 833 MB |
| agent-a | 1 / 2 / 3 | 1 075 / 1 264 / 2 426 MB |

Per-worker RSS (age > 20 s): p50 564 MB, p90 936 MB, p99 1 213 MB, max
1 250 MB — with the lease holding at most 190 MB. Raising `holdFrames` from 8
to 21 adds at most **+322 MB per live worker** and consumes RAM the node's
admission has already refused sessions to protect (`session-decode: REFUSED —
node live decode-worker ceiling reached`: **129 refusals in 12 h**, 102 on the
mini and 27 on the hub). Worst case on the busiest node: 7 × 322 = **+2.25 GB**, taking Σ RSS
from 4.98 GB toward ~7.2 GB against a `nodeDecodeBudgetMb` of 8 192.

**The honest risk:** `DECODE_WORKER_BASELINE_MB = 350` is already optimistic —
the measured floor is 314–410 MB and the p90 worker is 936 MB with a nearly
empty lease, so the true non-lease baseline is closer to **~750 MB**. At a full
512 MB lease a worker is ~1.3–1.6 GB, and eight of them are ~11–13 GB on a node
budgeted for 8. Raising `holdFrames` does not change the *accounting*, but it
does move the *reality* further from it. If `holdFrames` goes up,
`maxLiveDecodeWorkers` or `nodeDecodeBudgetMb` should be revisited in the same
change.

---

## 4. Why the RAM rung never serves a key frame

`ramTier = 0` across 3 142 attempts / 12 h, on every camera, while
`native full-frame miss` — which fires **only** after
`retainedFrames.cropAsync()` has already returned `null` — fired **39 596**
times. The rung produced nothing, ever. Two independent reasons.

### 4.1 It is not a key-frame rung, by design

`persistTrackKeyFrame` counts `ramTier` when the fetch *succeeds* and
`keyFrameAcceptsTier(result.tier)` then **refuses** it
(`key-frame-persist.ts:106`). And the rung's content is
`ON_DEMAND_JPEG_VIEW = { content: 640×640, format: 'jpeg' }`. So a working RAM
rung would hand the key frame a ≤640 JPEG, the key frame would reject it, and
the outcome would move from `nativeMiss` to `ramTier` with **the landing rate
unchanged**. This corrects Task 0.2's reading in two places:

- `servedTier: 'ram-fullframe'` on the `native crop miss` line is a
  **permission**, not an outcome — `resolveNativeCropSource(isFullFrame,
  false)`. Over 12 h there were 37 938 such permissions and 39 596
  `native full-frame miss` lines (of which 1 126 are the unbounded resolve that
  logs no permission line). Within 1.4 %, **every permission ended in a miss.**
  The claim "on the ROI path the RAM rung covers, 51 376 vs 23 750" does not
  hold: that number counted permissions.
- "the code has two rungs; in production one works" is right about the count and
  wrong about the reason: the second rung is not a degraded key frame, it is a
  different kind of media.

### 4.2 It is hydration, not admission — and the pixels die in a third store

With `CAMSTACK_CONTINUOUS_RETAIN` unset:

1. `OnDemandRetentionSession.admitFrame` → `store.allocateHandle()` — mints a
   handle, writes **no content** (`noteAvoidedWrite`).
2. On the result, for a frame **with** detections, `noteInferenceResult` →
   `store.rememberOnDemand(...)` inserts an entry carrying a *lazy* fallback:
   `createOnDemandJpegFallback(registry, ref)`, which `registry.acquire(ref)`s
   a lease (refs 1 → 2). **So admission is fine — the entry exists.**
3. Eager hydration is gated on the same flag: `runner.ts:1081` runs
   `hydrateRetainedFrame` only `if (… && isContinuousRetainEnabled())`. Skipped.
4. The very next statement releases the owner's reference:
   `releaseFrameRef(frame.frameRef, 'success')` → refs 2 → **1**.
5. `LocalFrameRegistry.findOwnerOnlyVictim()` treats **`refs <= 1` as
   evictable**. The registry is a **process-wide singleton with
   `maxFrames = 24`** (`CAMSTACK_LOCAL_FRAME_MAX_FRAMES`). At 5–7 concurrent
   cameras × 6–8 delivered fps = 35–56 frames/s, 24 slots turn over in
   **0.43–0.7 s.**
6. The ask arrives at p50 1 084 ms. `resolveFromLease` returns
   `{ kind: 'miss', reason: 'stale-ref' }` → `materialize()` → `null` →
   `ensureContent` → `null` → `cropAsync` → `null` →
   `native full-frame miss`.

So the entry survives in `RetainedFrameStore` (160 MB budget, 16-frame
per-device floor, 3 000 ms time floor — comfortably long enough) while the
**pixels it points at** are gone in under a second. `CAMSTACK_CONTINUOUS_RETAIN=1`
is exactly the switch that moves materialisation inside that window — and per
§4.1 it would still not produce one more key frame.

I did not confirm this chain on the live cluster: the confirming counter is
`frameLazy.staleMisses` / `fallbackMisses` in `pipelineRunner.getLocalMetrics`,
and the only node reachable without a `nodePin` (`hub`) had zero active
cameras at the time of the call. See UNKNOWN #3.

---

## 5. Is there something cheaper than holding longer?

Ranked by what they cost and what they are worth.

**A. Ask sooner — the lane.** The lane is the only part of the ~1 s that is both
measured and bounded by a constant we own: 3 concurrent execs per device, a
24-deep queue that is *reached* on 17 of 20 cameras, and 33 % of requests never
running. A `keyFrame` request also carries no `staleAfterMs`, which is what
turns lane pressure into a *late* fetch rather than a cheap drop. This is an
addon deploy, not a settings change, and it is the only lever that also helps
`firstFrame`, `thumbnail` and `lastFrame`.

**B. Pin one frame per track at birth, instead of retaining a rolling window.**
The two-tier design's own logic applied to the whole frame. `cutTiles` already
runs at the exact instant the pixels exist *and* the detections are known, and
already produces compressed output into a store with a 64 MB budget and a
retention measured in tens of seconds. A key frame is a full-frame JPEG:
~1–2 MB at 4K/q82 against a 23.8 MB raster — **one order cheaper per frame than
the raster, and the tile store already holds 90–129 frames' worth of tiles at
its budget.** The runner would have to say *which* frames deserve a whole-frame
tile (it does not know about tracks), so this needs either a hub→runner hint or
a heuristic ("first frame of a new detection group"). Protocol + addon change on
both sides; strictly better than holding rasters, and it is the shape that makes
the key frame independent of the ask latency altogether.

**C. Make the last rung honest instead of dead.** Neither
`CAMSTACK_CONTINUOUS_RETAIN=1` nor any change to `RetainedFrameStore` can
produce a key frame (§4.1). It *would* address the ROI/thumbnail zero-media
defect, which is the other half of Task 0.2 and was explicitly left open there.
Different fix, different ticket — do not let §4's mechanism be read as a
key-frame fix.

**D. Things that do not help, with the reason.**
- Raising `KEY_FRAME_MAX_RETRIES`: Task 0.2 already showed the budget is not
  what is exhausted (0 % of 2–5 s tracks spend it). Confirmed here: retries
  fired 560 times against 3 142 attempts.
- `nativeLeaseAdmission: 'all'`: admits *more* frames into a **count**-bounded
  store, so it shortens the orphan lifetime. Strictly harmful while
  `holdFrames` binds.
- Raising `CAMSTACK_NATIVE_CROP_REGISTRY_CAP`: `no-registry-entry` is 7.5 % of
  key-frame misses (135 of 1 812 at `maxWidth=4096`). Confirms Task 0.2.

---

## 6. Recommendation, ranked by cost

**1 — Settings change, cluster-wide, reversible, no new RAM reservation:
`nativeLeaseHoldFrames` 8 → 21.**
This makes `budgetMb=512` the binding constraint, which is precisely
"hold until the session closes, with a ceiling". Expected window
**3.2–4.4 s** against an ask distribution whose p50 is 1.08 s and p75 3.61 s.
Cost: at most +322 MB per *live* worker (≤ 7 concurrent on the busiest node),
inside RAM the node's admission already reserves. `decodeWorkerFootprintMb` and
the node ceiling of 8 are unchanged, because `holdFrames` is not in the
footprint formula. The operator has run `nativeLeaseHoldFrames: 64` before
(§13 of the two-tier doc, as an incident mitigation) and observed the byte
budget binding at ~21 frames — this is the same setting, chosen deliberately.
Watch on the `session-decode metrics` line: `leaseMb` should rise from 190
toward but not past 512, `leaseFrames` toward 21, `holdOverflow` should keep
climbing (it is the orphan channel and it is doing the work), and `rssMb` p90
should stay under ~1 300. Watch `key-frame capture (window)`: `landed/attempts`
should rise from 50 %.
**If you want the whole effect and can afford the concurrency:** 64 with
`budgetMb` left at 512 is identical to 21 (the budget binds first); 64 with
`budgetMb` 1024 buys 6.5–9.0 s and drops the node ceiling 8 → 5.

**2 — Addon deploy (`addon-post-analysis`): unblock the capture lane.**
Give `persistKeyFrames` a `staleAfterMs` so a hopeless request is dropped
cheaply instead of running seconds late on a dead handle, and raise
`maxInFlightPerDevice` (3) / re-examine `DEFAULT_MAX_QUEUED_PER_DEVICE` (24,
reached on 17 of 20 cameras). This is the only lever that touches the
p90/p99 tail and it helps every media kind. **Do not do this before
instrumenting** — see UNKNOWN #2; the lane is a named contributor of unmeasured
size, and raising a concurrency limit on a hub that is already saturated is
exactly the kind of change this repo has paid for twice.

**3 — Addon deploy, both sides: instrument the ~825 ms.**
Two timestamps and one counter close every UNKNOWN below. Cheap, and it is what
makes decision 2 safe. Detail in §7.

**4 — Framework train, only if 1–3 leave a gap: whole-frame tile at cut time
(option B).** This ends the dependence on ask latency instead of widening the
window it races. Do not start here.

**Explicitly not recommended:** raising `budgetMb`, changing
`nativeLeaseAdmission`, setting `CAMSTACK_CONTINUOUS_RETAIN=1` *for the key
frame*, and any "cleanup" of the orphan admission (§2).

---

## 7. UNKNOWN — and the exact instrument that closes each

1. **What the ~825 ms on the hub is made of.** Not measurable today: no stamp
   travels with the inference-result event and `processFrame` times nothing.
   **Instrument:** put `emittedAt` on `PipelineInferenceResultPayload` and log
   `Date.now() - emittedAt` at entry to `handleInferenceResult` and again at
   the `persistKeyFrames` line. Two numbers separate "the bus was slow" from
   "the handler was slow", and today neither exists.

2. **How much of the tail the capture lane owns.** r = −0.580 against shed %
   is a correlation with a mechanism, and it is confounded by camera business.
   **Instrument:** record `enqueuedAt → started` per request in
   `CaptureScheduler` and add `queueWaitMs` (p50/p90) **per `CaptureKind`** to
   the existing `capture scheduler (window)` line. A key-frame-specific queue
   wait is a direct subtraction from `handleAgeMs`, not a correlation.

3. **Whether §4.2's chain is what actually kills the RAM rung.** The reasoning
   is from code; the confirming counters exist but I could not read them on a
   node with live cameras (`getLocalMetrics` is node-local and the reachable
   node was idle). **Instrument:** read `frameLazy.staleMisses` /
   `fallbackMisses` / `evictions` per node — a `staleMisses` count of the same
   order as the miss count confirms the 24-frame LRU; a zero there falsifies it
   and moves the cause to `RetainedFrameStore` eviction.

4. **Which of the three orphan sources dominates** — release arriving before
   the put (fact 2a), a result that never comes back (shed / inference
   timeout), or a release deferred by the tile JPEG encode inside
   `handleCutTiles`. All three produce `holdOverflow`. It matters because only
   the first is a race that could be *inverted* into a designed behaviour.
   **Instrument:** in `NativeLeaseStore`, count `release()` calls naming a
   frameId the store does not hold (`leaseReleaseUnheld`), and record a
   `leaseHoldMs` histogram at every exit, tagged by exit reason. Both are ~10
   lines and go on the existing metrics line.

5. **Whether 3 709 worker spawns / 12 h (one per 11.6 s, session p50 40 s) is
   the normal cadence of on-demand decode or a second source of
   `worker-lease-gone`.** `requestNativeCrop` returns `null` silently once
   `this.exited` is true, and that is indistinguishable from an expired hold in
   every log today. Task 0.2's UNKNOWN #4, still open. **Instrument:** a
   distinct miss reason (`worker-exited`) in
   `SessionDecodeCoordinator.requestNativeCrop`.

6. **Zero-media / thumbnail attribution.** Unchanged from Task 0.2 and
   deliberately not addressed here: §4 explains why the last rung is dead,
   which is *upstream* of that defect, but nothing in this analysis apportions
   it.

---

## 8. Method notes

- Loki's `query_range` proxy silently truncates at `limit`. Every count and
  quantile here comes from **metric** queries on `/query`
  (`sum|quantile|max_over_time({…} | json | __error__="" | unwrap … [12h]) by (…)`),
  which have no such limit. Raw pulls were used only for the 30-minute
  `session-decode metrics` sample, whose volume (1 075 lines) is far under the
  cap.
- A bare `quantile_over_time(…)` with no `by (…)` groups by *every* extracted
  label and returns one series per distinct log line — several MB of useless
  output. Always name the grouping.
- `session-decode metrics` counters are **cumulative per worker process** and
  workers recycle every ~40 s. Fleet totals were computed by detecting `ageS`
  resets per `(nodeId, deviceId)` and summing the last snapshot of each run.
- `avg_over_time` over 12 h and a 40-minute sample differ by 4–6× on `e2e`
  (250 ms vs 45 ms). The quiet sample is not the fleet. Both are quoted above,
  labelled.
