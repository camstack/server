---
title: Merging Intel NPU and GPU under a combined OpenVINO — is it worth it?
date: 2026-08-26
status: accepted
covers:
  - packages/addon-pipeline/python/inference_pool.py
  - packages/addon-pipeline/src/detection-pipeline/provider.ts
  - packages/addon-pipeline/src/detection-pipeline/engine/resolve-device-engine.ts
  - packages/addon-pipeline/src/detection-pipeline/engine/shared-inference-pool.ts
  - packages/addon-pipeline/src/detection-pipeline/engine/pool-memory-guard.ts
  - packages/addon-pipeline/src/detection-pipeline/engine/pool-provisioning.ts
  - packages/addon-pipeline/src/detection-pipeline/runtimes.ts
  - packages/addon-pipeline-orchestrator/src/device-balancer.ts
  - packages/addon-pipeline-orchestrator/src/session-dispatch-controller.ts
  - packages/addon-pipeline-orchestrator/src/node-inference-usability-mirror.ts
  - packages/types/src/capabilities/pipeline-orchestrator.cap.ts
  - packages/types/src/capabilities/pipeline-runner.cap.ts
---

# Merging Intel NPU and GPU under a combined OpenVINO — is it worth it?

> Analysis, 2026-08-26. **No code touched.** Everything that follows is read
> from the tree and from Loki with narrow windows; the live numbers are marked as
> such with the time of reading. The context is
> [`2026-08-26-pool-not-initialized.md`](./2026-08-26-pool-not-initialized.md) —
> read it first. Companion:
> [`../architecture/inference-devices.md`](../architecture/inference-devices.md),
> [`../architecture/detection-execution.md`](../architecture/detection-execution.md).

---

## 0. The answer in one paragraph

**No, it is not worth it, and on the incident that generated the question it would have done
worse.** A CamStack pool is **one Python process**
(`runtimes.ts:196`, `numWorkers: 1`). Merging NPU and GPU under `AUTO`, `MULTI` or
`HETERO` means hosting the two accelerators **in the same process**. The
2026-08-25 failure is not an exception of the GPU plugin: it is
`*** longjmp causes uninitialized stack frame ***` — a glibc **`SIGABRT`**,
which kills the process and cannot be intercepted by Python. Today that crash costs
**half** of the hub node's inference capacity; in a single pool it would cost
**all of it**. And it would not avoid it: `MULTI:NPU,GPU` (and `AUTO` in
`CUMULATIVE_THROUGHPUT`) **compile the model on every listed device at
load** — the GPU compilation of `camstack-yolov9m-320-int8.xml`, which is
exactly the line that aborts, would be executed anyway, every time, in the
same process that hosts the NPU. Moreover `AUTO` **has already been tried and removed
from this repo** after a failure experienced in production
(`inference_pool.py:180-186`, (planning repo: superpowers/specs/cluster-epic-2026-07-04/plan-CB1-openvino-realfix.md)).

The real answer is the one the operator did not ask for: **the remedy is not
merging the devices, it is the liveness gate with a budget and terminal state that
`2026-08-26-pool-not-initialized.md` §6.2 has already designed and deliberately
not implemented** — plus the piece that document does not cover and that is the real
reason the damage continues: **the terminal state must reach the
balancer**, because at this moment what sends the cameras to the dead pool **is not
an operator pin, it is an automatic rotation.**

---

## 1. The live state, measured now (2026-08-26, windows of 3-20 minutes)

Before reasoning about the design, three facts read now, not cited by the incident
document:

**1.1 — The storm is still going on.** `{job="camstack"} |= "not initialized"`
over a **10-minute** window returns 1000 lines (the tool's limit). The
blackout is not over: it has lasted ~33 hours.

**1.2 — The hub's GPU pool is still a corpse, and the runner was
restarted.** Last 3 minutes:

```
pool memory sample dropped for worker pid  {"poolKey":"openvino:gpu","pid":9948}
pool memory  {"poolKey":"default:openvino:npu","pids":[2568],"rssMb":139,
              "baselineMb":507,"thresholdMb":2027,"action":"ok",
              "modelsLoaded":10,"threads":60,"uptimeSec":12776}
```

`uptimeSec: 12776` (~3 h 33 m) on the NPU worker: **the runner restarted ~3.5 hours
ago and the GPU pool died again**. Independent confirmation of the determinism:
it is not a single incident, it is a compilation that aborts at every boot.

**1.3 — The Intel GPU in itself works: on another host.** In the same
window `agent-a` has a healthy `default:openvino:gpu` (pid 10868):
`rssMb: 599`, `peakRssMb: 665`, `modelsLoaded: 10`, `threads: 94`,
`action: "ok"`. The defect is `yolov9m-320-int8` × the GPU plugin **of that host**,
as already concluded — not "the Intel iGPU".

**1.4 — The fact that changes the question: there is no pin. There is a
rotation.** `inference device selection`, last 20 minutes, only the lines with
`tieBreak: "rotation"`:

| camera | `openvino:gpu` (dead) | `openvino:npu` (healthy) |
| --- | --- | --- |
| 3839 | 10 | 8 |
| 3835 | 4 | 2 |
| 618 | 3 | 3 |
| 587 | 2 | 2 |
| 104 | 1 | 3 |
| 592 / 1439 | 0 | 1 / 1 |
| **total** | **20** | **20** |

Twenty sessions in twenty minutes, across six cameras, were elected onto a pool that
answers `not initialized` to every frame. No line carries `pin`: the reason is
always `tie-break` / `rotation`. The device balancer
(`device-balancer.ts:198 pickInferenceDevice`) **deliberately alternates** between
devices at parity — it is the fix for the 2026-07-31 starvation — and has
**no** health input. It is doing exactly its job, on a set of candidates that lies.

> This reformulates the operator's question. It is not "is it worth merging the two
> devices I pinned": it is "half of my sessions end up on a dead
> accelerator and nobody notices". The merge does not touch that
> problem; it moves it.

---

## 2. How a device is modelled, today

### 2.1 Where a `deviceKey` is born, and who chooses it

| Question | Answer | File:line |
| --- | --- | --- |
| What a `deviceKey` is | The string `<backend>:<device>` (`openvino:gpu`, `edgetpu:usb`, `cpu`) | `engine/resolve-device-engine.ts:10` |
| Who translates it into an engine | `resolveDeviceEngine` → `{ runtime:'python', backend, format, device }`. The `format` comes from the sole SSOT `DEVICE_BACKEND_TO_FORMAT` | `engine/resolve-device-engine.ts:10-19` |
| Who enumerates a node's devices | `platformProbe.getCapabilities` — a **hardware** probe | `addon-pipeline-orchestrator/src/index.ts:1610-1638` |
| Who decides which are candidates | `resolveEligibleInferenceDevices`: probed ∩ stored, filtered by `enabled`, `available` and the root-capability guard | `addon-pipeline-orchestrator/src/index.ts:1467-1484` |
| Who chooses the device for ONE session | `pickInferenceDevice`: pin → capacity → rotation | `device-balancer.ts:198`, called by `session-dispatch-controller.ts:700-707` |
| The operator's pin | `pipelineDeviceKey` in the **camera's device store** — therefore **per-camera**, soft L1 affinity, `'auto'`/absent = no pin | `addon-pipeline-orchestrator/src/index.ts:976-987` |
| Granularity of the node default | `engineDevice@<nodeId>` — the node's default engine, **per-node** | `provider.ts:694-699` for the TTL; the default engine is `this.currentEngine` |
| Who builds the pool | `resolveDeviceFactory(deviceKey)` — single-flight per key, one `EngineFactory` per `deviceKey` in `factoriesByDevice` | `provider.ts:4065-4118`, map at `provider.ts:532` |
| When the device pool coincides with the default | `enginesEqual` also compares `device` — if it coincides the default pool is reused, otherwise a second one is opened | `provider.ts:363-370`, used at `provider.ts:4066-4069` |

So: **the device is not a per-camera choice by default.** It is a
per-session rotation among the node's enabled devices, with an
*optional* per-camera pin that overrides it. That is why the incident has a
blast radius of six cameras and not one.

### 2.2 One pool = one Python process

```
runtimes.ts:196   openvino: { tuning: { concurrency: 1, numWorkers: 1, batchMode: 'none', … } }
shared-inference-pool.ts:999-1015   for (i < numWorkers) new PoolWorker(...) ; Promise.all(initialize)
shared-inference-pool.ts:413        this.process = spawn(pythonPath, [scriptPath], …)
```

`numWorkers: 1` ⇒ **one Python process per pool**. The `pythonWorkers: 4` that
appears in `Pool ready` are **threads** inside that process, not processes
(`inference-devices.md`, «`pythonWorkers=4` on an openvino pool is CORRECT»). And
`pool-provisioning.ts:25-29` is explicit: **there is no per-DEVICE
provisioning row**, only per-runtime — `openvino:gpu` and `openvino:npu`
inherit the same numbers.

A side observation, not requested but relevant to the memory count:
on the hub the `Pool ready` lines for a single runner pid are **three** —
`openvino:gpu`, `openvino:npu` and **a second** `openvino:npu`. One is the node's
default pool (`default:openvino:npu` in the watchdog), the other is a device pool
with the same logical key. It is the anomaly already noted as unknown in
`2026-08-26-pool-not-initialized.md` §8.3, and it means that **even before
talking about the NPU+GPU merge there is probably a duplicate Python process to
eliminate** — a real saving, at zero risk, which the merge does not offer.

### 2.3 Memory: what would add up and what would not

The memory bound is **relative**, not absolute — `restartMultiple`,
`floorBytes` and `ceilingBytes` in
`packages/types/src/utils/pool-memory-watchdog.ts`: restart at
`restartMultiple × baseline`, with a **1024 MB floor** and a **3072 MB ceiling**
as a backstop. And it is **per pool** (`pool-memory-guard.ts:60-108` samples per
`poolKey`).

Measured now: `default:openvino:npu` on the hub `baselineMb: 507`,
`thresholdMb: 2027`, `rssMb: 139` with 10 models loaded;
`default:openvino:gpu` on agent-a `baselineMb: 496`, `thresholdMb: 1982`,
`rssMb: 599`.

In a single pool:

- **what is shared** is the Python interpreter and the text pages of the OpenVINO `.so`
  (already shared between processes by the page cache) — the saving is only the private
  heap of one interpreter;
- **what is not shared** is what weighs: the compiled kernels are **per device**,
  the runtime buffers are **per device**, and the 10 models would be
  compiled **twice** in the same address space;
- **the ceiling stays one.** A single pool inherits the same ~2 GB threshold
  to do the work of two, and a watchdog `restart` would restart **both**
  accelerators together instead of one.

The expected net saving is therefore small and the risk is concentrated. **Neither
number is to be assumed: they must be measured** (§7).

### 2.4 Per-device compilation, and the ready handshake

`Pool ready` arrives early (`startupMs: 139-251 ms` on the hub): the pool
declares itself ready **before** compiling the models. Compilation happens at
`loadModel`, in `inference_pool.py:813-843`, device by device, with
`CACHE_DIR` so as not to pay the JIT again at every spawn (`inference_pool.py:779-785`).
That is exactly where the hub aborts, **1.3 s after `Pool ready`**.

This separation is the reason `AUTO` is incompatible with this
design even regardless of the crash: the typical behaviour of `AUTO` is to
**serve on CPU while the accelerator compiles, then hand the model over hot**. On this pool the ready has already been given, the `InferRequest`s are already
created, and the hot handover is precisely what in 2026-07 produced
`Cannot find tensor for port opset1::Result score_8` in production
(`inference_pool.py:180-186`, full diagnosis in
`plan-CB1-openvino-realfix.md` §1).

### 2.5 The fallback between devices: it exists, but it is about **capacity**, not **health**

Searched in every form. What there is:

| Mechanism | What it decides | File:line | Why it did not fire |
| --- | --- | --- | --- |
| Capability gate per dispatch | Does the `deviceKey`'s pool have a build of the model for its **format**? If not → the node's default engine | `provider.ts:3068-3175`, warn at `:3151` | `openvino:gpu` and `openvino:npu` have the **same** format `openvino`. The gate cannot tell them apart. Ever. |
| Root-capability guard (orchestrator) | Can the device's format run `object-detection`? | `inference-device-model.ts:55-63` | Same thing: keyed on the format, blind between gpu and npu (already noted in `inference-devices.md:69-71`) |
| Detail-plan device jump | An enrichment step can jump to another device of the same node | `pipeline-runner/device-jump.ts` | Also format-based |
| Compilation failover inside the pool | Explicit NPU > GPU > CPU ladder, `try/except` per candidate | `inference_pool.py:211-236` and `:813-843` | **Active only when the requested device is `AUTO`/empty.** With a pin (`operator-pinned device GPU`, `inference_pool.py:764`) the list is `[GPU]` and that is it. **And it would not save anything anyway: `except Exception` does not intercept a `SIGABRT`.** |
| Node usability mirror | Does the **node** still have at least one usable device? | `node-inference-usability-mirror.ts` | It works at **node** granularity. The hub has the healthy NPU, so it is (correctly) usable. Nobody asks the same question **per device**. |
| Idle reaper | Evicts an idle pool after 6 h | `provider.ts:694-699`, `:4071-4074` | `touch()` on the `existing` branch: the traffic that fails at 13 Hz refreshes it. It never expires. |
| Memory watchdog | Restarts a pool that grows too much | `pool-memory-guard.ts:70-82` | `readProcessMemory(9948)` → `null` → `continue` → `workers.length === 0` → `return null`. It exempts the dead one instead of restarting it. |

And the vocabulary that would be needed **already exists**: the reasons for excluding a
device are a closed contract in
`packages/types/src/capabilities/pipeline-orchestrator.cap.ts` (`INFERENCE_DEVICE_EXCLUSION_REASONS`) —
`disabled` · `unavailable` · `cannot-host-camera-root` ·
`accelerator-preferred`. `unavailable` is documented as «the live probe did not
report it usable». The problem is **who answers**: the probe is
`platformProbe.getCapabilities`, i.e. the hardware
(`index.ts:1610-1638`). The hardware is there. The one that knows the pool is dead is
**the detection addon**, and that fact today has **no channel** to the
balancer: `RunnerInferenceDeviceSchema`
(`packages/types/src/capabilities/pipeline-runner.cap.ts`, `RunnerInferenceDeviceSchema`) carries
`deviceKey`, `weight`, `maxSessions` — and nothing else. No health field.

**This is the hole.** Not the lack of a combined device.

---

## 3. What would really change with `AUTO` / `MULTI` / `HETERO`

All three share the premise that sinks the idea: **a single
`ov::Core`, a single process, a single crash domain.** Below, what each does
on the specific failure of 2026-08-25.

| Mode | What OpenVINO does | Effect on the GPU abort | Effect on the rest |
| --- | --- | --- | --- |
| `AUTO` (default, LATENCY) | Compiles on the highest-priority candidate; with `ENABLE_STARTUP_FALLBACK` it serves on CPU during the JIT and then hands over | The NPU wins the priority: **the GPU is never compiled** → the abort does not happen… because the GPU is never used | Equivalent to **turning the GPU off**, but losing pin, per-device telemetry and per-device capacity. And it brings back the CPU→accelerator handover that already broke production (`score_8`) |
| `AUTO` + `CUMULATIVE_THROUGHPUT` | Compiles on **all** devices and distributes the requests | **The abort happens**, inside the process that also hosts the NPU → **both are lost** | `EXECUTION_DEVICES` becomes a set: CamStack's per-device capacity and telemetry stop having meaning |
| `MULTI:NPU,GPU` | Compiles on **every** listed device at load, round-robin on the requests | **The abort happens**, same process → **both are lost** | Doubles compilation time and memory per spawn; the memory watchdog covers two accelerators with a single threshold |
| `HETERO:NPU,GPU` | Partitions the **operators of a single graph** among devices | Compiles subgraphs on **both** → the abort happens, same process → **both are lost** | It is not load balancing: it solves nothing of what the operator wants. Moreover `_static_batch_required` (D202) is per-candidate (`inference_pool.py:552-566`) and `HETERO` has no candidates: the rule "the NPU rejects a dynamic dimension" has nowhere to apply |

Two observations worth as much as the table:

1. **`AUTO` is not a hypothesis: it is a rollback.** This repo used it, saw
   it break in production on the N100 and removed it in favour of explicit
   compilation with the NPU>GPU>CPU ladder. The comment at
   `inference_pool.py:180-186` is the record of that decision, and
   `inference-devices.md:124-133` repeats it as a rule: *«Do not replace this
   with `AUTO`, `MULTI` or `HETERO`»*. Proposing it again without dismantling that
   record would be going around a rule instead of changing it.

2. **OpenVINO's `AUTO` does not include the NPU in the default candidate
   list.** To have it you must write it explicitly (`AUTO:NPU,GPU`) — which
   means the only way to get "NPU+GPU together" is the mode that
   compiles on both, i.e. the one that reproduces the abort.

---

## 4. The three questions, separately

### (a) Would it avoid certain problems? — **NO. It would worsen this one.**

The decisive reasoning, in three steps:

1. `*** longjmp causes uninitialized stack frame ***: terminated` is glibc's fortify
   abort → `SIGABRT`. **It kills the process.** It is not a C++ exception,
   it does not rise as `Exception` in Python, and the per-candidate `try/except` of
   `inference_pool.py:819-838` — the only failover between devices that exists —
   **cannot intercept it.**
2. One pool = one process (`runtimes.ts:196`). Combining NPU and GPU puts the two
   accelerators in the **same** crash domain.
3. `MULTI` and `AUTO:CUMULATIVE_THROUGHPUT` compile on **both** devices
   at load. The GPU compilation of `camstack-yolov9m-320-int8.xml` — the line
   that aborts — would be executed anyway.

Result: today the crash costs **50%** of the hub's capacity (measured at
§1.4: 20 sessions out of 40 lost). With a single pool it would cost **100%**, and
`pipeline-analytics` would no longer receive anything from any camera of the hub.
The only variant that avoids the abort — `AUTO:NPU,GPU` in LATENCY — avoids it
**because it never uses the GPU**, i.e. obtaining the same result that is obtained
by disabling `openvino:gpu` in one click, but paying for it with pin, telemetry and
per-device capacity.

Problems that the merge would really solve: **none of those in this
list.** The duplicate pool of §2.2 is solved with a fix to
`enginesEqual`/default-engine, not with `MULTI`. The blind rotation of §1.4 is
solved with a health bit, not with `MULTI`.

### (b) Does it increase performance? — **Unknown, and the expected direction is neutral or negative on this load.**

No number here is invented and none is to be assumed. What can be said from the
structure of the system:

- **Adding up throughputs requires concurrency that this deployment does not have.** The
  sessions are *on-motion*: they start, last seconds, end, and almost never
  overlap — this is the balancer's explicit premise
  (`device-balancer.ts:22-32`: «at dispatch time EVERY device scores 0 and every
  dispatch is a tie») and `getLocalLoad()` typically reports
  `attachedCameras: 1` (`inference-devices.md:86`). A load at batch 1 and
  concurrency ~1 is **latency-bound**, not throughput-bound: `MULTI` distributes
  *requests* among devices, and with one request at a time there is nothing to
  distribute.
- **The pool is configured for LATENCY on purpose.** `PERFORMANCE_HINT` is set to
  `LATENCY` (`inference_pool.py:199-208`) because `THROUGHPUT` multiplies the internal
  streams, the memory and the async queue — and is a known factor of
  OOM-freeze on the N100. The gain that `MULTI` promises is collected in the
  `THROUGHPUT` regime, which here has been discarded for measured reasons.
- **NPU and iGPU share memory, bus and power budget.** The sum is not
  automatic and cannot be measured at a desk.
- **The compilation cost doubles per spawn.** With `CACHE_DIR` it is paid
  once cold, but the memory watchdog and every runner respawn
  pay it again — and there would be two compilations instead of one.
- **One thing the merge certainly loses**: the possibility of running different
  steps on different devices. The detail plan's device-jump
  exists for that and has an `EXECUTION_DEVICES` to read; under `AUTO`/`MULTI`
  that datum becomes opaque.

Honest verdict: **unknown**, with the expectation that on this load it is neutral or
worse. What to measure to close the question: §7.

### (c) Is it worth it? — **No.**

Cost: rewriting the pool's compilation path, redoing the modelling of the
`deviceKey`s (which today is the backbone of pin, capacity, telemetry,
device-jump and UI), dismantling an explicit architectural rule
(`inference-devices.md:124`) and a record of a failure experienced
(`plan-CB1-openvino-realfix.md`).

Benefit: an unproven performance gain on a load that
structurally cannot collect it, and a small memory saving that the duplicate NPU
pool of §2.2 gives back at a much lower cost.

Risk: **concentrating in a single process a failure that today is confined to
half.**

---

## 5. What to do instead

In order, with constraint D6 respected (budget, backoff, terminal state
**reported**, never an infinite loop).

1. **Operator action, right now, zero code.** Disable `openvino:gpu`
   on the hub (the node's `inferenceDevices`, the same map read by
   `resolveEligibleInferenceDevices`, `index.ts:1467-1470`). It is not a
   per-camera pin: the six cameras of §1.4 have no pin, so removing the
   device from the eligible set is the only lever that stops the rotation. §1.3
   says this does NOT touch `agent-a`, which has its healthy iGPU.
   Effect: the storm goes out and the hub is back to 100% on NPU.

2. **Liveness gate with budget and terminal state** — `2026-08-26-pool-not-initialized.md`
   §6.2, unchanged. `isReady()` exposed on `EngineFactory` (which today exposes
   `getPoolPids`/`getPoolBacklog` and **not** `isReady` —
   `engine/engine-factory.ts:308-320`, while
   `SharedInferencePool.isReady()` already exists at
   `shared-inference-pool.ts:1265`); a non-ready factory treated as absent
   in `resolveDeviceFactory` (`provider.ts:4071`); rebuild under a per-`deviceKey`
   budget with backoff and a terminal `failed` state, exactly the discipline of
   `CrashSupervisor` (`packages/system/src/kernel/moleculer/crash-supervisor.ts`).
   Without the budget, on a *deterministic* crash like this one, a Python
   process is spawned per frame at 13 Hz.

3. **The piece missing from the incident document: the terminal state must
   reach the balancer.** A `failed` pool must make its `deviceKey` disappear
   from the eligible set, otherwise the rotation of §1.4 keeps feeding
   it — a runner-side liveness gate alone converts 370,000 `not initialized`
   lines into 370,000 `pool failed` lines and saves not a single frame. The
   vocabulary already exists (`unavailable`,
   `pipeline-orchestrator.cap.ts:545-546`); what is missing is the **channel**, because the probe
   that answers today is the hardware one (`index.ts:1610-1638`) and the hardware is there.
   The safe form is the one already codified by D49 in the
   `NodeInferenceUsabilityMirror`: **one bad observation arms, the second
   consecutive one applies; a good one rehabilitates immediately** — applied per
   `(nodeId, deviceKey)` instead of per `nodeId`, and with the exclusion **reported**
   (a line + the event that already exists for the node), because "off" must not
   look like "broken".

4. **Stop the index leak** — §6.3 of the incident. With a dead pool,
   `allocateIndex()` consumes a slot per frame and beyond 254
   (`encodeModelByte`) the pool can no longer serve inference **even if the
   worker came back**. As long as this remains, every form of self-healing must
   go through a factory rebuild and not an in-place retry.

5. **Investigate the duplicate NPU pool** (§2.2 / incident §8.3). If `enginesEqual`
   does not recognise that `openvino:npu` **is** the node's default engine, the hub
   is paying for a whole Python process and a second copy of the 10 models for
   nothing. It is the memory saving that the merge promised, obtained without
   merging anything.

---

## 6. What has NOT been demonstrated here

- That `MULTI` does **not** give throughput on a concurrent load. It was not
  measured; the argument is that *this* load is not concurrent.
- That the crash is reproducible with a model other than
  `yolov9m-320-int8`. Every occurrence in the logs ties it to that model.
- The reason for the glibc abort. It stays outside this repo (incident §8.1).

---

## 7. What must be MEASURED before deciding anything

None of the numbers below exists today. None is to be estimated.

| # | Question | How | Why it blocks the decision |
| --- | --- | --- | --- |
| 1 | On a healthy Intel host (`agent-a`), what are the median and p95 latency of `yolov9m-320-int8` on explicit `GPU` vs explicit `NPU` vs `MULTI:NPU,GPU`, at **concurrency 1**? | The repo's synthetic benchmark, `plane: 'frame'`, explicit `deviceKey` (`bench-dispatch.ts` rejects the cached fast path when `deviceKey` is named — that is the guarantee that the right pool is being measured) | It is the only measurement that can refute (b). At concurrency 1 `MULTI` has nothing to distribute: if it does not gain here, it will never gain on this load |
| 2 | The same, at **concurrency 4 and 8** | Idem, batch of synthetic sessions | Tells whether the gain exists *somewhere*, and therefore whether it is worth changing the load model instead of the device model |
| 3 | Steady-state RSS and **peak** of a `MULTI:NPU,GPU` pool with the 10 models loaded, against the sum of the two separate pools measured today (507 + 496 MB of baseline, 139 + 599 MB of RSS) | `pool memory` already exists and samples per `poolKey` | Decides whether the memory saving is real or whether the single pool breaks through the 2 GB ceiling that today covers a single accelerator |
| 4 | Cold and warm (`CACHE_DIR` populated) compilation time for a single device vs `MULTI` | `Loading step variant` → `Step variant loaded` in Loki | The compilation cost is precisely what explodes here; doubling it per spawn has a cost in blind window |
| 5 | Does the hub's GPU compile `yolov9m-320-int8` with `_FORTIFY_SOURCE` disabled, or with a different version of OpenVINO / compute-runtime? | Reproduction on the host, outside this repo | If the defect is a version, the right answer is to update the driver — not to touch the architecture |
| 6 | How many sessions/day and how many cameras are really eligible on ≥2 OpenVINO devices, across the whole fleet? | `inference device selection`, `tieBreak: "rotation"`, aggregated over 24 h with `count_over_time` (not with `limit`, which truncates silently at 1000) | Sizes the benefit of *any* work on the device tier — including points 2-3 of §5 |
| 7 | Is the hub really holding two `openvino:npu` pools? | `Pool ready` per runner pid + `poolKey` in the `pool memory` lines, narrow window | If so, the memory saving is already there to collect, without merging anything |

---

## 8. Verdict

**Do not merge NPU and GPU.** The merge does not avoid the failure that generated the question
— it compiles it anyway, and in the same process, turning a 50% loss
into a 100% one. It has no demonstrated performance gain on a load that is
latency-bound at concurrency ~1. And it would dismantle the per-device modelling
on which pin, capacity, telemetry and device-jump rest, to bring back in a
plugin (`AUTO`) that this repo has already expelled after a failure experienced.

The real defect is that **a pool's health is not an input to any
routing decision**, at any level: neither the capability gate (keyed
on the format, blind between two devices of the same backend), nor the reaper
(kept alive by the failure), nor the memory watchdog (which exempts the dead one),
nor the balancer (which rotates over a set that lies). The two fixes that
matter are the liveness gate with budget and terminal state of §5.2 and its
channel to the balancer of §5.3. And both are worth it even if one day the hub's GPU
went back to compiling.
