---
id: D696
title: A camera's motion slice means motion, and only the orchestrator writes it
status: accepted
date: 2026-10-01
supersedes:
applies-to:
  - packages/addon-pipeline-orchestrator/src/camera-sensors/motion-slice.ts
  - packages/addon-pipeline-orchestrator/src/camera-sensors/motion-slice-gate.ts
  - packages/addon-pipeline-orchestrator/src/camera-sensors/motion-slice-provider-gate.ts
  - packages/types/src/device/hub-motion-read.ts
  - packages/types/src/pipeline/motion-ownership.ts
---

> Supersedes, in part, D475 §4 and D672 on WHO writes a camera's `motion` slice.
> Everything else in those two records stands.
>
> **Amended 2026-10-02 (post-release):** `addon-pipeline`, the orchestrator and
> the admin UI ship INSIDE the `@camstack/server` closure, so the release order
> below could not be followed. The real order, its windows, a per-camera
> PROVIDER gate beside the runner gate, and the rollback (a server rollback
> rolls none of them back) replace the old "Release order" and "Rollback rules"
> sections. The full table is in `docs/architecture/update-and-release.md`.

## Context

D673 split a camera's motion in two: the provider's RAW push (`ProviderMotion`),
and the EFFECTIVE motion the camera-sensors bridge emits as
`MotionOnMotionChanged`. A Replace or Confirm sensor suppresses the camera's own
motion there. The Task-14 review found that this did not reach Home Assistant.
HA export also publishes a camera's motion entity from the camera's `motion`
runtime SLICE (`ha-export.addon.ts` `onSliceChanged`), and Hikvision and Amcrest
wrote that slice raw from their VMD. Under Replace, HA's motion entity still
followed the camera.

The Task-M3 inventory found the slice had more writers than anyone had written
down:
- **The runner's phase machine**, which D475 §4 called "the sole writer".
- **Hikvision and Amcrest**, raw, on every edge.
- **Every camera provider**, which seeded `detected: false` at each boot. That
  seed can clip a live episode whenever a provider respawns.

The phase machine was also not motion:
- every on-motion detection session attaches `always-on`, so the phase wrote
  `detected: true` at each session attach;
- the detach wrote nothing, so the slice was left ON after every session (D1);
- an always-on camera read ON for as long as it was attached.

Separately, provider `isDetected` read the PROVIDER's local runtime state, which
holds only that provider's own writes. Reolink and Wyze answered their boot seed
(`false`) forever, and HAP hydrated from it (D2).

The operator ruled that the orchestrator is THE authority for a camera's motion:
every consumer reads the effective motion, never the raw.

## Decision

A camera's `motion` runtime slice is the camera's EFFECTIVE MOTION
(`detected` + the `lastDetectedAt` of the last effective rise). The orchestrator
is its ONLY writer, through `deviceState.setCapSlice`
(`packages/addon-pipeline-orchestrator/src/camera-sensors/motion-slice.ts`). It
writes alongside the effective `MotionOnMotionChanged`, for every camera it sees.
No camera provider writes the slice, not even a boot seed. The runner's phase
machine does not write it either: the phase keeps its own
`DetectionPhaseTransition`.

A provider's `motion.isDetected` AND `motion.getStatus` answer from the HUB's
slice: the provider is built by `hubMotionNativeProvider`
(`packages/types/src/device/hub-motion-read.ts`). An unreadable hub, or a slice
nobody has published since the hub started, makes `isDetected` fail: unknown is
never `false`. `getStatus` answers `null` for the unpublished slice (its
contract's own "no status") and fails on an unreadable hub. A SENSOR device
keeps writing its own `motion` slice, because that is its own fact.

> **Amended 2026-10-06:** the four camera providers served only `isDetected`.
> `registerNativeCap` then installed the framework's default `getStatus`, which
> reads the provider's LOCAL runtime state, empty under this decision, so
> `motion.getStatus` answered `null` for every camera while the hub held its
> slice. The viewer's Motion order seeded only the camera-grid device (whose
> provider has its own `getStatus`) and ranked it above every camera. The guard
> now refuses a direct `readHubMotion*` call outside `hub-motion-read.ts`, so a
> provider can only take both reads from the builder.

### Which input feeds each camera class

| Camera | Input | Counted when |
| --- | --- | --- |
| split onboard (its provider emits `ProviderMotion`) | the bridge's `MotionOnMotionChanged { source: 'onboard', triggeredBy }`: the combining rule applied (Replace / Confirm / In addition) | `motionSources` lists `onboard` |
| unsplit onboard (camera-grid, a rolled-back provider) | its own direct `MotionOnMotionChanged { source: 'onboard' }`, no `triggeredBy` (C13) | `motionSources` lists `onboard` |
| analyzer-only | the runner analyzer's transitions (`source: 'analyzer'`) | `motionSources` lists `analyzer` and nothing else that owns motion (D475's rule, `packages/types/src/pipeline/motion-ownership.ts`) |
| device activity | the orchestrator's `device-activity` source (D392) | `motionSources` lists `device-activity` |
| several sources | OR of the counted ones | — |
| no active detection config | `onboard` and `device-activity` count; the analyzer does not (none runs) | — |
| a composed camera (composer-owned) | not re-published; its slices are the composer's | — |

The class each camera is fed by is logged once per change
(`camera motion slice: input`, `tags: { deviceId }`), with the sources seen and
not counted.

### The level, per source

A counted source is high from its `true` until its OWN `false`, or until its
bound runs out with no new `true`. The camera is ON while any counted source is
high. What bounds a source depends on whether it sends its own clear (review F3):

| Source (as the orchestrator receives it) | Sends its own clear? | Held until | Bound with no new `true` |
| --- | --- | --- | --- |
| the analyzer (`source: 'analyzer'`) | yes: transitions only, `true` then `false` | its `false` | `maxSessionHoldMs`; the release is a WARN with `tags: { deviceId }` |
| an unsplit `onboard` emitter (no `triggeredBy`: camera-grid) | yes: edges only | its `false` | `maxSessionHoldMs`, same WARN |
| the bridge's `onboard` events (`triggeredBy` present) | not always: a heartbeat stream (the camera's own pushes, the sustain ticks); Reolink and Wyze never clear | its `false` | one WINDOW after the last `true` |
| `device-activity` | yes, with sustain ticks | its `false` | one window (the ticks re-assert it) |

The window is the camera's `motionCooldownMs`, floored at two sustain ticks: the
same window the bridge holds its effective level for (`effectiveWindowMs`). So a
heartbeat source that never clears cannot leave the slice ON, and a long
analyzer episode is not clipped mid-way, as Home Assistant reads the slice. The
bound for a held source is the camera's existing `maxSessionHoldMs`: a stuck-high
analyzer (its node died before its `false`) is released there.

An always-on camera's slice is now its effective MOTION, not "attached".

### Never two writers

The orchestrator writes only while every COUNTED runner node has answered, on
`getLocalLoad().motionSliceWriter === 'orchestrator'`, that it no longer writes
the slice (`MotionSliceWriterGate`). The gate FAILS CLOSED (review F9): whatever
it cannot vouch for leaves no orchestrator writer, never a second one. That
includes a node that never answered, a runner older than D696, and a framework
hop that strips the new field (Zod strips unknown keys).
- **A runner that answers without the field** is older than D696, and keeps the
  gate closed (WARN).
- **A node that never answered** also keeps it closed. Once it has blocked
  through a whole census it is a WARN naming the node, sampled.
- **A read that fails changes nothing** (D49): it never reopens, never closes,
  and never excludes a node.
- **A node the registry POSITIVELY reports offline does not count** (review F2,
  D58). "Positively" means listed `isOnline: false` in `nodes.directory`, or
  named by an `AgentOffline`. An offline node cannot reach the hub's
  `setCapSlice`, so it cannot be a second writer. An unlisted node is unknown
  and still counts. The exclusion is never sticky (re-review R1). A node that
  answers a census is online and counts at once. A directory read that began
  before the node's latest sign of life (a connect, an answer) cannot exclude
  it.
- **A runner process coming (back) up forgets its node's answer**, so the gate
  closes before that runner can write (review F1). Production signals this
  three ways (`agent-registry.service.ts` `classifyNode`):
  - `AgentOnline` for a bare agent id;
  - `WorkerOnline { workerId }` for `<node>/<group>`, the runner's own
    `detection` group included;
  - the node's `pipeline-executor` readiness going `ready` with a new epoch (the
    `detection` group came up). `NodeLifecycleHandler` re-attaches cameras on
    that transition. It calls the gate SYNCHRONOUSLY, before its first await, so
    nothing re-attaches while the gate is open on a stale answer.

  The matching `…Offline` events forget too. Re-attach never WAITS on a census
  (D49: a failed census must never block detection). A closed gate means no
  orchestrator write, so an old runner's attach write is then the only writer.
  A forget is per node, so any child respawn there closes the gate for one
  census.

The gate is cluster-wide, not per node. Sessions are balanced per episode and
standing attaches move on failover, so any camera can be attached on any runner
node, agents included. A per-node gate could not stop an old runner elsewhere
from writing a camera the orchestrator also writes.

When the gate opens (boot, respawn, or the runner handing over), every camera is
RE-PUBLISHED:
- A camera whose level is known gets it at once.
- Any other camera gets a GRACE WINDOW: one window, or `maxSessionHoldMs` for a
  camera whose motion is the analyzer's (a held source must not be clipped by a
  takeover either). A motion event inside it continues the episode with no OFF
  blip. Without one, a slice still reading ON is published OFF, keeping its
  `lastDetectedAt`.
- The grace DEADLINE is set once and kept across gate closures (review F7). A
  flapping gate cannot push a stuck ON past it.
- `lastDetectedAt` never moves backwards (review F8): a rise writes the max of
  its own stamp, the stamp last written and, over a slice it cannot vouch for,
  the slice's own stamp. An old runner may have written a later one.

The bound is the level's own rule. A live episode re-asserts within its bound,
so when none came, the previous writer's level has expired by that same rule. An
unreadable slice is said and left as it is.

### The provider gate (amended 2026-10-02)

The runner was not the only pre-D696 writer. Hikvision and Amcrest wrote the
slice raw, and all four camera providers (Hikvision, Amcrest, Reolink, Wyze)
seeded it at boot. The runner gate alone let the orchestrator write while an
OLD provider still did: measured on the 2026-10-02 release, about one minute
with two writers on every old Hikvision/Amcrest camera.

So a camera is also gated on its OWN provider
(`ProviderSliceGate`, `camera-sensors/motion-slice-provider-gate.ts`):
- **The flag.** `deviceProvider.getStatus` answers
  `motionSliceWriter: 'orchestrator'`, said by `BaseDeviceProvider`. Every
  provider builds `self-contained` and BUNDLES `@camstack/types`, so only a
  provider built from this code says it, whatever server it runs under. Absent
  means "may still write".
- **Which cameras.** A camera whose owning addon is one of the four
  (`PRE_D696_PROVIDER_SLICE_WRITERS`) is written only once that provider
  answered with the flag. No other provider ever wrote the slice (D696 removed
  exactly these four; the guard refuses a new one), so any other camera needs
  no answer. A spec pins that each of the four ids is a declared addon.
- **Per camera, not fleet-wide.** Only a camera's own provider ever wrote its
  slice, so the two-writer risk is per camera. A fleet-wide gate would stop the
  orchestrator on every camera while one old provider is installed, for no
  safety; per camera, an old Wyze keeps only the Wyze cameras unwritten. The
  answer is asked per PROVIDER (one `getStatus` each) and applied per camera.
- **Fails closed, D49.** Unanswered (or the camera's owner not listed yet):
  closed. A failed read changes nothing.
- **Forget on (re)connect.** `WorkerOnline { '<node>/<addonId>' }` (a provider
  is its own runner, D29) forgets that provider; a bare node id (an agent)
  forgets all four, its per-camera lines sampled. An answer read by a census
  that began before that event is dropped: it may be the previous process
  speaking.
- **Where `WorkerOnline` comes from (fix round 1, review C1, H1).** A forked
  runner has no Moleculer broker, so the Moleculer emitter
  (`agent-registry.service.ts`) never saw one: the event was DEAD for every
  forked runner, and a provider rollback went unseen. The UDS parent registry
  (`LocalChildRegistry`, `lifecycleEvents`, wired by the hub's
  `moleculer.service.ts` and the agent's `agent/main.ts`) now emits it, with the
  enum, on the node's kernel bus, at a new incarnation's FIRST register — the
  pre-init frame `LocalChildClient.start()` sends before the runner loads any
  addon module, emitted before that frame is acked — so before `initialize()`,
  any device restore and any boot seed. `WorkerOffline` follows the live
  connection's close, after the hub unregistered the child. Framework code:
  live only with a `@camstack/server` that carries it. Left: the event reaches
  the orchestrator as a UDS frame while the provider loads (its first write
  takes several round trips, so the event normally wins), and an orchestrator
  write already in flight still lands. A dropped event is bounded by the next
  provider census: every runner census re-asks the providers once the last
  provider census is over 30 s old.
- **Who else hears it (re-review R1).** The RUNNER gate forgets only for the
  runner's own child (`<node>/detection`) or a bare node id
  (`isRunnerProcess`): a decoder or provider restart no longer closes it
  fleet-wide. The Notification Center turns `worker.*` into no subject at all:
  a runner restart is no `node-*` push and no liveness-ledger row.
- **Gone does not block, D58.** `WorkerOffline` for the provider's process (the
  UDS registry's word, see above) is the positive statement that it left: it cannot write, so its cameras
  open until it comes back. The registry's provider list is NOT used as
  "gone": a provider that has not registered yet at the orchestrator's boot is
  booting, not gone, and would restore its devices (and seed) right after. A
  provider already down when the orchestrator boots therefore keeps its own
  cameras unwritten (WARN per camera, unanswered after a census) until it
  answers; those cameras have no stream while it is down.
- **No timers, D3.** A census is asked for on boot, on a process or agent
  (re)connecting or leaving, and — at most one per
  `PROVIDER_GATE_STALE_REFRESH_MS`, 30 s — on a motion edge of a closed camera
  and on every runner census.
- **Keyed by addon id.** The four providers are `placement: hub-only`, so one
  addon id is one process. A provider that could run on an agent would need its
  answers keyed by `(node, addonId)`.
- A camera that opens later is taken over alone, with its own full grace
  window (none runs out while it is closed).

### Release order

`@camstack/server` re-aligns the addons it carries at boot (D518): on the hub
`addon-admin-ui`, `addon-auth`, `addon-decoder-nodeav`, `addon-notifiers`,
`addon-pipeline`, `addon-pipeline-orchestrator`, `addon-post-analysis`; on an
agent `addon-pipeline`, `addon-decoder-nodeav`, `addon-agent-ui`. So the order
this record first named (server → orchestrator → providers → addon-pipeline →
admin-ui) cannot be followed. The runner, the orchestrator and the admin UI move
at the server step. The real order is:

**server (with addon-pipeline, the orchestrator, the admin UI) → providers.**

Who writes a camera's slice, with both gates:

| After | Hikvision / Amcrest camera | Reolink / Wyze camera | other camera |
| --- | --- | --- | --- |
| server step, runner gate closed | old provider (raw) | nobody (boot seed on a restart) | nobody |
| runner gate open | old provider (raw) | nobody (boot seed on a restart) | the orchestrator |
| provider step (server emits worker events) | the orchestrator; the new process's pre-init `WorkerOnline` closes it for one census | same | the orchestrator |
| provider step (server does NOT emit them, e.g. 1.2.430) | nobody until the next provider census (a motion edge on the closed camera, a runner census 30 s after the last provider census, an `AgentOnline`, an orchestrator restart) | same | the orchestrator |

The provider gate shipped AFTER the 2026-10-02 release. In that release the
second row had two writers on every old Hikvision/Amcrest camera (~1 min), and
the first lasted ~1.5 min with only the old providers' raw writes.

The released D696 providers carry no flag. Ship the four providers rebuilt with
it BEFORE the server that carries the provider gate ONLY when a live read
confirms that the hub's installed orchestrator is at or above the floor
(`addons.listPackages`: `@camstack/addon-pipeline-orchestrator` ≥ 1.2.272, the
version installed on the hub's disk) and
that every runner is D696 (`pipelineOrchestrator.getAgentLoad`: every online
entry carries `load.motionSliceWriter: "orchestrator"`). The closure does not
guarantee the first (the re-alignment is conditional and its failure only
WARNs), and D673 forbids a split provider in front of an orchestrator below the
floor. Server first, or the reads short: their cameras have no writer until
their provider step (never two).

### Rollback rules

- **A server rollback rolls none of the closure addons back.** An older closure
  under a newer installed copy is kept (`planAddonRealignment`). Install
  `addon-pipeline` (hub and every agent), the orchestrator and the admin UI back
  explicitly.
- **Order:** admin UI, providers, `addon-pipeline`, the orchestrator, the
  server.
- **A provider rollback** is one writer at every point with the provider gate
  AND a server that emits worker events for forked runners: its pre-init
  `WorkerOnline` closes its cameras before it loads, restores or seeds, and its
  old answer (no flag) keeps them closed. On a server that does not emit them
  (1.2.430) the orchestrator never hears of it and both write: restart the
  orchestrator immediately after the provider rollback (its boot census reads
  the old answer). Without the gate it is two writers.
- **The no-sensor-edit window** (D673) runs from the admin-UI rollback to the
  orchestrator rollback, across the providers and `addon-pipeline` steps
  between them.
- **addon-pipeline rollback:** the runner gate closes when the old runner's
  `detection` group comes up — its `pipeline-executor` readiness epoch, on every
  server, and its `WorkerOnline` on a server that emits it — before any re-attach,
  and the old runner writes the cameras it attaches. Residual race, as for every
  reconnect: a runner whose attachments survived a partition can write on its
  first phase change after reconnecting, before the hub's handler runs.
- **The orchestrator below the floor** (the version that first carried D696,
  1.2.272) while `addon-pipeline` is new: NO writer, every slice freezes. Roll
  `addon-pipeline` back first. Never below the floor once a provider emits
  `ProviderMotion` (D673).
- The D673 rules still hold. Never roll the admin-ui back alone, and do not
  edit camera sensors while an old admin-ui faces a new orchestrator or while
  the new server faces a CS-1 orchestrator (D673).

## Consequences

- **HA export, HAP hydration, provider `isDetected` and admin UI reads** of a
  camera's slice now see the effective motion. Under Replace, the camera's VMD
  no longer lights HA's motion entity.
- **The Motion card's camera row reads the camera's own RAW level** from the
  camera-sensors status (`cameraLevel`: the bridge's last received edge,
  `detected` evaluated against the window when the status is read), not from
  the slice. The slice is no longer that row's value.
- **A source that sends its own clear** (the analyzer, camera-grid) is held
  until that clear, at most `maxSessionHoldMs`. A heartbeat source falls one
  window after its last `true`.
- **A known runner node that never answers** keeps the gate closed, so no camera
  slice is written, unless the registry positively reports it offline (then it
  does not count). The gate WARNs, naming it, once it has blocked through a
  whole census. Any process (re)connect on a node closes the gate for one
  census, and the reopening re-publishes every camera: one slice read per camera
  with no known level, after its grace deadline.
- **The Motion card's camera row** re-reads the status every 5 s while mounted.
  The status evaluates the raw level against the window at read time, so a
  heartbeat-only camera reads idle once its pushes stop.
- **`isDetected` on a camera** throws for unknown. HAP's hydration catches it
  and keeps its own default.
- **One hub round trip per effective edge**, per camera, in order. Heartbeats
  write nothing.
- **What the guard cannot see:** a write through a variable cap name. The HA
  binary sensor writes `this.capName`, and the composer writes generic slices
  for its own devices. Both write sensors or composed devices.

## Enforcement

- **The guard** `scripts/check-onboard-motion-emitters.ts` refuses any
  production file that writes a `motion` slice, except the ONE hub-store module
  (`packages/addon-pipeline-orchestrator/src/camera-sensors/motion-slice-hub.ts`).
  It names `path:line`. Forms covered:
  - `setCapSlice` / `setCapSlice.mutate` / `setCapState` / `patchCapState` on
    `motion`, `motionCapability`, its `.name`, or a same-file constant holding one;
  - `capName: 'motion'`, and a shorthand `capName`;
  - `state.motion = …`, `state.motion.x = …`, and `state['motion'] = …`.

  Exemptions, each by exact path with a reason; a stale one is refused:
  - the sensor writers;
  - the framework's two generic writers (`base-device.ts`,
    `device-state-handle.ts`);
  - the hub-store module above.
- **Specs:**
  - the writer, the gate and the wiring
    (`packages/addon-pipeline-orchestrator/src/__tests__/camera-motion-slice.spec.ts`,
    `motion-slice-gate.spec.ts`, `camera-motion-slice-wiring.spec.ts`);
  - the runner
    (`packages/addon-pipeline/src/pipeline-runner/__tests__/motion-slice-not-written.spec.ts`);
  - the provider gate (`motion-slice-provider-gate.spec.ts`), the provider's
    flag (`packages/types/src/device/__tests__/base-device-provider-slice-writer.spec.ts`),
    and the real addon with an old, a new and a rolled-back provider
    (`camera-sensors-acceptance.spec.ts` #20–#22);
  - each provider's `motion-slice-from-hub.spec.ts`;
  - the readiness ordering (the gate forgets before any re-attach,
    `attach-pipeline-reattach.spec.ts`);
  - the real addon with production's `WorkerOnline` and an offline-since-boot
    agent (`camera-sensors-acceptance.spec.ts` #16, #17).
