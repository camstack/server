---
id: D317
title: A durable capture belongs to the periodic pass, not to a read — and the cluster diagram is not a lookup table
status: accepted
date: 2026-08-31
supersedes:
applies-to:
  - server/backend/src/core/agent/agent-registry.service.ts
  - server/backend/src/api/core/cap-providers.ts
  - server/backend/src/core/topology/topology-emitter.service.ts
  - packages/ui-library/src/hooks/use-cluster-nodes.ts
  - scripts/check-topology-is-a-diagram-not-a-lookup.ts
---

## Context

[D315](./adr-0315-not-yet-known-never-looks-like-not-installed-and-a-presence-gate-asks-the-registry-not-the-cluster.md)
removed one caller from `nodes.topology` and left the endpoint itself alone,
recording it as still costing **51.1 / 32.4 / 33.9 s**. It attributed that cost
**by subtraction** to "the three `$process.list` fan-outs and the per-node
history writes", and said so honestly: not isolated.

The subtraction named the wrong legs. Every leg was measured against its own
endpoint on the production hub on 2026-08-31:

| leg | probe | measured |
| --- | --- | --- |
| HTTP + auth + hub-local registry read | `nodes.getNodeAddons({nodeId:'hub'})` | **14 / 34 / 39 ms** |
| hub `$process.list` **plus its forked `ps`** over every hub runner pid | `metricsProvider.listAddonInstances` | **92 ms**, 4 984 B |
| `metricsProvider.getCached` (the metrics leg of `buildHubEntry`) | direct | **95 ms** |
| one remote `$agent.status` | `nodes.getNodeAddons({nodeId:<agent>})` | 170–220 ms |
| **one settings-store round trip** | `settingsStore.get` / `settingsStore.query` | **14 846 / 14 999 / 15 178 / 15 256 / 15 557 / 18 349 ms** |
| the whole call | `nodes.topology` | **30 483 ms**, 45 847 B |

The store number does not depend on the question. `settingsStore.get` on a
71-byte row and `settingsStore.query` returning 3 893 B cost the same. And three
store calls fired **in parallel** ended within **1 ms of each other**
(18 349 / 18 348 / 18 349), while a hub-local read in the same wave answered in
1 814 ms. So the settings store is not throughput-bound: it **stalls**, and
everything in flight is released on the same tick. A caller pays one tick per
SEQUENTIAL store phase, and nothing else it does matters.

`nodes.topology` had exactly two such phases, and that is the whole 30 s:

```
listNodes()
  ├─ hub  $process.list …………………………………………………  0.09 s
  ├─ per agent, SEQUENTIALLY: $agent.status then $process.list …  ~0.4 s
  └─ snapshotOnlineNodes() → one store.get per online node   ← STORE TICK 1
computeTopology()
  └─ getClusterNodeHistory() → one store.query               ← STORE TICK 2
```

Measured against a tick taken at the same instant: `nodes.topology` **30 483 ms**
= 2 x **15 557 ms**, plus half a second of everything else. The `ps` fork the
earlier record suspected is **0.3 % of the call**, and `$process.list` is not
1+N inside — the process service takes ONE `ps` for all pids at once.

**The real defect is what the two phases ARE.** `snapshotOnlineNodes` is a
durable capture: it persists each online node's descriptor so the node can still
be rendered OFFLINE after it disconnects. That is the durable half of an
OBSERVATION, and it had been bolted to the tail of a READ — so every operator
poll performed a read-back per online node (and, past the five-minute heartbeat
[D131] bounds, a write), in a phase that had to finish before the history read
could even start. Meanwhile `TopologyEmitterService` was already recomputing the
same picture every 30 s and pushing `cluster.topology-snapshot`, with a docblock
saying it "replaces UI polling on `nodes.topology`".

**And the callers had not migrated.** Fourteen call sites read `nodes.topology`
on mount and almost none of them wanted the diagram: `LogLevels` wanted a node
picker, `ClusterEventsTab` / `ClusterRecordingTab` wanted the online node ids,
`Settings` wanted the hub's addon ids, `NodeDetail` wanted one node's decoder
addon. `DeviceStepOverrideTab` was the worst of them — it forced
`refetchOnMount: 'always'`, a full cluster fan-out every time an operator opened
a camera tab, to learn which nodes are up.

## Decision

**A durable capture is work of the PERIODIC PASS, never of a read.**
`listNodes()` no longer writes anything; `AgentRegistryService.captureNodeHistory(entries)`
is called by `TopologyEmitterService` after it emits, over the entries that pass
already computed — one cluster fan-out, not two, and after the emit so a stalled
store delays no subscriber.

**Independent reads are one wave.** `computeTopology` awaits the live walk and
the durable history together; `listNodes()` walks every node concurrently and
issues each node's `$agent.status` and `$process.list` as one pair. The
`$process.list` fallback still reads `status.addons` — it is applied after both
have settled, so the fallback survives without re-serialising the calls.

**`nodes.topology` is the cluster DIAGRAM, and a UI reaches it through one
hook.** `useClusterTopology` bootstraps once (`staleTime: Infinity`) and then
lives off the pushed `cluster.topology-snapshot`; `useClusterNodes` is the
ROSTER projection over it — id, name, online, addon capabilities — and is what a
picker, a filter or an "is this node up" check asks. Neither is a consumer
cache: the query is the late joiner's FIRST value and every value after it comes
from the owner's push, which the hub sends every 30 s and, debounced 200 ms,
on every agent/addon lifecycle edge. That is strictly fresher than the poll it
replaces for the one thing a picker cares about — whether a node is up.

Two cures were refused. **Raising a timeout** hides a stall behind a longer
stall. **Caching topology in a consumer** is [D224](./adr-0224-the-freshness-of-a-camera-fact-lives-in-its-provider.md),
which shipped here once and was stale by design.

## Consequences

- Shape of ONE operator read, before → after: **4 settings-store round trips in
  2 sequential phases → 1**; **up to 3 durable writes → 0**; **5 sequential
  cross-node RPCs → 2 concurrent waves**. On the hub as measured today that is
  **30.5 s → ~15.5 s** (one remaining store tick); with the store healthy it is
  ~0.4 s. The residual is now ONE `getClusterNodeHistory()`, and it is the only
  thing still coupling an operator read to the durable store.
- **Nothing stopped being reported.** `computeTopology`'s projection is
  untouched: offline rows from history, `lastSeen` from the persisted
  `lastActive`, per-node cpu/memory, `processes`, `categories`, `rootPackage`.
  `topology-read-shape.spec.ts` asserts every one of those against the same
  fakes, and that assertion was already green before the change — which is what
  makes it a regression pin rather than a restatement.
- The capture's cadence is unchanged in the case that matters. It used to run on
  every poll AND on the 30 s emitter pass; it now runs on the 30 s pass and on
  every lifecycle edge (debounced 200 ms), which is when a descriptor actually
  changes. Its own write gate (D131: write on change, or once per five minutes)
  is untouched.
- A node that disconnects still stamps `lastActive` on its own edge via
  `touch()`, which was never on the read path.
- `useClusterNodes` grew `isError`, and now derives from `useClusterTopology`
  instead of holding a second query — one query key, one subscription for the
  whole admin UI.
- **This does not make the endpoint cheap on a stalled store.** One tick is
  still one tick. What it fixes is who pays it: a page that draws the diagram,
  on demand, instead of every tab an operator opens. Taking the last store round
  trip off the read path — a write-through index owned by
  `ClusterNodeHistoryStore`, the D295 shape — is deliberately deferred: it is a
  third mechanism, and the caller routing had to land first to know it is worth
  it.

### Callers, and where each went

| caller | what it actually needs | verdict |
| --- | --- | --- |
| `pages/system/Cluster.tsx` | the diagram — per-node CPU/mem/addons/processes | **keeps it**, via `useClusterTopology` (was hand-rolling the same bootstrap+push) |
| `metrics/ProcessResources.tsx` | every runner subprocess on every node | **keeps it**, via the hook (its local push wiring deleted) |
| `pipeline/NodeList.tsx` | cores / RAM / `lastSeen` per node | **keeps it**, via the hook |
| `pipeline/NodeDetailHeader.tsx` | one node's hardware line | **keeps it**, via the hook |
| `pipeline/tabs/ClusterBalancerTab.tsx` | `buildClusterGraph(topology)` | **keeps it**, via the hook |
| `metrics/AgentLoad.tsx` | id, name, up/down, capabilities | → `useClusterNodes` |
| `pages/system/LogLevels.tsx` | a node picker | → `useClusterNodes` |
| `pipeline/tabs/ClusterEventsTab.tsx` | online node ids | → `useClusterNodes` |
| `pipeline/tabs/ClusterRecordingTab.tsx` | online node ids | → `useClusterNodes` |
| `pipeline/tabs/NodePipelineTab.tsx` | one node's name + online | → `useClusterNodes` |
| `device/tabs/DeviceStepOverrideTab.tsx` | online node ids (was `refetchOnMount: 'always'`) | → `useClusterNodes` |
| `pages/system/Settings.tsx` | the hub's addon ids | → `useClusterNodes` |
| `pipeline/NodeDetail.tsx` | one node's decoder addon id | → `useClusterNodes` |
| `addon-benchmark/tabs/SustainedTab.tsx` | every node + every runner, to place load | **stays expensive**, allowlisted — operator-initiated, never a boot path |

Server-side callers were left alone and are recorded here so the next session
does not have to re-find them: `addon-terminal` (two node-list reads, operator
command paths), `addon-provider-homeassistant`'s HA export (a reconcile poll
that genuinely wants per-node cpu/memory/uptime/version), and `packages/cli`'s
`deploy` (enumerates online nodes before pushing). `addon-pipeline`'s two
platform/arch lookups (`detection-pipeline`, `audio-analyzer`, both through
`shared/node-topology-platform.ts`) carry docblocks calling this "a hub-LOCAL
read (no remote round-trip, no probe)" — **that is false and was false before
this change**; it fans out. Those are one-fact reads on the wrong endpoint and
belong in the next pass.

## Enforcement

`scripts/check-topology-is-a-diagram-not-a-lookup.ts`, wired into
`.github/workflows/ci.yml`. Three rules:

1. in a UI package, `useNodesTopology` / `trpc.nodes.topology` may appear only
   in `packages/ui-library/src/hooks/use-cluster-nodes.ts`, or behind an
   allowlist entry stating what diagram the surface draws;
2. the hook owner must bootstrap-and-push, never poll — `staleTime: Infinity`,
   no `refetchInterval`, and it must subscribe to `cluster.topology-snapshot`
   (without the push, `staleTime: Infinity` means the diagram never updates);
3. no call site re-declares `refetchOnMount` / `refetchInterval` / `staleTime`
   beside a topology read — that is the `DeviceStepOverrideTab` defect one layer
   out.

Verified by restoring the pre-fix `DeviceStepOverrideTab` call shape under a
probe name: the guard fails it on rules 1 and 3. Rule 2 verified by setting the
hook's `staleTime` back to `60_000`: the guard fails.

Behaviour is pinned by
`server/backend/src/__tests__/cap-providers/topology-read-shape.spec.ts` (a read
issues no durable write and no per-node durable read; the history read is in
flight while the node RPCs are; the per-agent legs overlap; every field is still
reported) and
`server/backend/src/core/topology/__tests__/topology-emitter-owns-the-capture.spec.ts`
(the capture runs on the periodic pass, over the set that pass projected, on ONE
fan-out, after the emit). Each implementing line was disarmed in turn and the
matching assertion went red.
