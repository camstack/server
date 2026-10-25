---
id: D322
title: A poll asks each question ONCE — and a batch answers for every id it was asked about
status: accepted
date: 2026-08-31
supersedes:
applies-to:
  - packages/addon-pipeline-orchestrator/src/camera-status/fleet-read-pass.ts
  - packages/addon-pipeline-orchestrator/src/switch-authorities.ts
  - packages/addon-admin-ui/src/components/detection-intelligence/use-stationary-objects.ts
  - packages/addon-admin-ui/src/hooks/use-scenes-feed.ts
---

## Context

[D320](./adr-0320-a-walk-that-answers-a-question-is-bounded-single-flighted-and-never-on-a-timer.md)
fixed one timer-driven collection walk and the accompanying
[audit](../design/2026-08-31-timer-driven-collection-reads.md) surveyed the
rest. Four of its findings share one shape — **N queries per poll, N = the
camera fleet** — and D320's own remedy (an operator Refresh button) is the
wrong one for all four. The operator said so:

> *"Va bene il refetch continuo, ma devono essere query ottimizzate al massimo,
> cachate dove possibile."*
>
> [Continuous refetch is fine, but the queries must be optimised to the maximum, cached where possible.]

These are live-status surfaces for an NVR operator. Wanting them live is
correct. The defect is not the cadence; it is the size of the question.

**Where the cache goes is not negotiable.** [D224](./adr-0224-the-freshness-of-a-camera-fact-lives-in-its-provider.md)
already settled it: a device fact stays fresh in the addon that owns the
device, and a consumer's second copy is stale by design on the one write an
operator makes. [D317](./adr-0317-a-durable-capture-belongs-to-the-periodic-pass-and-the-cluster-diagram-is-not-a-lookup-table.md)
showed the sanctioned alternative — a snapshot the OWNER maintains and pushes —
and turned a 30 s call into 0.15 s with it.

### The seven stages, and the verdict on them

The worst finding was `pipelineOrchestrator.getCameraStatuses`, polled every
5 s by the admin Cameras page and served as
`Promise.all(ids.map(getCameraStatus))`. The audit called each element "a
7-stage cross-node RPC fan-out"; the question put to this work was whether the
ASSEMBLY is itself the defect, and whether the answer could be maintained
rather than assembled on demand.

The seven stages, and what each actually costs:

| stage | reads | scope |
| --- | --- | --- |
| source | `streamBroker.listAllProfileSlots` | the whole NODE's slot table |
| broker | the same slots, + `getBrokerStats`/`listClients` per slot, + `getAllRtspEntries` | node table + genuinely per camera |
| decoder | nothing — derived from the detection assignment | free |
| motion | nothing — the orchestrator's own cached `RunnerCameraConfig` | free |
| detection | `getEngineProvisioning`, `getSelectedEngine`, `pipelineRunner.getCameraMetrics` | per NODE, per NODE, per camera |
| audio | nothing — the cached assignment plus the switch read | free |
| recording | `recording.getStatus` | per camera |
| switches | `readSwitchAuthorities`: 8 authorities | mixed (see D113) |

**Two of the seven are free already.** What made the call expensive was not the
number of stages but that **six distinct questions that are not about a camera
were asked once per camera**: the node's slot table, the node's restream table,
the fleet's mute list, the node's engine pair, and the device type's bindable
caps. Two more — the device row and the binding table — are per-camera
questions the device manager already answers for a SET
(`listAll({deviceIds})`, `getBindingsBatch({deviceIds})`, both added for
exactly this shape). Measured as shape on a four-camera fixture: **16 round
trips per camera**, of which **8 were per-camera facts and 8 were the same
answer fetched again**.

**A maintained snapshot is the WRONG remedy here, and the reason matters.**
The orchestrator owns none of those facts. It owns placement — which is already
synchronous and free. The broker stats belong to `stream-broker`, the recorder
state to `recording`, the mute list to `notification-rules`, the mask and
microphone to the camera's own provider (whose freshness D224 placed in that
provider, deliberately). A snapshot maintained in the orchestrator would be a
second copy of six other addons' facts — D224's forbidden shape, six times
over. The one plane that IS maintained-and-pushed, the 1 Hz
`pipeline.camera-metrics-snapshot`, the admin page already overlays.

## Decision

**A poll asks each distinct question exactly once per call — and never
remembers the answer afterwards.**

`FleetReadPass` is created per `getCameraStatuses`, holds one promise per
distinct question (per node, per device type, per set), and is discarded when
the call returns. It is deliberately **not a cache**: no TTL, nothing
invalidates it, and the next poll asks again from scratch. What it buys is not
staleness-for-speed but coherence — every camera in a pass sees the fleet-wide
answer read at ONE instant, where N separate reads saw N instants.

Three properties ride with it, and each was a live failure mode:

1. **The pass does not bound and does not log.** Every promise it hands out is
   the raw cap call; the consumer wraps it exactly as it wrapped its own —
   `bounded(...)` per source, `boundedStage(...)` per stage. So each camera
   keeps its own deadline, degrades independently, and writes its own warn line
   with `tags: { deviceId }`. A fleet read that fails fails for each camera
   separately, with the line each would have written alone.

2. **The shape follows the SET, not the caller.** A pass of one asks
   `getDevice` and `getBindings`; a pass of many asks the batch methods. The
   write path (`CameraSwitchService.setCameraSwitch`) is always a pass of one
   and is unchanged by this record. Answering a set of one with a fleet-shaped
   method is no cheaper and moves a write onto a read it does not need. Because
   the method varies, the warn line's source name travels WITH the read
   (`PassRead.source`) rather than being a constant at the call site.

3. **A shared promise is kept alive.** `listBindableCapsForDeviceType` is
   reached after an await, so two cameras genuinely attach handlers in
   different ticks; without a no-op `catch` the first rejection is unhandled in
   between.

**And, for a fan-out the CLIENT was doing: one batched query, answered by the
owner.** `zoneAnalytics.getCurrentSnapshotBatch`,
`sceneMonitor.listScenesBatch` and `pipelineAnalytics.getKeyEventsBatch` do the
same per-device work the fan-out caused, in the process that already holds the
data, with N transports collapsed to one. The polls stay.

**A batch answers for EVERY id it was asked about, and a camera it could not
read is MARKED, never answered with emptiness.** This is the half a batch can
lose silently, because fanned out it was free — one query rejected while the
others resolved. It is [D315](./adr-0315-not-yet-known-never-looks-like-not-installed-and-a-presence-gate-asks-the-registry.md)'s
rule one layer out: a not-yet-known value must never render as a definite one.

- `SceneMonitorStatusForDevice.status: null` is *"could not look"*, and is not
  `monitors: []`. Silence reading as "nothing configured" is that feature's
  whole failure mode.
- `CameraOccupancySnapshotForDevice.read` splits THREE outcomes the single
  method could express as only two, because `snapshot: null` was already
  spoken for by "no frame yet".

## Consequences

- **`getCameraStatuses`, as shape:** the per-camera cost falls from 16 round
  trips to 8, and the six fleet-invariant reads stop multiplying — 8 per pass
  regardless of fleet size. On the four-camera fixture that is **64 → 40**; on
  the 29-camera fleet it is **464 → 240**, twelve times a minute. Two
  sequential legs also became concurrent (`getBrokerStats` + `listClients` per
  slot; the runner metrics against the engine pair), halving the depth of the
  two stages that had any.
- **The three UI fan-outs:** N → 1 per refresh, at 15 s, 30 s and 30 s.
- **`StationarySection` no longer hides itself on an empty list** when a camera
  could not be read. It used to return `null` whenever nothing was parked
  anywhere, which turned an unread camera into a positive claim that nothing is
  parked on it. `Scenes.tsx` already rendered its `unreachableCount`; the
  stationary section now has one.
- **An empty selection asks nothing.** The three batch caps take
  `deviceIds.min(1)`, which has no spelling for "no cameras"; sending `[]` to
  be answered with the fleet is the opposite of this change.
- **What is NOT fixed.** The remaining 8 per-camera reads in a status pass are
  genuinely per camera and stay: the broker slot stats, the runner metrics, the
  recorder's status and config, the broker mute, and the camera's own privacy
  pair. Two of those (`recording.getStatus` + `recording.getDeviceConfig`) are
  two calls to one addon about one camera and could become one; the broker's
  per-slot stats could become one node-wide read. Both need a cap method that
  does not exist and neither was measured to matter yet.
- The `pipelineAnalytics.getKeyEventsBatch` store work is unchanged: still N
  indexed queries, now concurrent inside the owner. Making it ONE query needs
  `whereIn` on the track store and a per-camera-limit semantics that survives
  it; that is a store change, not a transport one, and is not attempted here.

## Enforcement

Tests, each confirmed RED by removing the line it guards — thirteen disarms in
total, listed because the count is the point:

- `packages/addon-pipeline-orchestrator/src/__tests__/camera-status-pass-shape.spec.ts`
  asserts SHAPE — which cap methods a four-camera pass reaches and how many
  times — never wall clock. **Nine disarms:** the shared pass itself, each of
  the five memos, both batch branches, and the roster/bindings set reads. Its
  last test is the honesty check: the status composed in a pass of four is
  field-for-field identical to the one composed alone, which is what fails if
  the work avoided was work that mattered.
- `packages/addon-admin-ui/src/components/detection-intelligence/__tests__/per-camera-feeds-are-one-query.spec.tsx`
  asserts the operations issued and that the SINGULAR method is no longer
  reached at all — a batch running BESIDE the fan-out would satisfy "the batch
  was called" while costing strictly more. **Six disarms.**
- `packages/addon-post-analysis/src/pipeline-analytics/__tests__/per-device-batch-rows.spec.ts`
  arms the OWNER half. It exists because disarming the provider branches left
  the hook spec entirely green: that spec mocks the tRPC client and cannot
  reach a provider. **Four disarms**, all on the "marked, not answered with
  emptiness" rule and its per-camera log line.

No guard script. "Do not ask a fleet-invariant question per camera" is not
mechanically detectable from a diff — the questions are ordinary cap calls and
what makes one fleet-invariant is its meaning, not its shape. D320 reached the
same conclusion about its own rule and shipped no guard for the same reason; a
vague guard is worse than none.
