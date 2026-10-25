# shm-ring removal — decode + detect in one process domain

> Status: design (2026-07-16). Supersedes the Phase 5 / D9 shared-memory frame
> plane for the DETECTION data plane. Companion to
> [`decode-path.md`](./decode-path.md) (updated alongside this work) and
> [`transport-and-cross-node-routing.md`](./transport-and-cross-node-routing.md).
>
> **Required reading before touching the code:** this doc, `decode-path.md`,
> and the CLAUDE.md D9 / "one addon = one process" invariants (which this work
> amends: cross-process frame transport is now tRPC, never shm).

## 1. Why remove shm-ring

`@camstack/shm-ring` is the last **host-external NATIVE** package in the addon
data plane. That single fact drives three concrete problems:

1. **It broke the Mac mini runners outright** — the native ESM import is
   unresolvable in the Electron-agent framework closure (see and the
   `project_two_plane_pipeline_live` memory: the agent's boot-plan could not
   resolve the framework dir, and the native `@camstack/shm-ring` import is the
   kind of host-external that does not survive a data-root/seed mismatch).
2. **It blocks npm publishes** — shm-ring needs a native prebuild workflow that
   was never built (`project_release_checkpoint_v1153`: "shm-ring needs a
   prebuild workflow before publish"). Every release has to special-case it.
3. **It duplicates maintenance** — an orphan-segment purge is hand-rolled in
   THREE addons (`addon-decoder-ffmpeg`, `addon-decoder-nodeav`, and the
   pipeline-runner's retention purge), each with its own segment prefix
   (`csf.` / `csr.`) and its own startup reclaim.

The tRPC alternative already exists and is battle-tested: the cross-node ingest
path already resolves frames via `decoder.getFrame`, native crops already flow
over `pipelineRunner.getNativeCrop` (RAM lease, no shm), and audio already
travels over tRPC. shm buys a same-node zero-copy read; the cost is a native
host-external that fails exactly where we most need portability (Electron/Mac).

## 2. Where shm lives today (the map)

There are **four** distinct shm consumers. Only the first is the default hot
path; the rest are either already-non-shm or legacy.

### 2a. Runner → executor / motion — the "CB5 passthrough" (hot path)

Default decode path is **session-decode** (`useSessionDecode: true`): the runner
`child_process.fork`s a decode worker per session; the worker decodes and hands
the runner a `DecodedFrame` over **IPC** (`serialization:'advanced'`) — already
non-shm, already one serialize/copy. The runner then:

- copies the decoded rgb into a per-session **`csr.` shm retention ring**
  (`session-decode/retention-sink.ts` → `DecoderFrameRingSink`), and
- ships the resulting zero-pixel `FrameHandle` to `pipelineExecutor.runPipeline`
  (and `motionDetection.analyze`) **instead of** the pixels, when the handle
  names a LOCAL segment and matches the frame geometry (`useHandle` in
  `pipeline-runner/index.ts`). The executor / motion process resolves pixels
  back zero-copy from the same `/dev/shm` segment (`resolveFrameHandle` in
  `detection-pipeline/provider.ts` + `motion-wasm/addon/index.ts`).

`pipeline-runner`, `detection-pipeline` (executor), and `motion-wasm` are three
SEPARATE addon manifests → three SEPARATE processes (no `execution.group` — D2/D9
default). So `runPipeline` / `analyze` cross a **UDS** boundary, and the shm
passthrough is what keeps the ~640-wide rgb frame from being msgpack-serialized
across it at `detectionFps`.

### 2b. Runner retention ring → post-analysis media

The same `csr.` handle rides the emitted `pipeline.inference-result` event.
Hub-side **post-analysis** (`addon-post-analysis`) resolves it to pixels to cut
event/track/face crop media and the boxed full-frame:

- co-located → direct shm read via `FrameRingReaderCache` (`resolveFrame`), else
- cross-node → `decoder.getFrame({ handle, nodeId })` — the decoder addon on the
  runner's node acts as a **generic shm reader** for the `csr.` segment.

Used in `pipeline-analytics/index.ts`, `services/event-media-dispatcher.ts`,
`embedding/embedding-dispatcher.ts`.

### 2c. Native crops — ALREADY non-shm (the model to copy)

`pipelineRunner.getNativeCrop({ handle, bbox })` cuts an ROI from the decode
worker's **retained native surface** (`NativeCropRegistry` = a RAM lease keyed by
the handle, `session-decode/native-crop-registry.ts`). Routed to the owning node
by `nodePin(handle.nodeId)`. No shm. This already proves the pattern: **the
runner owns the frame in RAM and serves pixels by handle over tRPC.**

### 2d. Legacy shared-poller path (`useSessionDecode:false`, non-default)

The pre-session-decode path, still selectable by unchecking the runner's
`useSessionDecode`:

- broker `FrameHandlePlane` runs `frameSink:'shm'` decoder sessions →
  `decoder` addon `frame-ring-sink.ts` writes `csf.` rings;
- runner `frame-handle-poller.ts` → `streamBroker.subscribeFrames` /
  `pullFrameHandles` → reads `csf.` via `FrameRingReaderCache`;
- decoder cap `getFrame` / `getShmStats` / `pullHandles`; the satellite
  `RemoteSourcePlane` for cross-node.

Nothing ships with `useSessionDecode:false`. This entire path is dead weight.

## 3. Target architecture

**One principle: the node that decodes a frame owns its pixels in RAM and serves
them by `FrameHandle` over tRPC. Same-node calls route in-process / over UDS;
cross-node calls route over Moleculer. No `/dev/shm`, no native host-external in
the data plane.**

Decode and detection stay in the **session-decode topology**: decode worker
(forked child, node-av in-process) → runner over IPC. We KEEP this — it is
already non-shm, already gives per-session GPU/VAAPI reclaim on idle, and the
IPC copy is unavoidable (the worker is a separate process for crash isolation of
the native decoder). We do NOT introduce a shared `execution.group` merging the
Python/CoreML executor into the runner process:

- **Rationale for keeping topology, replacing transport (not co-locating):**
  co-locating `detection-pipeline` (which owns a Python subprocess pool +
  CoreML + heavy native) into the runner process trades the shm zero-copy for a
  crash-isolation regression (an executor native fault would kill the runner and
  every camera's decode). The recurring instability notes
  (`project_addon_update_stability`, the clip-enable version-skew churn) argue
  for LESS process coupling, not more. The frame is ALREADY serialized once at
  the decode-worker→runner IPC hop; replacing the shm passthrough with inline
  pixels over UDS adds ONE msgpack copy on the runner→executor hop. At the ≤640
  detection raster that is ~0.5–0.9 MB/frame × `detectionFps` — e.g. 640×360 rgb
  = 691 KB × 10 fps ≈ 6.9 MB/s per active camera, which UDS msgpack handles
  comfortably (the same order as the already-shipping audio-over-tRPC and
  remote-source planes). Motion gray is ~1/3 of that. This is the "session-decode
  worker come oggi via IPC" option from the brief, and it is the lowest-risk one.
  - The `execution.group` co-location option is documented in §7 as a future
    optimization if the runner→executor UDS copy ever shows up in profiles; it
    is deliberately NOT taken now.

### 3a. Retention: shm `csr.` ring → RAM retained-frame store

Replace `createSessionRetentionSink` (`DecoderFrameRingSink` over `/dev/shm`)
with a **RAM `RetainedFrameStore`** in the runner: a per-node, latest-N ring of
`DecodedFrame`s keyed by the handle's identity (`shmId:slot:seq`). Budget-bounded
exactly like the shm ring (default 32 MB → ~46 slots at the ≤640 geometry), but
in the Node heap. `write(frame)` returns a `FrameHandle` (unchanged schema — see
§4) whose `shmId` is now an **opaque RAM key**, not a `/dev/shm` name.

### 3b. Serving frames by handle — reuse `getNativeCrop`, no new cap

Post-analysis needs full frames AND native crops by handle. Both are served by
the runner today via **`pipelineRunner.getNativeCrop`** (routed by
`nodePin(handle.nodeId)`). We extend its implementation so a **full-frame
request** (`bbox = {x:0,y:0,w:1,h:1}`, `maxWidth` = detection width) is answered
from the RAM `RetainedFrameStore` when the native surface lease has aged out —
giving full-frame media the DEEP retention the `csr.` ring had, while native-res
ROI crops keep coming from the worker's native surface lease. **No cap-surface
change** → this ships as a live addon deploy, not a framework train.

> Alternative considered — a clean new `pipelineRunner.getFrame({handle})` cap.
> Rejected for the FIRST cut only because a cap-surface addition rides the
> framework/applyServerUpdate train (live `camstack deploy packages/system` is
> rejected on release-image hubs — `project_framework_livesync_disabled_on_image_hub`),
> which blocks the live addon-deploy validation loop this work needs. If a later
> release batches framework changes, promoting the full-frame path to a dedicated
> `getFrame` cap is a clean follow-up (§7).

Post-analysis `resolveFrame` collapses to a single call routed by
`nodePin(handle.nodeId)`:

- **full frame** → `pipelineRunner.getNativeCrop({ handle, bbox:{0,0,1,1},
  maxWidth: handle.width })` → RGB bytes → existing box-draw / JPEG encode.
- **native ROI crop** → `pipelineRunner.getNativeCrop({ handle, bbox, maxWidth })`
  (unchanged).

Same-node this routes in-process / over UDS (cheap); cross-node over Moleculer.
`FrameRingReaderCache` and the `@camstack/shm-ring` import are deleted from
post-analysis entirely. `decoder.getFrame` is no longer called.

### 3c. CB5 passthrough removed → inline pixels

The runner stops writing the retention shm ring and stops sending `frameHandle`
to the executor / motion; it always ships the inline `frame` it already holds.
`detection-pipeline/provider.ts` and `motion-wasm/addon/index.ts` delete their
`resolveFrameHandle` + `FrameRingReaderCache`. The `frameHandle` INPUT field on
`pipeline-executor` / `motion-detection` caps stays defined (dormant) so no
cap-surface change is required; a received `frameHandle` (only possible under
version skew) degrades to the empty result it already returns.

### 3d. Motion — already inline in the default path

In session-decode, motion frames are enqueued INLINE (`enqueueMotionFrame`, no
handle) — already non-shm. Shared onboard motion derives gray from the detection
rgb in-process (`rgbFrameToGrayFrame`) — already non-shm. Nothing to change in
the default path; only the legacy poller's gray path (§3e) goes away.

### 3e. Legacy shared-poller path deleted

Remove `useSessionDecode` (always session-decode). Delete `frame-handle-poller.ts`,
`resolve-polled-frame.ts`, `foreign-handle-throttle.ts`, the `RemoteSourcePlane`
satellite, `shm-retention-purge.ts`, and `frame-queue.ts` if it is shm-only.
Delete the decoder addons' `frame-ring-sink.ts` + `shm-orphan-purge.ts` and the
`frameSink:'shm'` session mode. **Decode-path.md note:** RTP/rtsp sources decode
via the broker RTSP restream in PULL mode — that lives in the decode worker /
decoder session `openStream`, NOT in the poller, so removing the poller does not
regress RTP decode. Verified: the pull-mode restream wiring
(`resolveFrameHandleStreamInfo` / `nodeav-decoder-session` `runPullLoop`) is
independent of `frame-handle-poller`.

## 4. FrameHandle stays wire-invariant (compat)

`FrameHandleSchema` (`shmId, slot, seq, width, height, format, pts, byteLength,
nodeId, slotCount`) is UNCHANGED. `shmId` is repurposed from a `/dev/shm`
segment name to an opaque RAM-store key; every other field keeps its meaning.
This matters for **version-skew tolerance**:

- A NEW runner emits handles whose `shmId` is a RAM key. NEW post-analysis
  resolves them via `getNativeCrop` (RAM). ✅
- An OLD post-analysis (shm reader) receiving a NEW handle would `shm_open` a
  non-existent segment → `null` → best-effort media miss, no crash. Tolerable
  during rollout; resolved once post-analysis is deployed.
- A NEW post-analysis receiving an OLD handle (from a not-yet-updated runner on
  another node) calls `getNativeCrop` on that node's OLD runner, which still
  serves it. ✅ (getNativeCrop predates this work.)

**Deploy order to minimize skew:** runner + decoder + post-analysis together
(one `camstack deploy` batch). Cross-node agents on older addons keep working on
their own shm locally; only their emitted handles are resolved by the hub via
`getNativeCrop` on the AGENT (which the old agent still serves) — so a mixed
cluster degrades gracefully to "media from updated nodes only".

## 5. Slice plan (each buildable + tested)

| Slice | Scope | Cap change? | Deploy |
|---|---|---|---|
| **A** | Runner `RetainedFrameStore` (RAM) + `getNativeCrop` full-frame branch; retention-sink → RAM; keep emitting handles | no | addon |
| **B** | Post-analysis: `resolveFrame`/dispatchers → `getNativeCrop` full-frame; drop `FrameRingReaderCache` + `@camstack/shm-ring` | no | addon |
| **C** | Remove CB5 passthrough: runner always inline pixels; delete `resolveFrameHandle` + shm from detection-pipeline + motion-wasm | no | addon |
| **D** | Delete legacy shared-poller (`frame-handle-poller`, `resolve-polled-frame`, `foreign-handle-throttle`, `RemoteSourcePlane`, `shm-retention-purge`, `useSessionDecode` setting, `frame-queue` if shm-only) | no | addon |
| **E** | Decoder addons: delete `frame-ring-sink`, `shm-orphan-purge`, `frameSink:'shm'` mode | no | addon |
| **F** | Drop `@camstack/shm-ring` from every addon `package.json`; keep it in the repo + host-externals for old-addon compat | no | addon |

**Follow-up (framework/system train — NOT in this batch):**
- Remove dormant cap methods `decoder.getFrame` / `getShmStats` / `pullHandles`,
  `streamBroker.subscribeFrames` / `pullFrameHandles` (codegen + generated
  routers), and optionally promote full-frame retrieval to a dedicated
  `pipelineRunner.getFrame` cap.
- Remove `@camstack/shm-ring` from `packages/system` host-externals
  (`host-externals.ts`) — a system-package change, ships on a release image, and
  only safe once no deployed addon still imports it. **Do NOT touch
  `packages/system` in this batch** (per brief).
- Delete `packages/shm-ring` itself + its `system`/`server` bootstrap specs. <!-- drift-ok: deleted in D763 -->

## 6. Test plan

- Runner: `RetainedFrameStore` unit (latest-N eviction, budget, key identity,
  `get` after evict → null); `getNativeCrop` full-frame branch (bbox 0,0,1,1 →
  full downscaled frame from RAM store when native surface gone).
- Post-analysis: `event-media-dispatcher` / `embedding-dispatcher` resolve via
  the injected `getNativeCrop`-backed resolver (replace the shm-reader fake with
  a fake runner cap); assert media still produced with no `FrameRingReaderCache`.
- Delete shm-specific specs (`frame-handle-poller.spec`, `frame-ring-sink.spec`,
  `retention-sink.spec`, decoder `getshmstats`/`pull-handles` specs) in the same
  slice that deletes their subjects.
- Full suites green: `addon-pipeline` (~600), `addon-post-analysis` (~757),
  decoder suites.

## 7. Non-goals / future

- **`execution.group` co-location** of runner + executor + motion into one
  process — would eliminate the runner→executor UDS copy entirely (true "decode
  and detect in one process"). Deferred: crash-isolation regression + the Python
  pool make it a separate, weighable decision. Revisit only if the UDS pixel
  copy shows up in a profile.
  - **⚠️ Post-deploy evidence (2026-07-16): it DID show up.** The inline-pixels
    plan §3c OOM'd the hub main process in production: on the UDS plane, child↔child
    traffic transits the PARENT (hub) router, so every raw rgb detection frame
    (runner→executor) was buffered through hub-main. Mitigated live by shipping
    the runner→executor detection frame as **binary JPEG** (— the
    executor's existing `image` input; ~200 KB vs ~1 MB raw, and the executor
    re-encoded raw→JPEG for the Python pool anyway, so this also removes a
    decode+re-encode). A co-location attempt via `execution.group: 'detection'`
 then appeared to be a no-op on the deployed hub: a hot
    `camstack deploy` respawns each runner from its CAPTURED `runnerAddons`
    (`$process.restart`), so a group manifest deployed onto runners that were
    spawned solo at the previous boot never regroups without a full reboot — and
    the deployed image's runners predated the group manifest. (The boot plan
    `buildAddonGroupPlan` in `addon-registry.service.ts` DID already group by
    `resolveRunnerId`; the gap was the POST-boot spawn paths.)
  - **✅ IMPLEMENTED (framework train — activation at the next release/reboot).**
    Co-location is now honoured on EVERY spawn path, not just boot:
    - `ensureForkedRunner(addonId, { restart })` (in `addon-registry.service.ts`)
      is the single group-aware authority for post-boot (re)spawn — hot-install,
      retry, operator restart, deploy hot-reload. It resolves the runner id
      (`resolveRunnerId`) + the FULL co-located roster (`buildAddonGroupPlan`) and
      CONVERGES the live process topology onto it (`planRunnerConvergence` in
      `server/backend/src/core/addon/runner-convergence.ts`): stop stale solo
      runners → spawn the group, or restart the group in place on deploy. This
      converges stale-solo → group WITHOUT a full reboot.
    - `initializeAddon` (hot-install) + `restartAddon` (deploy) both delegate to
      it. Updating ONE group member respawns the whole group (shared process);
      redundant respawns from a package reload looping `restartAddon` over every
      member are coalesced (`recentGroupRespawns`, 10 s window). Health-banner
      suppression covers all group siblings during a group respawn.
    - Python (`detection-pipeline`'s `python.requirements`) already installs
      per-addon in the runner boot loop, so group mode is unaffected.
    - Proof of the payoff: `co-location-in-process-resolution.spec.ts` asserts a
      call to a co-located sibling cap resolves in-process (zero copy) and NEVER
      reaches the parent hop. Plan coverage:
      `server/backend/src/core/addon/__tests__/runner-convergence.spec.ts`.
    The three addons already declare `group: 'detection'`. Until this ships live
    (framework train → reboot), the JPEG hop remains the
    load-bearing mitigation. **Activation checklist at deploy:** see
    (planning repo: superpowers/specs/2026-07-15-active-backlog.md).
- **Dedicated `pipelineRunner.getFrame` cap** — cleaner than overloading
  `getNativeCrop`; deferred to the next framework train.
- **host-externals + `packages/shm-ring` deletion** — the final train once no <!-- drift-ok: deleted in D763 -->
  deployed addon imports shm-ring.
- Stream / WebRTC / recorder frame-transport (`stream-broker` tcp/uds/ws/inproc)
  is a SEPARATE plane — out of scope, untouched.

## 8. Risk register

| Risk | Mitigation |
|---|---|
| Full-frame media hit-rate drops (native surface shallower than `csr.` ring) | RAM `RetainedFrameStore` gives full frames the SAME depth the shm ring had; native ROI stays on the worker surface. |
| Runner→executor UDS pixel traffic | **MATERIALIZED post-deploy** — child↔child UDS routes through the hub-main parent, which OOM'd buffering raw frames. Fixed by shipping the hop as binary JPEG; real co-location is the §7 kernel follow-up. |
| Version skew mid-rollout | FrameHandle wire-invariant; missing frame → best-effort null, never a crash. Deploy runner+decoder+post-analysis together. |
| RTP decode regression from poller removal | Pull-mode restream lives in the decode worker, not the poller — verified independent. |
