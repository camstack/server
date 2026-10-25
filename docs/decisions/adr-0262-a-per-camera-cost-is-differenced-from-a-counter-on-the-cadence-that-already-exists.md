---
id: D262
title: A per-camera cost is DIFFERENCED from a counter on a cadence that already exists, and is scoped to one node before any pid is compared
status: accepted
date: 2026-08-27
supersedes:
applies-to:
  - packages/addon-admin-ui/src/components/cluster/load/camera-load-rates.ts
  - packages/addon-admin-ui/src/components/cluster/load/contribution-origin.ts
  - packages/addon-admin-ui/src/components/cluster/load/use-camera-load-series.ts
  - packages/addon-admin-ui/src/components/cluster/load/CameraLoadPanel.tsx
---

## Context

[D260](adr-0260-the-load-series-is-durable-on-a-fixed-cadence-with-a-row-cap-behind-the-retention-knob.md)
put the per-addon load series on disk and the `load-contribution` capability
made every addon declare its own per-camera cost. Neither produced a per-camera
chart, and drawing one turned out to have two ways of being wrong that both
look completely normal on screen.

**The first wrong turn was already documented and was still tempting.**
`load-contribution` reports `cpuSeconds` as a CUMULATIVE counter, and each
entry carries `startedAtMs`, so `cpuSeconds ÷ (now − startedAtMs)` is one
subtraction away. It is also exactly the `ps pcpu` column
`docs/architecture/load-ledger.md` warns about — an average over the whole life
of the process. On a segment writer that has been up for a day it is a flat
line by construction: the 692 % tick that started the entire load
investigation would not have moved it. A chart built to find peaks that cannot
show one is the graphical form of a number that merely looks true.

The obvious repair — sample the counter ourselves — is the defect half of the
load ledger documents: four separate times the reader made the thing it
measured worse.

**The second was found by construction and had no symptom yet.**
`system.getLoadContributions` is answered by the hub and returns the WHOLE
cluster: `buildLoadContributionPlane` enumerates the registry, and the registry
holds an RPC proxy for every agent's providers alongside the hub's own. The
Load tab is per node. Subtracting a cluster-wide set of claimed pids from ONE
node's process snapshot marks that node's unclaimed process as claimed
whenever some other machine happens to run a process with the same number.
Nothing fails. The single finding this surface exists to produce — "a process
nobody knows about" — is deleted, and the coverage pair reads 47 of 47 while a
leak runs. A cluster of three nodes each running dozens of short-lived ffmpeg
children makes a collision routine, not exotic.

The rejected repair for that one was adding `nodeId` to the contribution wire
schema. The information is already on the entry: the hub reports the registry
KEY as `addonId`, and that key is bare for a hub-local provider and
`` `${addonId}@${nodeId}` `` for an agent's — the rule `moleculer.service.ts`
writes and `CapabilityRegistry.nodeOfKey` reads. A second carrier for a fact
already in the payload is a second thing that can disagree with the registry.

## Decision

A per-camera cost is a **delta of the cumulative counter across two readings
the consumer took itself**, never the counter divided by the unit's lifetime,
and never over a cadence the consumer invented: the read rides the
`metrics.node-processes-snapshot` fan-out the cluster already emits, so the
window is the operator's fixed cadence and nothing is read while the panel is
closed.

A window is **dropped to `null`** — never zero, never interpolated, never the
previous value held over — whenever anything in it is unknown: a unit that
reported no counter, a unit whose `startedAtMs` moved, a unit that vanished
between the readings, or a counter that went backwards.

And **contributions are narrowed to one node before any pid is compared**,
using the node encoded in the registry key. A bare key is the hub and nothing
else.

## Consequences

- A camera whose writer restarts every 80 seconds draws a **broken line**. That
  is the correct picture — nobody measured those windows — and it is also a
  legible symptom of the restart storm the ledger's item 7 documents.
- The per-camera window is **not durable**: contributions are stored nowhere,
  and a rate needs two readings this page saw. It starts when the panel opens,
  and the panel says so, next to per-addon charts that now say the opposite
  because they read a table. Two different promises, both stated.
- `getLoadContributions` is re-read once per cadence **while the panel is
  open**, reading `/proc/<pid>` for already-claimed children. The capability's
  own contract anticipates this ("answered on whatever beat the caller already
  has"); a panel that is closed costs nothing.
- What may be drawn per camera is read off `CAMERA_LOAD_ATTRIBUTION` through
  `isChartablePerCamera`, so the chart **cannot disagree with the table**.
  Detection stays refused because its own contributor declares it
  unattributable; streaming stays refused because only an ffmpeg-backed source
  spawns a child. `CameraLoadAttributionRow` still has no slot for a value,
  which is what stops an apportioned estimate from ever being dressed as a
  measurement.

## Enforcement

Tests, and each was disarmed and confirmed red before being restored:

- `packages/addon-admin-ui/src/components/cluster/__tests__/camera-load-rates.test.ts`
  — the drawable set equals what the attribution table declares; detection and
  streaming produce no per-camera point; a rate of 40 % is not the 2.8 %
  lifetime average of the same unit; a restart, a disappearance and a missing
  counter each leave a `null` in the series rather than a zero.
- `packages/addon-admin-ui/src/components/cluster/__tests__/contribution-origin.test.ts`
  — two nodes both running pid 100: the agent's unclaimed process stays
  unclaimed and the coverage pair reads 1 of 2.
- `packages/system/src/builtins/native-metrics/__tests__/load-series-reader.test.ts`
  — six hours at the 10 s cadence reduced to 720 points keeps a one-tick 692 %
  spike at full height, in exactly one bucket, with its floor intact.

No guard script: the rules are about arithmetic, and the arithmetic is pure and
tested. The one thing review must still catch is a new consumer folding an
unclaimed process into a neighbouring bucket.
