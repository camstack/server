---
title: Inference devices — what runs where, and how a session lands on one
last-verified: 2026-10-23
applies-to:
  - packages/addon-pipeline/src/detection-pipeline/engine/**
  - packages/addon-pipeline-orchestrator/src/device-balancer.ts
  - packages/addon-pipeline-orchestrator/src/load-balancer.ts
  - packages/addon-pipeline-orchestrator/src/node-stress.ts
  - packages/addon-pipeline-orchestrator/src/node-stress-controller.ts
  - packages/addon-pipeline/python/inference_pool.py
  - packages/addon-pipeline-orchestrator/src/attach-pipeline.ts
  - packages/addon-pipeline-orchestrator/src/auto-tune/**
  - packages/types/src/pipeline/auto-tune/**
  - packages/types/src/pipeline/load-balancing/**
  - packages/addon-pipeline-orchestrator/src/session-share-placement.ts
  - packages/addon-pipeline-orchestrator/src/session-placement-stats.ts
  - packages/addon-pipeline-orchestrator/src/load-balancing-shares.ts
  - packages/addon-pipeline-orchestrator/src/load-balancing/**
  - packages/addon-pipeline-orchestrator/src/stale-device-pins.ts
---

# Inference devices

Which accelerator a camera's detection runs on, why, and the numbers that were
measured rather than assumed. Companion to
[object-detection.md](object-detection.md) (thresholds and gating),
[detection-execution.md](detection-execution.md) (what runs on the chosen
device — pools, planes, the per-step capability gate and detail-plane device
jump) and [data-planes.md](data-planes.md) (how frames get there).

## The fleet (re-read 2026-10-10 via `getNodeInferenceDevices`)

| Node | Host | Accelerators reported | Notes |
| --- | --- | --- | --- |
| `hub` | agent-a | `openvino:gpu`, `openvino:npu`, `edgetpu:usb`, `cpu` | Intel path |
| `agent-a` | agent | openvino (+cpu) | — |
| `mac-mini` | Mac Mini | `coreml` | ANE |
| `agent-b` | Proxmox CT201 | `onnx:webgpu` (on), `openvino:cpu` / `cpu` (opt-IN) | VAAPI radeonsi; XDNA1 present-only (no Linux EP). WebGPU = one OS child per model (D823). Latency measured: `amd-phoenix/amd-igpu` + `amd-phoenix/x86-cpu` (prefer OV-CPU INT8 for live YOLO). Catalog: `docs/benchmarks/2026-10-10-amd-webgpu-catalog.md`. |

`getNodeInferenceDevices({nodeId})` is the honest live answer — prefer it over
this table when deciding what a node can run.

`getNodeInferenceDevices({nodeId})` is the honest answer for any node. `available`
means the probe found the hardware; `enabled` means it may be balanced onto.
Both must be true for a device to be a candidate.

`enabled` defaults are NOT uniform: an accelerator with no stored entry is
enabled (opt-OUT) — an NPU, iGPU, ANE **and a Coral** ([D912](../decisions/adr-0912-a-coral-is-an-accelerator-like-the-rest-it-is-enabled-by-default-and-auto-tune-sizes-it.md),
which superseded D39's Coral opt-in); **CPU-class devices are opt-IN** (fallback
only). A Coral is balanced at a speed-proportional weight, because Auto tune
sizes it at `yolov9s-320-edgetpu` from the measured latency. The equal-share
rotation once put a never-enabled Coral on a third of camera 101's sessions and
left it at 2.4 fps failing tflite model resolution. A stored `enabled:false`
always wins. The executor side carries a matching
capability gate (`resolveStepsForDispatch` in the detection-pipeline provider),
and since 2026-08-01 it is **per step, not per tree**:

- on the FRAME plane only the frame-plane steps are gated. A DETAIL step with no
  model build for the dispatch device's format is **pruned and deferred** (logged
  once, `tags.deviceId`) — not dropped: it runs later as its own per-track detail
  dispatch, where the runner's `resolveStepDevice`
  (`pipeline-runner/device-jump.ts`) places it on a same-node device that can run
  it, or warns no-candidate loudly. An unrunnable child no longer bounces the
  whole tree off its accelerator.
- when the ROOT itself has zero builds for that format, the whole dispatch falls
  back to the node-local default engine (logged once, `tags.deviceId`) — never to
  another node, that is the orchestrator's tier.
- when the node's own engine cannot run it either, this throws fast — no
  model-download retry — and logs model, available formats and both engines tried.

The hub's NPU is real hardware: `/dev/accel/accel0` with `intel_vpu` loaded,
mapped into the container. Confirm with
`docker exec CamStack ls -la /dev/accel/` before suspecting the code.

## How a session lands on a device

0. The cluster policy `sessionPlacement` (Pipeline → Cluster → Load balancing,
   D748, D750) decides HOW steps 1 and 3 choose: `share` (default since D750,
   see "Share placement") or `least-loaded` (the behaviour described below).
1. The node is chosen first (`load-balancer.ts`, node tier).
2. `resolveEligibleInferenceDevices(nodeId)` builds the candidate set: probed ∩
   stored, filtered by `enabled`, `available`, and a **root-capability guard**
   that drops any device whose FORMAT cannot run the object-detection root.
   The guard keys on format, so it can never separate two devices of the same
   backend (`openvino:gpu` vs `openvino:npu` are indistinguishable to it).
3. `pickInferenceDevice` resolves **pin → capacity → tie-break**.
4. Fewer than two candidates and no pin ⇒ no `deviceKey`, and the runner's
   single default pool serves the session. With exactly ONE candidate that
   default pool IS that device, so the attach provisions from it — its node
   model pin and the camera's override stored under its key (`provisioningKeyFor`,
   D745). Before 2026-10-07 it read the empty key `''`, which no store writes:
   a model pinned on a Mac's `coreml:all` never ran.

### The tie-break, and why it starved an accelerator

Until 2026-07-31 the device tier inherited the node tier's ending:

```
.toSorted((a, b) => a.sortKey - b.sortKey || a.node.nodeId.localeCompare(b.node.nodeId))
```

Correct for nodes; wrong here. Sessions on this fleet are **on-motion** — they
start, run, and end, and rarely overlap (`getLocalLoad()` typically reports
`attachedCameras: 1`). At dispatch both devices therefore score 0, weights are
equal, and the LEXICOGRAPHIC tie decides every placement: `openvino:gpu` sorts
before `openvino:npu`, forever. An NPU that was `available:true enabled:true`
did no work at all, and nothing logged the decision.

The device tier now rotates across the tied set instead. Three properties worth
keeping:
- the cursor is keyed by the **tied set**, so unplugging a Coral restarts a
  correct rotation over the remainder rather than inheriting a skewed index;
- **stickiness is checked first** (`currentDeviceKey`) and does not consume a
  rotation slot, so re-running placement never thrashes a placed camera;
- the NODE tier is untouched and still deterministic.

> A balancer that only balances CONCURRENT load does nothing on a workload that
> is never concurrent. Weights and caps were fine; the tie was doing all the work.

### Share placement (D748)

The same flaw remained at both tiers for WEIGHTS: `attached / weight` is 0 for
every idle node whatever its weight, so with on-motion cameras the weights only
bit once a node was already busy. Measured over 18 h with Mac 70 / hub 20 /
N100 10: 51.7 / 32.3 / 16.0 — the N100 (≈ 4.5 % of the measured capacity)
carried 16 %.

Under `sessionPlacement: share` a share is a share of PARALLEL sessions, held at
each session start (`electByShare`): the candidate with the largest deficit
`share/Σshare × (Σrunning + 1) − running` wins — an empty cluster's first session
goes to the highest share, ten parallel sessions settle at 7 / 2 / 1. Node
`running` = its sessions plus its standing always-on cameras, each camera once
(`countRunningByNode`); device `running` = the pool's attached sessions. A node
pin still wins (L1) and counts toward its node.

Work-conserving: a candidate at an explicit cap (`maxCameras` / `maxSessions`)
or drowning (pool at its shed cap) hands its turn to the free one with the most
spare explicit room — logged (`share turn yielded`) and counted. The capacity
derived from the measured table is ADVISORY only (a suggested cap in the UI):
letting it refuse a session would make it a cap nobody set. Today no runner
reports `inFlight` / `inFlightCap`, so yields happen at explicit caps only.

`getPlacementStats` reports what placement did (time-weighted share of parallel
sessions, starts, peak, yields, the cluster's parallel peak, stale device pins);
`setLoadBalancingShares` writes node + device shares in one RMW; `suggestShares`
proposes shares ∝ capacity (D755: from the latency table at the Auto tune
models, or from node benchmark results). A device pin
naming a device the elected node does not offer is ignored (`device pin
ignored`, once per camera and key) and no longer bypasses the single-device
default pool.

### Where the shares come from (D750, D755)

`shareSource` is one of `hardware` (default), `benchmark` or `manual` (a stored
D750 `auto` reads as `hardware`). The two automatic sources are CAPACITY, never
load — no observed peak, no estimate, nothing that needs a day of uptime:

- `hardware` — each node's capacity in parallel sessions at its Auto tune
  models (picked at the defaults: 40 % kept free, at least 2 sessions per
  device), `⌊fps × (1 − headroom) / camera fps⌋` per enabled accelerator from
  `DETECTOR_PERF`; device shares inside a node follow fps.
- `benchmark` — the same from node benchmark results, read through
  `NodeCapacitySource` (`types/src/pipeline/load-balancing/capacity-shares.ts`).
  The results store does not exist yet; the orchestrator wires
  `NO_MEASURED_CAPACITY`, so every node falls back to `hardware` and says so
  (`capacityFallback: no-benchmark-results`, or `partial-benchmark-results`
  when only some of its devices are measured — a node is one source or the
  other, never a mix).

`computeCapacityShares` is the ONE computation: `suggestShares` returns it and
`EffectiveSharesService` (`load-balancing/effective-shares-service.ts`) holds
its answer in memory, recomputed when a node joins or leaves, a node's
detection or a device is switched, Auto tune changes a model, or the source
changes — plus a 60 s reconcile that recomputes when the answer is for another
source, when a node was present but not readable yet (skipped `node-offline` /
`no-hardware-facts`: its catalog or hardware had not answered), when
`shareTopologySignature` changed (online nodes, detect flags, enabled devices
and their detector models, **and each node's LIVE device set** — key,
availability and the dispatcher's exclusion verdict, read from the last probe;
a device plugged in with nothing stored for it, or one pulled out, changes no
stored entry), or after 15 min. A probe that returns another device set also
calls the recompute at once (`devices:<nodeId>`, logged with `tags: { nodeId }`)
and nudges the automatic benchmark ([D913](../decisions/adr-0913-balancing-is-automatic-a-new-device-is-measured-and-the-shares-follow-the-live-hardware.md)).
The not-ready rule is the D755
fix: on 2026-10-07 the share was computed the instant the N100 rejoined, before
its catalog answered, so the N100 got no share (weight 1 → 1 %) and the
answer was held for up to 15 min while `suggestShares` said 6 %. Each
recompute logs `automatic shares recomputed` per node, before → after, with
the source each node used. `manual` uses the stored sliders. Every reader goes
through the effective shares: `PipelineSettingsStore.buildNodeWeights` (both
balancers, the share election, stress failover) and the device weights of
`resolveEligibleInferenceDevices`. A node or device that cannot take sessions
is simply not a candidate, so the others split its share —
`resolveEffectiveShares` computes the same split for the tab
(`getEffectiveShares`, which also names per node the capacity source and any
fallback). `setShareSource('manual')` seeds the sliders with the automatic
values in one write.

**Sessions that never overlap still split by weight.** On-motion sessions
rarely run together, so at each election every `running` count is 0 and the
deficits tie; the key order then handed all of them to one device (three
Corals of weight 100 got 38 / 1 / 0 of 39 sessions on 2026-10-23).
`ShareElectionHistory` (`share-election-history.ts`) remembers each election
per scope (the node id for devices, `nodes` for the node tier) as a count that
halves every 30 min, and the election adds it to `running`
(`ShareCandidate.recent`) — a deficit round robin over time, so equal weights
get equal sessions and 100:100:10 converges to 100:100:10. It is in memory and
advisory: a restart costs a few unfair elections.

**A camera keeps its placement while the share allows it** ([D916](../decisions/adr-0916-a-camera-keeps-its-session-placement-while-the-share-allows-it.md)).
That memory rotates a camera on purpose, and every move costs a stream dial, a
decode-worker fork and a cold pre-roll: 3835 moved node 11 times in 14
sessions. `SessionAffinityMemory` (`session-affinity.ts`) remembers each
camera's last node and device for the same 30 min, and the election keeps them
while they are offered, have room, and are within ONE session of the turn
holder's deficit; otherwise the plain share election decides. The dispatch line
says which: `sticky`, `stickyReason` (`no-previous`, `previous-is-turn`,
`within-one-session`, `share-off`, `previous-ineligible`, `previous-no-room`),
`previousNodeId`, `turnKey`, `recent`, `running`.

**A session on a device that dies re-elects per frame.** A device in backoff
(or `failed`) is not offered to new sessions; a session already on it used to
have every frame refused until it ended. A live camera frame now goes to the
node's default pool while its elected device is unusable
(`frame-device-reelection.ts`), said once per change with the camera's
`deviceId` and the `deviceKey`. Before a POISONED worker is SIGTERM'd it is
asked for its stack (SIGUSR1 → Python `faulthandler`, at most 1.5 s); the dump
is the worker's stderr, logged as `[<worker label>] …` lines, and a
`poisoned pool worker asked for its stack` line says so.

The share election only offers nodes the topology still knows: the load census
is memoised and a node that just left would otherwise be elected and fail the
dispatch. Stress failover under `share` (`planShareTarget`) moves a camera only
to a healthy (`ok`), under-cap node below its share, the largest deficit first,
and holds — naming the camera — when none is.

## Pools

One `SharedInferencePool` per `(node, runtime, device)`, each owning its own
Python subprocess, its own model copy and its own device context. A second Coral
is a second POOL (`edgetpu:usb:1`), never a second worker on one unit.

What a pool LOADS for a step is resolved static-catalog-first, then the
operator's custom-model registry
([D208](../decisions/adr-0208-every-model-resolution-surface-consults-the-custom-registry.md)
— `buildPoolModelConfigForStep` in `engine/engine-factory.ts`, the
`resolveCustomModel` seam); the mechanics live in
[detection-execution.md](detection-execution.md).

### Why OpenVINO devices stay explicit

`openvino:gpu` and `openvino:npu` are separate logical pools because they target
separate physical engines (`GPU` and `NPU`). The hub observation above confirms
the NPU is real `/dev/accel` hardware; the pool passes the explicit selector to
`compile_model`, and stderr records OpenVINO's `EXECUTION_DEVICES` for every
compiled model. An operator-pinned device does not silently fall through to the
other accelerator.

Do not replace this with `AUTO`, `MULTI` or `HETERO`:

- OpenVINO `AUTO` does not include NPU in its default candidate list. Its
  startup CPU helper also previously handed live requests to the GPU after
  compilation with incompatible result ports (`score_8`); explicit compilation
  structurally removes that handover.
- `HETERO` partitions unsupported operations of one graph across devices. It is
  not camera or request load balancing.
- cumulative-throughput/AUTO scheduling would hide the actual execution device
  from CamStack's per-device capacity, pinning and load telemetry.

**The NPU compiler refuses a DYNAMIC dimension, full stop.** Found live on
2026-08-20, not in theory: the hub — pinned by the operator to the NPU — repeated
`Loading step variant plate-ocr/cct-s-v2-global` with a climbing `poolIndex` and
never reached `Step variant loaded`, while `agent-a` loaded the same model
in 205 ms. Underneath were four lines that name the whole failure:

```
[w0] OpenVINO: operator-pinned device NPU
[w0] OpenVINO: compile on NPU failed
[w0] Got negative shape dim bound: '-1'
[w0] L0 pfnCreate2 result: ZE_RESULT_ERROR_INVALID_ARGUMENT
```

The `-1` was a dynamic `batch` axis on the ONNX input and output. The symptom is
the trap: a compile failure here is not an error the caller sees, it is a load
that never completes, so the pool looks busy rather than broken. Under AUTO it is
quieter and just as real — the NPU candidate loses every dynamic-batch model to
the GPU fallback, silently.

**Batch capability is derived at the LOAD from the (engine, device) pair, and is
not configurable** ([D202](../decisions/adr-0202-batch-capability-is-a-hardware-fact-not-a-setting.md)).
The first fix was to pin batch in that model's conversion script; it does not
generalise, because the same artefact is downloaded to CPU, iGPU, NPU and CoreML
nodes and an export cannot know which it will meet — and pinning at export is
actively wrong for CoreML, where the flexible `RangeDim` axis is what the stacked
single-dispatch ANE path reads. So the rule lives in one function in
`inference_pool.py`:

| engine | device | dynamic batch |
| --- | --- | --- |
| openvino | NPU | **refused** — reshaped static 1 at load |
| openvino | CPU, GPU | kept |
| onnxruntime | any EP | kept |
| coreml | ANE/GPU/CPU | kept (a `RangeDim` export is the batched-ANE input) |
| edgetpu | USB | n/a — a tflite graph is static by construction |

`_static_batch_required(runtime, device)` is the authority; `_pin_batch_for_device`
applies it per compile candidate, so the AUTO ladder reshapes for its NPU attempt
and hands the untouched source to GPU and CPU. "Per candidate" is load-bearing
and briefly was not true: the first cut reshaped the shared model object, so an
NPU attempt's pin LEAKED into the next candidate's compile —
`test_inference_pool_static_batch.py` now pins the isolation. Both outcomes are logged
(`OpenVINO: batch shape for <model> on <device> — PINNED to 1 …` / `… already
static, no reshape`), so the derivation is readable in the pool stderr. A dynamic
axis that is not the batch (a dynamic H/W) is NOT invented away: it is named in
one line and the compile is allowed to fail.

Nothing declares batch per model — not the catalog, not a conversion script, not
an operator knob. The static pin still in `build-plate-ocr-model.py` is redundant
belt-and-braces; the dynamic exports in `build-camstack-models.py` and
`build-auraface-model.py` are dynamic on purpose.

**The OpenVINO request pool is sized by the DEVICE, and four is what UNKNOWN
answers — not a floor.** It used to be `max(optimal, OV_DEFAULT_CONCURRENCY)`,
which is a floor of four however small the device's own answer was, and the
comment beside it described a fallback. On this hub that pinned four
GPU-resident `InferRequest`s per model pool forever while the iGPU under
`PERFORMANCE_HINT=LATENCY` asked for one or two and `intel_gpu_top` showed
Render/3D idle — and creating the VAAPI device for an HEVC decode then failed
with `-12`. One function decides now, `_ov_request_count`, called by both sites
that must agree (the per-model request pool in `_load_model` and the predict-pool
worker count in `_run`): it honours the device's answer with a floor of
`OV_MIN_CONCURRENCY` (2, so a second frame can be preprocessed while the first
infers), and keeps `OV_DEFAULT_CONCURRENCY` (4) **only for `optimal <= 0`** —
the device could not be asked, and unknown is not small
([D393](../decisions/adr-0393-a-measurement-that-failed-is-not-a-measurement-of-zero.md)).

A `worker saturated` warning is the TypeScript live-request backlog reaching its
cap; it is not proof that the OpenVINO request count is wrong. Change this only
from a device-specific benchmark, not from the warning label.

### A COMPILE is bounded, and one worker does it

Compilation, not inference, was the thread holder. Measured on the hub
2026-09-18: one `inference_pool.py` held **214 threads** 17 minutes after boot —
the largest in the container, 3× ffmpeg — with the start times clustering exactly
on compile timestamps, 23 threads per compile on a 20-core box, never retired.
`COMPILATION_NUM_THREADS=4` bounds it (`CAMSTACK_OV_COMPILATION_THREADS`, `0`
disables). Four rather than one because the cold-compile storm is where frames
pile up, and it costs nothing at inference time: `INFERENCE_NUM_THREADS` is
deliberately left at OpenVINO's default, because the CPU device is this pool's
guaranteed fallback floor and capping its inference threads trades latency on
exactly the nodes with no accelerator for a pid saving nobody measured.

The property is sent **only to a device whose `SUPPORTED_PROPERTIES` lists it**,
and a probe that fails sends nothing — absent beats rejected. A plugin rejects an
unknown property as a compile exception, and in the failover ladder of
`_load_model` that rejection reads as *this device cannot run the model* and
silently lands a GPU model on the CPU.

**A pool's workers all miss the compiled-model cache at the same instant.** They
start together, so on the Mac three hours of CoreML produced 59 hits against 55
misses — not a cold cache, N workers each compiling what the others were
compiling — plus five `could not persist compiled-model cache ([Errno 2] …
/yolov9m-320.mlmodelc/weights)`, a path *inside* the old bundle: `rmtree` walking
a directory another worker was swapping out from under it. `compile_cache_lock`
is a per-**model**, timeout-bounded `flock` (180 s): a miss takes it and asks the
cache again before compiling, so a waiter turns into a hit, and only the holder
writes. It is fatal in no direction — an unusable lock directory, a missing
`flock`, a holder that died — because each of those ends in a compile without the
cache, which is what this code did before the cache existed. An optimisation that
can refuse to serve a camera is worse than every miss it prevents.

A device pool is reaped when unused (`engine/idle-pool-reaper.ts`), and the TTL is
measured in HOURS — `DetectionPipelineProvider.DEVICE_POOL_IDLE_TTL_MS`, default
6 h, `CAMSTACK_DEVICE_POOL_IDLE_TTL_MS`. The reason is the workload again: only a
DISPATCH touches the key, and dispatch is driven by motion, so "an active camera"
does not keep its pool warm — a quiet camera stops touching it entirely. Under the
old 120 s TTL the pool was evicted between events and the next motion paid a full
model reload before it could detect anything.

Provisioning comes from `RUNTIME_DETAIL` (`runtimes.ts`) keyed by **the pool's
own runtime** — not the node default. Before 2026-07-31 `resolveDeviceFactory`
passed the process-wide executor options to every pool, so an openvino pool could
inherit onnx's arrangement.

| runtime | concurrency | numWorkers | batchMode |
| --- | --- | --- | --- |
| onnx (also `cpu`, `cuda`) | 4 | 1 | list |
| openvino | 1 | 1 | none |
| coreml | 1 | 1 | none |
| edgetpu | 1 | 1 | none |

Precedence: operator override (the addon's "Inference executor" settings) → the
pool's own registry row. No third layer.

`batchMode` / `maxBatchSize` are REQUEST GROUPING and stay tunable — they decide
how many pending predicts the pool coalesces into one dispatch, never a model's
compiled shape. The compiled shape is the derived fact above, and has no knob.

**The operator override is PER NODE** (2026-08-13). Every field of the
"Inference executor" section is `perNode: true`, so it persists as
`<key>@<nodeId>` in the detection-pipeline's hub-central store and a node with
no scoped key resolves to the registry value — never to another node's. Until
that marker landed the keys were BARE and the store is shared by every node, so
one save reached the whole cluster: raising the Mac's `numWorkers` would also
have doubled the hub's per-pool model RAM. Read/write both go through
`types/addon/per-node-store.ts`; the settings form reads
`resolveGlobalStore(nodeId)`, never the raw store.

Live, and **the only two calls that touch the right store** — see the trap
below:

```
# write (goes through the schema's per-node scoping)
addonSettings.updateGlobalSettings
  {"addonId":"detection-pipeline","patch":{"numWorkers":2},
   "nodeId":"MacMiniAgent.localdomain"}

# read back the raw blob the addon actually resolves from
settingsStore.get
  {"namespace":"detection-pipeline","collection":"addon-settings","key":"root"}
  → { "numWorkers@MacMiniAgent.localdomain": 2 }
```

> **TRAP — `addonSettingsRaw` does not read a FORKED addon's store.** It reads
> the `addon-settings` table's **one-row-per-key** shape
> (`id = "<addonId>.<key>"`) — what an IN-PROCESS hub builtin's `ctx.settings`
> uses. A forked addon's `ctx.settings.readAddonStore()` — what `resolveConfig`
> uses in the inference addon — is a **single blob row** under namespace
> `<addonId>`, key `root`. On 2026-08-13 this key was written through
> `addonSettingsRaw.updateGlobal` (deleted since, D675), read back through
> `addonSettingsRaw.getGlobal` looking exactly right, and was invisible to the
> Mac's addon: the pool kept coming up `numWorkers: 1, overriddenFields: []` —
> which was the CORRECT behaviour of an addon whose store was genuinely empty.
> Write and read an addon's settings through the `addonSettings` cap. Note on
> the router itself (`api/core/addon-settings.router.ts`).

Verification after a change is the `Pool ready` line on the target node, and it
must show BOTH the count and two pids — `Python inference pool` alone is not
enough, because `verifyEngine`'s throwaway import probe logs the same line
pinned to `{concurrency: 1, numWorkers: 1}` and is disposed a second later
(`Pool process(es) terminated` right after `Pool ready` is the probe, not the
live pool):

```
Python inference pool  {deviceKey: coreml:all, numWorkers: 2, overriddenFields: ["numWorkers"]}
Pool ready             {workers: 2, pythonWorkers: 2, pids: [9004, 9005]}
```

`pipelineExecutor.spinEngine {nodeId, engine}` forces the live pool up without
waiting for motion — on an on-motion fleet a node can sit for hours with no
pool at all, which makes "nothing changed" indistinguishable from "not applied".

**`numWorkers` is the knob that lifts a saturated pool, and `concurrency` is
not.** Each `numWorkers` subprocess owns its own MLModel copy, its own device
context AND its own `POOL_MAX_IN_FLIGHT` budget, and inference round-robins
across them; `concurrency` adds threads that share ONE model context, which
CoreML serialises anyway. Measured on 2026-08-12 21:19→22:20Z, with every pool
in the fleet at `numWorkers: 1`, the edge-triggered
`worker saturated — shedding` line fired **563 times on the Mac mini**
(`w0`, coreml), 283 on agent-a and 114 on the hub — all on a single `w0`
per node. RAM is the counterweight: cost is linear in
`numWorkers × modelSize`, so raise it where there is headroom (the Mac has
16 GB) and never on hub-main.

### `pythonWorkers` above 1 on an openvino pool is CORRECT

Do not "fix" it. The TS registry value of 1 is what the addon *sends*; Python
overrides it upward through `_ov_request_count` because 1 starves the per-model
InferRequest pool, and says so on stderr (`OpenVINO LATENCY: predict concurrency
1 -> <target>`). This cost an hour of chasing a non-defect.

**What the target is has changed, and a 4 you remember seeing is not the
expectation.** Until 2026-09-13 it was `max(optimal, OV_DEFAULT_CONCURRENCY)`,
so every openvino pool showed 4. It is now the device's own
`OPTIMAL_NUMBER_OF_INFER_REQUESTS` with a floor of 2, and 4 only when the
property could not be read at all — an iGPU under the LATENCY hint answers 1–2,
so `predict concurrency 1 -> 2` on a startup-loaded model is the correct line
now. See the request-pool paragraph above for why the old floor mattered.

### The memory watchdog

An idle pool is reaped; a GROWING pool is restarted. Until 2026-08-18 the only
bound on a Python pool's RSS was the kernel OOM killer, which took anon-rss kills
at 3.8 GB and 8.8 GB — and the co-hosted Home Assistant VM with them
([D177](../decisions/adr-0177-a-python-pool-is-bounded-by-its-own-watchdog-not-the-kernel.md)).

`PoolMemoryWatchdog` (`packages/types/src/utils/pool-memory-watchdog.ts`, wired
to this provider by
`packages/addon-pipeline/src/detection-pipeline/engine/pool-memory-guard.ts`)
sweeps every 60 s over the node-default pool plus every per-device pool, reads
each worker's RSS from `/proc/<pid>/status`, and restarts one whose worst worker
crosses `min(3 GiB, max(1 GiB, 4 × settled baseline))`. The baseline is the
MEDIAN of three samples taken after five settle samples — median so one
inference burst cannot drag it up, settled so a model load does not read as a
leak — and it is RELATIVE, so it survives a model swap.

What keeps this from becoming a second lifecycle:

- **A restart IS the dispose-and-lazy-recreate** the idle reaper already uses:
  the map entry is cleared first and the next dispatch rebuilds the pool through
  the single-flight guards, with `ensureModelsForSteps` reloading models on
  demand. `CrashSupervisor` is untouched — it supervises the addon RUNNER.
- **At most one pool per sweep**, a 30 min per-pool cooldown, and a budget of 6
  restarts per 24 h past which the watchdog STOPS and escalates at error
  (`pool memory watchdog gave up — restart budget exhausted`). That is
  [D6](../decisions/adr-0006.md) at pool granularity: never an unbounded
  restarter.
- **A pid that changed on its own** — a kernel kill, an idle eviction — is
  re-baselined and never charged to the budget.

Every threshold is env-tunable (`CAMSTACK_POOL_MEM_INTERVAL_MS` / `_MULTIPLE` /
`_FLOOR_MB` / `_CEILING_MB` / `_COOLDOWN_MS` / `_MAX_RESTARTS` /
`_RESTART_WINDOW_MS`); a garbage value falls back to the default rather than
disarming the bound.

## Overload: the shape it takes

A worker that falls behind does NOT crash and does NOT deadlock — it answers at
full rate, further and further in the past. Once it is more than one reply
deadline behind, EVERY reply arrives after its request was abandoned and the
camera produces nothing while the worker runs flat out.

The signature, and it is unmistakable once you know it:

- `frames=0` with `dropped≈full rate` on one camera, every window;
- a steady drip of `Response for unknown request id`, ids climbing at frame rate;
- `availablePermits=1` — the semaphore is fine, this is not the 2026-07-13 wedge.

Measured on device 101 on 2026-07-31: **52 minutes** of total loss, recovered
only by restarting the runner. That figure is a one-off production observation
and has not been reproduced since — it is kept because it sizes the failure, not
because it was re-measured.

Three bounds now make the state unreachable, and they must be understood
together:

- **in-flight cap** per worker (`CAMSTACK_POOL_MAX_IN_FLIGHT`, default 8) — over
  the cap, inference is SHED with the same `{dropped: true}` contract Python
  already uses for its own per-model bound;
- **live deadline** of 3s (`CAMSTACK_POOL_LIVE_INFER_TIMEOUT_MS`), separate from
  the 60s that commands keep. Sixty seconds was never a deadline for live
  detection: a result that late describes a scene that no longer exists. A
  model load gets its own per-runtime bounds instead (`POOL_MODEL_LOAD_BOUNDS`:
  a soft bound inside the worker plus a 30 s margin on the host, and a hard
  bound after which a still-running compile costs the worker)
  ([D653](../decisions/adr-0653-a-model-load-never-runs-on-the-pool-loop-and-a-worker-that-hangs-is-recycled.md)).
- **the deadline travels ON THE WIRE** ([D350](../decisions/adr-0350-a-sheddable-request-carries-its-absolute-deadline-on-the-wire-and-expired-work-is-never-executed.md)):
  each sheddable request carries its absolute deadline (8 B epoch-ms prefix,
  protocol v2, negotiated `min()` in the handshake so version skew works in
  both directions), and the Python worker checks it immediately before predict,
  answering `{dropped: true, shedReason: 'deadline-expired'}` instead of
  executing. Without this the first two bounds only shaped the queue — the
  worker still burned 25–47 ms of predict on every abandoned request, which is
  how the 2026-09-04 storm held the accelerator at 100% with goodput ~0 for
  4 h 15 m (16 146 timeouts). A live request whose deadline fires on the TS
  side now RESOLVES as that same shed rather than rejecting; the timeout
  rejection survives for commands and model loads only.

Together the queue can hold at most `cap × deadline` of work — and since D350
expired work costs microseconds instead of a predict — so a slow worker sheds,
catches up and recovers by itself. Python's own comment records the same
failure from the other side: over-dispatching one model "balloons per-frame
inference time (9-22s observed on the N100 iGPU)".

## Node stress: the verdict above the pool

The bounds above are *per pool* and they keep one worker from wedging. They say
nothing about whether the MACHINE should still be receiving work — a node whose
pools all shed correctly is a node that is quietly dropping frames, and until
2026-08-13 nothing in the cluster had an opinion about that. The balancer's only
real-time term is `queueDepthTotal`, which read 0 on all three nodes during the
563-shed hour above.

`node-stress.ts` (pure) + `node-stress-controller.ts` (orchestrator) add the
missing tier. Sweep every 15 s over the `PipelineCameraMetricsSnapshot` samples
the orchestrator already receives:

| Sub-signal | From | Meaning |
| --- | --- | --- |
| `queuePressure` | `CameraMetrics.queueDepth` ÷ (4 × active cameras) | behind NOW |
| `dropRatio` | Δ`droppedFrames`/s ÷ Σ configured fps | throwing work away |
| `fpsDeficit` | 1 − Σ actual ÷ Σ configured | not delivering |

Only cameras in `phase: 'active'` count — an idle on-motion camera is not
evidence, which is exactly why the older absolute `fpsMinThreshold` ships
disabled. The composite is a **max**, never a sum (two half-signals must not
fake a full one).

**The corroboration rule is the load-bearing part.** A camera whose SOURCE
produces 2 of 5 configured fps shows a 0.6 deficit on a perfectly idle node.
Acting on that would tour the camera around the cluster forever, so `fpsDeficit`
counts toward the score only when a queue or a drop corroborates it — a starved
source produces neither, an overloaded node produces both.

States and hysteresis (`ok → stressed → saturated`, one rung at a time):
enter at 0.60 after 45 s, saturate at 0.80 after a further 90 s, leave only
below 0.35 after 180 s. A single disagreeing sample resets the dwell clock; the
0.35–0.60 middle band is the hysteresis and keeps a node where it is.

Only `saturated` may shed, and then AT MOST ONE camera per sweep — the largest
non-pinned active one, onto an `ok` node (never a merely-less-bad `stressed`
one) that is frame-source eligible, under its ceiling and carrying strictly
fewer cameras. Three bounds on the action, all required: a 10-minute per-device
cooldown, a **30-minute ban on returning a camera to the node it was just taken
off** (the ping-pong guard — without it a two-node cluster oscillates), and a
cluster-wide cap of 4 moves/hour after which it logs `rate-bounded` and stops
rather than churning. A camera is never PAUSED: running degraded beats running
blind, and the fps governor is already throttling.

`nodeStressMode` (Pipeline → Cluster → Settings → Load balancer) is `off` /
`observe` / `failover`, default **`failover`** (D914) — a saturated node sheds
one camera under the bounds above. `observe` only logs `node is stressed` /
`node is saturated` / `node stress cleared` with the sub-signals and moves
nothing; it is how thresholds are checked on a new fleet. The verdict history
is the `node-score` device-history series, so "how often was a node saturated"
is a query, not a log search. The four Load balancer settings (session
placement, min fps, node stress handling, low-fps window) live in the Settings
tab; the Load balancing tab keeps the live load, node shares and share source.

## Auto tune: the recommended model per device (D745, D755)

Pipeline → Cluster → Auto tune computes, for every node, the most accurate
**YOLOv9** model (t/s/m — one family for the whole cluster) its enabled
accelerators can run while each still carries a minimum number of cameras at
once, and applies it only after the operator confirmed the full list of
writes. There is no load input (D755): nothing is observed, estimated or
remembered about how many sessions ran.

- **Hardware class** from the probe's static facts (`classifyInferenceHardware`,
  `cpuModel`): `intel-core-ultra`, `intel-n-series`, `apple-m-base`,
  `apple-m-pro`, `amd-phoenix`. Anything else is `unknown` and the node is
  skipped — no guess.
- **Speed** from `DETECTOR_PERF` (class × accelerator → p50 / fps), locked to
  `docs/benchmarks/detector-latency.json`; **accuracy** from `DETECTOR_ACCURACY`
  (person recall at the shipped floor), locked to `model-floors.json`. Refresh a
  column with the `camstack-benchmark-detection` skill /
  `scripts/bench-detector-latency-column.mjs` (not the Node capacity ramp).
- **Capacity floor**: a device's capacity at a model is
  `⌊fps × (1 − headroom) / camera fps⌋` parallel sessions
  (`capacitySessionsOf`), the camera fps being the fastest camera that runs the
  pipeline root (10 when none does). A model fits when every accelerator of the
  node reaches `minSessionsPerDevice` (operator option, default 2, 1–8).
- **Pick** (`recommendNode`): one model for all of a node's accelerators (the
  floors never flip with the device a session rotated onto); among the models
  that fit, the most accurate wins and ties within 0.02 recall go to the
  faster — the step-down order keeps 640 before 320 (m-640 → s-640-int8 → …).
  When nothing reaches the floor, the model with the most capacity is used
  (`no-fit-lightest`). Every device says `capacity N sessions ≥ min M`.
  Headroom 0.4 by default (0.3–0.5). CPU fallback devices get their own pick;
  a Coral is never touched.

The apply's writes and their order are in `auto-tune-service.ts` and
`plan-diff.ts`: download first (abort on failure, nothing written), node pins
and thresholds, re-dispatch. A camera carries no model or threshold (D927), so
nothing per camera is written. The plan's
`planHash` covers every write plus the headroom, floor and camera fps; a
different hash at apply time answers `stale` with the fresh plan.

On this cluster at the defaults: hub `yolov9m-640-int8` (NPU 3 + iGPU 2
sessions), N100 `yolov9s-320-int8` (2 — `m-320-int8` at 26 fps carries only
one 10 fps camera with 40 % kept free), Mac M2 `yolov9m-640` (5). AMD Phoenix
(`agent-b` / `onnx:webgpu`) has measured single-request cells for
all six `yolov9t/s/m` @320/640 (re-measured on the GPU 2026-10-23, D845;
warm p50 40 ms for t-320 up to 228 ms for m-640, see `amd-phoenix/amd-igpu`
in `detector-latency.json`), so Auto tune can pick a mid-size model until a
capacity ramp measures real concurrency.

**Custom models are never overwritten**
([D786](../decisions/adr-0786-auto-tune-never-overwrites-a-custom-model-pin.md)).
A (node, device) whose root detector is pinned to a custom-registry model (a
fine-tune, a canary) is marked `kept: 'custom-pin'` with no chosen model, and
the diff writes nothing on it — model, thresholds and other steps' pins. One
kept accelerator keeps the node's whole accelerator group (they share one
model); a CPU device is kept alone. A training canary is an accelerator pin
too (D927), so it is kept the same way. The plan carries a `custom-pin-kept`
warning for each, shown on the Auto tune tab. If `customModelRegistry.listModels` does not
answer, every pin to a model outside `DETECTOR_ACCURACY` is kept and the plan
says `custom-registry-unreadable`.

## Reading the logs

Every line below carries the device, because `runtime` alone does not identify a
pool — a node runs one openvino pool per accelerator.

| Line | Answers |
| --- | --- |
| `inference device selection` | eligible set, chosen key, reason — `pin` / `capacity` / `tie-break` when a device WAS elected, `single-eligible-device` / `no-eligible-device` / `pin-unplaceable` / `all-devices-at-cap` when the default pool serves it instead; on a tie-break, also `tieBreak: rotation \| sticky \| lexicographic` |
| `inference devices: candidate set changed` | which device left the candidate set and why (`disabled` / `unavailable` / `cannot-host-camera-root`). Fires on CHANGE of the split, not per dispatch |
| `Pool ready` | runtime, **device**, TS workers, python workers, pids |
| `inference request timed out` | COMMANDS and model loads only since D350 (a live deadline expiry is a shed, not a fault): pid, runtime, device, **inFlight**, reqId, `timeoutMs` (the deadline that actually fired — until 2026-08-02 this printed the 60 s constant while the 3 s live deadline was what expired), and `tags.deviceId` since 2026-08-07 |
| `live inference deadline expired in flight — answered dropped` | the D350 backstop: the worker never replied inside the live deadline and the request resolved `{dropped, shedReason: 'deadline-expired'}`. Sampled (first + every 500th, `deadlineShedTotal` keeps the exact count); carries the same pool facts as the old error line plus `tags.deviceId`. Rare against a v2 worker (it sheds expired work itself, fast); the steady state against a wedged or v1 worker |
| `pool worker POISONED — recycling it` | [D653](../decisions/adr-0653-a-model-load-never-runs-on-the-pool-loop-and-a-worker-that-hangs-is-recycled.md): a LIVE worker that will not serve again. `reason` is `compile-hung` (a compile still running at its hard bound; not charged to the device), `unresponsive` (a command and the `mem_stats` probe after it both missed, no load outstanding) or `infer-unresponsive` (live requests ended without a result for 30 s). Also names `command`, `modelIndex`, `model`, pid and `inFlightCommands`. The `Worker process exited` line that follows carries `poisonedBy` |
| `model compile past its soft bound — left running so its cache can be written` / `slow model compile finished after its soft bound` | a compile that answered `compile-timeout` and kept going; the second line is the worker's `compile-finished-late` event, after which it loads again (warm) |
| `inference pool recycled after a compile hung — not charged to the device budget` | the provider's side of a `compile-hung` recycle |
| `model loadable again after late compile` | a late compile came back; the pool's load back-off is lifted at once |
| `model REFUSED on this device — its compile timed out repeatedly` | ERROR, once: the same model timed out twice within an hour on this device and is now refused there by name; the device serves every other model. Cleared by `rearmInferenceDevice` |
| `pool command timed out but the worker answers its liveness probe — slow, not wedged` / `liveness probe unanswered while a model load is outstanding — not poisoning yet` | a command missed its deadline and the worker was NOT poisoned — because the probe answered, or because a load is sent and unanswered on a runtime flagged `gilMayBeHeldDuringCompile` (CoreML only) |
| `Step variant load failed` / `model load for dispatch failed` | every rejected model load (D653). The first is the one ERROR per failed load, naming `modelId`, `poolIndex`, `deviceKey` and `reason`. The second is a WARN per camera that lost a frame, tagged `{deviceId}`, once per state change (a new failure, a refusal). A failed model is not re-issued on its pool for 5 s, doubling to 5 min |
| `[wN] Model N load started` / `loaded (ms)` / `load TIMED OUT` / `returned AFTER its bound` | the worker's own view of a load (stderr relayed at WARN). A `load started` with no end line is a compile in progress |
| `worker saturated — shedding` | the in-flight cap engaging, edge-triggered; carries `cap`, `inFlight`, `deadlineMs` and `tags.deviceId` |
| `pool memory` | one info line per pool per 60 s sweep — `poolKey`, pids, per-worker rss/vm/peak-rss/swap/threads, the baseline and the threshold, plus backlog / shed / dropped / **deadlineExpired** (dead work refused, D350) / models loaded and the Python `mem_stats` (which carries `shedDeadlineExpired` from the worker's own counter). Shipped to Loki, because the addon log ring holds ~10 min and a ramp takes hours |
| `pool memory watchdog restarting pool — RSS over threshold` | the bound firing: `poolKey`, rss, threshold, baseline, `restartsInWindow` and the candidates deferred to a later sweep. `pool memory watchdog gave up — restart budget exhausted` is the escalation; `pool process changed outside the watchdog` is a kernel kill or an idle eviction being re-baselined |

The two `pool memory` lines are the exception to the per-device rule: a pool
serves N cameras, so they are keyed by `poolKey` and carry no `tags.deviceId`.
That is a real gap on the restart line — a pool restart is a seconds-long
inference hole for every camera on it, and no line names them.

`inFlight` is the number that changes the diagnosis: it separates one stuck
request from a worker drowning in backlog. Nothing measured it before
2026-07-31, which is why a camera could be dead for the better part of an hour
and look merely quiet.

## Traps

- **`camstack deploy -n <agent>` used to report success without delivering —
  FIXED 2026-08-07, and the diagnosis is worth keeping.** It was never a stale
  tarball cache. Three separate defects wore the same symptom: the `-n` branch
  called `$agent.deploy` and never `$agent.reload`, so correct bytes sat unloaded;
  `nodeId` was read before the multipart body drained, so a large tarball silently
  redirected the deploy to the HUB while the CLI printed the agent's name; and the
  hub's addon back-fill re-installed the REGISTRY's build of the same version over
  the one just delivered, ~1.5 s later. Both callers now go through one
  `deliverAddonToAgent` (deploy → sha256 check → reload), `checkDeployTarget` makes
  the CLI FAIL when the hub reports a target other than the one requested, and an
  agent target that reloaded nothing warns. Checking for a string only the new
  build contains is still the cheapest way to be sure.
- **Re-publishing a model under the SAME filename reaches a node only through
  its revision.** `ensureModel` keeps a file whose path exists
  (`packages/system/src/download/model-downloader.ts`). Every format hosted on
  the mirror has a revision (D744), which is the sha256 of its weight file and
  is generated into `packages/system/src/download/hosted-model-revisions.ts`.
  A copy is current when `<file>.revision` next to it matches. It is also
  current when its weight file hashes to the revision, and then the record is
  written and nothing is downloaded. Otherwise `isModelDownloaded` says no and
  `ensureModel` fetches the new bytes, and the old copy serves until they are
  complete (D743). So, after replacing an artefact on the mirror, run
  `npx tsx scripts/check-hosted-model-revisions.ts --write` and ship the table
  in a `@camstack/server` release. Without that, the node keeps the old file
  while the catalog, the logs and the version all say it was updated. A
  running pool keeps the model it already loaded until it reloads it.
- **`hasGpu` on `RunnerLocalLoad` is literal** — an NPU or a Coral is not a GPU.
  The per-accelerator truth is `RunnerLocalLoad.devices`. It was a hardcoded
  `false` until 2026-07-31 and the admin UI drew a badge from it.
- **A pin to a root-guard-excluded device is silently ignored** — `balance()`
  never sees a pin outside the eligible set and falls through to the capacity
  tier. The selection line now makes it visible (`pin` and `chosen` differ).
- **`getEligibleInferenceDevices` does a live probe RPC on every dispatch**, on
  both the session and standing paths — `resolveEligibleInferenceDevices` calls
  `probeNodeInferenceDevices`, which is a bare `platformProbe.getCapabilities`
  with no cache. Still true on 2026-08-08. Only the LOGGING was gated: the
  candidate-set line fires on change of the split, not per dispatch.
