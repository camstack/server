---
id: D650
title: A detail step the elected device cannot run is delegated to another device of the same node, with that device's provisioning; the root never moves
status: accepted
date: 2026-09-26
supersedes:
applies-to:
  - packages/addon-pipeline-orchestrator/src/pipeline-resolver.ts
  - packages/addon-pipeline-orchestrator/src/jump-roster.ts
  - packages/addon-pipeline-orchestrator/src/attach-pipeline.ts
  - packages/addon-pipeline-orchestrator/src/package-zone-reattach.ts
  - packages/addon-pipeline-orchestrator/src/placement-service.ts
  - packages/addon-pipeline-orchestrator/src/pipeline-settings-store.ts
  - packages/addon-pipeline-orchestrator/src/apply-device-provisioning.ts
  - packages/addon-pipeline/src/pipeline-runner/device-jump.ts
  - packages/addon-pipeline/src/pipeline-runner/detail-subtree.ts
---

## Context

The hub has `openvino:gpu`, `openvino:npu` and a Coral (`edgetpu:usb`, tflite).
While the Coral was in the pool, every camera the device balancer put on it
logged `pipeline steps gated on but not provisioned on this node — skipped
{face-detection:no-compatible-model,plate-detection:…,face-embedding:…,
clip-embedding:…,plate-ocr:…,audio-classifier:…}`: 98 warnings on 14 cameras
in 3 h. Those sessions ran object detection only. The Coral was disabled as a
mitigation.

The runner already had the fix. `pipeline-runner/device-jump.ts` jumps a
detail subtree the elected device cannot run to another enabled device of the
same node (weighted-least-loaded, under `maxSessions`, or an operator
`jumpDeviceKey`). It never ran, because the orchestrator removed the steps
first. `resolvePipelineWithSkips` gated EVERY step on
`addonHasCompatibleModel(addon, format)`, where `format` is the ELECTED
device's format (`resolvePipelineForDevice` derives it from `deviceKey`). A
step with no build for that format was dropped before the attach.

Keeping the step was not enough on its own. A jumped step also carried the
wrong model. `applyDeviceProvisioning` attaches the ELECTED device's
per-(node,device) base and the camera's override for that device. The runner
jumped the subtree with those values. The executor then resolved them against
the target pool's format. The target device's own pin and the camera's
override for that device were never read. A face model the operator chose for
`openvino:gpu` would have been replaced by the openvino format default on every
jumped dispatch, and no log line would have said so.

## Decision

The per-device gate is two gates. A ROOT (a video step with no `inputClasses`)
must have a build for the ELECTED device's format. It is the elected device's
job and is never jumped. When only other devices could run it, it is dropped
with `root-not-runnable-on-elected-device`. A detail step is kept when the
elected device OR any device of the node's jump roster ships a build for it.
The roster is the set of enabled, available devices the runner jumps within.
When no device on the node can run the step, it is still dropped, and the
existing warn names the elected device, its format, the roster and why. The
resolver stays pure: the caller passes the roster's device keys in.

**One owner of an attach's steps: `resolveAttachPipeline`**
(`attach-pipeline.ts`). It runs AFTER the device is elected. It builds the
roster (`buildJumpRoster`), resolves the STRUCTURE-ONLY tree for the elected
device and roster, and provisions it. The elected device gets its base and the
camera's override (`applyDeviceProvisioning`). Every roster entry gets
`steps`: what the resolved tree would run with had the camera been elected
onto that device (`provisionDeviceSteps`, the same function, flattened). One
read of each settings blob serves the elected device and the whole roster
(`readDeviceProvisioning`). `withAttachPipeline` replaces a config's
`steps`/`audio`/`deviceKey`/`inferenceDevices` together, so a previous
attach's device or roster never survives a spread.

Every path that sets or replaces a live attach's steps goes through it:
- the standing dispatch, and a rebalance migration, which now elects the
  target node's device (`PlacementService.electInferenceDevice`);
- the on-motion session;
- the executor-readiness re-attach and its stale-empty sweep, on the device
  the camera is already elected onto
  (`PlacementService.resolveAttachPipelineOnDevice`);
- the package-zone re-attach (`reattachAfterPackageZoneChange`).

**One exception remains, and it predates this branch:**
`DetectionWiringController.handlePipelineCameraUpdated` (the hot-reload on a
`pipeline.camera-updated` event) writes `steps`/`audio` from the EVENT
PAYLOAD onto the cached config and re-attaches, without the owner. The payload
is a tree resolved for the node default format with no device provisioning
and no roster, so a hot-reloaded camera runs that tree until its next real
attach. Left as it is in this branch; recorded as a known follow-up: route it
through `PlacementService.resolveAttachPipelineOnDevice` on the camera's
elected device, as the readiness and package-zone re-attaches were.

`dispatchCamera` never reuses the incoming `steps`. They were hydrated for the
node default format before election, or they are a previous attach's
already-provisioned tree (a re-dispatch from the ledger). The standing path's
post-dispatch "correction" is gone: the one attach is already right. It used
to fire only when the node changed or the steps were empty. On a
tflite-default node, a GPU-elected camera kept a face-less tree forever.

The runner (`placeDetailStep`) picks the target and REPLACES the jumped
subtree's `modelId` and `settings` with the target's entry. Every other field
of the step travels as sent. A step absent from the entry runs the target
format's default.

Ownership of the model is split three ways, and nothing is computed twice.
The orchestrator decides what the operator chose for a (node, device, camera).
The runner decides where a subtree runs. The executor resolves the chosen id
against the target pool's format (`resolveModelForFormat`).

**A manual `jumpDeviceKey` takes the TARGET's provisioning too.** Before D650,
a manually jumped step kept the elected device's base and the camera's
override. Now it runs what the target's base and the camera's override for the
target say. That is the right meaning: the step runs in the target's pool. The
change is not silent. When a manual jump the runner can take (its target is on
the roster) leaves a camera override for that step behind on the elected
device, the orchestrator warns once per (camera, step): `manual jumpDeviceKey
leaves an elected-device override behind`. Live on 2026-09-26, no node (hub,
agent-a, MacMiniAgent.localdomain) had a `jumpDeviceKey` on any device,
so no live configuration changes behaviour.

**Audio.** `audio-classifier` is not gated through the inference-format test
at all; enablement (`stepToggles`) still applies. It never runs on an
inference pool. The audio-analyzer runs its own backend (YAMNet in an embedded
Python subprocess, or Apple SoundAnalysis), so an inference format says nothing
about whether it can run. Its availability has its own signals, and they
already decide whether audio runs:
- the `audio-analyzer` readiness per node (`subscribeToAudioAnalyzerReadiness`);
- the audio placement's eligible nodes (`topology.enabledAudioNodes`, from
  `agentSettings[node].audio`);
- the `audio-analysis` wrapper binding (`isAudioAnalysisActive`).

The format gate was a second, wrong opinion. Its only effect was a false
warning on every node whose elected format has no YAMNet build.

**Frames.** Nothing new crosses a process boundary. A detail dispatch was
already a per-track, on-demand, JPEG-compressed crop sent through
`pipelineExecutor.runPipeline` with a `deviceKey` (D9, D18). The jump changes
only which pool of the same executor that key selects. The native child re-cut
(`nativeCropRef`) is the same handle, whatever the pool.

## Consequences

- A Coral-elected session now runs faces, plates, CLIP and OCR on the node's
  other devices. That load lands on those pools, but nothing counts it. The
  jump picks its target by the number of cameras ELECTED onto each device,
  compared with `maxSessions`, and the balancer counts the same thing. Jumped
  detail work appears in neither count.
- `RunnerInferenceDeviceSchema` gains an optional `steps`. That is a
  `@camstack/types` change. The attach is an addon→addon call, and its input
  is parsed in the process that OWNS the method — the runner's — with the
  `@camstack/types` that process resolves (`child-addon-call-dispatch.ts`,
  "validation happens HERE"; the hub's registered copy of a forked catalog
  carries no schemas). The addon declares `@camstack/types` as a peer
  dependency, so that is the RUNNER NODE's closure — never the hub's. `steps`
  therefore survives whenever the runner node is new, whatever the hub runs;
  only the tRPC layer parses with the hub closure's types. A runner whose node
  predates D650 strips `steps`: it sees a roster without provisioning and runs
  a jumped step AS SENT, with the elected device's provisioning. The executor
  resolves that pin against the target format, substituting the target format
  default only when the pin has no build there. The jump log says so:
  `provisioned: false`. An orchestrator that predates D650 behaves the same
  way. (Corrected in the pre-ship review: the first draft placed the parse in
  the hub's closure.)
- **Waiting for a catalog is a first-placement privilege** (round 2). The
  owner has two named entry points:
  - `resolveAttachPipeline` waits for the node's catalog
    (`waitForAgentAndCatalog`). It serves the first standing dispatch
    (`dispatchCamera`), the on-motion session and the re-attaches, exactly
    as `main` did.
  - `resolveAttachPipelineIfCatalogCached` reads the catalog from the cache
    only (`peekCatalogForAgent`). It serves the re-place paths:
    - `redispatchCamera`: the pending-retry sweep and the remote-health
      re-place;
    - a rebalance migration, resolved BEFORE the source is detached.

  These run cameras serially under one in-flight flag. A node that the
  topology reports online but whose executor never answers (the 2026-07-17
  shape) would otherwise hold every later camera, and every later sweep,
  forever. With the cached read, its camera stays pending as
  `catalog-unavailable:<nodeId>`, logged once per change of pending state, and
  a migration to it is skipped with the camera left on its source. A cold
  cache starts ONE background refresh per node, so the next round finds the
  catalog. That is D3 (no waiting for a node) and D49 (never gate on a
  fallible read).
- **Device election follows the same split** (round 3). Round 2 made the
  eligibility's root guard read the cached catalog on EVERY path. On a cold
  cache it failed open, and a first dispatch could elect a Coral with no
  tflite root build. The camera was then attached with no root step and
  recorded as placed, with nothing to re-place it. Now:
  - A first placement (`resolveEligibleInferenceDevices`) waits for the
    catalog (`awaitCatalogForNode`) before electing, and asks the node's
    device probe and pool health live, as `main` did.
  - A re-place (`resolveEligibleInferenceDevicesIfCached`) makes no live
    call to the node. It elects against the node's LAST COMPLETED device
    probe and the pool-health mirror that probe updated, plus the cached
    catalog.
  - A node whose probe has never come back leaves the camera pending as
    `device-health-unavailable:<node>`. A cold catalog leaves it pending as
    `catalog-unavailable:<node>`; it never fails open. Each case starts one
    background refresh per node.
  - "Completed" is the bar, not "answered healthy". A health read that
    failed (`null`, e.g. a version-skewed executor) changes no verdict
    (D49), but it did come back. The node that must not be waited on is the
    one whose read never returns.
  - Consequence: the first re-place toward a node that no dispatch has ever
    probed goes pending for one round. A first placement or the session
    refresher warms it.
- **An attach without its CAMERA ROOT is refused, by name** (round 3,
  narrowed in round 4). The resolver reports the camera root
  (`OBJECT_DETECTION_STEP_ID`, exported by `pipeline-resolver.ts`) when it is
  gated on and the elected device cannot run it
  (`ResolvedPipeline.droppedRoots`). Both owner entry points then answer
  `root-refused` instead of a pipeline, and every caller refuses the attach
  and never records an assignment:
  - a placement leaves the camera pending as `root-unrunnable:<node>/<device>`
    (error, once per change);
  - a session opens nothing, says so once per change of the refusal, and
    exposes it (`SessionDispatchController.refusalReason`) to the camera
    status, which renders `reasons.detection` as `pending:<reason>` in place
    of `armed:on-motion` — the surface a standing camera's pending reason
    already uses. It is NOT written to the ledger's `pendingReasons`: an
    entry there reads as a standing attach in `handleSessionMotion` and
    would freeze the camera idle;
  - a re-attach keeps the live attach. The camera stays placed and running,
    so there is no pending state to show; the error line (one per readiness
    epoch, one per zone edit) is the surface.
  Election and resolve now read the same catalog, so this should not fire.
  It is the backstop for when they disagree — which is why it judges exactly
  the step the election guard judges, derived from one constant. Round 3
  counted EVERY gated-on video root the device could not run: on a Coral with
  `segmentation` toggled on, `droppedRoots` was `["segmentation"]` while the
  tree still held object-detection, and the camera was refused and pending
  forever, because the election never looks at segmentation and elected the
  Coral again every round. Any root other than the camera root that the
  device cannot run is a logged skip, as on `main`.
- **A fenced catalog read is re-read, never returned** (round 4). The fence
  kept a pre-invalidation answer out of the cache but still handed it to the
  caller awaiting it, so a first placement could resolve against the catalog
  the invalidation had just removed. `getCatalogForAgent` now reads again
  under the new generation, at most `CATALOG_FENCE_REREADS` times, then
  answers `null` ("not answered") with a warn.
- **An unreachable device probe changes nothing** (round 4, D49).
  `probeNodeInferenceDevices` answers `reachable:false` with an empty list,
  and that list was recorded as a completed probe: it wiped a good last-known
  device list, and it turned a never-answered node into an "answered with
  nothing" one, so `device-health-unavailable` stopped firing after a single
  failure. Now the last known list is kept and a never-answered node stays
  unanswered.
- **A read nothing waits on takes one round** (pre-ship review, D3). Round 3
  made `resolveEligibleInferenceDevices` await the node's catalog — and that
  same function is the session controller's balancer memo `load`, driven by
  its background refresher every 30 s for every node a session was dispatched
  to. When such a node departed (a Mac asleep), the in-flight read looped
  forever: a `getSchema` plus a 30 s acquire per round and a WARN every round.
  The mode is now explicit in the signature
  (`EligibilityCatalogRead = 'await-catalog' | 'one-round'`), the memo's
  `load` is told whether it serves a MISS (a dispatch waiting: `await-catalog`)
  or the REFRESHER (`one-round`), and a one-round read that gets no catalog
  fails so the memo keeps its last answer. Only the first-dispatch and
  motion-start paths wait unbounded.
- **A node that leaves is forgotten** (pre-ship review, M4). `AgentOffline`
  and `removeAgentSettings` clear the node's last device probe, so a node that
  returns with a different accelerator set is probed again rather than elected
  against the list it left with.
- **The past-TTL catalog line warns only past five minutes** (pre-ship
  review, M5). The re-place sweep runs every 60 s against a 30 s TTL, so every
  round served a stale entry by construction and the warn said nothing. It now
  fires once per stretch only when the age exceeds `CATALOG_STALE_WARN_MS`
  (5 min) — a refresh that has not landed in ten windows.
- **Codegen reads the INPUT argument for device-binding** (round 4).
  `parse-cap.ts` regex-tested the whole `method(...)` text, output included,
  so a `deviceId: z.number()` in an OUTPUT row marked the method
  device-bound. Round 3 hoisted the `rebalance` skip schema out of the method
  to dodge it; it is inline again. The fix also reclassified two methods that
  were wrongly device-bound for the same reason: `deviceProvider.reloadDevice`
  (input `{ stableId }`, output `{ deviceId }`) and
  `pipelineOrchestrator.getAudioAssignments` (`void → rows`), which moved from
  the `DeviceProxy` to the `SystemProxy`. Neither is called through the device
  proxy anywhere.
- The cached catalog is served past its TTL with ONE warn per node, naming its
  age. A failed catalog read is a warn once per failing stretch, no longer a
  debug line. `invalidateCatalog` fences a refresh already in flight: a
  per-node generation, plus an epoch for a full clear, means a read that began
  before an invalidation never re-installs its answer.
- `rebalance()` reports `skipped` (`deviceId`, `targetNodeId`, `reason`), so a
  manual rebalance toward a node that has not answered does not read as
  "nothing to do". The cap output schema carries it. The per-camera
  "migration skipped" line fires once per change of reason.
- The standing path's placeholder hydrate reads the cached catalog too; a
  cold cache gives an empty placeholder. The readiness re-attach and its
  sweep skip, and log, a ledger config with no assignment and no elected
  device. That is a camera the balancer never placed, and placing it would
  bypass the balancer.
- A rebalance migration elects a device on the target node. Before, it
  carried the SOURCE node's `deviceKey` across. It also no longer keeps the
  cached steps when the target resolves empty; it attaches the empty tree.
  An empty resolve is not always operator intent. It can be the camera's
  toggles or its binding, but it can also mean that no build exists for the
  elected format: the device election does not consult buildability beyond
  the root guard, and a root with no build on the elected device is dropped.
  The resolver says which it was. `pipeline steps gated on but not
  provisioned on this node — skipped` names the dropped steps and why.
  `resolvePipelineForDevice → empty (all steps gated off/unprovisioned)`
  follows when nothing is left. Keeping the source node's tree would attach
  steps the target cannot run, under the source node's provisioning.
- Settings reads per session open: `buildNodeInferenceDeviceSteps` and
  `readCameraDeviceOverride` each read a whole addon-store blob over the
  settings-store RPC, uncached. The first D650 cut paid 2 + 2×N of them (N =
  roster size, 3 on the hub: 8). The owner now reads each blob once (2).
- A rebalance pass now tallies the sessions it hands each accelerator, not
  only each node. Before, the device election read one snapshot for the
  whole pass and could overshoot a device's `maxSessions`.
- Known limit: a subtree whose steps have builds only on DIFFERENT roster
  devices (no single format runs the whole subtree) passes the per-step gate.
  The runner then reports it `no-candidate` with its once-per-(camera, step)
  warn.

## Enforcement

- `pipeline-resolver.spec.ts` (D650 block) checks:
  - the step is kept on a tflite election with an openvino device on the node;
  - it is dropped and reported when the roster cannot run it;
  - the root is never kept by the roster;
  - audio is kept on a single-device node with no audio build, and still
    honours enablement;
  - with no roster, the old gate applies.
- `attach-pipeline.spec.ts` checks the owner:
  - GPU elected on a tflite-default node: faces kept, with the GPU's pin;
  - Coral elected: faces kept through the roster;
  - one read of each blob;
  - the manual-jump warn fires once, and only when an override is left;
  - `withAttachPipeline` drops stale fields.
- `attach-pipeline-reattach.spec.ts` covers the readiness re-attach, the
  stale-empty sweep and the package-zone re-attach. It uses the real store,
  ledger and owner.
- `first-dispatch-node-reresolve.spec.ts`:
  - a restart on a tflite-default node with the GPU elected keeps its faces;
  - a re-dispatch of a ledger config carrying a stale device, roster and pin
    is re-resolved from structure.
- `session-dispatch-detail-jump.spec.ts` drives the real store through a
  session onto the Coral.
- `device-jump.spec.ts` and `detail-subtree.spec.ts` check the runner:
  - replace, never overlay;
  - a manual jump;
  - a pre-D650 roster;
  - the placed step reaches `runPipeline`.
- `pending-retry-catalog-wedge.spec.ts` runs a sweep over three cameras
  where node B's executor never answers:
  - A and C are placed, and B is pending as `catalog-unavailable:agent-b`;
  - the sweep completes within its bound;
  - B is placed on a later sweep, once it answers.

  Making the re-place wait turns it into a timeout.
- `rebalance-migration-attach.spec.ts` covers the migration:
  - election on the target, with the source device and roster stripped;
  - an empty resolve attaches empty;
  - `maxSessions` is never overshot within one pass;
  - a wedged target is skipped without a detach and without hanging the
    pass.

  It also drives the package-zone re-attach through the bootstrap wiring.
- `attach-pipeline.spec.ts` measures the reads of the whole
  `resolveAttachPipeline` against the structure resolve alone: provisioning
  adds exactly two blob reads for a three-device roster.
- `root-guard-placement.spec.ts` covers the root guard:
  - a cold cache plus a first dispatch waits for the catalog and never elects
    the Coral;
  - a root-less attach is refused, pending as `root-unrunnable:…`, with no
    assignment.
- `pending-retry-catalog-wedge.spec.ts`: agent-b's executor answers NEITHER
  its catalog NOR `getInferenceDeviceHealth`, and each sweep still finishes
  in under 3 s. A node whose probe answers but whose catalog never does stays
  pending as `catalog-unavailable`. That test is also covered by the resolve's
  own cache gate, so it goes red only when the cached election is made to
  wait.
- `catalog-cache-fence.spec.ts` covers the cache:
  - the per-node fence;
  - the full-clear fence;
  - a caller whose read was fenced out re-awaits a fresh read and never
    receives the stale answer (round 4);
  - the once-only stale warn and failure warn.
- Round 4, the refusal is the camera root only:
  - `pipeline-resolver.spec.ts`: segmentation toggled on with no tflite build
    is a skip with `droppedRoots` empty; `droppedRoots` names object-detection
    and only it;
  - `attach-pipeline.spec.ts`: the same through the owner on the real store —
    the camera attaches with its root and the skip line names
    `segmentation:root-not-runnable-on-elected-device`; an elected device
    with no object-detection build is `root-refused`.
- Round 4, each refusal path has a spec:
  - `session-dispatch-root-refusal.spec.ts`: no attach, no assignment, the
    error once across three motion edges, cleared (and said) when a session
    opens, forgotten on `stopForDevice`;
  - `session-refusal-camera-status.spec.ts`: through the whole addon,
    `reasons.detection` goes from `armed:on-motion` to
    `pending:root-unrunnable:<node>/default-pool`;
  - `camera-status-cap.spec.ts`: the status composition for that case;
  - `attach-pipeline-reattach.spec.ts`: the readiness re-attach, its deferred
    sweep and the package-zone re-attach each keep the live attach untouched
    and log one error.
- `device-probe-unreachable.spec.ts` (round 4): a never-answered node stays
  `device-health-unavailable` across a failed refresh; a good last-known list
  survives one.
- `scripts/__tests__/parse-cap.spec.ts` (round 4): an output-only `deviceId`
  does not make a method device-bound; an input one does.
- Pre-ship review:
  - `eligibility-one-round-read.spec.ts`: a departed node's `one-round` read
    settles within one round (under 3 s, no `executor reconcile` warn);
  - `session-dispatch-balancer-cache.spec.ts`: the memo asks `await-catalog`
    on a dispatch miss and `one-round` from the refresher;
  - `device-probe-unreachable.spec.ts`: `AgentOffline` forgets the node's
    probe, and a re-place goes `device-health-unavailable` until it is probed
    again;
  - `catalog-cache-fence.spec.ts`: a 60 s-old catalog is served silently; a
    6 min-old one warns once;
  - `attach-pipeline.spec.ts` (M2): the resolve-side cache gate on its own —
    a cold cache answers `catalog-unavailable` and the next call, once the
    background refresh lands, resolves.
- Each gate was disarmed and its test went red, then restored (rounds 3 and
  4; round 4 also disarmed the bootstrap wiring of the status surface and the
  two re-attach refusals, whose specs were new).
