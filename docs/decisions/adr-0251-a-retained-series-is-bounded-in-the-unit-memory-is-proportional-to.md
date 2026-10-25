---
id: D251
title: A retained series lives in the addon that emits it, and is bounded in the unit memory is proportional to
status: accepted
date: 2026-08-27
supersedes:
applies-to:
  - packages/system/src/builtins/native-metrics/node-load-ring.ts
  - packages/addon-admin-ui/src/components/cluster/load/load-series.ts
  - packages/addon-admin-ui/src/components/cluster/load/use-node-load-series.ts
---

## Context

D250 settled that a metrics surface consumes a fan-out that already exists and
keeps its own bounded buffer *for as long as it is open*. That was correct about
the sampling and wrong about the window: the buffer lived in the browser tab, so
closing the Load page threw the hour away, a reload started from nothing, and two
operators looking at the same node saw two different charts of the same 20 s
event. The operator asked for the hour to survive the page — shared — without
becoming storage.

Three things had to be chosen, and each had an alternative that looks right until
you write it down.

**Where the ring lives.** The obvious answer is "the hub", since every node's
snapshot lands on hub-main's retaining bus. The obvious answer is also a consumer
keeping a copy of somebody else's fact, which is what D224 exists to forbid. The
ring therefore belongs to `native-metrics` — *the addon that emits the snapshot
retains it*, with no branch on role. On the hub that bus happens to carry the
whole fleet, so the hub's ring is the cluster's; on an agent it holds that agent.
The code does not know the difference, which is why there is no third case to get
wrong.

**What the ceiling counts.** 180 samples per node is the operator's hour, and it
is *not* a memory bound. A node whose process count explodes — a leaked `tsx`
tree, an inference pool respawning, the ghost storms the Processes tab exists to
surface — multiplies its own partition without ever touching a cap expressed in
samples. That is exactly the defect the RTP pre-roll rings still have
(`docs/architecture/load-ledger.md` #5): a maximum per instance, no budget for
the fleet, 898 MB across 47 rings. So the fleet ceiling is denominated in PROCESS
ROWS, because rows are what the bytes are proportional to and samples are not.

**How a node leaves.** "Evict when the node is removed from the cluster" was
rejected: it couples the ring to a registry it has no other reason to know, and a
node that is merely offline is never removed — so the case that actually happens,
an agent that stops answering, would hold its partition for the life of the
process.

And the measurement came first, because the ledger's own rule is that an
optimisation — or a new cost — without a number is an opinion. Weighed against
the real payloads of the live cluster (42 + 20 + 14 process rows), one retained
row is **464 B**, so the whole fleet's hour is **6.06 MiB**.

## Decision

**A telemetry series that must outlive a page is retained in the addon that
emits it, never in a consumer; it is fed only by subscribing to a fan-out that
already exists; and it declares TWO ceilings — one per key and one for the whole
fleet, the fleet one expressed in the unit its memory is proportional to — plus
an eviction rule for a key that stops arriving. The cost is measured against real
payloads and written into `docs/architecture/load-ledger.md` before the ring
ships.** Retention in RAM is not retention on disk: a durable series remains the
separate decision D250 describes, and this does not take it.

## Consequences

- `metricsProvider.getLoadSeries` is the only way to read the series, and its
  target node is `forNodeId`, not `nodeId` — the generated cap router strips a
  top-level `nodeId` from every input and uses it to ROUTE. A field named
  `nodeId` would have become a routing pin and never reached the provider.
- `sinceMs` is EXCLUSIVE. A caller passes the newest timestamp it holds and gets
  only what it lacks, so a chart can seed from the ring while already drawing
  live points. The client's fold is idempotent on `atMs` as well, because the
  seed and the live event are two deliveries of the same snapshot and can arrive
  in either order.
- hub-main pays up to 14.2 MiB (32 000 rows × 464 B) in the worst case, chosen to
  sit inside the same envelope the log ring already established there
  (`DEFAULT_MAX_TOTAL_LOG_ENTRIES`, ~15 MB). The live cluster uses 6.06 MiB and
  never evicts on the fleet ceiling.
- A node silent for a full hour loses its partition. That is deliberate and it is
  the cost: an operator cannot ask what a decommissioned agent was doing 90
  minutes ago. Every point it held had already aged out of the hour the ring can
  represent.
- The ring is generic over the process row and stores the payload verbatim. A
  field added to the snapshot needs no edit here — and equally, nothing here may
  start reading one.
- The window is still lost on a node restart, and the Load tab says so. "One
  hour, in memory" and "one hour, durable" are different promises and the surface
  must not blur them.

## Enforcement

`packages/system/src/builtins/native-metrics/__tests__/node-load-ring.test.ts`
asserts the 181st sample drops the oldest, that the fleet budget bites on a node
that multiplies its processes while a quiet node keeps its full window, that a
node silent for the whole retention window is evicted *and* that the row
accounting follows the eviction, and that `sinceMs` is exclusive at the boundary.
`packages/addon-admin-ui/src/components/cluster/__tests__/load-series.test.ts`
asserts a seed overlapping points already drawn adds only what is missing, in
either arrival order. Each was verified by disarming the mechanism and confirming
the red.

Nothing mechanically stops a future ring from bounding itself in the wrong unit,
or a consumer from keeping a second copy of a fact it does not own. That is
review, and the load ledger is the record a reviewer should point at.
