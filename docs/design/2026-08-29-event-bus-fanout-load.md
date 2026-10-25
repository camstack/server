---
title: The event-bus fan-out — 417 events/s offered 38 times, wanted 0.8 times
last-verified: 2026-08-29
covers:
  - packages/system/src/kernel/transport/local-child-registry.ts
  - packages/system/src/kernel/transport/uds-event-bridge.ts
  - packages/system/src/kernel/moleculer/event-bus.ts
  - packages/system/src/kernel/moleculer/event-bus-core.ts
  - packages/system/src/kernel/event-plane-report.ts
  - packages/addon-pipeline/src/detection-pipeline/provider.ts
  - packages/addon-pipeline/src/stream-broker/addon.ts
  - server/backend/src/api/core/system-events.router.ts
---

# The event-bus fan-out — 417 events/s offered 38 times, wanted 0.8 times

> Companion to
> [`2026-08-29-hub-main-memory-what-crosses-it.md`](./2026-08-29-hub-main-memory-what-crosses-it.md).
> That document's §8 named the cheapest experiment — *"print what already
> exists"* — and predicted it would *"settle whether the 22 500 writes/s are
> event fan-out or cap traffic."* The counters were wired today
> (`@camstack/server`, `event-plane-report.ts`). This document is the reading.
>
> **It settles the question, and the answer is the opposite of the one the
> experiment was framed to confirm.** The fan-out is a large number of
> *decisions* and a small number of *messages*: it accounts for roughly 4 % of
> hub-main's socket syscalls, not most of them. §2 states that as a falsifier
> against the companion document's §5 ranking.

---

## 0 · One-line result

Steady state on the live hub, 19 consecutive minutes: **417 distinct events/s**
are produced, each is **offered to all 38 runners**, and **0.80 of those 38
offers is wanted**. That is **15 854 delivery decisions/s** and **336 actual
deliveries/s** — a **46.2 : 1** suppression ratio.

**69 % of the produced events have zero addon subscribers.** Not "few" — zero.
The single largest, `pipeline.progress` at **206/s (43 % of every delivery
decision on the plane)**, is a debug-progress stream for an admin-UI tab, emitted
once per pipeline step on **every camera frame on every node**, past a gate the
same function already applies 300 lines later.

---

## 1 · What was measured, and the correction to the numbers in circulation

Three independent instruments over the same live hub, 13:20Z–13:40Z:

| Instrument | What it gives | Read-only? |
| --- | --- | --- |
| the `[mem] hub-main` heartbeat in Loki, with the new fan-out fields | per-minute deltas: `fanoutSent`, `fanoutSuppressed`, `crossNodeDelivered`, per-child top-5 | yes |
| `systemEvents.getRecent` (`system-events.router.ts:102`) | composition of the non-deny-listed traffic in the `recent[]` ring | yes |
| `systemEvents.subscribe` (`system-events.router.ts:119`), bounded to 8–15 s per category with a byte cap | **per-category event rate, source node, payload size** | a read; adds one in-process hub-main subscriber for the probe window |

### 1a · The widely-quoted "27 000/s" is the BOOT minute

The first fan-out line ever emitted is `13:20:44Z`, and it is the process's
**first heartbeat**. `createEventPlaneMeter` starts from
`EMPTY_EVENT_PLANE_BASELINE` (`event-plane-report.ts:268`), so that first window
is cumulative since the registry existed — and Loki confirms hub-main restarted
at `13:19:44Z` (`[mem] hub-main heartbeat attached to the log manager`, the
preceding lines carry the old `loopP50=20ms` format). **`13:20:44` is a fork
storm, not steady state.** It is also the only line in the series with
`loopMax=5265ms`.

```
time      fanoutSent  fanoutSuppressed    decisions   ev/s  xNodeIn  loopMax
13:20:44      390830           1245324      1636154    718     8700     5265   ← BOOT
13:21:44       21063            989892      1010955    443    12969       92
13:23:44       17634            782192       799826    351     8806       81
13:25:44       22091           1081343      1103434    484    14372      762
13:27:44       20843            999024      1019867    447    12375       62
13:31:44       15903            666276       682179    299     6941      638
13:35:45       21857           1042251      1064108    467    14680      258
13:39:45       19639            880809       900448    395    10659      694
```

19 steady-state samples (13:21:44 → 13:39:45), means:

| | value |
| --- | --- |
| delivery decisions | **951 226/min = 15 854/s** |
| actual deliveries (`fanoutSent`) | **20 146/min = 336/s** |
| suppressed | 931 079/min = 15 518/s |
| distinct events (`decisions ÷ 38`) | **25 032/min = 417/s** (range 299–484/s) |
| deliveries per event, against 38 offers | **0.80** |
| suppression ratio | **46.2 : 1** |
| cross-node inbound (`crossNodeDelivered`) | 11 643/min = **194/s** |

The `÷ 38` is not an assumption: it is checked against the per-child totals on
every line. In the 13:27:44 sample `homeassistant-export` and `export-hap` each
saw `sent + suppressed = 27 200`, and `27 200 × 38 ≈ 1 033 600` against a
measured 1 019 867 — the shortfall is exactly the `exceptChildId` skip
(`local-child-registry.ts:608`), which is why the two busiest *emitters*
(`pipeline-orchestrator` 23 588, `detection` 22 604) see fewer offers than
everyone else. The gap between a low emitter's total and a high emitter's total
**is** that runner's own emission rate.

### 1b · The fan-out is NOT hub-main's socket load — the premise is falsified

The companion document ranked *"the UDS / socket message plane (cap calls **+
event fan-out** …)"* first, at 22 500 writes/s. The brief that commissioned this
document went further and equated the 27 000 decisions/s with the ~44 000
syscalls/s. **A suppressed offer never touches a socket.**

```ts
// local-child-registry.ts:616
if (wants || this.fanoutMode === 'shadow') {
  stats.sent++
  entry.channel.emit(msg)
}
```

`fanoutMode=uds:filter` on the live hub (printed on every line). So the parent→
child event plane writes **336 messages/s**, not 15 854. Adding the outbound
Moleculer broadcast (417/s × 3 peer nodes ≈ 1 250/s, `event-bus.ts:366`) and the
194/s inbound, the **entire event plane is ≈ 1 800 socket messages/s of the
~44 000/s measured on hub-main — about 4 %.**

Two consequences, and the second is the more useful one:

- **The 15 854/s is CPU on the emit path, not bytes on a wire.** It is 15 518
  `matchesPattern` calls/s over a `Map` iteration, plus — upstream, and this is
  where the real cost is — 417 events/s of object construction, uuid minting,
  string formatting and an unconditional cluster broadcast.
- **hub-main's socket rate is still unattributed.** The companion document's
  §5 #1 must be re-opened: whatever pushes 82 messages/s into an *idle* `hub/ml`
  runner is not event fan-out, because `ml` declares one rare pattern
  (`device.bindings-changed`) and would receive nearly nothing. That is the
  single largest thing this investigation did **not** answer.

### 1c · `crossNodeSuppressed=0` is structural, not evidence

`crossNodeAcceptsCategory` short-circuits on `retainRecent`
(`event-bus-core.ts:357`), and hub-main is the only bus built with it
(`server/backend/src/core/events/event-bus.service.ts:50`). **On the hub that
counter can never be non-zero, in any mode.** The `shadow` burn-in described in
`event-bus-core.ts:310` therefore has no end condition on the hub for a reason
that predates the missing caller. Read it as "not applicable here", never as
"nothing would be dropped".

---

## 2 · The ranking: which categories, at what rate

Measured directly, one bounded `systemEvents.subscribe` probe per category
family, 13:35Z–13:39Z. `runner subs` is the count of **forked addon runners**
that declare the category — the only subscriptions the UDS gate can satisfy.
Browser subscribers (`live.onEvent`, `ui-library`) are served in-process by
hub-main and need **no** UDS delivery at all.

| # | Category | ev/s | runner subs | delivered/s | offers/s (×38) | **wasted offers/s** |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `pipeline.progress` | **206** | **0** | 0 | 7 828 | **7 828** |
| 2 | `pipeline.trace` | 48.9 | **0** | 0 | 1 858 | **1 858** |
| 3 | `pipeline.inference-result` | 48.9 | 2 | 97.8 | 1 858 | 1 760 |
| 4 | `stream-broker.metrics-snapshot` | 38.5 | **0** | 0 | 1 463 | **1 463** |
| 5 | `pipeline-analytics.frame-tracked` | 22–45 | 1 | 33 | 1 254 | 1 221 |
| 6 | `detection.result` | 26.7 | **0** | 0 | 1 015 | **1 015** |
| 7 | `pipeline.audio-inference-result` | 22.0 | 3 | 66 | 836 | 770 |
| 8 | `device.state-changed` | 15.9 | ~6 | ~95 | 604 | 509 |
| 9 | `detection.motion-analysis` | 9.8 | 2 | 19.6 | 372 | 353 |
| 10 | `detection.motion-zones-raw` | 9.8 | **0** | 0 | 372 | **372** |
| 11 | `motion.on-motion-changed` | 7.6 | 7 | 53 | 289 | 236 |
| 12 | `pipeline.camera-metrics-snapshot` | 6.2 | 1 | 6.2 | 236 | 229 |
| 13 | `pipeline-analytics.detection-event` | 5.4 | 1 | 5.4 | 205 | 200 |
| 14 | `pipeline.runner-load-snapshot` | 2.9 | **0** | 0 | 110 | **110** |
| 15 | `metrics.node-resources-snapshot` | 0.5 | **0** | 0 | 19 | **19** |
| 16 | everything else (17 categories) | ~2 | var | ~2 | 76 | 74 |
| | **total** | **~484** | | **~378** | **18 392** | **~18 014** |

**Two independent cross-checks, and both close.**

1. **Category sum vs. counter.** 484 ev/s from the probes against 299–484 ev/s
   from the fan-out counters (mean 417). The probes ran in the busier half of the
   window; they agree inside the observed variance and nowhere near a factor.
2. **Predicted vs. measured per-runner delivery.** Multiply each category's rate
   by the runners that declare it, and compare with `fanoutTop`. This is the
   strong test, because the two sides share no instrument:

| runner | predicted from the table | measured `sent` (range) |
| --- | --- | --- |
| `pipeline-orchestrator` | 48.9 + 33 + 9.8 + 7.6 + 6.2 = **105.5/s** | 3 467–6 663/min = **58–111/s** |
| `pipeline-analytics` | 48.9 + 22.0 + 9.8 + 7.6 + 15.9 = **104.2/s** | 4 487–6 278/min = **75–105/s** |
| `recorder` | 22.0 + 15.9 + 7.6 + 5.4 = **50.9/s** | 2 749–3 202/min = **46–53/s** |
| `homeassistant-export` | 15.9 + 22.0 + 7.6 + 0.3 = **45.8/s** | ~2 700/min = **45/s** |
| `export-hap` | 15.9 + 7.6 = **23.5/s** | ~1 364/min = **23/s** |

Five predictions, five hits. **The composition in the table is not a
reconstruction; it reproduces the delivery counts the kernel independently
counted.**

### 2a · Nobody is starved, and that is the point

Every runner-declared pattern in this codebase is an **exact category string** —
there is not one glob in any `packages/addon-*/src`. The three `'*'`
subscriptions that exist are all inside hub-main
(`device-manager/device-event-propagator.ts:64`, the bridge's own relay at
`uds-event-bridge.ts:159`, and `live-events.router.ts:66` when a client omits a
category). `childrenUndeclared=0` on every line, so no runner is failing open.

So the gate is working perfectly and is not the problem. The problem is that the
plane is **an offer, not an address**: `broadcastEventToChildren` iterates all 38
and asks each one, for an event whose subscriber set is known and, in 69 % of
cases, empty.

---

## 3 · The largest single source: `pipeline.progress`, and the gate that is already there

`206 events/s` — 43 % of every delivery decision on the plane — from
`runPipeline` (`packages/addon-pipeline/src/detection-pipeline/provider.ts:2155`).

**What it is.** `runPipeline` builds a local `emit()` helper
(`provider.ts:2185`) that fires `EventCategory.PipelineProgress` with a
human-readable string. There are ~15 call sites. The measured payload is
**366 bytes** and looks like this:

```json
{"source":{"type":"pipeline","id":"pipeline-test"},"category":"pipeline.progress",
 "data":{"nodeId":"<agent-host>/detection",
         "sessionId":"run-1788010604839-u9oyjqxh","step":"-",
         "message":"FrameRef: 3840×2160 (rgb)"}}
```

**Why it is 206/s.** Four of those call sites run *before* the executor, so they
fire on every invocation including the runtime camera path:
`provider.ts:2274` (`FrameRef: …`), `provider.ts:2411` (`Pipeline: N step(s)`),
`provider.ts:2529` (`Engine: …`), `provider.ts:2575` (`Running inference...`).
The measured shape confirms this exactly — the probe split the stream by payload
key:

| payload keys | measured | = 48.9 runs/s × |
| --- | --- | --- |
| `nodeId,sessionId,step,message` | 156.4/s | **3** call sites (2274, 2411, 2575) → 146.7 |
| `…,engine,message` | 51.5/s | **1** call site (2529) → 48.9 |
| `…,addonId,modelId,ms,…` | 2.0/s | the benchmark-only step loop (`provider.ts:2726`) |
| `…,ms,message` | 2.0/s | the benchmark-only `Done —` line (`provider.ts:2734`) |

48.9 runs/s is exactly the measured `pipeline.inference-result` rate. **Four
progress events per camera frame, on 4 active cameras.**

**Why this is a defect and not a design.** The gate already exists, 300 lines
below, and its comment states the intent in the repo's own words:

```ts
// provider.ts:2688
if (isRuntime) {
  // Runtime path mirrors the legacy `runFrame` behaviour: emit a
  // `pipeline.trace` event … and skip the benchmark-only per-step progress
  // spam.
```

`isRuntime` is computed at `provider.ts:2590`. The **late** emits honour it — the
2.0/s rows above prove they are gated. The **early** four do not, because they
run before the branch. This is precisely the failure mode `CLAUDE.md` names:
*a leftover that describes the right design is worse than nothing — it reads as
verification.*

**Who wants it.** Zero runners. Two admin-UI React tabs:
`packages/addon-benchmark/src/tabs/ImageTab.tsx:292` and
`packages/addon-benchmark/src/tabs/CapacityTab.tsx:249`, both via <!-- drift-ok: names benchmark code removed by D792 -->
`trpc.live.onEvent` — an **in-process hub-main** subscriber that the UDS fan-out
never touches. And `ImageTab` discards anything whose `sessionId` is not its own
(`ImageTab.tsx:299`), while the runtime path mints a fresh
`run-${Date.now()}-${random}` per frame (`provider.ts:2183`, because
`input.sessionId` is undefined). **Even the one intended consumer throws all
206/s away.**

**And it crosses the network first.** `emit` broadcasts to the whole cluster
unconditionally — there is no send-side gate anywhere (`event-bus.ts:366`). The
probe split it by origin node:

```
pipeline.progress 183/s   <agent-host>/detection  100.3/s
                          hub/detection                          62.3/s
                          agent-a/detection                20.7/s
```

**121/s (66 %) is produced on an agent, serialised, sent over Moleculer to
hub-main, accepted unconditionally by the `retainRecent` short-circuit, offered
to 38 runners and dropped 38 times.** It is the largest single contributor to the
194/s cross-node inbound rate.

---

## 4 · What the delivery is actually for — D8/D11 triage

Sorting the table by the question *"would losing this corrupt durable state?"*:

**(a) Telemetry that may be dropped, with no addon consumer — 333 ev/s, 69 % of
the plane.** `pipeline.progress`, `pipeline.trace`, `stream-broker.metrics-snapshot`,
`detection.result`, `detection.motion-zones-raw`, `pipeline.runner-load-snapshot`,
`metrics.node-resources-snapshot`. Four of these have a browser consumer
(`PipelineTab.tsx:665`, `ui-library/src/hooks/use-device-detections.ts:244`
and `:170`) which hub-main serves in-process; three have no consumer at all
anywhere in the repository. Under D8/D11 these are dropped-by-contract already.

**(b) Genuinely needed per-occurrence — ~84 ev/s.** `pipeline.inference-result`
→ orchestrator + analytics; `pipeline-analytics.frame-tracked` → orchestrator's
load model; `motion.on-motion-changed` → 7 runners including `recorder`, whose
`event-capture.ts:61` starts a recording from it; `device.state-changed` →
exports. These must keep flowing. They should be **addressed**, not offered.

**(c) Should have been an RPC.** `stream-broker.metrics-snapshot` at 38.5/s is a
1 Hz-per-broker snapshot with **no subscriber of any kind** — its dedup
(`addon.ts:1073`, keyed by `stableSnapshotKey` with `uptimeMs`/`totalBytes`/
`packetCount` stripped) is defeated by live fps/bitrate churn on every streaming
broker. A metric nobody subscribes to is a *read*, and the broker already has a
cap to read it from. Same shape, smaller: `pipeline.runner-load-snapshot` and
`metrics.node-resources-snapshot`.

---

## 5 · The reductions, ranked by delivery decisions/s removed

Basis: the 18 392 offers/s implied by the §2 category table (the 19-minute
counter mean is 15 854/s; percentages use the same-window basis so the ranking
is internally consistent).

| # | Reduction | dec/s removed | % | What breaks | Cheapest experiment BEFORE code |
| --- | --- | --- | --- | --- | --- |
| **R1** | **Move the four pre-executor `emit()` calls in `runPipeline` inside the `isRuntime` branch that already exists (`provider.ts:2688`)** | **7 828** | **43 %** | Nothing on the runtime path. UI-initiated runs are `isRuntime === false` and keep every line. | **Already run.** `systemEvents.subscribe {category:'pipeline.progress'}` for 12 s returned 183–212/s with `source.id='pipeline-test'`, a per-frame random `sessionId`, and `nodeId` naming three *detection runners* — no UI run can produce that. Re-run it after the change and require ≈0/s with no benchmark tab open. |
| R2 | Gate `pipeline.trace` on a live consumer instead of on `this.eventBus !== null` (`provider.ts:2694`; verbosity is already conditioned at `:2675`) | 1 858 | 10 % | `PipelineTab.tsx:665` stops streaming live traces unless the operator arms them. | Subscribe to `pipeline.trace` with every admin-UI tab closed. If it still reads 48.9/s, no consumer exists and the emit is unconditional. |
| R3 | **Address** `pipeline.inference-result` to its 2 declared runners instead of offering it to 38 | 1 760 | 9.6 % | Nothing — same deliveries, 36 fewer decisions each. Requires the category→children index in §6. | Log `fanoutTop` for a minute with the index built in-memory only (compute both, deliver by the old path, assert the sets are equal). |
| R4 | Delete `stream-broker.metrics-snapshot` as an event; read it through the broker's cap | 1 463 | 8.0 % | Nothing found. Only reference outside the emitter is a unit test (`ui-library/src/hooks/__tests__/use-event-invalidation-coalesce.test.tsx:51`). | `grep` is not enough — subscribe for 30 s and simultaneously check `fanoutTop`: if no runner's `sent` moves by ~2 300/min, nobody is receiving it. |
| R5 | Address `pipeline-analytics.frame-tracked` to its 1 declared runner | 1 221 | 6.6 % | Nothing. Same index as R3. | Same as R3. |
| R6 | `detection.result` — emit hub-main-local only (its only consumer is the browser overlay) | 1 015 | 5.5 % | `EmbeddingDispatcher` subscribes at `embedding-dispatcher.ts:166` but is constructed only in tests — **verify that on the live hub before acting.** | Check `fanoutTop` for `pipeline-analytics`: if its `sent` is fully explained without `detection.result` (predicted 104.2/s vs measured 75–105/s — it is), the dispatcher is not live. |
| R7 | Address `pipeline.audio-inference-result` to its 3 runners | 770 | 4.2 % | Nothing. Same index. | Same as R3. |
| R8 | Address `device.state-changed` to its declared set | 509 | 2.8 % | Nothing, **but** the set is partly built by lazy `proxy.state.*` bridges (`packages/types/src/device/device-state-handle.ts:263`) and is runtime-dependent. The index handles that correctly by construction; a hand-written list would not. | Log each child's `eventPatterns` once per minute for an hour and check the set is stable after warm-up. |
| R9 | `detection.motion-zones-raw` — hub-main-local only | 372 | 2.0 % | The browser zone overlay (`use-device-detections.ts:170`) keeps working; it is served in-process. | Same as R4. |
| R10 | Address `detection.motion-analysis` to its 2 runners | 353 | 1.9 % | Nothing. Same index. | Same as R3. |
| R11 | Drop `pipeline.runner-load-snapshot` + `metrics.node-resources-snapshot` (no subscriber anywhere) | 129 | 0.7 % | Unknown consumers outside this repo, if any. | Same as R4. |

**R1 is the single largest reduction, at 43 % of the entire plane, and it is four
lines moved inside a branch that already exists.** It also removes 121 events/s
of Moleculer broadcast across three nodes, 62 % of hub-main's cross-node inbound
rate, and 206/s of per-frame `Date.now()`/`Math.random()`/template-string
allocation inside the detection group's hot loop on every node.

**Grouped:** R1+R2+R4+R6+R9+R11 — the categories with **zero** addon subscribers
— remove **12 665 decisions/s, 69 %**, by *not producing or not broadcasting*.
R3+R5+R7+R8+R10 remove a further **4 613/s, 25 %**, by *addressing instead of
offering*.

---

## 6 · The structural note under R3/R5/R7/R8/R10

Those five are not "filter better". The gate is already correct; the cost is that
`broadcastEventToChildren` (`local-child-registry.ts:605`) asks 38 questions to
find an answer the registry already holds. Every child sends its full pattern set
on `event-sub` (`local-child-registry.ts:659`), and every declared pattern in the
repo is an exact string — so the inverse map `category → children` can be built
when `event-sub` arrives and read with one lookup on emit. The wildcard case
(`matchesPattern`) is not in any runner today but must still fall back to the
scan, and the `eventPatterns === null` fail-open (`local-child-registry.ts:311`)
must survive unchanged.

This is a data-structure change with no new mechanism, no queue and no buffer. It
is listed **after** the removals deliberately: doing it first would make the 69 %
that nobody wants cheap enough to stop noticing.

---

## 7 · What could NOT be determined

Stated plainly, because two inferences were closed early elsewhere in this
session and one of them was wrong.

- **What actually produces hub-main's ~44 000 socket ops/s.** §1b rules out the
  event fan-out (≈4 %). The companion document's observation that an **idle**
  `hub/ml` runner reads 82 messages/s is now *more* puzzling, not less: `ml`
  declares one rare pattern. Cap calls, the Moleculer transporter's own
  heartbeat/discovery traffic on 38 per-runner brokers, and the log ingest are
  the open candidates. **This is the most valuable unanswered question here** and
  it needs a per-channel message counter split by message `kind`
  (`child-cap-protocol.ts`), not more event telemetry.
- **19 minutes of one boot.** No day/night cycle, no viewer session, no export,
  no backup window. `pipeline.progress` scales with *active pipeline cameras*
  (4 today, `pipelineOrchestrator.getGlobalMetrics` → `totalCameras: 4`); at the
  fleet's ~31 streaming devices it would be ~1 600/s and R1 would be worth
  ~60 000 decisions/s. **That extrapolation is arithmetic, not a measurement** —
  separating steady state from event-driven needs 24 h of the heartbeat, 48 h to
  cover a weekday/weekend viewer difference.
- **`pipeline-analytics.frame-tracked` read 44.9/s and 21.9/s in two probes
  20 minutes apart.** Unexplained. The table uses the range; the per-runner
  cross-check is insensitive to it (orchestrator's measured range is wide enough
  to accommodate either).
- **`device.state-changed`'s true subscriber count.** "~6" is an estimate: three
  runners declare it explicitly and at least three more open it lazily through
  `proxy.state.*` bridges, which cannot be resolved statically. The predicted
  delivery for `homeassistant-export` and `export-hap` matched, so the estimate
  is not far off, but it is an estimate.
- **Whether an admin-UI client was connected during the probes.** Immaterial to
  the fan-out counters (a browser subscriber is in-process on hub-main and never
  reaches the UDS gate), but it would raise the measured SSE rates if a tab were
  driving a benchmark. The `sessionId`/`nodeId` shape in §3 rules that out for
  `pipeline.progress` specifically; it is not ruled out for every category.
- **The probes' own cost.** Each bounded `systemEvents.subscribe` added one
  in-process subscriber to hub-main for 8–15 s, up to 270 KB/s on the heaviest.
  The `fanoutSent`/`fanoutSuppressed` series shows no step change across
  13:35–13:39, so the measurement did not move the thing being measured — but it
  is not zero-cost and should not be left running.
- **`CAMSTACK_MOLECULER_EVENT_FANOUT=shadow`** remains a real latent defect and
  is deliberately not costed here: §1c shows its counter cannot fire on the hub
  at all, so this data says nothing about it either way. It stays an
  operator-owned decision with its own evidence.

---

## 7a · Corrections from executing §5 (2026-08-29, later the same day)

R1 was implemented (D290). Working the rest of the table falsified two of its
"what breaks" cells, in the same way, and the correction changes what the
remaining 69 % costs to remove.

**"Zero addon subscribers" was measured; "no consumer at all anywhere" was
grepped, and the grep missed the browser.** §4(a) named three categories with
"no consumer at all anywhere in the repository". All three have a live admin-UI
consumer:

| Category | Consumers the §4/§5 pass missed |
| --- | --- |
| `stream-broker.metrics-snapshot` (R4) | `StreamBrokerPanel.tsx:451`, `StreamBrokerPanel.tsx:579`, and a query invalidation at `StreamBrokerPanel.tsx:585`; `DeviceLiveInfoSection.tsx:44` |
| `pipeline.runner-load-snapshot` (R11) | `NodeDetailHeader.tsx:40`; a query invalidation at `NodeLiveTab.tsx:26` |
| `metrics.node-resources-snapshot` (R11) | `load-series.ts:9` — the cluster load chart, on this event's cadence |

Measured again the same day: `stream-broker.metrics-snapshot` 36.8/s,
`pipeline.trace` 27.7/s, `detection.result` 28.5/s — the composition in §2 is
unchanged, only the "what breaks" column was wrong.

**Consequence, and it is the useful part.** After R1, **every** remaining
zero-runner-subscriber category has a live browser consumer, and a browser
consumer is served in-process by hub-main and never reaches the UDS gate. So the
remaining waste cannot be removed by *not emitting* at all. R4, R6, R9 and R11
are not "delete the event" — they are "do not offer it to 38 runners", which is
the same change as R3/R5/R7/R8/R10: the category→children index in §6. Six
removals collapse into one structural change.

**And that change destroys the instrument, so it must land after R1's reading.**
`fanoutSuppressed` is a per-child count of offers the gate declined. An index
that addresses instead of offering stops taking those decisions, so the counter
goes to zero — and a zero that means "no longer computed" is indistinguishable
on the `[mem]` line from a zero that means "nothing was wasted". Shipping the
index in the same window as R1 would make R1's prediction unfalsifiable. The
index needs its own decision about what replaces `fanoutSuppressed` first.

R2 (`pipeline.trace`) is left as written: gating it on a *live consumer* is a
new mechanism (nothing today tells an emitter whether a browser is subscribed),
and the alternative — an operator arm switch — makes `PipelineTab.tsx:665` stop
updating until someone finds the switch.

---

## 8 · What this changes in the companion document

- **§5's ranking, entry #1, is wrong about the event fan-out.** It is ~4 % of
  hub-main's socket messages, not the bulk. The falsifier §8 asked for — *"if (2)
  shows the outbound bytes are dominated by a handful of large messages rather
  than tens of thousands of small ones"* — did not fire; but a different one did,
  and it is stronger: **most of the fan-out never becomes a message.**
- **§10's "which peer receives the 22 500 writes/s" is still open**, and the
  event plane is now excluded as the answer rather than being the leading
  hypothesis. The 78–82 % correlation with `hub/pipeline-analytics` cannot be
  event fan-out either: analytics receives a measured 75–105 messages/s.
- **§8's step (1) is complete and was worth its cost.** Zero new mechanism,
  and it named the largest producer on the plane in the first twenty minutes of
  data. Step (2) — per-channel byte and frame counters in `SocketChannel` — is
  now the *only* way to close §10, and should be split by message `kind` so cap
  calls, events and log ingest are distinguishable.


## 8 · MEASURED OUTCOME of R1 (deploy `addon-pipeline@1.2.146`, 18:10Z)

Prediction recorded before the deploy, and how it went:

| | before | predicted | measured |
| --- | ---: | ---: | ---: |
| decisions/min | 701 451 | ~450 000 | 252 912 – 468 358 |
| decisions/s | 11 691 | ~7 500 | ~5 660 |
| `fanoutSent`/min | 16 096 | **unchanged** | 10 220 – 16 051 |
| `crossNodeDelivered`/min | ~7 300 | 2 500 – 2 900 | 1 061 – 3 512 |

**The aggregate total is NOT enough to attribute the result.** In the same
window the detection activity fell by ~59 % (11 lines in 10 min against
27 an hour earlier), so a part of the −52 % is a drop in load, not the intervention.
`fanoutSent` fell by ~21 %, which was the condition designated as the
falsifier of "no subscriber".

**The per-peer comparison disambiguates, and confirms R1.**

| peer | delivered (17:55 → 18:29) | suppressed (17:55 → 18:29) |
| --- | --- | --- |
| pipeline-analytics | 4 170 → 3 767 (−10 %) | 11 189 → 5 087 (**−55 %**) |
| recorder | 2 575 → 2 453 (−5 %) | 14 164 → 7 560 (**−47 %**) |
| homeassistant-export | 2 410 → 2 329 (−3 %) | 14 361 → 7 702 (**−46 %**) |
| pipeline-orchestrator | 3 332 → 2 739 (−18 %) | 10 902 → 4 905 (**−55 %**) |
| detection | 1 090 → 1 018 (−7 %) | 13 160 → 7 840 (**−40 %**) |

Deliveries unchanged, suppressions halved: **only** the events that nobody
received are gone. Each peer suppresses **6 000–6 600 fewer offers/min**
(~100–110/s), against the **112/s** measured live for `pipeline.progress` before
the fix; x38 children = ~4 180 decisions/s removed against the 4 093–4 267 predicted.

**Lesson of method:** the drop in `fanoutSent` looked like the falsifier and
was not. An aggregate total does not distinguish "we stopped offering what
nobody wanted" from "a subscriber stopped receiving". Only the per-peer view
does, and that is the one to use to judge any future intervention on this plan.
