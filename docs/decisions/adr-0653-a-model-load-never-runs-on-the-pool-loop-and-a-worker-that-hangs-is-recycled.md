---
id: D653
title: A model load never runs on the pool's event loop and is bounded; a compile that hangs costs its model, not the device, and a worker that hangs is recycled
status: accepted
date: 2026-09-27
supersedes:
applies-to:
  - packages/addon-pipeline/python/inference_pool.py
  - packages/addon-pipeline/src/detection-pipeline/engine/shared-inference-pool.ts
  - packages/addon-pipeline/src/detection-pipeline/engine/pipeline-model-manager.ts
  - packages/addon-pipeline/src/detection-pipeline/engine/pool-worker-health.ts
  - packages/addon-pipeline/src/detection-pipeline/engine/model-load-governor.ts
---

## Context

2026-09-26, hub, `openvino:gpu` shared inference pool. From 18:33:48 until a
container restart at 22:41 the pool's Python worker was alive and answered
nothing. It was stuck inside ONE synchronous `core.compile_model()` of
`camstack-yunet-2023mar.xml` for the Intel iGPU, the first cold compile of
that model on this hub, and that call never returned.

The root cause was in `inference_pool.py`: `_run` handled `MSG_COMMAND` inline
on the asyncio loop (`response = _handle_command(models, cmd)`, line
~2952 before this change), and `load` → `_load_model()` → `compile_model()` is synchronous. While
it ran, the worker read no request and wrote no reply. What followed:

- the host's 60 s command deadline (`POOL_INFER_TIMEOUT_MS`) fired 786 times
  across six cameras, each one `worker alive, no reply`;
- the memory watchdog's 2-minute `mem_stats` probe, also an inline command,
  timed out 123 times out of 123;
- nothing recycled the worker. The per-device restart budget
  (`InferenceDeviceLivenessSupervisor`, the D6 discipline) only counts a pool
  that is NOT ready, and this one was ready, so the balancer kept routing
  cameras to it;
- 43 further `Loading step variant yunet` loads were issued behind the hung
  one. Each was rejected on the host after 60 s and none was logged. Each
  new dispatch re-issued the load and allocated a fresh pool index. The
  provider's `modelLoadInFlight` gate was one node-wide promise, so the hung
  GPU compile also held up loads for the NPU and CPU pools.

Earlier the same day the GPU compiler stack (libopencl-clang / IGC) crashed
the worker three times (SIGSEGV, SIGABRT) while compiling `scrfd-2.5g`, and a
fresh worker compiled YuNet on the same GPU in 1.4 s. So the trigger is a cold
JIT compile inside a worker that is serving six models at the same time, on
an old driver stack (compute-runtime 25.18). Updating the driver is the
operator's decision. This record is about making the pool survive the hang.

## Decision

**A model load never runs on the pool worker's event loop, and never runs
unbounded. A compile that outlives its soft bound keeps running so a slow one
still writes its cache; one still running at the hard bound costs the worker,
and a model whose compile keeps timing out is refused on that device by name.
A worker that is otherwise hung is recycled under the device's crash budget.**

(Fix round 1, 2026-09-27, changed items 2 to 6 below. The first version killed
the compile at the one 120 s bound, so its cache was never written: every
respawn faced the same cold compile, and 3 × ~125 s fits the device budget's
10 minutes, so a slow but finite compile walked the device to `failed`
deterministically.)

1. **Off the loop.** `load` / `replace` run on a dedicated daemon thread
   (`ModelLoader`), and the loop only awaits them. Model commands are
   consumed in order by one task (`CommandRouter`), so a `status` or `unload`
   never overtakes the `load` sent before it. `mem_stats` and `uncache_frame`
   are answered at once and never queue behind a load. Inference keeps being
   served while a compile runs. The thread is a daemon on purpose:
   `concurrent.futures` joins its threads at interpreter exit, so a stuck
   compile in an executor would also stop the worker from shutting down.

2. **Two bounds per runtime, in one table** (`POOL_MODEL_LOAD_BOUNDS`,
   `engine/pool-worker-health.ts`). The soft bound is declared to the worker
   as `modelLoadTimeoutMs`; the host's reply deadline for a load is soft +
   30 s, so the worker's named answer always arrives first.

   That depends on one invariant: **at most one load is outstanding per
   worker**. The worker runs model commands in order and starts a load's soft
   bound only when that load begins, while the host's deadline runs from the
   SEND. A load queued behind another would have its host deadline fire
   before the worker could answer it. The provider serialises loads per pool
   (`modelLoadTail`) and the model manager joins identical ones, so the queue
   depth is 1. `PoolWorker.warnIfLoadQueued` logs `model load queued behind
   another on one worker` if anything ever sends a second.

   | Runtime | Soft | Hard | GIL grace | Why |
   | --- | --- | --- | --- | --- |
   | `openvino` | 120 s | 600 s | no | A cold iGPU compile of the whole model set measured ~25 s on the N100; one model is 1-3 s (YuNet 1.4 s on a fresh worker). No evidence of a legitimate compile past 120 s. The binding is believed to release the GIL around `compile_model`; unmeasured on the hub. |
   | `coreml` | 300 s | 900 s | **yes** | A load may wait up to 180 s for another worker's compile-cache lock (`COMPILE_CACHE_LOCK_TIMEOUT_SEC`), then compile: 180 + 120. Whether coremltools releases the GIL while compiling is unverified. |
   | `onnxruntime` | 120 s | 600 s | no | Session creation, no compile cache; no frozen loop observed, and the grace would blind stall detection during every load. |
   | `edgetpu` | 120 s | 600 s | no | Precompiled models; nothing is compiled at load. |

3. **Past the soft bound, the compile runs on.** The worker replies
   `{status: 'error', reason: 'compile-timeout', modelId, index}` and is
   **poisoned for new loads only**: every later load is refused at once
   (`worker-poisoned`), already-loaded models keep serving, and the host does
   NOT recycle it. When the compile comes back, the worker sends an
   unsolicited `compile-finished-late` event (request id `0xFFFFFFFF`, never
   allocated to a request) and loads again. Its result is discarded (the host
   was told the load failed), but its cache is written, so the next load of
   that model, after the host's back-off, is a warm hit in the same worker.
   A compile still running at the HARD bound poisons the worker as
   `compile-hung` and recycles it. The hard clock counts from the ORIGINAL
   compile's start: the worker reports `compileElapsedMs` on both
   `compile-timeout` and `worker-poisoned` replies (round 2). When the late
   compile comes back, the provider lifts THAT model's negative-cache
   back-off at once and logs `model loadable again after late compile`; a
   late compile that FAILED is one more failure of that model, and its
   back-off grows (round 3). When the worker does not report
   `compileElapsedMs`, the host counts from this load's send time.

4. **A hung compile costs the model, not the device.** A `compile-hung`
   death is **not** charged to the device's crash budget (`noteFactoryDeath`).
   Instead the provider counts `compile-timeout`s per (device, model)
   (`ModelLoadGovernor`). A load whose HOST deadline expires with no reply
   counts too (round 3): it is rejected as a `compile-timeout` of that model,
   and the recycle that follows is `compile-hung`. Before, a GIL-frozen
   compile was charged as `unresponsive` and walked the device to `failed`.
   The same model timing out
   `COMPILE_TIMEOUTS_BEFORE_REFUSAL` = 2 times within an hour is **refused on
   that device by name**, with one ERROR (`model REFUSED on this device`). The
   device keeps serving every other model. Since a slow compile now finishes
   and warms the cache, only a compile that never finishes can time out
   twice. This is what bounds the respawns: one hard-bound recycle per
   timeout, and at most two timeouts per model. A success clears the count;
   `rearmInferenceDevice` clears the refusals with the device. A crash stays
   a crash: `unresponsive` and `infer-unresponsive` deaths, and every real
   crash, are charged to the budget as before (3 in 10 min, then `failed`,
   published on the health channel, which the balancer excludes).

5. **Recycling, on the host.** `PoolWorker` recycles a live worker as:
   - `compile-hung`, above;
   - `unresponsive`: a command misses its deadline AND the `mem_stats` probe
     sent after it misses its 10 s deadline. On CoreML only (the runtime
     flagged `gilMayBeHeldDuringCompile`), this waits while a load is sent
     and unanswered (`gilGraceActive`, item 6); on every other runtime an
     outstanding load changes nothing;
   - `infer-unresponsive`: live requests keep ending without a result (deadline
     expiry, or a shed) — at least 20 of them, over 30 s measured from the
     START of that unanswered streak (the first unanswered request after a
     result), not from the last result. Idle time is not silence: before the
     release review, a 60 s lull plus the first 20 sheds of a burst (~8 s
     with six cameras) poisoned a healthy worker and charged the device. A
     real hang is still caught about 33 s after it starts.
     The clock restarts when the worker becomes ready, when any load
     replies, and when a late compile comes back: spawn and load time are
     not silence (round 2; before, a 30 s load plus 20 sheds poisoned a
     healthy worker and charged the device).
     The `mem_stats` probe is answered by the loop, so it proves nothing about
     the executor threads; a shed is also answered by the loop, so it does not
     count as a result. A late reply to an abandoned request does.

   A poisoned worker logs one ERROR, `pool worker POISONED — recycling it`,
   with the reason, command, model index, model, pid and in-flight commands;
   takes no new work; and is killed: at once when unresponsive, after its
   in-flight requests drain when compile-hung, with a backstop at
   `POOL_LIVE_INFER_TIMEOUT_MS` + 1 s. The kill goes through the ordinary
   `Worker process exited` path (with `poisonedBy`) and `rejectAll`.

6. **The CoreML decision: a grace period, not a subprocess.** Whether
   coremltools holds the GIL while it compiles is **unverified**. If it does,
   the loop freezes, nothing — not the soft timer, not `mem_stats` — can
   answer, and the 60 s + 10 s probe would kill a legitimate compile. So a
   failed probe and an inference stall do not poison a worker **only while a
   load is sent and has no reply yet, and only on a runtime flagged
   `gilMayBeHeldDuringCompile`** (CoreML; see the table).

   **The real bound (round 3).** The grace cannot be chained. Round 2's rule
   ("a load is outstanding") let the provider's NEXT load — a queued set, or
   the same set after its 5 s back-off — swallow the probe failure of the one
   that had just missed its deadline: four back-to-back unanswered CoreML
   loads ran 1320 s and were never poisoned. Now a load whose host deadline
   expires with no reply ends the grace for that worker until a reply of any
   kind arrives, and the next failed probe or stall poisons it
   (`compile-hung`).

   That rule is the bound, and it is derived like this. A frozen loop sends
   no reply, so the first unanswered load — sent at `t0` — misses its host
   deadline at `t0 + soft + 30 s`, whatever else the provider sends after it.
   The liveness probe that deadline triggers then fails `10 s` later, with the
   grace already off. So a frozen CoreML worker is recycled at most
   **300 + 30 + 10 = 340 s** after its first unanswered load.

   **Why there is no separate cap.** Round 3 first added one: a grace window
   per worker, soft + 30 s from the first unanswered load, renewed only by a
   reply. It could never bind. Every load's host deadline has that same
   length, from a send time no earlier than the window's start, so the
   missed-deadline rule always fires first or at the same instant, and
   removing the cap left every test green by construction. A check that can
   never fire reads as a second guarantee that does not exist, so it was
   deleted.

   Round 2 narrowed this: round 1 also
   suppressed both rules while a compile ran past its soft bound, which left
   a worker whose inference hung behind that compile — the 2026-09-26 shape
   exactly — invisible until the hard bound (600-900 s). Once the worker has
   REPLIED `compile-timeout` its loop is proven alive, so the normal rule
   applies. A compile subprocess was not chosen for the same reasons as below.

7. **Loads on the host.**
   - **Per pool and per model set.** Two dispatches needing the same models on
     the same pool share one load. A dispatch needing a different set queues
     behind the pool's current load and then decides for itself, so camera B
     needing Y is never rejected by A's failure on X. Loads on different
     pools never wait for each other. `PipelineModelManager` also joins a
     pending load of the same `(step, model)`.
   - **Negative cache.** After a failed load the model is not re-issued on
     that pool for 5 s, doubling per consecutive failure up to 5 min. It is
     consulted on demand, with no timer; a success clears it. Before this,
     `needsPoolUpdate` stayed true and every frame re-issued the failing load.
   - **One ERROR per failed load**, where it failed: `Step variant load
     failed` with `modelId`, `poolIndex`, `deviceKey` and the reason. Every
     camera that lost a frame gets its own WARN, `model load for dispatch
     failed`, tagged `{deviceId}`, **once per state change** of that model
     (a new failure, a refusal), never once per frame.
   - A failed load gives its pool index back (`releaseIndex`).

8. **`replace` keeps the old model serving** until the new slot is installed.
   A replace that fails or times out leaves the old model in place; the old
   slot object is dropped on a successful swap, never mutated, so a predict
   already holding it finishes normally.

## Not done: compiling cold in a short-lived child process

A child that only compiles, populating `.ov-cache`, before the serving worker
imports the blob would contain a compiler SIGSEGV/SIGABRT. It would also make
a hung compile killable without costing the serving worker. It is the right
next step, and it is **not implemented** for three reasons:

- It cannot be tested here. There is no Intel GPU on the development Mac, and
  the containment depends on OpenVINO producing the SAME cache key in the
  child for an in-memory model that is PPP-folded and batch-pinned
  (`_build_ov_ppp_model`, `_pin_batch_for_device`). Nobody has measured that.
- On a warm cache it costs a Python + OpenVINO start for every load, on every
  pool spawn, unless the parent can tell a cold compile from a warm one before
  it starts. There is no reliable way yet to know that without OpenVINO's
  internal hash.
- The crash case is already bounded: a compiler SIGABRT is a worker death,
  and the budget costs three spawns, not one per frame.

Shape of the next step: run `inference_pool.py` in a precompile mode with the
exact load config, and let the parent compile only after the child exits 0
within the bound. A child that crashes or times out is reported as a named
load failure and never costs the serving worker.

## Consequences

- **A slow compile no longer costs anything but the soft-bound WARN.** One
  that never finishes costs one recycle per hard bound (10 min on OpenVINO)
  and is refused on the device after two timeouts.
- **A frozen loop is only detected after the load's own deadline, and only on
  CoreML.** A CoreML worker whose compile holds the GIL forever is recycled
  340 s after its first unanswered load (soft 300 s + 30 s margin + 10 s
  probe), whatever the provider sends after it, not at 70 s. The recycle is
  `compile-hung` and counts against the model. Every other runtime keeps the
  normal rules throughout a load.
- **The model refusal is not on the health channel.** The channel's shape is
  device-level (`InferenceDeviceUnhealthy` in the `pipeline-executor` cap), so
  the balancer still elects a device for a camera whose model is refused
  there; the dispatch is refused by name and the camera's line says so. Adding
  models to the channel is a cap change (framework release) and is left open.
- **Inference now runs next to a cold compile in the same process.** If that
  concurrency is itself what triggers the IGC hang, hangs may get more
  frequent; each now costs a recycle at most, and the model's refusal after
  two ends it.
- **A second model is briefly resident during a `replace`.**
- A recycled worker's remaining in-flight requests fail once when it is
  killed, like the memory watchdog's restart (D177).

## Enforcement

Each fix was removed on its own and its test went red:

- `python/test_inference_pool_compile_off_loop.py` (run by
  `scripts/test-python-pool.sh`): `mem_stats` during a blocked load; order
  kept; `compile-timeout` names the model; a poisoned worker refuses further
  loads; a late compile is never installed; **a compile that finishes after
  the bound writes its cache, re-enables loads, and the next load is warm**;
  **a replace that times out or fails leaves the old model; a successful one
  swaps without mutating the old slot**.
- `engine/__tests__/poisoned-worker-is-recycled.spec.ts`: the soft bound does
  not recycle; a late-finish event cancels the hard bound; the hard bound
  recycles as `compile-hung`, not charged; drain, and the drain backstop;
  command plus probe missed means poisoned, an answered probe does not, and a
  load outstanding gives grace; `infer-unresponsive` fires on a stall and not
  while results arrive; per-runtime bounds, CoreML at least lock + compile.
- `engine/__tests__/model-load-is-joined-and-named.spec.ts`: a load is joined,
  the rejection is logged with index and device, and the index is released.
- `__tests__/model-load-rejection-names-the-camera.spec.ts`: N dispatches
  after a failure make one load and one ERROR; the back-off retries and a
  success clears it; each joined camera gets its own tagged line; a different
  model set is not handed another's failure; a hung GPU load does not block
  the NPU; two compile timeouts refuse the model by name, not the device, and
  re-arm clears it; ordinary failures never refuse.
- Round 2, in the same two spec files: after a `compile-timeout` reply a hung
  inference is recycled on the normal rule (CoreML); the grace holds with a
  load unanswered on CoreML and does not on OpenVINO; a hung executor seen
  only through `dropped` replies is recycled; a 60 s load or a 60 s spawn
  followed by 20 sheds does not poison; the hard clock counts from the
  reported original start; the event request id is never allocated across a
  wrap; the owner hears of a late compile, which lifts the back-off; a set
  queued behind a failed load is refused by the back-off without re-issuing.
  The Python suite pins `compileElapsedMs` and that the late notification is
  held until sent.
- Round 3: back-to-back unanswered CoreML loads are poisoned within
  soft + 30 s + probe; a host-side load deadline is a `compile-timeout` of
  that model and its recycle is `compile-hung`, not charged; a refusal
  without `compileElapsedMs` counts from the load's send time; a late
  compile restarts the stall clock; a late compile lifts only its own
  model, and a failed one keeps it backed off — driven end to end from the
  worker through the real pool and factory to the provider
  (`__tests__/late-compile-reaches-the-provider.spec.ts`).
- `__tests__/dead-pool-is-not-handed-back.spec.ts`: the budget charge and the
  health channel carry the pool's death reason; a `compile-hung` death never
  charges the device.

## Verification on the live hub

**Passive, read-only.** Run after the release is installed.

```bash
# Host-side timeouts per hour on the GPU pool. Expect ~0; the incident ran 786 in 4 h.
ssh unraid 'docker logs --since 24h CamStack 2>&1 | grep "timed out after 60000ms on openvino:gpu" | cut -c1-13 | sort | uniq -c'
# Every load says when it started and how long it took ("load started" with no end line = a compile in progress).
ssh unraid 'docker logs --since 24h CamStack 2>&1 | grep -E "Model [0-9]+ (load started|loaded|replaced|load TIMED OUT)|returned AFTER its bound|compile past its soft bound|slow model compile (finished|failed)" | tail -40'
# Recycles, refusals and the budget's verdicts.
ssh unraid 'docker logs --since 24h CamStack 2>&1 | grep -E "pool worker POISONED|Worker process exited|recycled after a compile hung|model REFUSED on this device|inference pool died|inference device FAILED|Step variant load failed|model load for dispatch failed" | tail -40'
```

Expected on a healthy day: no `POISONED`, no `load TIMED OUT`, and every
`load started` followed by a `loaded` within seconds. To confirm that
`compile_model` releases the GIL, look for a `mem_stats`-driven `pool memory`
line timestamped between a `load started` and its `loaded`.

**Active. For the operator to schedule; NOT run by the agent.** This
exercises exactly one cold compile.

1. In a quiet window, delete ONE GPU cache blob under the models directory's
   `openvino/.ov-cache/` (the YuNet one, identified by mtime right after a
   YuNet load).
2. Open one live session on a camera whose face step routes to
   `openvino:gpu`.
3. Watch for `Model N load started: …yunet…` and then either `loaded (… ms)`;
   or `compile past its soft bound` followed by `slow model compile finished`
   and a warm reload; or, at the hard bound, `pool worker POISONED …
   compile-hung`, `Worker process exited … poisonedBy`, and a rebuild that is
   not charged to the device.

Any of these outcomes is correct. A silent stall is not.
