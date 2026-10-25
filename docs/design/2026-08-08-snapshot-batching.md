# Snapshot freshness for the camera grid — batching, caching and invalidation

> **Superseded in part, 2026-08-11.** The server-side keep-warm loop this
> document designs was REMOVED (operator directive: snapshots are on-demand,
> always). Its job had already been taken over by `snapshot.getSnapshotLinks`,
> which the client polls every 5 s and which calls the ordinary capture path —
> so the two ran the same refresh, on the same cameras, at the same cadence.
> Everything below about batching, the variant cache, the identity and the
> invalidation still holds; the timer does not. See
> [`2026-08-11-snapshot-out-of-hub-main.md`](2026-08-11-snapshot-out-of-hub-main.md).

> Status: **Phase 1 implemented and live, 2026-08-08** (hub `1.2.76-dev.1786208302`,
> viewer `v1.0.274`). Phases 2 and 3 remain proposals.
> The rule that came out of building it is [D93](../decisions/adr-0093.md); what
> the measurements corrected is in `../history/sessions.md` (planning repo: sessions/sessions.md).
> §5's open questions 1-6 are answered below; §3.6's deployability table was WRONG
> and is corrected in place.
> Read [`../architecture/data-planes.md`](../architecture/data-planes.md) and
> [`decode-path.md`](./decode-path.md) first — D9/D18 bound every option below.
>
> Supersedes the open items of
> `../superpowers/specs/2026-07-13-snapshot-batch-loading-analysis.md` (planning repo: superpowers/specs/2026-07-13-snapshot-batch-loading-analysis.md),
> whose §3.1–3.5 shipped. This doc is about what is still wrong *after* that.

## The operator's complaint, and what it actually is

> "la lista di snapshots non è sempre aggiornata" [the list of snapshots is not always up to date]

Measured on the live hub (.9) on 2026-08-08, 16 enabled cameras:

```
snapshot.getSnapshotOverview  →  15 of 16 cameras cached,
                                 ALL captured within a 5-second window,
                                 ALL 13.5 minutes old, and not moving.
                                 (re-queried 14 min later: age had grown
                                  by exactly the wall clock, 807s → 840s → 898s)
```

The cache was filled **once**, in one burst, by one client opening the Cameras
grid — and then went cold and stayed cold. Nothing in camstack refreshes a
snapshot unless a client is actively asking for it, right now.

So "not always up to date" is literal and total: with no viewer open, every
thumbnail in the system is as old as the last time somebody looked.

### It is NOT the log line the investigation started from

`event media: capture batch lost — frame recycled before resolve`
(`packages/addon-post-analysis/src/pipeline-analytics/services/event-media-dispatcher.ts:469`)
is a **different subsystem** and does not touch grid thumbnails.

- It belongs to **track media** — per-track `thumbnail` / `firstFrame` /
  `lastFrame` / boxed `snapshot` filmstrip tiles, owned by a `trackId`, written
  to `pipeline-analytics:media`.
- It fires when a late by-handle resolve
  (`pipelineRunner.getNativeCrop` → `RetainedFrameStore.crop`) misses the
  retention window: budget `160 MB`, count floor `16` frames, time floor
  `3000 ms` (`packages/addon-pipeline/src/session-decode/retained-frame-store.ts:66`).
- Agent cameras (`ram:agent-a:1436`) miss more because every hop in the
  ~150–500 ms end-to-end horizon becomes a network hop, and a 25 fps camera
  blows past the 16-frame count floor in **640 ms**.

That is a real defect worth its own slice. **It is not why the grid is stale**,
and fixing it would not move a single thumbnail. Recorded here so the next
session does not chase it.

---

## 1. What the three reference designs actually do

### 1.1 the reference NVR `plugins/snapshot` (open source, v0.2.68)

Per-camera mixin, in-process, in-memory. No disk cache, no batch, **no timer of
any kind** — `grep setInterval|setTimeout` over the plugin returns nothing. It is
purely demand-driven; the refresh loop lives in the caller.

What makes per-camera polling survivable is entirely server-side:

| Mechanism | Value | Source |
| --- | --- | --- |
| source-fetch debounce (promise-keyed, evicted *after* settle) | **4000 ms** (0 for `reason:'event'`) | `main.ts:332-336` |
| resize-result debounce, keyed `(pictureTime, w, h)` | **10000 ms** | `main.ts:421-427` |
| staleness budget | event 0 / periodic **20000** / other 10000 ms | `main.ts:361` |
| adaptive fetch deadline | 1000 ms if <3 s old · 3000 ms if within budget · 10000 ms if cold | `main.ts:359-382` |
| HTTP response | `Cache-Control: max-age=10` | `main.ts:822` |
| last-good frame | `currentPicture` (1 h, 5 h if `Sleep`), `lastAvailablePicture` (**never expires**) | `main.ts:148-152, 323-327` |
| battery cameras | `Sleep` → never woken for a periodic snapshot, serve `lastAvailablePicture` | `main.ts:305-308` |

Fallback ladder on failure: rethrow if `event` → re-read `currentPicture` →
pre-captured `availablePicture` → **rendered placeholder JPEG** (last good frame
blurred `gblur=sigma=25`, dimmed, with "Snapshot Timed Out" / "Snapshot Failed"
drawn over it).

The SDK defines `RequestPictureOptions.bulkRequest` — *"hints whether multiple
cameras are being refreshed by this user request. Can be used to prefetch"* —
and **nothing in the open tree reads it**.

### 1.2 the reference NVR client (closed source — reconstructed from the shipped bundle + 87 h of real traffic)

Evidence base: the Electron app's Chromium HTTP cache on this Mac, **55,079
entries over 87.4 hours, 32 cameras**, plus the minified NVR client bundle
recovered from the service-worker precache. This is observed production
behaviour, not inference.

**There is no batch endpoint.** 55,076 of 55,076 image requests are single-device:

```
54,654 × /endpoint/@the reference NVR/snapshot/hotlink-ok/<id>/Camera/<epochMs>.jpg?width=512&reason=periodic
   422 × /endpoint/@the reference NVR/nvr/hotlink-ok/thumbnail/<id>/<epochMs>.jpg?detectionId=…&height=512&…
```

The client bundle contains exactly one thumbnail URL builder and it is
per-device. Key mechanics, verbatim from the bundle:

- **Cadence 11,000 ms**, a *chained* `setTimeout` (next tick scheduled only after
  the previous settles), not `setInterval`. Measured: 89 % of all inter-request
  deltas land in 11.0–11.1 s across 54,654 requests.
- **A 10 s module-level dedupe map keyed by device id**, shared by every
  component showing that camera. The 11 s timer is deliberately `TTL + 1s` so the
  cache has just expired when the timer fires.
- **Width quantized to multiples of 512**:
  `x = max(round(x/512),1)*512`. A grid tile never rounds past 512, which is why
  **100 % of observed requests were `width=512`**. Payloads: mean **22.7 KB**,
  p50 21.3 KB, p90 34.0 KB.
- **Plain periodic GETs.** No MJPEG, no push, no `If-None-Match` anywhere in the
  bundle. Conditional requests are *structurally impossible*: `Date.now()` is
  baked into the URL **path**, so every request is a distinct resource.
- Each refresh costs **1 websocket RPC + 1 HTTP GET** (the client asks the server
  to mint the URL, then fetches it).
- Aggregate: 32 cameras ≈ **2.9 image req/s**, ≈ 66 KB/s.
- **18.8 % of those requests fail** — 44,728 × 200 vs 10,334 × 500 + 17 × 530.

So the design NVR actually ships scales by **deduplication and quantization**,
not by batching — and at 32 cameras it still throws a 500 on nearly one request
in five.

### 1.3 camstack today

The 2026-07-13 spec shipped almost completely. Live and verified:

- `GET /addon/snapshot/media/<deviceId>[.jpg]?w=&streamId=&force=`, served by the
  hub-resident builtin via `ctx.dataPlane.serve` (`snapshot.addon.ts:204-212`).
- `ETag: "<id>-<capturedAt>[-w<width>]"`, `Cache-Control: private, max-age=<maxAgeS>`,
  304 on `If-None-Match` (`snapshot-media-handler.ts:162-175`).
- Width ladder `[160,240,320,480,640,960]`, snapped **up**, so `?w=` cannot mint
  unbounded work; variants memoized per `(device, stream, width, capturedAt)`.
- Single-flight `COALESCE_MS=4000`, SWR waits `2500` stale / `10000` cold,
  bounded pools `MAX_CONCURRENT_GRABS=3` / `MAX_CONCURRENT_NATIVE=6`
  (`snapshot-coalescing.ts:29,37,45,52,59`).
- `snapshotMaxAgeS` default **10 s** non-battery, **3600 s** battery; battery
  sleep gate never captures unless `force`.
- `snapshot.getSnapshotOverview` — cache-only batch metadata, O(n), never
  captures.

**Measured cost of that path, live, today:**

| Operation | Result |
| --- | --- |
| single tile `?w=320`, cache hit | **24 ms**, 7.7 KB |
| single tile `?w=320`, `If-None-Match` → **304** | **29 ms**, 0 bytes |
| single tile `?w=320`, cache expired (real capture) | 0.36–0.58 s, 7.5–9.7 KB |
| **full 16-camera grid, all caches expired, parallel** | **2.87 s wall**, **141 KB total**, 15/16 → 200, 1 → 404 |
| agent camera 1436 (`agent-a`) | 0.36 s — **not slower than hub cameras** |
| same frame with **no** `?w=` | **1,078,848 bytes** — 140× larger |

The per-device data-plane endpoint is **healthy, fast and cheap**. The pools did
not collapse under a 16-way simultaneous cold fan-out.

---

## 2. So why is it stale? Five defects, none of them the endpoint

### D1 — Nothing keeps the cache warm (the actual complaint)

The cache has exactly **one writer**: `SnapshotCache.set`, called only from
inside `captureFresh` after a native or ffmpeg grab succeeds
(`snapshot.addon.ts:541-545, 577-581`). The addon has **no `eventBus`
subscription at all** (`grep eventBus snapshot.addon.ts` → 0 hits) and the cap
has no write method. It is 100 % pull-driven.

Consequence: cache freshness is a function of *whether somebody is looking*.
Close the app for 15 minutes and every tile is 15 minutes old — which is exactly
what the live probe found. The first paint of a grid open is therefore always
stale-then-swap, for all 16 tiles at once.

### D2 — The viewer asks for the full 4K frame on 5 of its 6 surfaces

Only `CameraCard` passes a width (`useCardSnapshotWidth()`,
`camstack/src/hooks/use-responsive.ts:76-81`). `GridTile`, `GridsScreen`,
`CameraDetailScreen`, `StreamPoster`, `CustomZoneDrawOverlay`,
`GridBuilderScreen.web` all omit `targetWidth` and are served the **full
capture** — measured **1.05 MB** where 7.7 KB would do. The paused grid wall,
the surface most likely to have many tiles at once, is one of them.

### D3 — The `?v=` cache-buster makes a 304 impossible on the refresh path

`buildSnapshotMediaUrl` appends `?v=<bucket>` where
`bucket = floor(now/30000) + epoch` (`camstack/src/data/snapshot-media-url.ts:32-34`).
Both the browser cache and `expo-image` key on the full URL. When `v` rolls over
there is no stored entry for the new URL, so **no `If-None-Match` is sent and a
304 can never happen** on a periodic refresh. Every window is a full 200 with a
full body.

The docblock at `snapshot-media-url.ts:9-10` ("a request for an unchanged frame
is a cheap 304") and spec §3.3 both assert the opposite. That is a leftover that
reads as verification — the measured 29 ms 304 above only happens on same-URL
revalidation, which the bucket prevents.

Note also that a 304 is **not cheap server-side**: `snapshot-media-handler.ts:145`
runs the full coalesced ladder *and* the resize before comparing ETags at `:165`.
Only the body bytes are saved.

### D4 — The admin UI bypasses the wrapper entirely

Admin UI and `ui-library` use **tRPC `snapshot.getSnapshot` → base64 → `data:` URI**
and never touch the data plane (grep for `snapshot/media` across
`addon-admin-ui`, `ui-library`, `addon-viewer-ui` → **zero hits**).

Two consequences, both confirmed live:

- The device-list thumbnail is a **28 × 28 px `<img>` fed a full 4K base64 frame**
  (`ui-library/src/composites/device-item/preview.tsx:57,76-82`), over the tRPC
  WebSocket — the msgpack plane the 2026-08-07 hub profile showed at 37.3 %
  serialization + 25.7 % GC.
- Device-scoped `snapshot.getSnapshot` **routes to the native provider, not the
  wrapper**. Probed live: `snapshot.getStatus {deviceId:101}` was rejected with
  `not routable to node hub/provider-hikvision`, and a `force:true` `getSnapshot`
  returned a fresh 1.05 MB JPEG in 0.55 s while `lastCapturedAt`/`etag` for 101
  **did not move**. The wrapper's cache is not populated by this path at all.

So camstack has two snapshot paths with different behaviour, and only one of
them maintains the cache the other one reports on.

### D5 — Nothing is event-driven, and `getSnapshotOverview` has no consumer

`getSnapshotOverview` is shipped, tested, and called by **nobody** (grep: zero
consumers outside generated types and tests). No grid skips a device that never
produced a frame (device 106 → 404, discovered only by probing). No client
pre-invalidates by ETag. And motion — which the bus already carries — never
refreshes a tile.

---

## 3. Proposal

### 3.1 The batch question, answered: **do not batch the pixels**

The task asked whether to build a batch endpoint (multipart, or manifest +
per-handle fetch). The evidence says no, and it is worth being explicit because
the intuition is strong.

Against a pixel batch:

- **The per-tile path is already faster than a batch could be.** 24 ms cache hit,
  29 ms 304, 141 KB for the whole fleet. There is no latency budget to reclaim.
- **A batch destroys per-tile HTTP caching.** One response has one ETag, so a
  fleet where 15 of 16 tiles are unchanged still ships 16 bodies. Today those 15
  are 29 ms / 0-byte 304s. Batching makes the common case *worse*.
- **Head-of-line blocking.** One slow camera (the 2.8 s tail measured above, or a
  15 s ffmpeg timeout ×2 with retry) delays every tile in the response. This is
  already documented as the reason batching was rejected
  (`snapshot.addon.ts:201-206`), and it is why the tail matters more than the mean.
- **It must not be a cap method.** The cap channel is msgpack over UDS through
  the hub-main router — the D9 buffering path, and the profile's hot spot. A
  batch of JPEGs there is the base64 mistake at 16× scale.
- **the reference NVR, at 2× our camera count, does not batch either** — and its
  client was built with full knowledge of its own server.

A streaming multipart/tar batch on the data plane *would* be legal (D9 is not
violated: compressed media, on demand, one request; there is precedent in
`training-export-handler.ts:66-85`). It is simply worse than what exists.

**Batch the metadata, keep the pixels per-tile.** `getSnapshotOverview` already
is that batch endpoint. Give it its consumer.

### 3.2 Phase 1 — hot-deployable, no cap change, no train

All four are `camstack deploy` (addon) or a viewer OTA. None touches a `*.cap.ts`.

1. **Keep-warm loop in the snapshot addon (fixes D1 — the actual complaint).**
   A timer in `SnapshotAddon` that refreshes the cache for cameras that are
   *subscribed*, not for all cameras blindly. Subscription = "a data-plane
   request for this device arrived within the last N seconds". Concretely: on
   every `snapshot-media-handler` request, stamp `lastRequestedAt[deviceId]`; a
   single interval walks devices with `now - lastRequestedAt < WARM_WINDOW_MS`
   and calls the existing coalesced `getMedia`.
   - `WARM_INTERVAL_MS = 5000`, `WARM_WINDOW_MS = 120000` (2 min of inertia after
     the last viewer closes, then it goes quiet).
   - Costs nothing when nobody is watching — which is the whole point, and the
     difference from blind polling.
   - Respects the battery sleep gate unchanged (never `force`).
   - Reuses the existing single-flight, so a warm tick and a live request collapse.

2. **Always send `?w=` from the viewer (fixes D2).** Pass `targetWidth` on all
   six surfaces. 1.05 MB → ~8 KB per tile. This is the single largest byte win
   available and it is a one-line change per call site.

3. **Align the cache-buster to the freshness contract (fixes D3).** Replace the
   30 s `?v=` bucket with either (a) no `v` at all, relying on
   `max-age=<snapshotMaxAgeS>` + `If-None-Match` — the browser then revalidates
   naturally and gets 29 ms 304s; or (b) an ETag-derived `v` fed from
   `getSnapshotOverview` so the URL changes **only when the frame changes**.
   Option (b) also gives point 4 its consumer.
   Open question — see §5 — whether `expo-image` honours `Cache-Control`/`ETag`
   or treats a URL as immutable-until-evicted. **Measure before choosing.**

4. **Give `getSnapshotOverview` its consumer (fixes D5, partially).** The grid
   polls the overview (one small RPC for all 16 devices) every `WARM_INTERVAL_MS`
   and only re-renders tiles whose `etag` changed; devices with
   `lastCapturedAt === null` render "no snapshot yet" instead of firing a 404.
   This is the batch — of metadata, ~40 bytes per device instead of 8 KB.

**Phase 1 target**: grid tiles perceptibly fresh within ~5 s while watched, at a
steady-state cost of 16 × 8 KB per 5 s = **~26 KB/s** plus one small RPC — versus
today's 1.05 MB × 16 per 30 s = **~560 KB/s** on the surfaces that omit `w`.

### 3.3 Phase 2 — event-driven invalidation

Motion and track events are already on the bus. Subscribe the snapshot addon and
**drop the cached frame's freshness stamp** (not the frame) on motion for that
device, so the next request — or the next warm tick — captures instead of serving
cache.

Constraints that bind here:

- **D8**: events may be dropped. A missed motion event must degrade to "the tile
  refreshes on the normal 5 s warm tick", never to "the tile is wrong forever".
  The warm loop is the reconcile.
- **D49**: this is a one-shot event; it must not gate on a fallible read. It
  invalidates a stamp, which is idempotent and destroys nothing.
- **D11**: `EventCategory` enum, never a raw topic string.
- **Never push pixels on the bus.** D9/D18 — the event carries a device id, the
  client fetches by URL. A periodic JPEG push is the shape D18 explicitly
  replaced, and at 300 devices it lands on the 37 %-msgpack path.

### 3.4 Phase 3 — the decoded-frame fast path (the real cost win, needs a cap change)

`snapshot.addon.ts:512-521` carries a live `TODO` for exactly this, and **two of
its three stated blockers are now stale**:

| Stated blocker (2026) | Status today |
| --- | --- |
| "frames are in the shared-memory ring" | **stale** — shm removed 2026-07-16 |
| "session-scoped, need the active session id" | **stale** — `RetainedFrameStore` is *node-level*, one per runner, explicitly so any session's handle resolves |
| "raw-pixel, need a JPEG encoder the builtin lacks" | **moot** — `getNativeCrop` already takes `encodeJpeg:true` and returns base64 JPEG encoded **on the owning node** |

The one real remaining gap is **latest-handle discovery**: nothing publishes "the
newest `FrameHandle` for device N". `getNativeCrop` is by-handle only, and
handles leave the runner only by riding an inference-result event.

Proposed shape — a **new cap method**, therefore a train (`@camstack/system`
force-publish + `applyServerUpdate`), not a hot deploy:

```
pipelineRunner.getLatestFrameJpeg({ deviceId, maxWidth }) → { base64, capturedAt } | null
```

Node-pinned to the device's ingest owner. Returns `null` freely — the ladder
becomes `latest-decoded → native → broker ffmpeg → stale cache`, so a miss just
falls through to what happens today.

Why it matters: it removes the ffmpeg process from the common case. Today a cold
grab is **one `execFile('ffmpeg')` per capture**, 15 s timeout, ×2 on cold-broker
retry, against a **process-wide** budget of 3 — and for agent cameras that ffmpeg
runs **on the hub against the agent's RTSP restream over the network**.

**Explicit caution.** Do not build this on the same primitive that is already
failing. The late by-handle resolve is at `pinned:false` on 100 % of the 383
batch losses in a 3 h sample. "Freshest frame for device N" is a *different and
far more forgiving* query than "this specific handle, resolved late" — no
staleness contract, no retention race, a `null` is fine. Keep them separate.

Also note the availability limit from `decode-path.md`: only frames delivered to
the runner enter the lease, and a camera in `on-motion` that is currently
detached has no decoded frame at all. This path **must** keep the capture ladder
behind it — it is an optimization, never the only source.

### 3.5 Cost estimate

Per camera per minute, at the proposed 5 s warm cadence while watched:

| Path | Captures/min | Encode work | Bytes to client |
| --- | --- | --- | --- |
| today, watched, 30 s poll, no `w` | 2 | 2 × (grab + full-size encode) | 2 × 1.05 MB = **2.1 MB** |
| today, watched, 30 s poll, `w=320` | 2 | 2 × (grab + resize) | 2 × 8 KB = **16 KB** |
| Phase 1, watched, 5 s warm | 12 | 12 × (grab + resize) | 12 × 8 KB = **96 KB**, minus 304s |
| Phase 1, **not** watched | **0** | 0 | 0 |
| Phase 3, watched, 5 s warm | 12 | 12 × (JPEG encode of an *already decoded* frame) — **no ffmpeg, no camera dial** | **96 KB** |

Fleet-wide (16 cameras, all watched), Phase 1 steady state: 192 captures/min
against pools of 3 ffmpeg / 6 native. The measured full-fleet cold fan-out was
2.87 s for 16, so a 5 s tick has headroom — **but this is the number to watch**,
and it is the reason Phase 3 exists. Phase 3 removes ffmpeg from that entirely
for any camera the pipeline is already decoding.

Compare the reference NVR: 32 cameras at 11 s = 2.9 req/s and 66 KB/s. Phase 1 at 16
cameras / 5 s = 3.2 req/s and ~26 KB/s. Same order, better bytes (320 px vs 512 px),
and with a warm loop we get freshness *without* a client having to ask — which is
the one thing NVR does not do, and the one thing the operator complained about.

### 3.6 Deployability

| Change | Vehicle |
| --- | --- |
| keep-warm loop, overview consumer, event invalidation | **`camstack deploy-server`** — NOT a hot addon deploy. `camstack deploy packages/system` is REJECTED outright on a deployed hub (*"Framework packages no longer live-update via upload"*), because snapshot is a `@camstack/system` builtin and that package is host-provided ([D15](../decisions/adr-0015.md)). It ships as a server closure + `applyServerUpdate`, which restarts the hub. `applyServerUpdate` times out at 60 s and still succeeds — poll `serverManagement.getServerPackageStatus` for the promoted `runningVersion` instead of trusting the CLI's error. |
| viewer `?w=`, cache-buster, overview polling | viewer OTA |
| admin UI → data-plane URLs (D4) | `camstack deploy packages/addon-admin-ui` |
| `pipelineRunner.getLatestFrameJpeg` | **train** — new cap method → `npm run codegen`, `@camstack/system` force-publish, `applyServerUpdate` |

---

## 4. Comparison with the reference NVR, and why we differ

| Dimension | the reference NVR | camstack proposed | Why |
| --- | --- | --- | --- |
| batch endpoint | none | none (metadata only) | measured: per-tile 304 is 29 ms; a batch loses per-tile caching and adds head-of-line blocking |
| cadence | 11 s, client-driven only | 5 s warm loop, **server-side**, subscription-scoped | fixes the actual complaint: NVR's cache is also cold when nobody looks, we just noticed |
| conditional requests | structurally impossible (`Date.now()` in the path) | ETag + `If-None-Match`, 304 | we already built it; we just have to stop busting it |
| size negotiation | quantized to 512 multiples | fixed ladder `[160…960]`, snapped up | same idea, same reason (bounded variant count); ours is tighter for grids |
| event-driven | no | yes (Phase 2), as invalidation only | our bus already carries motion; D8 makes it advisory, the warm loop reconciles |
| decoded-frame reuse | no (ffmpeg from prebuffer) | yes (Phase 3), by handle, encoded on the owning node | we already decode for detection; D9/D18 make the by-handle+compressed shape legal |
| failure UX | rendered placeholder JPEG (blurred last-good + text) | 404 + client overlay | **worth reconsidering** — see §5 |

The substantive difference is that the reference NVR is entirely demand-driven and we are
proposing a bounded server-side warm loop. That is a deliberate divergence: it is
the only thing that makes a tile fresh at the moment a grid *opens*, rather than
5 s after.

---

## 5. Open questions for the operator

> **Answered while building Phase 1.** Kept below in their original form; the
> resolutions are here.
>
> 1. **Cadence/window** — operator chose 5 s / 120 s, shipped. But the window
>    alone deadlocks: see D93. The overview poll had to become the heartbeat.
> 2. **All cameras or only watched?** — watched only, and the enrolment is the
>    image request. The app-wide overview poll deliberately cannot enrol.
> 3. **Battery** — unchanged, and deliberately given no new gate: a warm tick is
>    a non-forced `getSnapshot`, so the existing 3600 s max-age and sleep gate
>    already refuse it. Covered by a test.
> 4. **Placeholders** — not built. Still 404 + client overlay, plus a real
>    "no snapshot yet" state now that `getSnapshotOverview` can distinguish
>    "never captured" from "request failed" (device 106).
> 5. **`expo-image` cache semantics** — **answered: it does NOT revalidate.** Its
>    own contract defines the default `cachePolicy: 'disk'` as "queried from the
>    disk cache if exists, otherwise downloaded"; `Cache-Control`/`ETag` are not
>    consulted. This is why option (b) — a URL versioned by capture identity —
>    was the only correct choice for native, and why the admin UI (a browser,
>    which *does* revalidate) needs no version parameter at all.
> 6. **Admin UI migration** — in scope and done. It authenticates on the
>    same-origin `camstack_session` cookie, which `access: 'authenticated'`
>    accepts and a bare `<img>` can send. The cookie is now also re-established
>    on session *restore*, not only on login — every admin thumbnail depends on
>    it and its lifetime is independent of the token's.
> 7. **Phase 3 train** — not attempted. Still the right next lever; the residual
>    freshness tail measured after Phase 1 is ffmpeg-pool contention, which is
>    exactly what `getLatestFrameJpeg` removes.

### Original questions

1. **Warm-loop cadence and window.** `WARM_INTERVAL_MS = 5000` / `WARM_WINDOW_MS
   = 120000` are proposals. 5 s × 16 cameras is 192 captures/min against a pool of
   3 ffmpeg. Is ~5 s the right "perceived fresh", or is 10 s (halving the load)
   acceptable? This is the single biggest cost lever in the design.
2. **Does the warm loop cover *all* cameras or only watched ones?** All-cameras
   makes a grid open instant but burns capture budget 24/7. Watched-only (proposed)
   costs nothing when idle but the very first paint after a long absence is still
   stale. A middle option: warm all cameras at a slow rate (60 s) plus watched
   ones at 5 s.
3. **Battery cameras.** Proposal keeps the existing gate — never warmed, 3600 s
   max-age, `force` only from an operator button. Confirm that stale-but-honest is
   the wanted behaviour on the grid.
4. **Placeholder images.** the reference NVR renders a blurred last-good frame with
   "Snapshot Timed Out" burned in. We 404 and let the client draw an overlay.
   The client overlay is cheaper and more flexible; do you want the reference NVR
   behaviour instead? (Spec §3.2.5 proposed it and it was never built.)
5. **`expo-image` cache semantics** — does it honour `Cache-Control`/`ETag`, or
   treat a URL as immutable until evicted? This decides between the two options in
   Phase 1 §3.3 and **must be measured, not assumed**. The 2026-07-13 spec listed
   it as an open risk and it is still open.
6. **Admin UI migration (D4).** Moving it off the base64 tRPC path is clearly
   right, but it is a separate surface with its own auth story (the data plane
   needs a Bearer or the session cookie). Confirm it is in scope.
7. **Phase 3 train.** `pipelineRunner.getLatestFrameJpeg` is a new cap method and
   therefore a full publish + `applyServerUpdate`. Worth it, or do we live with
   ffmpeg grabs until something else forces a train anyway?

## 6. Known defects surfaced by this investigation (not part of the proposal)

Recorded so they are not lost; each is small and independent.

- **Resize failure poisons the variant ETag.** On a failed resize
  (`snapshot.addon.ts:293-299`) the full frame is served but the ETag still
  carries `-w<width>` and nothing is cached. A later successful resize for the
  same `capturedAt` mints the *same* ETag with different bytes — a client holding
  the full frame gets a 304 and keeps the megabyte.
- **A 304 costs a full capture.** `snapshot-media-handler.ts:145` runs the ladder
  and the resize *before* the ETag comparison at `:165`. Comparing against the
  cached ETag first would make it genuinely cheap.
- **`SnapshotPopover.tsx` is dead code** — zero call sites, and its `snapshotUrl`
  prop is produced nowhere in the repo.
- **`RetainedFrameStore` emits no metrics.** `size` / `retainedBytes` exist
  (`retained-frame-store.ts:192-199`) but nothing logs them, so per-node retention
  pressure — the thing that decides the `frame recycled before resolve` rate —
  cannot be observed. Worth a log line before anyone tunes the floors.
- **Device 106 has never produced a snapshot** (404, `lastCapturedAt: null`) and
  nothing surfaces that.
