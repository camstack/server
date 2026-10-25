---
title: Durable value tracking — who already does it, what runtime state costs, and what a central mechanism would buy
last-verified: 2026-10-03
applies-to:
  - packages/system/src/builtins/device-manager/device-state-mirror.ts
  - packages/types/src/device/device-runtime-state.ts
  - packages/types/src/device/__tests__/durable-runtime-state.spec.ts
  - packages/addon-post-analysis/src/notification-center/occupancy-store.ts
  - packages/addon-post-analysis/src/notification-center/alarm/alarm-panel-device.ts
  - packages/addon-post-analysis/src/notification-center/liveness-ledger.ts
  - packages/addon-post-analysis/src/notification-center/device-directory.ts
  - packages/addon-post-analysis/src/durable/durable-ledger.ts
  - packages/addon-post-analysis/src/pipeline-analytics/runtime/slice-throttler.ts
  - packages/addon-pipeline-orchestrator/src/node-stress-controller.ts
  - packages/addon-pipeline-orchestrator/src/zone-mirror-hydration.ts
  - packages/addon-pipeline-orchestrator/src/device-features-mirror.ts
  - packages/addon-pipeline-orchestrator/src/node-stress-move-ledger.ts
  - packages/addon-pipeline-orchestrator/src/durable/durable-ledger.ts
  - scripts/check-age-keyed-retention.ts
  - scripts/check-durable-state-declared.ts
  - scripts/check-runtime-state-durability.ts
covers:
  - packages/system/src/builtins/device-manager/**
  - packages/addon-post-analysis/src/notification-center/**
---

# Durable value tracking

> **STATUS, re-verified 2026-08-14: EVERY PHASE OF §4.4 SHIPPED.** Phases 0 and
> 1 on 2026-08-13 ([D131](../decisions/adr-0131.md)); Phases 2, 3 and 4 the same
> day ([D132](../decisions/adr-0132.md)). This document is now the census and
> the reasoning behind a design that exists, not a proposal.
>
> **BUILT.** `DurableLedger`, extracted from `liveness-ledger.ts` and shipped as
> a byte-identical copy in each consuming addon (addons never import each
> other): `packages/addon-post-analysis/src/durable/durable-ledger.ts` and
> `packages/addon-pipeline-orchestrator/src/durable/durable-ledger.ts`. Liveness,
> occupancy, stationary objects and snooze windows sit on it; the outbox
> deliberately does not, as §4.4 asked. Phase 3's two cold-start holes are
> closed — `node-stress-move-ledger.ts` (a restart no longer refunds four
> failover moves) and a seeded `device-features-mirror.ts` (a cold read can no
> longer resolve `[]` and dial a sleeping battery camera awake). Phase 4's LTS
> tier is `durable/lts-aggregator.ts` plus `node-stress-lts.ts`.
>
> **Changed on the way in, and worth knowing before you read §4.4 literally:**
>
> - The semantic class is a **`@durable` comment annotation** on the constant
>   that names a collection, not a typed field — it has to cover collections that
>   will never use the shared primitive (raw DDL, the kernel's canonical KV
>   list), and a second typed authority is a shape this repo has shipped wrong
>   twice.
> - **No `docs/reference/durable-state.md` was created.** <!-- drift-ok: the catalogue page §4.4 proposed; storage.md §3a renders it instead --> The catalogue renders
>   into `docs/reference/storage.md` §3a instead, guarded by
>   `scripts/check-durable-state-declared.ts` against a shrink-only backlog.
> - **Phase 4 shipped wider than "two series only"** — motion, audio dBFS,
>   battery, occupancy per zone and the four node-stress signals, bounded by a
>   row cap per (subject, series, scope) rather than by an age sweep.
>
> **NOT built.** Nothing in §4.4. The open item is operator question 6 —
> `camstack.db` off shfs (D96's lever 1) — which every write-volume argument here
> sits on top of and which no phase of this design touched.
>
> Every number in §2 was measured on the live hub on 2026-08-13 (read-only:
> SQLite in `mode=ro`, the hub's own `settingsStore` data door, and
> `deviceState.getSnapshot` polling). Sections 1 and 4 close with questions for
> the operator; §5 records the recommendations, not the answers.
>
> **§2.4's conclusion was WRONG and is corrected in place.** Runtime state was
> never failing to persist — the probes read a collection that has no writer.
> Read §2.4's correction box before trusting anything in §0.3 or §4.2.
>
> **2026-08-19 — three of the census's blob rows were EXECUTED.** The
> device-manager's fleet is one row per device in `device-manager:devices`
> ([D182](../decisions/adr-0182-a-fleet-is-rows-not-a-blob-and-a-per-device-question-costs-one-row.md));
> six of the recorder's and the broker's root-blob keys are declared row
> collections
> ([D185](../decisions/adr-0185-a-forked-addons-settings-row-holds-config-not-a-workload.md)
> — rows 20 and 21 below are updated in place); and the integration-registry's
> dead `devices` / `device_settings_kv` tables are dropped
> ([D183](../decisions/adr-0183-code-that-is-deleted-takes-its-tables-with-it.md)).
> `device-runtime-state` itself is UNCHANGED — §2.1's write path, its row shape
> and its 1 s coalescer are all still what the code does.

The question that started this: *who already implements "remember a value across
a restart"? Should it be centralised onto one runtime-state mechanism with a
global retention policy, Home-Assistant-long-term-statistics style? And above
all — what is the WEIGHT of that, given we run SQLite on shfs and we have
already spent a night on filesystem stalls?*

The short answer, and the reason this document is longer than that: **the repo
already has the central mechanism the question asks for, it is called
`device-runtime-state`, and it was persisting far more than anyone wanted —
1.0–1.6 M whole-blob writes a day, into a collection nobody had noticed it was
not using.** That changes what the right move is.

---

## 0. TL;DR

1. **There is no "re-engineering" going on.** The per-feature stores that exist
   (liveness, occupancy, outbox, stationary, alarm) are LEDGERS — they record a
   transition the system itself accepted, and nothing else in the system holds
   that fact. A snapshot of runtime state could not replace a single one of
   them, because runtime state does not know what the notification centre
   *accepted*.
2. **The generic snapshot mechanism already exists and is already whitelisted
   by construction** (only caps that declare `runtimeState` get a slice). It is
   `device-runtime-state`: one row per device, all cap slices in one JSON blob,
   coalesced at one write per device per second.
3. ~~**It is currently writing zero rows on the live hub**~~ — **WRONG, see the
   correction box in §2.4.** The table named `device-runtime-state` has no
   writer and never had one; the state lives in `addon-device-settings` under
   `__device-state`, **1,268 rows across 374 devices**, and D96's 1,118 was the
   same prefix count. Nothing was lost, no regression happened, and the zones
   blindness on 102 was the mirror-hydration bug, not this. The real defect the
   wrong hypothesis uncovered is that the old keying wrote **one row per (device,
   cap)**, i.e. `1 + N` statements per flush instead of one upsert. Fixed
   2026-08-13 (D131).
4. **The weight is not one number, it is two, an order of magnitude apart.** The
   whole persisted state is **161 KB across 358 devices** (median device 266
   bytes). Maintaining it costs **1.0–1.6 M whole-blob writes/day ≈ 2.6–5 GB of
   rewrite** — and **~90 % of that comes from two of the 62 caps**
   (`audio-metrics`, `zone-analytics`), whose restored value is worth nothing.
   Drop those two and the cost is **~10⁵/day**; then note that **~50 % of what
   remains is a device rewriting its blob to record that it re-read a value that
   had not changed** — `battery` did this **526 times in 25 minutes without one
   percentage moving** (§2.3b). Fix that too and you are at ~5×10⁴/day for a
   snapshot that actually restores.
5. **HA's split maps onto us almost exactly, with one twist:** we already have
   HA's *short-term states* (raw `motion-events` / `audio-events` /
   `object-events`, 7-day device window). What we do not have is HA's *long-term
   statistics* — the 5-minute mean/min/max kept forever. And the one place that
   most needs it (node stress `observe` mode, whose stated purpose is to MEASURE
   thresholds) writes to nothing but the log.
6. **Recommendation: option C (hybrid), in that order** — fix the snapshot, then
   put the ledgers on a shared primitive with a declared semantic class and a
   guard, then add an LTS aggregator for the three series that earn it.

---

## 1. Census — who already persists-and-reseeds

Semantic class, used throughout:

| Class | Definition | Rule |
| --- | --- | --- |
| **LEDGER** | Records a fact only this component ever held — typically "the last observation I ACCEPTED". No other authority can regenerate it. | Must be durable. Must not be pruned against a fallible read (D49/D130). |
| **MIRROR** | A derived copy of an authority that lives elsewhere. | Must be REHYDRATED from the authority at boot, never persisted as truth. |
| **SNAPSHOT** | A cache of a value the source will re-publish on its own. | May be persisted purely to avoid a cold window; staleness at restore must be harmless. |
| **EPHEMERAL** | Correct to lose. | Must not be persisted. |
| **CONFIG** | Operator intent. | Already durable everywhere. Out of scope. |

### 1.1 The table

Rates are **per camera per day** unless marked *(global)*. "Live" = counted on
the hub on 2026-08-13.

| # | Owner | Keying | Write trigger | Rate | Live size | Retention | Boot | Class |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `device-runtime-state` (kernel; `device-state-mirror.ts`) | `id = deviceId`, whole cap map in one JSON blob **since D131** — was `__device-state:<dev>.<cap>` in `addon-device-settings`, one row per slice | a **`restored`** cap slice changed in a non-clock field, coalesced 1 s/device (D131; was: any slice at all) | offered 12–19/s = 1.0–1.6 M/day (§2.3) → **~5×10⁴/day after D131** | **1,268 rows / 374 devices** *(the `__device-state` prefix; the named table read 0 because it had no writer — §2.4)* | none — one row per device, replaced in place | seeds hub mirror + worker `fromInitial` | SNAPSHOT (2 slices are LEDGER — see §2.6) |
| 2 | `notification-center:liveness` (`liveness-ledger.ts`, D130, shipped 2026-08-13) | `subject` = `device:102` / `node:x` | state **transition** only; `no-flip` writes nothing | ~0–2 | **263 rows** (217 online / 46 offline), ~8 KB, all seeded in ONE boot | **none, deliberately** | `hydrateLiveness()` in `runBootBackfill`, AFTER `evaluationActive` since [D179](../decisions/adr-0179-start-means-the-intake-is-open-not-that-the-back-fill-has-finished.md) — the intake opens on a cold ledger and the reseed catches up; since [D698](../decisions/adr-0698-a-state-summary-may-send-one-notification-per-section-and-a-restart-never-moves-since.md) an observation made before the load ANSWERED is provisional (`boot-window-rows.ts`) — never persisted over a stored row the load has not read, merged at load so a stored row holding the same state keeps its `updatedAt` | LEDGER |
| 3 | `notification-center:occupancy` (`occupancy-store.ts`) | `dev\|zone\|class\|t<n>` | confirmed occupancy boolean **flip** | ~10–100 per watched key | **0 rows** (no watched key currently confirmed) | `pruneExcept(activeKeys)` every 30 s | `hydrateOccupancy()` suppresses re-fired edges | LEDGER |
| 4 | `notification-center:outbox` + `:meta` | `ruleId:trackId:targetId`; meta `watermark` | per notification + per delivery attempt; watermark ~every 30 s *(global)* | **151 rows / 7 days ≈ 21/day (global)**; watermark ~2,880/day *(global)* | 151 rows | 7 d, terminal rows only | rehydrates pending rows AND the 7-day dedup horizon | LEDGER + dedup gate |
| 5 | `notification-center:device-mutes` | `deviceId` | operator only; unmute = DELETE | ~0 | 0 rows | none (absence = not muted) | `load()` at start; failed load KEEPS RAM | CONFIG/authority |
| 6 | `notification-center:texts` | single `texts` doc | operator only | 0 | 1 row | none | reload at boot + every 30 s | CONFIG |
| 7 | `notification-center:snoozes` + `:snooze-suppressed` | uuid; `snoozeId\|targetId\|ruleId\|deviceId` | operator; **counter RMW per suppressed notification** | 0 unless snoozed | 0 rows | prune 6 h after close | `load()` at boot AND every 2 s drain tick | LEDGER (aggregate counters) |
| 8 | `notification-center:summary-rules` (`markGenerated`) | `ruleId` | after a successful enqueue, `max(existing, windowEndMs)` | 1–4/day *(global)* | 0 rows | none | `generatedAt` IS the anti-re-run stamp across restart | CONFIG + run-watermark |
| 9 | `notification-center:timelapse-rules` (`markGenerated`) | `ruleId`, `generatedByDevice[deviceId]` | per (rule, camera) per closed window | ~1 | 2 rows | none | an unstamped (rule, camera) re-runs; a stamped one does not | CONFIG + per-camera run-watermark |
| 10 | `pipeline-analytics:stationary-objects` | entry id | promote/retire transition **+ 5-min dirty flush** | 2–20 transitions, up to 288 flushes per live parked entry | 5 rows | TTL on OBSERVED time | `load()` at init, hydrates WITHOUT firing `onChange` | LEDGER |
| 11 | `pipeline-analytics:ops-log` | uuid | per retention/eviction op | ~1,400/day *(global)* | **42,107 rows** | 30 d fixed | never read back | AUDIT |
| 12 | `pipeline-analytics:{motion,audio,object}-events`, `tracks`, `media` | uuid | per event | **motion 43,855 + audio 32,541 + object 5,347 + tracks 1,329 + media 14,866 = ~97,938 rows/day** *(global)*; peak camera 103 = 456 motion/h | 267,963 + 235,440 + 52,263 + 10,730 + 171,444 rows; DB **326 MB** | ONE age sweep on the device window (D61), 7 d default | not reseeded (query surface) | LEDGER (raw time series) |
| 13 | `cluster-node-history` (`cluster-node-history-store.ts`) | `nodeId` | descriptor CHANGE, or a 5-minute heartbeat (D131); was `snapshot()` on every `listNodes()` refresh at 30 s | ~6 upserts/min = 8,640/day → **~864/day after D131**, for 3 rows | 3 rows | **none, no TTL, no cap** | `getAll()` renders OFFLINE nodes after a hub restart | LEDGER (grow-only), pathological write:row ratio |
| 14 | Alarm state machine (`alarm-panel-device.ts`) | `machine` key in the panel device's CONFIG blob | **every `publish()` — 1 Hz while a delay counts** | ~0 at rest, 1/s while arming/pending | 1 device | none | `restore()` in ctor via a type guard; instants not timers, so a restart mid-delay settles correctly | LEDGER-in-config |
| 15 | `zones` / `zone-rules` device-state mirrors (`zone-mirror-hydration.ts`) | deviceId slice | operator mutation only | ~0 | 19 devices carry `zones` | n/a | **one RPC sweep at boot** from the durable catalogue; a failed read writes NOTHING | MIRROR (the canonical example) |
| 16 | NC `device-directory.ts` | deviceId | boot + reconcile tick, never on the event path | n/a | RAM | n/a | cold = type-blind but safe; failed refresh KEEPS the snapshot | MIRROR (ephemeral) |
| 17 | `NodeStressController` (`node-stress-controller.ts`) | deviceId / nodeId | `noteMetrics()` per camera metric; verdict every 15 s | n/a | **RAM only** | 45 s / 2 h in-memory TTLs | **nothing survives** — cooldown, return-ban and the 4-moves/hour bound all reset | EPHEMERAL — *bug by absence for `failover` mode* |
| 18 | `DeviceFeaturesMirror` | deviceId | off the read path | n/a | RAM | n/a | self-documented cold hole: first failed read resolves `[]` → battery camera dialled awake | MIRROR — *known bug, logged not fixed* |
| 19 | `ai:usage` + `ai:budgets` | uuid, `dayKey(ts)` | per LLM call | low | 14 rows | **90 d** | rollup computed in JS | LEDGER (the ONLY persisted time series with a rollup) |
| 20 | Stream-broker — `stream-broker:{probe-snapshots,rtsp-tokens,profile-map}` **since D185**; `rtspEnabled` + `deviceOverrides` stay root-blob keys | one row per broker / per camera (`RowMapStore`); blob for the two that persist by REPLACING a shrinking set | mutation; probes throttled at 60 s | ≤1/min | was 33 KB of blob, now rows | none | full reseed at boot, persister wired BEFORE the load | CONFIG + MIRROR (exemplary) |
| 21 | Recorder — `recorder:{recording-configs,exports,ops-log}` **since D185**; `recordingPlacement` stays a root-blob key — plus `recording-index` / `calendar-index` | one row per camera / job / operation (`RowMapStore`); deviceId / path for the indexes | operator + per segment | low | was 201 KB of blob, now rows | ring bound on `recorder:ops-log` | indexes REBUILT from disk (`list()`), cannot drift | CONFIG + AUDIT + MIRROR |
| 22 | `alerts` (canonical KV) | alert id | per mapped event | **~128/day *(global)*** | **500 rows** | `retentionDays` + `maxAlerts` | persisted, survives restart | LEDGER |
| 23 | `lifecycle/jobs` journal | job/task id | during update jobs | per operation | files | journal | boot reseed re-drives active jobs from checkpoints | LEDGER + reseed |
| 24 | `HubNodeRegistry` (`registerNode`) | nodeId | one atomic idempotent RPC | per handshake | RAM | n/a | **nothing persisted, by decree (D3)**; history store is routing-blind | EPHEMERAL (correct) |

### 1.2 What the census says

- **Every LEDGER in the table records "what THIS component accepted", not "what
  the device is".** Liveness: the last liveness the notification centre
  accepted. Occupancy: the last CONFIRMED count, not the raw count. Outbox: the
  dedup horizon. Stationary: what was promoted. Timelapse: which windows already
  produced an artefact. **A generic runtime-state snapshot cannot supply any of
  them** — runtime state holds the device's current value, and none of these
  questions is about the current value. This settles the operator's suspicion
  directly: the per-feature stores are not a re-implementation of the snapshot.
- **Two things in the table are the same shape and were fixed independently in
  the same week**: the zones mirror (a slice written only on mutation, so a
  camera that never had a mutation read `null` forever) and the liveness ledger
  (a RAM map whose memory was shorter than the restart it had to survive). Both
  are cold-start-correctness bugs. **A third instance is still open**:
  `NodeStressController` (#17), where the anti-flap guards that are the entire
  safety argument for `failover` mode do not survive a restart.
- **The worst write:row ratio in the whole system is `cluster-node-history`**:
  8,640 upserts/day to maintain 3 rows, on the same shfs SQLite file that D96
  showed can stall the event loop for seconds. It exists only to age
  `lastActive`. Nobody has looked at it because it has three rows.

---

## 2. Runtime state — what it is, what it costs, measured

### 2.1 The mechanism

A capability may declare `runtimeState: SomeZodObject`. Every device that
registers that cap gets a kernel-managed slice. **62 caps declare one**; on this
installation 40 distinct slices are live across 358 devices.

Write path, end to end (one cross-process hop, three dedup gates):

```
[forked runner]  provider → BaseDevice.setCapSlice(cap, value)
                 → runtimeState.setCapState → applyCapWrite
                    ├── schema.parse
                    └── GATE A: shallowEqual(current, parsed) → return
                 → writer() → dev.deviceState.setCapSlice({capName, slice})
──────────── tRPC over UDS ────────────
[hub-main]       device-manager deviceStateProvider.setCapSlice
                 ├── GATE B: applySingleCapUpdate → shallowEqual → false ⇒ stop
                 ├── emit DeviceStateChanged  (synchronous, NOT debounced)
                 └── GATE C: scheduleRuntimeStateDiskWrite — max 1 write per
                     device per 1000 ms, trailing edge, non-resetting
                        → settings.writeDeviceRuntimeState(deviceId, WHOLE BLOB)
                        → settingsStore.set → better-sqlite3 .run()  [SYNCHRONOUS]
```

Row shape: `device-runtime-state(id TEXT PK, data TEXT)`, `id = String(deviceId)`,
`data` = `JSON.stringify(everyCapSliceOfThisDevice)`. **Replace, not merge.**

Read path at boot: `deviceManager.loadRuntimeState(deviceId)` reads the blob,
seeds the hub mirror (`seedMirror`, with `feature-probe.lastProbedAt` forced to
0 so a pre-restart probe cannot masquerade as a this-session one) and returns it
to the worker for `DeviceRuntimeState.fromInitial`.

> Verified 2026-09-28 (D663, per-field claims): the blob may additionally carry a
> `$owned` key — the device's claims record, always persisted — which
> `loadRuntimeState` strips before handing the blob to the worker (the provider
> hydrates only its own truth). The boot seed fills gaps and never overwrites
> memory (`fill`); the migration reseed passes `replace`. The write path above is
> otherwise unchanged; a claim or release is written through, outside Gate C.

> Verified 2026-09-29 (D677): because the write REPLACES the row, the writer
> never writes a device's row until this process has READ it — at fire time it
> reads the row once and fills memory's gaps from it (`fill`), and writes
> nothing while the read fails (re-armed, 1 s doubling to 60 s). Before this, a
> boot-time `zones` write reached Gate C for a device whose provider had not
> loaded yet, and the blob that replaced its row held one or two slices.

### 2.2 Magnitude — the mirror is small

Measured from `deviceState.getAllSnapshots` (one call, whole fleet):

| | |
| --- | --- |
| devices with a slice | **358** |
| total mirror, serialised | **165,384 bytes (161 KB)** |
| median device blob | **266 bytes** |
| p90-ish (13 cameras) | 1.9 – 3.9 KB |
| largest | dev 640 = **16,471 bytes** (14 caps), dev 592 = 12,482 |
| distinct cap slices in use | 40 |

The two largest blobs are both one slice: `motion-zones` at **14,564 bytes**
(dev 640) and 10,064 (dev 592) — a polygon region list. Dev 289 is 5,716 bytes
of `device-discovery`. These are the extremes worth knowing before deciding what
a whole-blob replace costs: on a camera with drawn motion zones, every 1 Hz
`audio-metrics` tick rewrites 14 KB of polygons that have not changed since the
operator drew them.

Slice population (top): `device-status` 358, `feature-probe` 358,
`enum-sensor` 80, `switch` 55, `numeric-sensor` 42, `battery` 32, `binary` 21,
`control` 20, `camera-streams` 19, `zones` 19, `motion` 18, `zone-analytics` 17,
`audio-metrics` 16, `privacy-mask` 15, `zone-rules` 15.

**The whole persisted state of the runtime-state system is 161 KB.** That is the
first number the design question needs: this is not a volume problem.

### 2.3 Rate — where the churn actually is

Two classes of slice, and they are two orders of magnitude apart.

**Hot, sub-second sources.** `zone-analytics` and `audio-metrics` are written on
every inference frame / audio chunk — 5–30 Hz per camera at source. They are the
only two caps behind a real rate limiter, `SliceThrottler`
(`pipeline-analytics/runtime/slice-throttler.ts`), which does a genuine deep
compare ignoring `ts` and then a trailing-edge throttle at
`SLICE_WRITE_INTERVAL_MS = 1_000`. So the *offered* rate at the mirror for a
live camera is **1 Hz per hot cap**, and Gate C collapses all caps of one device
into **1 disk write per device per second**.

Measured — `deviceState.getSnapshot` polled at 1 Hz for 240 s per camera
(the poll matches the throttle, so a change per sample is a change per second):

**Camera 101** — 232 samples / 241 s, whole-device blob **1,800 bytes**:

| slice | changes | per hour | slice bytes | which fields moved |
| --- | --- | --- | --- | --- |
| `audio-metrics` | 133 | **1,987** | 286 | `ts` 133, `avgDbfs` 133, `byClass` 129, `level` 125, `current` 83, `peakDbfs` 14 |
| `motion` | 2 | 30 | 73 | `detected`, `lastDetectedAt`, `autoClearAfterMs` |
| `zone-analytics` | 2 | 30 | 374 | `ts`, `frame`, `unzoned` |
| `zones`, `device-status`, `feature-probe`, `privacy-mask`, `camera-streams` | **0** | 0 | 711 / 45 / 98 / 80 / 133 | — |

**Camera 104** — 231 samples / 240 s, whole-device blob **1,334 bytes**:

| slice | changes | per hour | slice bytes | which fields moved |
| --- | --- | --- | --- | --- |
| `audio-metrics` | 169 | **2,530** | 360 | `ts` 169, `avgDbfs` 169, `level` 168, `byClass` 87, `current` 47, `peakDbfs` 12 |
| `zone-analytics` | 70 | **1,048** | 533 | `ts` 70, `stationaryObjects` 58, `frame` 15, `unzoned` 15 |
| `camera-streams`, `device-status`, `feature-probe`, `motion`, `privacy-mask`, `zones` | **0** | 0 | — | — |

Three things fall out of this, and they decide the design:

1. **Device-level disk-write rate is 0.57–1.0 writes/second per live camera**
   (101: 137 changes in 241 s; 104: 239 in 240 s, and Gate C collapses them to
   one write per second). Across 19 cameras carrying a hot slice that is
   **~12–19 writes/s ≈ 1.0–1.6 M writes/day**, each replacing the device's whole
   1.3–4 KB blob. Byte-wise: **~2.6–5 GB/day of rewrite to maintain 161 KB of
   state** — an amplification of roughly 20,000×. This is D96's soak from the
   other end: they paced 50/s and measured 9.4 % of wall-clock blocked; the
   fleet's own steady state offers a third of that.
2. **100 % of that rate comes from two slices**, `audio-metrics` and
   `zone-analytics`, and **the change is real, not a dedup failure**: `avgDbfs`
   is a rolling 60-second average and it genuinely moves every second. No
   equality fix reclaims this. Only *not persisting them* does — and their
   restored value is worthless anyway (a 2-hour-old dB reading rendered as
   current).
3. **On these two cameras every slice worth restoring changed ZERO times**:
   `zones`, `device-status`, `feature-probe`, `privacy-mask`, `camera-streams`.
   `motion` changed twice. But two cameras are not the fleet — see §2.3b, which
   corrects this.

That asymmetry is most of the answer to "is snapshot persistence cheap or a
write-amplification disaster". **It is both, and which one it is is decided by
two of the 62 caps.**

### 2.3b The fleet, and the correction it forces

`deviceState.getAllSnapshots` polled at **5 s for 25 minutes** (1,505 s, 265
samples). Note the sampling floor: at 5 s this counts at most one change per
5 s per (device, cap), so every number here is a **lower bound** — camera 104
scored 0.27 changes/s here against 1.0/s at 1 Hz, so the undercount is ~4×.

**5,765 changes across 78 of 358 devices.** Per cap, with the fields that moved:

| cap | changes | devices | fields that moved |
| --- | --- | --- | --- |
| `audio-metrics` | **3,635** | 14 | (the hot half) |
| `numeric-sensor` | 669 | 33 | `lastFetchedAt` 669, **`value` only 418** |
| `battery` | 526 | 22 | **`lastUpdated` 526 — and NOTHING else. Not one percentage changed.** |
| `zone-analytics` | 262 | 7 | (the hot half) |
| `motion` | 236 | 7 | `detected` 183, `lastDetectedAt` 166, `autoClearAfterMs` 50 |
| `temperature-sensor` | 125 | 5 | `lastFetchedAt` 125, `celsius` 56 |
| `humidity-sensor` | 75 | 3 | `lastFetchedAt` 75, `percent` **8** |
| `pressure-sensor` | 50 | 2 | — |
| **`device-status`** | **32** | **16** | `online` 32, `lastChangedAt` 32 — every one a REAL flip |
| `climate-control` / `fan-control` | 28 / 28 | 2 / 2 | `currentTemp` 28 (real) |
| `device-discovery` | 25 | 1 | — |
| `enum-sensor` | 22 | 2 | `value` 20 |
| `privacy-mask` | 22 | 2 | **`lastFetchedAt` 22 — and nothing else** |

Three corrections to the two-camera picture:

- **The transition-driven half is ~10⁵/day, not 10³.** Excluding the two hot
  caps, 1,868 changes in 1,505 s ≈ **1.2/s ≈ 10⁵ writes/day fleet-wide** (lower
  bound). The hot/cold split is therefore **~10⁶ vs ~10⁵ — one order of
  magnitude, not three.** Still a ~90 % reduction, but the honest number.
- **Roughly half of the cold half is pure clock churn** (§2.7.2), and now it is
  measured rather than argued: `battery` **526 writes, zero value changes**;
  `privacy-mask` 22 writes, zero value changes; `humidity-sensor` 67 of 75;
  `temperature-sensor` 69 of 125; `numeric-sensor` 251 of 669. **~937 of 1,868 —
  50 % — are a device rewriting its whole blob to record that it re-read a value
  that had not moved.** A clock-field exclusion on the compare removes all of
  them, and it is the single highest-leverage change in this document per line
  of code.
- **`device-status` is not idle: 32 real online/offline flips across 16 devices
  in 25 minutes** (~77/h fleet-wide). That is the slice the operator's
  offline-notification concern is about, it moves constantly, and today none of
  it survives a restart.

### 2.4 The finding — WRONG, and corrected on 2026-08-13 (D131)

> **This section's conclusion did not survive execution. Runtime state was
> persisting the whole time.** The probes below all read the collection
> `device-runtime-state`, which has never had a writer in this repo. The blob
> goes to `addon-device-settings` under the synthetic addonId `__device-state`,
> **one row per (device, cap)** — re-measured on the live hub the same day:
> **1,268 rows across 374 devices**, growing, and D96's "1,118 runtime-state
> rows" was that same prefix count. `docs/design/2026-08-03-storage-table-map.md`
> §3.5 had already found this ("there are two device-runtime-state stores and
> the named one is the empty one") ten days earlier.
>
> What the wrong conclusion did surface is a real and more expensive defect:
> `setAddonDevice` is a DELETE-by-prefix plus **one INSERT per cap slice**, so
> an eight-slice camera paid nine statements per flush rather than the single
> upsert §2.1 describes. Phase 0 shipped as the redirect to the named
> collection, one row per device, with a legacy read fallback and a per-device
> migration. See **D131**.
>
> Consequences for the rest of this document: the zones-blindness on 102 was
> NOT downstream of a missing snapshot (`__device-state:102.zones` is on disk
> and `deviceState.getCapSlice{102,'zones'}` answers with the polygon today) —
> it was the mirror-hydration bug `zone-mirror-hydration.ts` fixed. The §4.2
> "it is currently broken" verdict is void. Everything in §2.2, §2.3 and §2.3b —
> the sizes and the rates — was measured against the live mirror and stands.

### 2.4 (superseded) The finding: on the live hub, runtime state persists NOTHING

| Probe | Result |
| --- | --- |
| `sqlite3 ... 'select count(*) from [device-runtime-state]'` (mode=ro, WAL visible — a `motion-events` row 0 s old was readable in the same query) | **0** |
| `settingsStore.count {collection:'device-runtime-state'}` through the hub's own data door | **0** |
| `settingsStore.get {collection:'device-runtime-state', key:'101'}` | **null** |
| same door, control collections | `alerts` 500, `addon-settings` 23, `addon-device-settings` 3169 — the door is unnamespaced and agrees with SQLite exactly |
| D96, 2026-08-09, same file | **1,118 rows** |
| hub log, today | zero occurrences of `writeDeviceRuntimeState`, zero `settings write failed (device-runtime-state/...)` |
| lifetimes covered | the count was 0 **before** and **after** a hub container restart that happened mid-measurement (uptime 15 min, `notification-center:liveness` visibly re-seeding 1 → 263 rows in the same window). So it is not a post-restart artefact, and the write path had 15 minutes of continuous 1 Hz slice churn to produce a row in |
| deployed code | the running bundle's `writeDeviceRuntimeState`, `readDeviceRuntimeState` and `loadRuntimeState` were read out of `/opt/camstack-hub/.../@camstack/system/dist` and are byte-for-byte the design described in §2.1 — the write is not missing from the build |

Meanwhile the in-RAM mirror is fully populated and churning (§2.2), and
`deviceManager.loadRuntimeState{101}` answers with eight live slices — i.e. the
READ surface that D96 identified as the mirror's only seeder is answering from
somewhere other than the empty table.

Two consequences, and they are the reason this document exists:

1. **The hub has been running a de-facto RAM-only runtime state.** That is
   exactly option B's failure mode, and it is a natural experiment we did not
   design. D96 predicted the symptom precisely — *"RAM-only means the mirror is
   empty at boot too, for every device, until each provider happens to push"* —
   and refused the RAM-only refactor for it. Camera 102's invisible zones is
   that symptom: a slice written only on operator mutation had nothing to
   survive in, so `deviceState.getCapSlice{102,'zones'}` answered `null` while
   `zones.listZones{102}` returned the polygon the whole time. The occupancy
   cold baseline and the liveness flood are the same *shape* on ledger state
   rather than snapshot state — which is why all three landed in one week.
2. **Any decision about a central retention policy is premature until this is
   fixed**, because today the baseline it would be measured against is zero.

This is the one item in this document that should be treated as a defect rather
than a proposal. It needs a root cause before anything else here is built.

### 2.5 Cost — the write is cheap, the checkpoint is not

D96 measured this on the same file, the same directory, the same shfs FUSE
share, with production pragmas, and it has not changed:

- the statement shape costs **p50 0.14 ms**;
- `synchronous=NORMAL`, so an ordinary commit does **no fsync**;
- the multi-second frames are `sqlite3WalCheckpoint` copying WAL frames back
  into a 300 MB file over FUSE, entered from **whichever commit is unlucky**:
  max **3,001 ms** at `wal_autocheckpoint=1000`, and **25,178 ms** when the WAL
  had been allowed to reach 15–33 MB;
- moving the checkpoint to a worker thread was measured **6× worse**, twice.

Confirmed today: `/data` is still `shfs`, `journal_mode=wal`, DB 326 MB, WAL
5 MB.

**So the cost model for any "persist more values" proposal is not bytes and not
rows — it is *how many additional commits you offer to the checkpoint lottery*.**

> **2026-08-19 — there is a SECOND cost, and it is the larger one.** The
> checkpoint is what a WRITE risks;
> [D181](../decisions/adr-0181-hub-mains-event-loop-is-the-clusters-only-queue.md)
> measured what a READ costs. `better-sqlite3` is synchronous and
> `sqlite-settings` is an in-process builtin, so every store call from every
> runner and every agent executes on hub-main's single JS thread — the same
> thread that answers every UDS handshake. A V8 profile of the 2026-08-19 boot
> had that thread **0.1 % idle with 64 % inside `getAllAddon`**, and UDS
> requests timed out behind it. Read volume was never budgeted in this document
> and it must be: on hub-main a read that costs more than its answer queues the
> whole cluster.
Runtime state at full rate offers **12–19 commits/s** (measured, §2.3).
pipeline-analytics offers ~1.13 rows/s but in far larger transactions. D96's
ranked levers stand:

1. get `camstack.db` off the FUSE share (operator change, removes the cause);
2. treat write volume into `camstack.db` as a budget;
3. do not move the checkpoint to another thread.

### 2.6 Two slices are genuinely durable; the rest are re-derivable

From D96's full reader audit, pinned by
`packages/types/src/device/__tests__/durable-runtime-state.spec.ts`:

- `native-object-detection.enabled` — an operator toggle on a Reolink camera
  whose `refresh` is a no-op and whose `staleMs` is `Infinity`. There is no
  hardware value to re-read. The only `getCapState(...) === undefined` guard in
  the repo exists to protect the restored value.
- `doorbell.{pressCountSinceStart,lastPressedAt}` — a monotonic accumulator on
  a doorbell (the virtual doorbell when this was written; a composed doorbell
  since slice 6, D671). The slice IS the record.

Everything else regenerates within one poll, push or probe. **But "re-derivable"
is not the same as "free to lose"**, and this is where the operator's intuition
about offline notifications is exactly right: the WINDOW between boot and the
first re-derivation is when the cold-start bugs happen. Restoring
`device-status.online = true` at boot is not a claim that the camera is online —
it is the previous observation that makes the first real observation a
*comparison* instead of a *transition*. That is D130's rule stated in the
runtime-state vocabulary.

### 2.7 Three leaks that make the dedup gates weaker than they look

1. **`shallowEqual` is reference equality.** Both Gate A and Gate B use
   `if (a[k] !== b[k]) return false`. The stored value is the output of
   `schema.parse` (fresh nested allocations); the incoming value is a fresh
   deserialisation. **Any slice with an object or array field therefore never
   dedupes.** That is 25+ of the 62 caps, including `zones`, `zone-rules`,
   `camera-streams` (`slotStatuses`), `feature-probe` (`flags`), `privacy-mask`
   (`regions`), and every `available*[]` control cap.
2. **Timestamps defeat dedup by construction.** 58 call sites write
   `lastFetchedAt: Date.now()`, and `createRuntimeStateBridge.ensureFresh`
   *detects a successful refresh by that field advancing*. So every landing
   refresh produces a diff and schedules a write even when every substantive
   field is identical. Only `SliceThrottler` (2 caps) strips the timestamp
   before comparing.
3. **The write is whole-blob.** One 1 Hz `zone-analytics` writer re-serialises
   and re-upserts the device's entire cap map — including `zones[]` and
   `feature-probe.flags` — once per second.

**What fixing (1) and (2) is actually worth, measured (§2.3b):**

- Against the **hot** caps: **nothing.** `avgDbfs`, `level`, `byClass`,
  `stationaryObjects` are real content changing every second. A compare cannot
  remove a value that is genuinely different — only `durability: 'session'` does.
- Against **everything else: about half.** `battery` wrote **526 times with zero
  value changes**; `privacy-mask` 22 times with zero; `humidity-sensor` 67 of 75;
  `temperature-sensor` 69 of 125; `numeric-sensor` 251 of 669. **~937 of 1,868
  cold-half writes are pure clock churn.**

So: do not budget the hot rate against a dedup fix, and do budget half the cold
rate against it. The specific change is a per-cap declared set of clock fields
(`lastFetchedAt`, `lastUpdated`, `lastChangedAt`, `ts`) excluded from the
equality test but still written — the same trick `SliceThrottler` already plays
with `ts`, generalised to the kernel gate.

---

## 3. Home Assistant LTS, mapped onto CamStack

### 3.1 What HA does

HA keeps two tiers:

- **states / short-term** — every state change, row per change, purged after
  `purge_keep_days` (default 10). Cheap to write, expensive to keep.
- **statistics / long-term** — for sensors declaring `state_class`, a
  **5-minute** row (`mean`, `min`, `max`, or `sum` for meters) and an **hourly**
  roll-up of those, **kept forever**. Opt-in per entity, and the aggregation is
  computed in the recorder, not in SQL.

The point of the split is that a chart over a year needs 105,120 five-minute
rows, not 40 million state changes.

### 3.2 What CamStack already has

**We already have HA's short-term tier, and we did not call it that.**
`pipeline-analytics:{motion,audio,object}-events` IS a per-camera state-change
log with a purge window: **97,938 rows/day, 7-day device window (D61)**. It has
the same economics and the same shape.

What we do not have is the long-term tier. There is exactly one persisted rollup
in the repo (`ai:usage`, 90 d, grouped in JS), and the data door's only
aggregate primitive is `histogram` — **grouped COUNT only, no mean/min/max**. So
LTS would need either a new aggregate on the door or (better) aggregation in RAM
before the write.

### 3.3 Which CamStack series earn an LTS row

| Series | Source today | Aggregate | Rows/day (5-min, 20 cameras) | Operator value |
| --- | --- | --- | --- | --- |
| **Audio dBFS** | `audio-metrics` slice (RAM, 1 Hz) + `audio-events` (32.5 k/day, 7 d) | mean / min / max / p95 | 5,760 | **High.** A per-camera noise baseline is what makes "unusual sound" a threshold instead of a guess. Note the symmetry with §2.3: `avgDbfs` is the single field that costs the most to persist as a *snapshot* (it moves every second and the restored value is worthless) and is worth the most as an *aggregate*. That is the LTS argument in one field. |
| **Motion activity** | `motion-events` (43.9 k/day, 7 d) | count / mean regionCount | 5,760 | **High.** "Is 103 at 456 motion/h normal for a Tuesday afternoon?" is unanswerable today after 7 days. Also the cheapest anomaly signal we have. |
| **Detection rate per class** | `object-events` (5.3 k/day) | count by class | ~5,760 | Medium-high. Feeds "no person detected on the driveway for 3 days" and validates a model change against a fleet baseline. |
| **Occupancy count** | occupancy watcher (RAM + flip ledger) | mean / max | 5,760 | Medium. Charts are nice; the ledger already covers correctness. |
| **Node stress score / worker saturation** | `NodeStressController` (RAM, verdict every 15 s) | mean / max per node | **~864 (3 nodes)** | **Highest value per row in the table.** `observe` is the DEFAULT mode and its documented purpose is *"this is how the thresholds get measured on your fleet"* — and it writes to nothing but the log. This is a 300-rows-per-node-per-day store that would let the failover thresholds be chosen from data. |
| **Device liveness uptime %** | liveness ledger flips | derived from #2 | ~0 | Medium — derivable from the ledger, no new writer needed. |
| Camera stream health | `camera-streams` slice | state histogram | 5,760 | Low. `alerts` already covers the incidents. |

**Total if all six ship: ~29,000 rows/day** against today's 97,938 — a 30 %
increase in row count, but in rows that are **~60 bytes and never deleted**,
versus the raw events that are ~200–2,000 bytes and deleted weekly. Steady-state
disk after a year: ~10.5 M rows ≈ 700 MB. That is more than the whole database
today and is the number that decides whether this is opt-in.

**Recommendation for §3: ship the aggregator for two series first — node stress
and audio dBFS (864 + 5,760 = 6,624 rows/day).** The number that matters is not
rows, it is commits (§2.5), and a batched 5-minute flush is **one transaction
per node per flush = 864 commits/day total**, i.e. **0.01 commits/s against the
12–19/s runtime state offers today**. Both series are currently *thrown away*,
both have a named consumer, and together they are noise on the checkpoint
budget. Add motion/detection only once someone builds a chart that reads the
first two.

### 3.4 What the pipeline would look like

D8 makes this simple rather than hard: **events are lossy telemetry, so an
aggregator must never be the only path to a fact.** An LTS row is a *summary*,
which is the one thing that is allowed to lose a sample.

```
in-process ring (per camera, per series)  ← fed by the SAME call that already
   ↓  (no new event topic, no new subscriber)     writes the runtime-state slice
flush timer, 5 min, aligned to the wall clock
   ↓
one batched INSERT per node per flush     ← ONE transaction, not one per series
   ↓
`analytics:stats-5m` (declared collection)
   ↓  optional, later
hourly rollup by the same sweep that already runs every 5 min for retention
```

Three constraints that fall straight out of the existing rules:

- **One flush = one transaction.** N series × M cameras in one commit, so the
  checkpoint lottery sees one ticket per 5 minutes per node, not 6,624/day.
- **The aggregator lives where the value is produced** (pipeline-analytics for
  audio/motion/detections, orchestrator for node stress), not in a new central
  addon. Central *mechanics*, decentralised *ownership* — see §4.4.
- **It must be classified in `ANALYTICS_COLLECTIONS`**, or
  `scripts/check-age-keyed-retention.ts` fails the build. Good: that guard
  forces someone to write down, in the diff, what happens to these rows. The
  answer for LTS is "kept forever, bounded by row count per (device, series)" —
  which is a *cap*, not an age sweep, so it does not become a fifth age-keyed
  root.

---

## 4. Design assessment

### 4.1 Option A — per-feature ledgers on a shared `DurableLedger` primitive

Every ledger in §1.1 declares its own collection, columns, `load()`, mirror,
failure direction and (sometimes) prune. Five of them are the same 120 lines.
A shared primitive would take `{collection, columns, keyOf, semanticClass}` and
supply: declare-at-boot, RAM mirror, write-behind persist, `load()` with the
D49 failure direction chosen by class, and a generated catalogue + guard.

| | |
| --- | --- |
| **Write load on shfs** | **Unchanged.** These stores already exist; the primitive changes who writes the code, not how many commits happen. Summing §1.1: `cluster-node-history` 8,640 + outbox watermark 2,880 + ops-log ~1,400 + stationary dirty-flush ~1,440 + alerts ~128 + outbox rows ~100 + liveness/occupancy ~0 ≈ **~14,600 writes/day for every ledger on the hub combined** — i.e. **1 % of what runtime state offers in a single day**, and 59 % of it is `cluster-node-history` aging a `lastActive` on three rows. |
| **Staleness at restore** | **None by construction.** A ledger row is a record of an event that happened; it does not become false while the hub is down. This is the whole reason ledgers are the safe class. |
| **Migration cost** | Medium and incremental. Each store moves independently; the specs already exist and would be the regression net. `liveness-ledger.ts` is the reference implementation and is 3 days old. |
| **D3 / D62** | **Best fit.** The authority stays with the owner; only the mechanics are shared. Nothing gains a second writer. |
| **What it buys** | A generated catalogue (`docs/reference/durable-state.md` — proposed, does not exist yet) <!-- drift-ok --> answering "what survives a restart, and who owns it" — which nothing answers today — plus a guard that a new durable store must declare its class and its failure direction. That guard is what would have caught #17 and #18. |
| **What it does NOT buy** | Anything about runtime state. The cold-start window stays exactly as it is. |

### 4.2 Option B — generic whitelisted runtime-snapshot persistence with global retention (the operator's hypothesis)

| | |
| --- | --- |
| **It already exists** | `device-runtime-state` IS this. The whitelist is `cap.runtimeState !== undefined` — declared per capability, in the cap file, which is exactly where D4 says behavioural cap metadata belongs. The coalescer is Gate C. |
| **Write load on shfs** | **Measured: 12–19 writes/s, 1.0–1.6 M/day, ~2.6–5 GB/day of rewrite** at full fleet activity, each a whole-blob replace bounded by the 1 s debounce rather than by the value's rate. **The dedup fixes in §2.7 reclaim none of the hot 90 %** — `avgDbfs` genuinely moves every second. Persisting the full whitelist as-is is the write-amplification disaster the question was worried about. |
| **Retention** | A "global retention policy" does not apply cleanly: there is exactly **one row per device**, replaced in place. Nothing accumulates. What accumulates is rows for devices that no longer exist — and `clearDeviceRuntimeState` already handles removal. **The retention question here is a non-question.** |
| **Staleness at restore — where it HELPS** | `device-status.online` (358 devices): restoring it gives D130's second observation for free, at the mechanism level, for every device rather than per feature. `native-object-detection.enabled` and `doorbell.pressCount`: nothing else holds them. `zones` / `zone-rules`: a restored mirror closes the exact hole `zone-mirror-hydration.ts` was written to paper over. `feature-probe`: already handled correctly (reset to 0 on seed). |
| **Staleness at restore — where it HURTS** | A snapshot restored after 2 h of downtime asserts stale facts. Concretely: `camera-streams.slotStatuses = streaming` for a camera that has been dark for two hours; `battery.percentage` from before an overnight discharge; `motion.detected = true` frozen mid-event (the slice carries `autoClearAfterMs`, so this one self-heals); `audio-metrics` / `zone-analytics` (a 2-hour-old dB reading rendered as current); `presence.state`; any `*-sensor.value` older than its poll interval. **Every one of these is guarded by a `lastFetchedAt` / `lastChangedAt` the slice already carries** — the convention exists precisely so a reader can tell age. What is missing is that most readers do not check it. |
| **Migration cost** | **Zero to build. Non-zero to fix**: §2.4 must be root-caused first. |
| **D3 / D62** | Compliant — the value stays with the cap that declares it, and there is one writer (`setCapSlice`). |
| **The honest verdict** | The operator's hypothesis is **right about the mechanism and wrong about it being new**. This is not a re-engineering of something that could be structured — it IS the structured thing, and it is currently broken. |

### 4.3 Option C — hybrid

Snapshot for the low-churn whitelisted slices where restoring a possibly-stale
value is SAFE *because a reconcile follows*; ledgers where transition semantics
matter; mirrors never persisted as truth.

| | |
| --- | --- |
| **Write load** | Lowest of the three, and the gap is measured, not estimated. Excluding `zone-analytics` + `audio-metrics` takes 1.0–1.6 M/day down to **~10⁵/day** (§2.3b); adding the clock-field exclusion takes it to **~5×10⁴/day**, because half the remaining writes record a re-read that changed nothing. **A ~25× reduction against option B, on measured data.** |
| **Staleness** | Handled by RULE rather than by hope: a slice may be persisted only if (a) a reconcile follows within a bounded time, or (b) nothing else holds the value. `feature-probe`'s `withResetSessionProbe` is the existing precedent for "restore the row but blank the field whose meaning is per-session". |
| **Migration cost** | The ledger half is Option A; the snapshot half is fixing §2.4 plus a per-cap `durability` marker. The marker is one field in the cap definition and a codegen pass — the same shape as `runtimeState` itself. |
| **D3 / D62** | Strongest. The `durability` marker lives in the `*.cap.ts` next to `runtimeState` (D4: behavioural cap metadata lives only there), so a value can never be persisted without its authority declaring the intent. |

### 4.4 Recommendation — Option C, in a strict order

**Central mechanics, decentralised ownership.** One primitive, one catalogue,
one guard; the decision about what a value MEANS stays with the capability or
addon that owns it. That is the same rule D3 applies to capability registration
and D62 applies to per-camera switches, and it is the only shape that survives
this repo's history of a second knob disagreeing with the first.

**Phase 0 — root-cause the empty table (defect, not a feature). SHIPPED
2026-08-13, and the root cause was not the one predicted.** The table was empty
because it has never had a writer: the blob went to `addon-device-settings`
under `__device-state`, one row per (device, cap). Nothing was lost, and the
real cost was `1 + N` statements per flush instead of one upsert. Fixed by
pointing the writer at the collection it is named for, with a legacy read
fallback and a per-device migration. See §2.4 and **D131**.
*Rode: a `@camstack/server` train (kernel/system).*

**Phase 1 — make the existing snapshot cheap and honest.** Add a
`durability: 'session' | 'restored'` marker to capabilities declaring
`runtimeState`, defaulting to `'session'`. **SHIPPED 2026-08-13 (D131)**: 62
caps declared, 33 `restored` / 29 `session`, plus the declarative
`volatileStateFields` clock exclusion and
`scripts/check-runtime-state-durability.ts`. `'session'` slices are mirrored but
not persisted; `'restored'` slices are. **This is the phase that turns 1.0–1.6 M
writes/day into ~10⁵**, because `audio-metrics` and `zone-analytics` are
`'session'` and they are ~90 % of the rate (§2.3b). Proposed initial split:

| `'restored'` | `'session'` |
| --- | --- |
| `device-status`, `native-object-detection`, `doorbell`, `zones`, `zone-rules`, `battery`, `switch`, `binary`, `contact`/`smoke`/`gas`/`flood`/`tamper`/`vibration`/`carbon-monoxide`, the numeric/enum sensors, `privacy-mask`, **`motion-zones`** (the 14 KB polygon list — high value, zero churn), `image-settings`, `stream-params`, `day-night`, `alarm-panel`, `lock-control`, `cover` | **`audio-metrics`, `zone-analytics`** (the whole hot rate), `camera-streams` (a restored `streaming` for a dark camera is a lie the UI renders), `motion` (self-clearing via `autoClearAfterMs`), `feature-probe` (already blanked on seed), `device-discovery` (5.7 KB of re-derivable scan output) |

Do §2.7.1/§2.7.2 (deep compare + declared clock-field exclusion) in the same
phase — measured at **another ~50 % off what remains** (`battery` alone: 526
writes, zero value changes in 25 minutes). Do **not** budget the hot rate
against it; §2.3b shows those fields genuinely change.
*Rides: a train (codegen + cap definitions + kernel).*
*Guard (new): `scripts/check-runtime-state-durability.ts` — a cap declaring
`runtimeState` must declare `durability`, so the choice is made in the diff.*

**Phase 2 — `DurableLedger` primitive + generated catalogue. SHIPPED 2026-08-13
(D132).** Extract from `liveness-ledger.ts` (the newest and cleanest). Move, in
this order: `liveness` (already shaped like it), `occupancy`,
`stationary-objects`, `snoozes`. Do NOT move `outbox` — it has delivery-attempt
semantics a ledger primitive should not learn. All of that is what happened; the
catalogue is the part that changed shape. It is a `@durable` comment annotation
rendered into `docs/reference/storage.md` §3a, **not** a new
`durable-state.md` — one generated storage page, because the annotation has to
cover collections that will never sit on the primitive.
*Rides: addon deploys (`camstack deploy addon-post-analysis`) for the movers;
the primitive itself is copied byte-identically into each consuming addon, since
addons never import each other.*
*Guard (new): `scripts/check-durable-state-declared.ts` — every declared collection
outside the canonical list must declare a semantic class and a load-failure
direction.*

**Phase 3 — close the two open cold-start holes the catalogue exposes. SHIPPED
2026-08-13 (D132).** `NodeStressController`'s failover guards (#17) and
`DeviceFeaturesMirror` (#18). Both became ledgers/mirrors on the Phase-2
primitive: `packages/addon-pipeline-orchestrator/src/node-stress-move-ledger.ts`
persists every APPLIED move, and the cooldown, return ban and 4-moves/hour
budget are all derived from that one list.
*Rides: addon deploy (`addon-pipeline-orchestrator`).*

**Phase 4 — LTS aggregator, two series only. SHIPPED 2026-08-13 (D132), and
wider than this.** The recommendation was node stress (864 rows/day) and audio
dBFS (5,760 rows/day), in-RAM ring, wall-clock-aligned 5-minute flush, one
batched transaction per node per flush, bounded by row count per (device,
series) rather than by age. What shipped keeps all of that and adds motion,
battery and per-zone occupancy, bounded per (subject, series, scope) —
`packages/addon-post-analysis/src/durable/lts-aggregator.ts`, <!-- drift-ok: deleted when device-history replaced the LTS tier (D850) -->
`packages/addon-pipeline-orchestrator/src/node-stress-lts.ts`. <!-- drift-ok: deleted when device-history replaced the LTS tier (D850) -->
*Rides: addon deploys (`addon-pipeline-orchestrator`, `addon-post-analysis`).*

**Not recommended, and worth writing down**: a *global* retention policy over
runtime state. There is one row per device and it is replaced in place; a
retention policy would have nothing to delete. The thing that actually needs a
global budget is total commits into `camstack.db`, and the lever for that is
D96's lever 1 — get the file off shfs.

**Also worth a separate look**: `cluster-node-history` at 8,640 upserts/day for
3 rows (§1.1 #13). Nothing in this design depends on it, but it is the cheapest
write-volume win available and it is 40 % of all ledger writes on the hub.
**SHIPPED 2026-08-13 (D131, operator decision #7)**: `snapshot()` writes on a
descriptor change or once per 5 minutes — 8,640/day → ~864/day. `touch()` still
writes the disconnect edge unbounded, so "when did it disconnect" is unchanged.

---

## 5. Questions for the operator

Each with a recommendation.

1. **Phase 0 — do we treat the empty `device-runtime-state` as a P1 defect and
   root-cause it before anything else here?**
   *Recommendation: yes.* It is the mechanism the whole question is about, and
   three of this week's bugs are downstream of a runtime state that does not
   survive a restart.

2. **Do we accept `durability` as a per-cap declaration (Phase 1), rather than a
   central whitelist in the kernel?**
   *Recommendation: per-cap.* D4 already says behavioural cap metadata lives only
   in the `*.cap.ts`; a central list is a second authority that will disagree
   with the first one, which this repo has shipped twice.

3. **Is a stale-but-restored value acceptable for `device-status.online`?** A
   camera that died during a 2-hour outage comes back asserting `online: true`
   until the first real observation contradicts it.
   *Recommendation: yes, and it is the point.* The restored value is not a claim
   about now — it is the previous observation that turns the first real reading
   into a comparison instead of a phantom transition (D130). The alternative is
   the flood we just fixed. Supporting datum: `device-status` produced **32 real
   flips across 16 devices in 25 minutes** (§2.3b), so this is not a hypothetical
   slice — it is the busiest thing in the cold half. *(Separate operational
   question worth its own look: is 16 devices flipping liveness in 25 minutes
   normal for this installation, or is something flapping?)*

4. **Which LTS series first — node stress, or audio dBFS?**
   *Recommendation: node stress.* It is 864 rows/day, `observe` is the default
   mode, its documented purpose is to measure the thresholds, and today it
   writes to nothing but the log. Audio dBFS is the higher operator value but
   costs 7× the rows and has no consumer built yet.

5. **Do we keep LTS opt-in per camera (HA's model), or on for all cameras?**
   *Recommendation: on for all, bounded by row count per (device, series).* At
   ~60 bytes/row the fleet cost is trivial compared to `media` and `tracks`, and
   an opt-in that nobody turns on produces no baseline — which is the failure
   mode `observe` is already in.

6. **`camstack.db` off shfs — is this the session where we do it?** D96 ranked
   it as lever 1 and nothing since has changed that; every write-volume argument
   in this document is arithmetic on top of a 43× multiplier.
   *Recommendation: yes, and before Phase 4* — the backup story has to be
   arranged first (Unraid's Appdata Backup walks the share; a cache-only path is
   outside it).

7. **`cluster-node-history` — fix the 8,640/day, or leave it?**
   *Recommendation: fix it in Phase 2 as a by-product.* Write `lastActive` only
   when the node's status or descriptor CHANGES, plus a bounded heartbeat (say
   5 min) — that is 3 rows × 288 = 864/day instead of 8,640, with no loss of the
   "when did it disconnect" answer, which `touch()` already writes on the edge.
