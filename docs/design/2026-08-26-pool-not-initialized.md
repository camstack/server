# `PoolWorker[w0]: not initialized` — the storm is not the 2026-08-07 bug

> Status: **investigation, 2026-08-26.** One fix landed (§6.1); the rest is a
> proposal. Everything below was read off the running hub via Loki and off the
> tree at `packages/addon-pipeline/src/detection-pipeline/**`. No production
> state was changed.
>
> Read with `docs/architecture/detection-execution.md` and
> `docs/design/decode-path.md`.

---

## 0. The one-paragraph answer

There is **no fourth unprotected "assign then await" path**. All four sites that
publish an `EngineFactory` publish *after* awaiting `initialize()`; the comment
at `provider.ts:4032` is accurate about the defect it describes, and that defect
is not what happened. What happened is the opposite failure: a pool that came up
**correctly**, then **died**, and that nothing in the system is able to notice.
The Python worker for `openvino:gpu` was `SIGABRT`'d by glibc 1.3 s after `Pool
ready` while compiling `yolov9m-320-int8` for the Intel GPU. Node reported
`code === null`, the `exit` handler's guard treated that as nothing to report,
and from that instant every frame routed to `openvino:gpu` was answered
`PoolWorker[w0]: not initialized` — **for 31 hours and counting**, ~370 000 ERROR
lines, every frame lost.

The pool was **not** recreating itself. It was never recreated at all.

---

## 1. The incident is not the incident that was reported

The brief described a 14-minute burst, 19:59–20:13 local, "at least 1000 lines".
That shape is an artifact of the counting tool truncating at 1000 lines: the last
1000 lines happened to span 14 minutes.

Measured with `count_over_time` (no truncation), `{job="camstack"} |=
"PoolWorker[w0]: not initialized"`:

| 30-min bucket (UTC) | lines |
| --- | --- |
| 2026-08-25 10:30 | 1 |
| 2026-08-25 **11:30** | **3 884** ← storm begins |
| 2026-08-25 22:00–00:00 | 14 736 / 14 699 / 14 693 / 14 700 |
| 2026-08-26 09:00 | 6 999 |
| 2026-08-26 15:30 | 6 544 |
| 2026-08-26 18:25 | 59 (still running at the time of writing) |

**~31 hours continuous. Order 370 000 lines.** GPU object detection on the hub
has been totally dead since 2026-08-25 ~11:20 UTC.

---

## 2. The death, to the millisecond

`hub/detection`, runner pid 1875, pool `openvino:gpu`:

```
15:17:26.114  Pool ready {"runtime":"openvino","device":"gpu","workers":1,"pythonWorkers":4,"pids":[9948]}
15:17:26.116  [w0] OpenVINO: operator-pinned device GPU
15:17:26.153  [w0] OpenVINO: PrePostProcessor folded for camstack-yolov9m-320-int8.xml (…)
15:17:27.452  [w0] *** longjmp causes uninitialized stack frame ***: terminated   ← glibc abort
              … (126 identical lines, one per Python worker thread)
15:18:26.xxx  pool  inference request timed out {"worker":"w0","pid":9948,"inFlight":0,"reqId":1,"timeoutMs":60000}
              runInference failed … "PoolWorker[w0]: inference request 1 timed out after 60000ms (worker alive, no reply)"
15:18:26+     runInference failed … "PoolWorker[w0]: not initialized"   ← forever after
```

`*** longjmp causes uninitialized stack frame ***: terminated` is glibc's
`__longjmp_chk` fortify abort → `SIGABRT`. It is **deterministic and
reproducible**: every occurrence in 42 h of logs (37, 3, 45, 38, 39, 76, 126 per
hour bucket) follows the pair `operator-pinned device GPU` +
`PrePostProcessor folded for camstack-yolov9m-320-int8.xml` by 1.3–1.8 s. The
**same model on NPU loads fine** (`operator-pinned device NPU` +
`camstack-yolov9m-320-int8.xml`, no crash) — so this is `yolov9m-320-int8` × the
Intel GPU plugin, not the model and not the pool.

The origin is therefore **outside this repo** (OpenVINO GPU plugin / compute
runtime). Everything that turned a 1.3-second crash into a 31-hour silent
blackout is **inside** it.

---

## 3. Why nobody was told (the bug that landed today)

`shared-inference-pool.ts`, as it stood:

```ts
this.process.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    this.log.error('Worker process exited', { meta: { worker: …, code } })
    this.rejectAll(new Error(`Worker process exited with code ${code}`))
  }
  this.ready = false
})
```

A child killed by a signal reports `code === null`. The guard excludes exactly
that case. Consequences, both measured:

- **`Worker process exited` appears ZERO times in 24 h of hub logs**, while
  ~370 000 `not initialized` lines were produced downstream of it. The one line
  that could have named the cause was the one suppressed.
- `rejectAll` never ran, so the in-flight model load (`reqId 1`) was orphaned
  and hung the full 60 s command deadline, then reported **"worker alive, no
  reply"** about a process that had been dead for a minute. That message sent
  the first look at this incident in the wrong direction.

This is a direct violation of the repo rule *"a branch that DROPS work silently
logs it"*. **Fixed** — see §6.1.

---

## 4. Why nothing recovered it — four independent misses

`ensureReady()` throws `PoolWorker[…]: not initialized` for **three** distinct
states, and the message distinguishes none of them: never initialized, worker
exited, worker disposed. Only the first is the 2026-08-07 race. The recovery
paths for the other two do not exist:

1. **`resolveDeviceFactory` never re-checks liveness.**
   `provider.ts:4068` — `const existing = this.factoriesByDevice.get(deviceKey);
   if (existing) { this.deviceReaper.touch(deviceKey); return existing }`. The
   single-flight guard protects *creation*; nothing protects against handing
   back a dead one. Same shape at `ensureEngineFactory` (`if (this.engineFactory)
   return`).

2. **The idle reaper is kept alive by the failure itself.**
   `DEVICE_POOL_IDLE_TTL_MS` is 6 h, and `touch()` fires on the `existing`
   branch — i.e. on every failing dispatch. The one mechanism that would have
   evicted the dead entry is refreshed ~13×/s by the very traffic that is
   failing. It can never expire.

3. **The memory watchdog exempts a dead pool instead of restarting it.**
   `pool-memory-guard.ts:70-82` — `readProcessMemory(9948)` returns `null` for a
   pid whose `/proc` is gone, the loop `continue`s, and then
   `if (workers.length === 0) return null // every pid vanished mid-sweep (pool
   respawning)`. The pool is not respawning; it is dead. The watchdog is the only
   supervisor these Python children have, and this branch removes the only
   candidate it would ever have restarted. Observed live: `pool memory sample
   dropped for worker pid {"poolKey":"openvino:gpu","pid":9948}`, repeating every
   sweep, for 31 hours, next to zero `default:openvino:gpu` verdicts.

4. **`EngineFactory` exposes no health at all.** `SharedInferencePool.isReady()`
   and `PoolWorker.isReady()` both exist. `EngineFactory` surfaces
   `getPoolPids()` and `getPoolBacklog()` and **not** `isReady()`. The signal is
   one layer below every caller that needs it and is never lifted.

---

## 5. The index leak — why this pool could not have recovered anyway

`pipeline-model-manager.ts:325-343`:

```ts
const index = this.pool.allocateIndex()          // allocate
this.log.info('Loading step variant', …)
const { loadMs } = await this.pool.loadModel(index, config)   // await — throws here
…
perStep.set(modelId, entry)                      // record ONLY on success
```

`allocateIndex()` is `this.nextFreeIndex++`. On failure the index is consumed and
nothing is recorded, so the next frame re-enters, allocates a *new* index and
fails again. Measured live: `Loading step variant … poolIndex: 24347`, and in
the same 30-minute window **5 936 `Loading step variant` against 0 `Step variant
loaded`** — every load attempt failing, one leaked slot per frame.

`SharedInferencePool.encodeModelByte` rejects any index `> 254`. So after ~255
failed loads **this pool could never serve inference again even if the Python
worker came back**. The leak is bounded by the factory's lifetime (a rebuilt
factory gets a fresh counter), which is precisely why recovery must go through a
factory rebuild and not a retry-in-place.

Note also the per-frame cost of the failure loop: each frame runs the full
`Benchmark: models to load` → `Loading additional models for benchmark` →
`allocateIndex` → `loadModel` → throw cycle, at ~13 Hz, for 31 hours.

---

## 6. What to do

### 6.1 Landed: the silent branch (this commit)

`shared-inference-pool.ts` — every unexpected child exit is now an ERROR line
carrying `code`, `signal`, `pid`, `runtime`, `device` and `inFlight`, and
`rejectAll` runs so in-flight work fails at once instead of hanging 60 s on a
deadline that then lies about the worker being alive. A deliberate `dispose()`
nulls `this.process` before terminating, so its SIGTERM stays silent.

Test: `engine/__tests__/worker-death-by-signal-is-not-silent.spec.ts`. Verified
load-bearing — with the old guard restored, 2 of its 3 cases go red.

This does not stop the storm. It makes the next occurrence **decidable in one
log line** instead of by hand-correlating a 60-second-late timeout against a
Python stderr line.

### 6.2 LANDED (2026-08-26): liveness gate + bounded rebuild + the routing channel

The correct remedy is **not** a fourth copy of the creation guard. It is a
different invariant — *liveness*, not *creation-race*:

1. Surface `isReady(): boolean` on `EngineFactory`, delegating to
   `SharedInferencePool.isReady()` (which already exists).
2. In `resolveDeviceFactory` and `ensureEngineFactory`, treat a cached factory
   that is **not ready** as absent: drop it from `factoriesByDevice` /
   `engineFactory`, `dispose()` it, and fall through to the existing
   single-flight rebuild. No new lifecycle — this is exactly `restartGuardedPool`.
3. In `pool-memory-guard.ts`, split the two cases the `workers.length === 0`
   branch currently conflates. "Pids vanished **and** the factory reports not
   ready" is a **dead pool → restart**, not a sweep to skip. This is the smallest
   change that would have self-healed the incident.

**This must be bounded.** The crash here is *deterministic*: `yolov9m-320-int8`
on the Intel GPU aborts every single time. A naive "rebuild when not ready"
would spawn a Python process per frame at 13 Hz — measured since, with the
budget disarmed: 12 dispatches build 12 pools.

**Implemented as [D257](../decisions/adr-0257-a-dead-inference-pool-leaves-the-balancer-candidate-set.md).**
Steps 1 and 2 landed as written. Step 3 did NOT: the memory watchdog does not
restart the dead pool, because a restart from there bypasses the budget and
reintroduces the spawn loop; it logs `inference pool is DEAD` and leaves
condemnation to the dispatch path, which charges the budget.

Two things this section did not say, and which turned out to be the whole job:

- **The budget must not reset on a successful spawn.** This worker dies 1.3 s
  AFTER `Pool ready`, so any success-based reset makes the budget unreachable.
  There is deliberately no `noteHealthy()`; deaths only age out of a window.
- **"a fallback to another device" is not something the runner can do.** The
  runner does not know which other device the balancer would have picked, and a
  runner-side substitution would silently contradict an operator pin. The
  terminal state is instead PUBLISHED
  (`pipelineExecutor.getInferenceDeviceHealth`) and the ORCHESTRATOR reroutes,
  through the eligible-device set it already owns. Without that channel this
  whole section converts 370 000 `not initialized` lines into 370 000 `pool
  failed` lines and saves no frames.

### 6.3 Proposed: stop leaking the index

`ensureLoaded` should release the index when `loadModel` rejects (a free-list, or
simply not advancing `nextFreeIndex` on failure), and should log the failure —
today the `Loading step variant` line has no matching failure line at all, only
the caller's generic `runInference failed`.

### 6.4 Operator action, independent of any code change

`yolov9m-320-int8` cannot be served by this node's OpenVINO **GPU** plugin. It
works on NPU. Until the plugin/driver is updated, the object-detection device pin
for the affected cameras should not be `openvino:gpu`.

---

## 7. What was excluded, and how

| Hypothesis | Verdict | Evidence |
| --- | --- | --- |
| A fourth "assign then await" path | **Excluded** | All four publication sites read: `provider.ts:2415` (awaits `cached.initPromise`), `2473` (awaits `initPromise`), `4015` (awaits `factory.initialize`), `4111` (awaits `factory.initialize`). Every one publishes after the await. |
| The pool was recreating in a cycle | **Excluded** | Exactly one `Pool ready` for `openvino:gpu` on pid 1875 (15:17:26), then none. `Pool process(es) terminated` for that device: none. |
| The runner was crash-looping | **Excluded** | All 1 784 lines in the sampled window carry `tags.pid = 1875`. The runner is stable; the Python child is not. |
| A runaway benchmark | **Excluded** | `Benchmark: models to load` has exactly one call site, `provider.ts:2512` — inside **`runPipeline`** (declared at 2110), the live per-frame path. The message is misnamed, not a benchmark. |
| Memory pressure / OOM kill | **Excluded** | The healthy `openvino:npu` pool on the same node samples at 388–390 MB against a 3 072 MB threshold, `action: ok`. The GPU worker died 1.3 s after start, at ~0 work done. |
| A model or config change | **Excluded** | The model was already `yolov9m-320-int8` before the storm; the same model loads without incident on NPU in the same minute. |
| An override-cache swap | **Excluded** | `Benchmark: engine override` does not appear in the incident window. |
| Load shed | **Excluded** | `inFlight: 0` on the timeout line; the shed counters for this pool never move. |

---

## 8. What remains unknown

1. **Why glibc aborts.** `longjmp causes uninitialized stack frame` names the
   symptom, not the frame. Needs a core dump or `GLIBC_TUNABLES` /
   `_FORTIFY_SOURCE=0` reproduction on the host, plus the exact OpenVINO and
   Intel compute-runtime versions in the addon image. Out of scope for this repo,
   but it is the trigger.
2. **Whether `openvino:gpu` ever worked with this model on this host**, or
   whether the pin was newly applied around 2026-08-25 11:20 UTC. The device pin
   is per-camera/per-step operator state; nothing in the log window records when
   it was set.
3. **Whether the NPU pool's repeated `Pool ready` → `Pool process(es)
   terminated` within the same millisecond** (observed twice at 15:15:04 and
   15:20:00) is a benign double-create losing a race, or a second, quieter
   defect. It is not this incident, but it is the same map.

## 9. Instrumentation that would make the next one decidable

Beyond §6.1, in descending order of value:

- **Report the state, not a single string.** `ensureReady()` should distinguish
  `never-initialized` / `exited(signal)` / `disposed`. One error text for three
  states is what made a chronic corpse look like a startup race for 31 hours.
- **Log the load failure where it happens.** `Loading step variant` with no
  `Step variant loaded` and no failure line is a silent drop by the repo's own
  rule; the count of consecutive failures per `(deviceKey, step)` belongs in
  that line.
- **A per-pool "last successful inference" gauge**, surfaced next to the `pool
  memory` verdict. A pool that has been ready-false for N sweeps is the exact
  signal the watchdog is missing, and it costs one field.
