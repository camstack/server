---
id: D441
title: A balancer input past its budget yields to the last known answer, and a census asks every runner at once
status: accepted
date: 2026-09-10
applies-to:
  - packages/addon-pipeline-orchestrator/src/balancer-input-cache.ts
  - packages/addon-pipeline-orchestrator/src/agent-load-service.ts
  - packages/addon-pipeline-orchestrator/src/dispatch-timing.ts
  - packages/addon-pipeline-orchestrator/src/session-dispatch-controller.ts
last-verified: 2026-10-01
---

## Context

After D440 capped the placement census, the dispatch line named what was left:
in a busy quarter-hour on the hub (18:36–18:51Z, 145 dispatches) `balanceMs`
was p90 3 070 / p99 9 205 ms and `configMs` p90 1 404 / p99 11 826 ms. Three
cameras at 18:39:49 carried `balanceMs 9205` **identical**: they had joined one
`collectAgentLoad` in flight. Two things made that number. The load memo is
invalidated after every dispatch and teardown (`notePlacementChanged`), so a
burst's next camera always finds the re-read in flight and waits for it, with
no budget. And the re-read itself asked the runner nodes **in sequence**, each
under its own 4 s `agentLoadTimeoutMs` — two nodes past the budget in turn is
8 s, and the only line about a skipped node was at `debug`, which the hub
does not write (D438).

Where those seconds come from is not the orchestrator. The census reported
all three nodes over budget at once, the hub's own local RPC included, which
is hub-main's event loop, and this record carries the measurement that says
who occupies it because the next decision depends on it. A 60 s CPU profile
of hub-main (V8 sampling profiler over the inspector, 21:23:56Z; taking it
cost one 2 748 ms stall, `loopMax` on the `[mem]` line at that second) in a
moderately loaded window (`loopP99` 20–200 ms, `loopMax` up to 500 ms):

| main-thread busy time (30.8 s of 62.7 s) | share |
| --- | --- |
| garbage collector | 29.5 % |
| UDS frames in: msgpack decode + `handleFrame` dispatch | ~27 % |
| `child_process.spawn`, synchronous (26 forks, p50 91 ms, max 200 ms) | 8.5 % |
| event fan-out to 39 children + Moleculer publish | ~8 % |
| UDS frames out: msgpack encode | ~6 % |
| settings door prefix scans (`loadPrefixed` / `readDeviceStoreBatch`) | ~5.5 % |
| tRPC WebSocket + superjson to the admin UI | ~3.5 % |
| log formatting | ~2 % |

The GC is not one big pause: 307 scavenges in 60 s at 9.5 ms mean (max 66 ms)
plus incremental marking, and the ten longest busy runs (500–660 ms) are
75–96 % GC steps interleaved with JS. The four V8 platform threads spent
**20 CPU-hours on concurrent marking against 8.3 on the main thread** over the
process's 21.5 h life, because the live set is 2.3 GB and growing
**~57 MB/h** (heapUsed floor 1 940 MB at 14:10 → 2 343 MB at 21:10, 3 072 MB
limit). The UDS traffic is ~600 requests/s transiting hub-main as a router
between siblings — `stream-broker → decoder-nodeav audio-codec` 13 404/min,
`pipeline-orchestrator ↔ stream-broker` audio chunks 5 967/min at 12–16 KB
each way, `recorder → settings-store` 1 945/min, `pipeline-analytics →
device-state` 690/min and `→ settings-store` 636/min — and under load
hub-main writes 8–11 MB/s of responses. The spawns are `native-metrics`
(`ps` and the GPU probe every 5 s, `ps -p` per `getPidStats`), each a `fork()`
of a 5.8 GB RSS process.

None of that is fixable from an addon today. The kernel changes ride a
published `@camstack/server` (D16) and the heap growth needs a snapshot the
live hub cannot afford. What an addon CAN do is refuse to let a dispatch wait
on hub-main for an input it already holds.

## Decision

A balancer input the dispatch already holds is served within a budget.
`TtlMemo.getWithin(key, budgetMs)` answers from memory when fresh, from the
read when it lands inside `BALANCE_LOAD_BUDGET_MS` (500 ms, the census's
budget for the census's reason), and otherwise from the **last known value —
invalidated included** — reported as `stale` with its age. `get` keeps its
contract: an invalidated value is never served by it. Three properties hold:
the overrunning read is not abandoned (it lands and becomes the next answer,
so a stale value is served at most once per read); a **cold** key waits past
the budget, because a cold cache must never be the reason a camera fails to
dispatch; a read that fails with a last-known value in hand serves it as
stale. The latency line carries `balanceLoadStale`, and a stale balance logs
`agent load read overran its budget — balancing on the last known load` with
`loadAgeMs`.

And the load census asks every runner **in parallel**, each under the per-node
budget, so the census costs the slowest node and never the sum; a census that
skipped a node reports it at WARN with every node's cost and outcome
(`agent load census skipped a runner`).

## Consequences

- A burst's second camera balances on a load snapshot at most a refresh old
  (the memo refreshes off the dispatch path every 5 s and after every
  dispatch), which can undercount the sessions dispatched since. The
  balancer's own session registry counts those; a two-node tie-break may
  still land one camera on the busier node for one dispatch. Nine seconds of
  retained pre-roll was the price of not doing this.
- `balanceMs` is now bounded by the pin read plus 500 ms plus the memoised
  cap/weight reads. `configMs` is not touched by this record: its reads
  (`resolvePipelineForDevice`, the provisioning read — since D650 one
  `readDeviceProvisioning` for the elected device and its jump roster —
  and `listZones`) are settings reads through hub-main
  whose value changes with the operator, and a stale pipeline config is a
  different kind of wrong.
- Nothing here shortens hub-main's event loop. The per-cause options — an
  in-process audio-codec provider for the broker, the audio chunk plane off
  the orchestrator relay, `native-metrics` forking from a small process, the
  settings door's prefix scans, and above all a heap snapshot to name the
  2.3 GB — are in (planning repo: sessions/sessions.md) under this date, with what each <!-- drift-ok: moved to the private planning repo -->
  costs and which need a published closure.

## Enforcement

`balancer-input-cache.spec.ts` (`getWithin` block), `agent-load-census.spec.ts`,
`session-dispatch-latency.spec.ts` (D441 block). Each guard disarmed and the
suite re-run:

| disarmed | red |
| --- | --- |
| the census sequential again | 2: two wedged runners cost one budget; the skipped-runner line |
| `getWithin` ignoring its budget | 2: the invalidated value within budget; the dispatch at the budget |
| the last-known slot dropped on `invalidate` | 3: the two stale answers; the dispatch at the budget |
| `balanceLoadStale` hard-wired false | 1: the latency line |
