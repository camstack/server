# Realigning the Benchmark addon with the pipeline it measures

> Status: **plan only, 2026-08-18. Nothing here is implemented.** This document
> is the executable follow-up to the analysis recorded in `docs/roadmap.md` <!-- drift-ok: moved to the private planning repo -->
> ("Benchmark addon — analisi fatta, 7 tab + 1 orfana"). Every load-bearing
> claim in that entry was re-verified against the tree on 2026-08-18 and is
> restated here with `file:line`; **two of its claims did not survive** (§1.6).
>
> **Two decisions are deliberately left to the operator** (§3). Phases 0–4 do
> not depend on either answer and can start immediately; phases 5 and 6 are
> blocked on one each.
>
> **Verification method.** Everything below is read off the repository. No live
> hub call was made while writing this. §7 names the three facts that can only
> be read off the cluster, and when they must be read.

---

## 1. What is true today

### 1.1 The page

`packages/addon-benchmark/src/page.tsx:14` declares seven tabs in this order:

| # | Tab id | Label | Component |
| --- | --- | --- | --- |
| 1 | `image` | Detection Pipeline | `packages/addon-benchmark/src/tabs/ImageTab.tsx` |
| 2 | `sustained` | Sustained Throughput | `packages/addon-benchmark/src/tabs/SustainedTab.tsx` | <!-- drift-ok: removed by D646 -->
| 3 | `decoder` | Decoder Performance | `packages/addon-benchmark/src/tabs/DecoderTab.tsx` | <!-- drift-ok: removed by D646 -->
| 4 | `audio` | Audio Analysis | `packages/addon-benchmark/src/tabs/AudioTab.tsx` |
| 5 | `pipeline` | Pipeline Live | `packages/addon-benchmark/src/tabs/PipelineTab.tsx` | <!-- drift-ok: removed by D646 -->
| 6 | `webrtc` | WebRTC / TURN | `packages/addon-benchmark/src/tabs/WebRTCTab.tsx` | <!-- drift-ok: moved to Network → Diagnostics by D752 -->
| 7 | `history` | History | `packages/addon-benchmark/src/tabs/HistoryTab.tsx` | <!-- drift-ok: names benchmark code removed by D792 -->

`packages/addon-benchmark/src/tabs/ModelsTab.tsx` is imported by nothing — <!-- drift-ok: fossil removed in Phase 3, cited here as history -->
`page.tsx` has no import for it, and the only occurrence of the identifier in
the package is its own declaration at `ModelsTab.tsx:85`. It is a model
download/delete manager, which is the surface `@camstack/addon-model-studio`
owns today (`docs/reference/packages.md:49`), so it is a stale duplicate, not a
missing feature.

The page is a Module-Federation remote. `packages/addon-benchmark/vite.config.ts:71`
declares `react`, `react-dom`, `@tanstack/react-query`, `@trpc/client`,
`@trpc/react-query`, `@camstack/ui-library`, `@camstack/sdk` and
`@camstack/types` as `singleton` with **`import: false`** — the remote ships no
fallback copy and consumes the HOST's. `packages/addon-admin-ui/src/layouts/AddonPageLoader.tsx:12`
confirms the host's React, react-query, tRPC and workspace packages are
inherited, and `:213-221` shows the page is rendered inside the admin-ui
provider tree with `system.trpcClient` passed as a prop.

**The consequence that decides cost, and one trap.** Reusing a composite that
`@camstack/ui-library` ALREADY exports costs one `camstack deploy
packages/addon-benchmark`. Adding or changing a ui-library export is a framework
change — and because of `import: false`, a benchmark page importing a NEW
ui-library export type-checks locally and is `undefined` at runtime until a
`@camstack/server` containing that ui-library is installed. Same failure shape
as "your edit is probably not running", in a UI.

### 1.2 The structural mismatch (verified)

The pipeline's unit of work is `(camera → node → deviceKey)`, resolved in two
stages by two owners:

- **Structure** — `packages/addon-pipeline-orchestrator/src/pipeline-resolver.ts:1`:
  *"STRUCTURE ONLY … it attaches NO `modelId` / `settings` — that is a separate
  provisioning stage (`applyDeviceProvisioning`) run at dispatch once the
  balancer has picked the concrete `(node, deviceKey)`."*
- **Model/settings** — per `(node, deviceKey)`:
  `inferenceDevices[node][deviceKey].steps` and the per-camera override
  `stepOverridesByDevice[node][deviceKey]`
  (`packages/types/src/capabilities/pipeline-orchestrator.cap.ts:779`), with
  each probed accelerator carrying its own `format` and `defaultModelId`
  (`packages/types/src/capabilities/pipeline-orchestrator.cap.ts:532`). One
  node can host devices whose formats share nothing.

Tab 1's unit of work is `(step tree + JPEG + node)`. Concretely:

| Fact | Where |
| --- | --- |
| Tab 1's run payload has `nodeId` and an `engine` triple, and **no `deviceKey`** | `packages/addon-benchmark/src/benchmark-schemas.ts:206` (`PipelineRunInputSchema`) | <!-- drift-ok: names benchmark code removed by D792 -->
| …and the addon forwards to `runPipeline` without one | `packages/addon-benchmark/src/benchmark-addon.ts:351` | <!-- drift-ok: names benchmark code removed by D792 -->
| The synthetic bench has `nodeId` + `engine`, and **no `deviceKey`** | `packages/addon-pipeline/src/pipeline-runner/bench-actions.ts:68` |
| Yet the cap accepts `deviceKey` on both `runPipeline` and `runPipelineBatch` | `packages/types/src/capabilities/pipeline-executor.cap.ts:598`, `:653-655` |
| Tab 1 builds its tree from `schema.slots[].addons[].defaultModelId` — one model per step, node-wide | `packages/addon-benchmark/src/tabs/ImageTab.tsx:28` |
| Tab 1 uses the OLD composite | `packages/addon-benchmark/src/tabs/ImageTab.tsx:8` → `packages/ui-library/src/composites/pipeline-builder.tsx` |
| Tab 2 already speaks `(node, deviceKey)`: probes devices, fans ONE target per key | `packages/addon-benchmark/src/tabs/SustainedTab.tsx:208`, `:328-346`; payload shape at `packages/addon-benchmark/src/benchmark-schemas.ts:452` | <!-- drift-ok: removed by D646 -->

So tab 1 has exactly one dropdown (node) where the system has three
coordinates, and it cannot name `edgetpu:usb` vs `openvino:npu` at all — not
because the cap refuses, but because the addon's own schema drops the field.

**The good news for a rebuild:** the per-camera answer is already one call away.
`pipelineOrchestrator.getCameraStatuses` returns, per camera,
`detection: { nodeId, engine: { backend, device }, phase, actualFps, avgInferenceMs }`
(`packages/types/src/capabilities/pipeline-orchestrator.cap.ts:377` and
`:460-468`), and `<backend>:<device>` IS the deviceKey format
(`packages/types/src/capabilities/pipeline-executor.cap.ts:598`). "Why is
102 worse than 101" is answerable from data that already exists.

### 1.3 Three surfaces that lie to the operator

| # | Lie | Verified at | Correct precedent |
| --- | --- | --- | --- |
| L1 | `AddonGlobalSettingsForm mode="override"` with **no `onOverrideChange`** — the form renders the banner *"Benchmark override — applies to this run only. The addon's saved settings are not changed."* (`packages/ui-library/src/composites/addon-global-settings-form.tsx:288`) and the edit is dropped on the floor (`:214-230` only emits through the callback) | `packages/addon-benchmark/src/tabs/ImageTab.tsx:597` (detection-pipeline) and `packages/addon-benchmark/src/tabs/AudioTab.tsx:452` (audio-analyzer) | `packages/addon-benchmark/src/tabs/DecoderTab.tsx:249` passes it AND prints *"Benchmark will use `<x>` for this run"* (`:263-269`) | <!-- drift-ok: removed by D646 -->
| L2 | The audio tab reads step key **`audio-classifier`**; both producers write **`audio-analyzer`** ⇒ the Classifications panel and the inference timing are permanently empty | reads at `packages/addon-benchmark/src/tabs/AudioTab.tsx:440` (`alternateLabels`) and `:441-443` (`stepTimings.source`); writes at `packages/addon-pipeline/src/detection-pipeline/provider.ts:4187` and `:4207` | the LIVE path writes `audio-analyzer` too (`packages/addon-pipeline/src/audio-analyzer/audio-window-accumulator.ts`'s `buildAudioResultFrame` — it moved out of `pipeline-orchestrator` with the relay, D461) and a test pins it (`packages/addon-pipeline/src/audio-analyzer/__tests__/audio-result-event.spec.ts`) |
| L3 | The audio **Upload WAV** button has no payload field in the cap: `runAudioTest` takes `{addonId, modelId, filename?, settings?}` only (`packages/types/src/capabilities/pipeline-executor.cap.ts:792`), and `packages/addon-benchmark/src/tabs/AudioTab.tsx:270` never sends `uploadedBase64` | — | — |

**The direction of the L2 fix is the UI, not the provider.** `audio-analyzer` is
canonical on both the bench path and the live path, and one test already pins
it. `audio-classifier` is a real `StepDefinition.id`
(`packages/addon-pipeline/src/detection-pipeline/registry/step-definitions.ts:289`)
— it is simply not what the audio ANALYZER tags its debug with. That collision
is what makes this bug survive a naive guard (§6, rule 2).

L3 is worse than "does nothing": the upload handler clears `selectedFile`
(`packages/addon-benchmark/src/tabs/AudioTab.tsx:253`), so the provider falls
back to the FIRST reference WAV in the directory
(`packages/addon-pipeline/src/detection-pipeline/provider.ts:4122`). The
operator uploads a file and is shown a confident classification of a different
one.

Two more of the same class, found while verifying:

| # | Lie | Verified at |
| --- | --- | --- |
| L4 | **"Run E2E (live path)"** is not the live path. It sets `simulatePipeline: true` (`packages/addon-benchmark/src/tabs/ImageTab.tsx:494`), which takes the slow branch at `packages/addon-pipeline/src/pipeline-runner/index.ts:1390`: `runPipeline` with **no `plane`** (default `'full'`, i.e. root + crop children in one call) and no `deviceKey`. The live per-frame dispatch is `plane: 'frame'` (`packages/addon-pipeline/src/pipeline-runner/index.ts:3800`, whose comment says outright *"the BENCHMARK caller stays on the default `'full'` plane"*). The button's tooltip claims *"Measures what production cameras actually see"* (`packages/addon-benchmark/src/tabs/ImageTab.tsx:696`) | <!-- drift-ok: names benchmark code removed by D792 -->
| L5 | Tab 1's card is titled **"Benchmark (saves to history)"** (`packages/addon-benchmark/src/tabs/ImageTab.tsx:650`) and nothing in the page ever calls `saveBenchmarkResult`. Consequently `HistoryTab`'s `kind: 'pipeline'` filter (`packages/addon-benchmark/src/tabs/HistoryTab.tsx:37`) is a filter over the empty set | <!-- drift-ok: names benchmark code removed by D792 -->

### 1.4 The capacity ramp: production-shaped, server-side, no UI

`runCapacityRamp` / `getCapacityRampStatus` / `abortCapacityRamp` are declared at
`packages/addon-pipeline/src/pipeline-runner/bench-actions.ts:187` and
implemented from `packages/addon-pipeline/src/pipeline-runner/index.ts:1601`,
with the pacer in `packages/addon-pipeline/src/pipeline-runner/capacity/capacity-runner.ts`
and the wire shapes in `packages/addon-pipeline/src/pipeline-runner/capacity/capacity-schemas.ts`.

- Open-loop, paced, `plane: 'frame'`, raw RGB — *"the production dispatch shape,
  byte for byte"* (`packages/addon-pipeline/src/pipeline-runner/index.ts:1749`).
- Takes `deviceKey` (`packages/addon-pipeline/src/pipeline-runner/capacity/capacity-schemas.ts:63`)
  and an SLO, and returns per ramp step `dropRatio` / `e2eMs` / `inferMs` /
  `predictMs` / stall counters / RSS delta / `pass` + `failReasons`, plus an
  `nMax` verdict (`packages/addon-pipeline/src/pipeline-runner/capacity/capacity-schemas.ts:134`).
- Fire-and-poll, because the UDS addon-call plane has a hard 60 s request
  timeout and custom actions cannot declare a longer one
  (`packages/addon-pipeline/src/pipeline-runner/capacity/capacity-schemas.ts:106`).
- It already emits on the channel tab 1 subscribes to:
  `EventCategory.PipelineProgress` with `benchProgress: true`
  (`packages/addon-pipeline/src/pipeline-runner/index.ts:1921`) — the same
  shape as the synthetic bench's (`:1459-1484`), which
  `packages/addon-benchmark/src/tabs/ImageTab.tsx:262` filters on.
- Guards at the action door: node-locality (`packages/addon-pipeline/src/pipeline-runner/index.ts:1626`),
  quiet-node (`:1638`, with `scripts/capacity/pause-restore.mjs` as the pause
  tool), one ramp at a time (`:1609-1614`).

**It has never run against the fleet** (planning repo: sessions/sessions.md). <!-- drift-ok: moved to the private planning repo -->

**The routing constraint, and it is load-bearing for decision B.**
`addons.custom` carries `{addonId, action, input}` and nothing else
(`packages/types/src/capabilities/addons.cap.ts:246`, `:514`), and
`dispatchCustomAction` resolves against the HUB process's registry
(`server/backend/src/api/core/cap-providers.ts:1457`). The gateway refuses
to proxy the `custom` target to a remote agent —
`server/backend/src/core/addon/addon-call-gateway.ts:157`:
*"routes/custom are hub-local-child surfaces (mounted / invoked on the owning
node); they are not proxied to a remote agent through this gateway."*
(planning repo: sessions/sessions.md) records this as the reason the driver was <!-- drift-ok: moved to the private planning repo -->
built in `pipeline-runner` rather than in `addon-benchmark`, and calls agent
tuples *"unmeasurable until custom actions route cross-node — open gap"*.

Every other bench action dodges this by taking a `nodeId` as DATA and fanning
out over node-routed CAP calls (`runSustainedThroughput` →
`pipelineExecutor.runPipelineBatch`, `packages/addon-benchmark/src/benchmark-addon.ts:704`). <!-- drift-ok: removed by D646 -->
The capacity ramp cannot: a node-local driver is the whole point (D9). So **a
capacity-ramp UI can drive the hub's runner and only the hub's runner**,
wherever the UI is put, until someone adds a routed leg.

### 1.5 Fossils

| Path | State |
| --- | --- |
| `packages/addon-benchmark/src/tabs/ModelsTab.tsx` | never imported; duplicates `@camstack/addon-model-studio` | <!-- drift-ok: fossil removed in Phase 3, cited here as history -->
| `packages/addon-benchmark/src/page-types.ts` | zero importers (no `from './page-types'` anywhere in the tree) | <!-- drift-ok: fossil removed in Phase 3, cited here as history -->
| `packages/addon-benchmark/src/types.ts` | 13 exported interfaces; only `AgentInfo` and `RuntimeOption` are imported — by `packages/addon-benchmark/src/components/AgentSelector.tsx:3` and `packages/addon-benchmark/src/components/RuntimeSelector.tsx:3` | <!-- drift-ok: fossil removed in Phase 3, cited here as history -->
| `packages/addon-benchmark/src/components/AgentSelector.tsx`, `packages/addon-benchmark/src/components/ProgressBar.tsx` | no importer in the package | <!-- drift-ok: fossil removed in Phase 3, cited here as history -->
| `packages/addon-benchmark/src/distributed/benchmark-hub.ts`, `benchmark-agent.ts`, `benchmark-protocol.ts` | nothing imports the directory; recorded as *"wired to nothing"* in (planning repo: sessions/sessions.md) | <!-- drift-ok: fossil removed in Phase 3, cited here as history -->

### 1.6 Two claims from the analysis that did NOT survive re-verification

Both were corrected before this plan was written, and this is where the
correction has to live.

**1. "Three declared-but-uncalled actions" — wrong as a deletion list.**
Three actions have no *UI* caller — `runPipelineBatchTest`,
`runMultiCameraStressTest`, `saveBenchmarkResult`
(`packages/addon-benchmark/src/benchmark-actions.ts:71`, `:82`, `:110`) — but two <!-- drift-ok: names benchmark code removed by D792 -->
of them are called by operator scripts:

- `runPipelineBatchTest` — `scripts/bench-pool-ceiling.mts:84` and <!-- drift-ok: removed by D646 -->
  `scripts/bench-pipeline-investigation.mts:164`, `:189` <!-- drift-ok: removed by D646 -->
- `runMultiCameraStressTest` — `scripts/bench-pool-inprocess.mts:185` <!-- drift-ok: removed by D646 -->

**Deleting them breaks three operator scripts.** Only `saveBenchmarkResult` is
unreferenced outside `packages/addon-benchmark/src/__tests__/benchmark-actions.spec.ts`,
and the right move there is to CALL it (L5), not to delete it.

**2. "The package typechecks and its 40 tests pass" — the tests are not in CI.**
The typecheck is real (`packages/addon-benchmark/package.json:76` declares
`typecheck: tsc --noEmit`). The tests are not run: the package declares **no
`test` script** (`packages/addon-benchmark/package.json:70`), `npm run test`
is `npx nx run-many -t test` (`package.json:41`), and nx derives targets from
package scripts — `packages/nx-plugin/src/plugin.ts` adds only a `deploy`
target, and `nx.json:13` only supplies defaults for a `test` target that
exists. Siblings declare one (`packages/addon-pipeline/package.json:246`,
`packages/addon-pipeline-orchestrator/package.json:80`,
`packages/ui-library/package.json:34`, `packages/addon-admin-ui/package.json:42`);
this package does not. Its four spec files are collected only by a deliberate
root `npx vitest run packages/addon-benchmark`, never by CI
(`.github/workflows/ci.yml:237`).

That second correction reframes the whole plan: **every phase below promises
"this test goes red", and today no test in this package can go red in CI.** That
is why Phase 0 exists and comes first.

### 1.7 One latent trap, worth one line

`listBenchmarkHistory` and `listDecoderFixtures` are declared with `z.void()`
input (`packages/addon-benchmark/src/benchmark-actions.ts:109`, `:130`). <!-- drift-ok: removed by D646 -->
The `addons.custom` envelope insists on `input: {}` and a `z.void()` schema
rejects it, so the action resolves and can never be called — by a settings
button or by `hub.mjs`. The tabs get away with it only because they send
`input: undefined` (`packages/addon-benchmark/src/tabs/HistoryTab.tsx:29`). <!-- drift-ok: names benchmark code removed by D792 -->

---

## 2. What this plan is trying to make true

1. A knob a bench exposes either reaches the run, or it is not shown.
2. A panel is either fed by the value the producer writes, or it is not drawn.
3. A button's label is what the button does.
4. The bench can name the same `(camera, node, deviceKey)` the pipeline does.
5. The only production-shaped measurement the system has (the ramp) is
   reachable without a shell.
6. None of the above can rot silently again (§6).

---

## 3. The two decisions the operator has not made

### Decision A — what is tab 1 *for*?

> **Option A1 (recommended).** Tab 1 becomes the **device-scoped** run: pick
> camera 102 → the page shows the tree that really runs, on the node and
> accelerator it really runs on → run THAT, on THAT device. Tab 2 stays the
> synthetic model bench it already does correctly.
>
> **Option A2.** Tab 1 stays a free-form step-tree lab and merely gains a
> `deviceKey` selector, duplicating tab 2's device model at a second place.

**Recommendation: A1**, for four reasons that are facts, not taste:

- The tab is already called *"Detection Pipeline"*, and the pipeline's unit of
  work is `(camera → node → deviceKey)` (§1.2). Today the tab's answer to "what
  will this camera do" is a tree it invented from `defaultModelId`
  (`packages/addon-benchmark/src/tabs/ImageTab.tsx:28`), which no camera
  necessarily runs.
- The operator's actual question is per-camera ("why is 102 worse than 101") —
  the same question the `tags: { deviceId }` logging rule in `CLAUDE.md` exists
  to answer. No tab answers it today.
- Everything A1 needs already ships: `resolvePipeline` for the structure
  (`packages/types/src/capabilities/pipeline-orchestrator.cap.ts:1036`),
  `getNodeInferenceDevices` for the devices and their per-device base (`:941`),
  `getCameraStatuses` for the LIVE `(node, backend, device)` (`:377-389`,
  `:460-468`), and `getPipelineAssignment` / `getPipelineDevicePin` for the pins
  (`:688-691`, `:669-672`). Plus the ui-library composites the admin UI already
  uses for exactly this shape — `DeviceStepMatrix`, `AgentStepEditor`,
  `buildStepTreeFromSchema`, `resolveEffectiveStepModel`, `ModelPicker` — all of
  which are **props-driven with no internal data fetching**
  (`packages/ui-library/src/composites/agent-step-editor.tsx:268`, <!-- drift-ok: superseded by the step inspector (D756) -->
  `packages/ui-library/src/composites/device-step-matrix.tsx:69`,
  `packages/ui-library/src/composites/step-tree-master.tsx:114`), so the page can <!-- drift-ok: superseded by the step inspector (D756) -->
  feed them from the `trpc` client it already receives as a prop. One addon
  deploy.
- A2 puts a second per-device model resolution in a second place, which is
  precisely the failure `scripts/check-step-model-single-owner.ts` was written
  for (its header records two pages disagreeing about one camera's model on one
  accelerator at one moment).

**What A1 costs, stated so it is not discovered later:** the free-form
"arbitrary tree on an arbitrary image" run loses its top billing. It should not
be deleted — it is how a new step gets tried before any camera has it — so it
survives as a "Custom tree" mode inside tab 1, or folded into tab 2. Say which;
do not let it evaporate.

### Decision B — where does the capacity-ramp UI live?

> **Option B1.** A new Benchmark tab ("Capacity"). Cost: one
> `camstack deploy packages/addon-benchmark`. No framework train.
>
> **Option B2.** In admin-ui under `Pipeline → node`, beside
> `NodeDeviceStepsMatrix`
> (`packages/addon-admin-ui/src/components/pipeline/tabs/NodePipelineTab.tsx`,
> `packages/addon-admin-ui/src/components/pipeline/tabs/NodeDeviceStepsMatrix.tsx`), <!-- drift-ok: superseded by the step inspector (D756) -->
> where the `(node, deviceKey)` tuple already lives. Cost: an admin-ui change
> ships inside the `@camstack/server` closure — a framework train / image
> rebuild.

**Recommendation: B1 first, B2 later or never**, with one caveat stated up
front so the choice is not made on a false premise:

- The ramp is a **measurement**, not a configuration. `Pipeline → node` is where
  an operator changes what runs; a tens-of-minutes ramp that requires every
  local camera to be paused does not belong beside the controls that set them
  up.
- The ramp's prerequisites are a bench's prerequisites: a pinned frame
  (`cacheBenchFrame`), a quiet node, a step tree. The Benchmark page already
  owns all three, including the `pipeline.progress` / `benchProgress`
  subscription the ramp emits on (§1.4) — B1 reuses an existing wire, B2
  rebuilds it.
- Cost asymmetry is one addon deploy versus a framework train, and this feature
  will need several iterations before its result table is right.
- **The caveat that applies to BOTH options:** neither placement can run a ramp
  on an agent, because `addons.custom` does not route (§1.4). B2's placement
  under a specific node would *imply* per-node capability that does not exist —
  which makes B2 not merely more expensive but more misleading, unless the
  routed leg (P6.2) is built first. Whichever is chosen, the UI must state the
  node it is measuring and refuse — never silently retarget — any other.

---

## 4. Phases

Ordered by value ÷ effort. Each phase is independently shippable and revertible.
"Ship" means what has to happen for the change to be RUNNING, not merely merged.

### Phase 0 — make a red test possible (prerequisite)

Nothing else in this plan means anything until the package's tests run (§1.6).

| Item | Files | Codegen | Ship |
| --- | --- | --- | --- |
| P0.1 | add `"test": "vitest run"` to `packages/addon-benchmark/package.json` | no | CI only — no deploy |
| P0.2 | add a package vitest config so `vitest` does NOT pick up the federation build config — new `packages/addon-benchmark/vitest.config.ts` <!-- drift-ok: planned file, does not exist yet --> | no | CI only |

P0.2 is not optional: `vitest run` inside the package would otherwise load
`packages/addon-benchmark/vite.config.ts`, which is a Module-Federation *lib*
build with the `federation()` plugin, a `remoteEntry` filename and
`base: '/api/addon-pages/benchmark/'`. The precedent to copy is
`packages/addon-admin-ui/vitest.config.ts` — a package that deliberately keeps a
`vite.config.ts` and a separate `vitest.config.ts` side by side.

**Verification.** `npm run test` names `@camstack/addon-benchmark` in its
project list and reports the package's specs.

**Mutation that must turn it red.** Break one assertion in
`packages/addon-benchmark/src/__tests__/throughput-stats.spec.ts`; `npm run test` <!-- drift-ok: removed by D646 -->
— not a hand-typed vitest invocation — must fail. If it stays green, the target
is still not wired and the rest of this plan is unverifiable.

⚠️ Expect this phase to find something. Four spec files that CI has never run
may not pass on a clean machine. Fix them here; do not proceed on a red
baseline, and do not "fix" them by narrowing the config until they are skipped.

### Phase 1 — delete the lies (cleanup; highest value ÷ effort)

All five items are addon-local. **No codegen. One
`camstack deploy packages/addon-benchmark`.**

| Item | Change | Files |
| --- | --- | --- |
| P1.1 (L1) | Wire `onOverrideChange` and feed the patch into the run payload, following `packages/addon-benchmark/src/tabs/DecoderTab.tsx:249` verbatim — including the "will use X for this run" line. Where an override has **no channel to the run**, delete the form instead of wiring it (see below) | `ImageTab.tsx:597`, `AudioTab.tsx:452` | <!-- drift-ok: removed by D646 -->
| P1.2 (L2) | Read `audio-analyzer`, the key both producers write | `AudioTab.tsx:440`, `:441-443`, plus the stale comments at `:435` and `:571` |
| P1.3 (L3) | Disable the WAV upload with an explicit "reference files only" note. Do NOT leave a control that classifies a different file | `AudioTab.tsx:463` |
| P1.4 (L4) | Rename the button to what it is — "Full tree (root + children, one call)" — and fix the tooltip. The genuinely live-shaped run arrives in Phase 4 | `ImageTab.tsx:692` |
| P1.5 (L5) | Call `saveBenchmarkResult` when a synthetic bench completes, so the History tab's `pipeline` half stops being a filter over the empty set | `ImageTab.tsx:519`, `HistoryTab.tsx:37` |

**On P1.1's "delete instead of wire" — check each side before writing code.**
`ImageTab`'s detection-pipeline override has a real channel: `runPipelineTest`
already carries a per-run `engine` triple
(`packages/addon-benchmark/src/benchmark-schemas.ts:219`), and Phase 4 adds <!-- drift-ok: names benchmark code removed by D792 -->
`deviceKey` / `plane`; a settings patch beyond those has no field, so wire what
has a field and drop the rest of the form. `AudioTab`'s audio-analyzer override
has **no** channel: `runAudioTest` accepts only per-step `settings`
(`packages/types/src/capabilities/pipeline-executor.cap.ts:792`), which the
tab already sends separately. Wiring it would require a cap change; the honest
Phase-1 move is to delete that form and keep the Classifier Settings panel,
which is real.

**Verification.** Extract the payload construction into pure helpers
(`buildPipelineRunInput`, `buildAudioRunInput`, `selectAudioDebug`) and test
those; the tabs stay thin.

| Item | Test | Mutation that must turn it red |
| --- | --- | --- |
| P1.1 | `buildPipelineRunInput({override:{…}})` carries the override into the payload | drop the override spread ⇒ red |
| P1.2 | `selectAudioDebug(fixture)` returns the labels and the ms, where the fixture is the shape written at `provider.ts:4183` | flip the key back to `audio-classifier` ⇒ red |
| P1.3 | `buildAudioRunInput` never produces a payload with an uploaded blob and no filename | re-enable the upload path ⇒ red |
| P1.5 | a fake action dispatcher records a `saveBenchmarkResult` call after a completed bench | remove the save ⇒ red |

⚠️ **P1.2's unit test is not sufficient on its own and must not be sold as
such.** A hand-written fixture keyed `audio-classifier` would have made a green
test for the broken code — that is exactly how this bug survived. The fixture
must be copied from the producer, and the real protection is Phase 2, rule 3.
Land the two together.

### Phase 2 — the guard (cleanup → prevention)

Full specification in §6.

| Item | Files | Codegen | Ship |
| --- | --- | --- | --- |
| P2.1 | new `scripts/check-bench-step-keys.ts` <!-- drift-ok: proposed guard, does not exist yet --> + the guard loop in `.github/workflows/ci.yml:114` | no | CI only |
| P2.2 | add `packages/addon-benchmark/src` to `SCAN_ROOTS` in `scripts/check-step-model-single-owner.ts:66` | no | CI only |

P2.2 is safe today — verified: no file under `packages/addon-benchmark/src`
matches either restated rule. Do it BEFORE Phase 5, so a rebuilt tab 1 cannot
fork the model rules.

**Mutations that must turn it red, all three:** (a) delete `onOverrideChange`
from `DecoderTab.tsx:258` ⇒ rule 1 fires; (b) restore `audio-classifier` in
`AudioTab.tsx:440` ⇒ rule 3 fires; (c) type a nonexistent step key into any
scanned UI file ⇒ rule 2 fires. Additionally run the finished guard against the
PRE-fix commit: both shipped bugs must be reported, and that output belongs in
the PR.

### Phase 3 — remove the fossils (cleanup)

**No codegen. One `camstack deploy packages/addon-benchmark`.**

| Item | Action | Note |
| --- | --- | --- |
| P3.1 | delete `tabs/ModelsTab.tsx` | duplicate of `@camstack/addon-model-studio` |
| P3.2 | delete `page-types.ts` | zero importers |
| P3.3 | delete the 11 unused interfaces in `types.ts` | keep `RuntimeOption`; keep `AgentInfo` only if P3.4 keeps `AgentSelector` |
| P3.4 | delete `components/AgentSelector.tsx` and `components/ProgressBar.tsx` | no importer |
| P3.5 | delete `src/distributed/` (3 files) | wired to nothing; if cross-node custom actions are ever built they go through the gateway, not this |
| P3.6 | **do NOT delete** `runPipelineBatchTest` / `runMultiCameraStressTest` | three operator scripts call them (§1.6). Instead add a one-line comment on each naming its script caller, so the next reader does not repeat this analysis |
| P3.7 | change `z.void()` → `z.object({})` on `listBenchmarkHistory` and `listDecoderFixtures`, and send `input: {}` from the tabs | §1.7; makes them callable from a button and from `hub.mjs` |

**Mutation.** None applies to a deletion. The test is the build plus a manual
pass over every tab after the deploy — say that in the PR rather than inventing
a spec that proves nothing.

### Phase 4 — teach the bench to name a device (unblocks both decisions)

The smallest change that removes the *mechanical* half of the structural
mismatch. Worth doing whichever way Decision A goes.

| Item | Change | Files | Codegen | Ship |
| --- | --- | --- | --- | --- |
| P4.1 | add `deviceKey?: string` and `plane?: 'full' \| 'frame'` to `PipelineRunInputSchema`; forward both to `pipelineExecutor.runPipeline` | `benchmark-schemas.ts:206`, `benchmark-addon.ts:351` | **no** | `camstack deploy packages/addon-benchmark` |
| P4.2 | add `deviceKey?` and `plane?` to `RunSyntheticBenchInputSchema`; forward on the slow path and on the cached fast path | `bench-actions.ts:68`, `pipeline-runner/index.ts:1398` and `:1222` | **no** | `camstack deploy packages/addon-pipeline` **on every node that must serve it** |
| P4.3 | make "live path" true: a run with `plane: 'frame'` + `deviceKey`, labelled as the root-plane dispatch it is; keep the full-tree run as a separate, differently-named button | `ImageTab.tsx:692` | no | benchmark deploy |

Neither schema is a `*.cap.ts` — both are `defineCustomActions` catalogs, and
`scripts/codegen.ts` reads only `*.cap.ts`. **No codegen, no framework train.**
The cap already accepts both fields
(`packages/types/src/capabilities/pipeline-executor.cap.ts:590`).

⚠️ P4.2 is an `addon-pipeline` deploy, which is heavier than a benchmark deploy:
it must reach each node whose devices the operator wants to bench, and the
runner respawns. A successful `camstack deploy` is not evidence that a new
action shape landed — verify it.

**Mutation.** Remove the `deviceKey` spread ⇒ the forwarding spec goes red. The
spec must assert on the object the fake RECEIVED, not on the input it was
handed — otherwise deleting the schema field alone would leave it green.

### Phase 5 — tab 1 becomes device-scoped ⛔ BLOCKED on Decision A

Only under **A1**. Depends on Phase 4 — without `deviceKey` it has nothing to
run.

1. **Camera picker** — `getCameraStatuses` plus `deviceManager.listAll` for
   names; that pairing already exists at
   `packages/addon-admin-ui/src/components/pipeline/cameras/use-cameras-overview.ts:1`.
2. **Resolved context strip**, read-only: the live `detection.nodeId` and
   `engine.backend` / `engine.device`, the pins, and the camera's live `phase` /
   `actualFps` / `avgInferenceMs`. This alone answers "102 vs 101" before any
   run happens.
3. **The tree that really runs** — `resolvePipeline({ deviceId, agentNodeId })`,
   rendered with `buildStepTreeFromSchema` + `DeviceStepMatrix`, model resolved
   through `resolveEffectiveStepModel` — the single owner. Never re-derive a
   model here; P2.2 makes that a build failure.
4. **Run** on the resolved `(node, deviceKey)` via P4.1 / P4.3.
5. The free-form tree survives as a secondary mode (Decision A's stated cost).

⚠️ Before writing a line: confirm each composite you plan to import is present
in the *shipped* `@camstack/ui-library` the hub serves, not only in the tree.
`import: false` turns a wrong guess into an `undefined` component at runtime,
not a build error.

**Mutation.** Make `deviceKeyOf` return the node id ⇒ red. Drop the resolved
tree and fall back to `buildDefaultSteps` ⇒ the payload spec red.

### Phase 6 — capacity-ramp UI — P6.1 LANDED 2026-08-19 (B1)

Under **B1** (recommended): a `Capacity` tab.

> **P6.1 is implemented.** `packages/addon-benchmark/src/tabs/CapacityTab.tsx` <!-- drift-ok: names benchmark code removed by D792 -->
> with the pure half in `packages/addon-benchmark/src/capacity-payloads.ts` <!-- drift-ok: names benchmark code removed by D792 -->
> (spec: `packages/addon-benchmark/src/__tests__/capacity-payloads.spec.ts`) and <!-- drift-ok: names benchmark code removed by D792 -->
> the SVG curve in `packages/addon-benchmark/src/components/CapacityCurveChart.tsx`. <!-- drift-ok: names benchmark code removed by D792 -->
> One contract gap was closed to make it recoverable: `getCapacityRampStatus`
> throws without a sessionId, so a page reopened during a tens-of-minutes ramp
> could neither watch nor abort it. `listCapacityRamps`
> (`packages/addon-pipeline/src/pipeline-runner/capacity/capacity-schemas.ts`)
> returns `{nodeId, maxHistory, quiet, busyCameras, runs[]}` — adoption, the node
> assertion and the quiet-node preflight in one read. That makes P6.1 an
> `addon-pipeline` deploy on the hub as well as a benchmark deploy. P6.2 is
> unchanged and still not built: no agent can be ramped.

| Item | Files | Codegen | Ship |
| --- | --- | --- | --- |
| P6.1 | `packages/addon-benchmark/src/tabs/CapacityTab.tsx` + a tab entry in `packages/addon-benchmark/src/page.tsx` | no | `camstack deploy packages/addon-benchmark` **and** `camstack deploy packages/addon-pipeline` on the hub | <!-- drift-ok: names benchmark code removed by D792 -->
| P6.2 | (optional, later) node-routed custom actions so an agent can be ramped | `addon-call-gateway.ts:157`, `cap-providers.ts:1457`, `addons.cap.ts:246` | **yes** | framework train + image rebuild |

The tab, minimally: a preflight stating node = hub and only hub until P6.2, the
quiet-node requirement naming `scripts/capacity/pause-restore.mjs`, and the
pinned frame; `cacheBenchFrame` → `runCapacityRamp` → poll
`getCapacityRampStatus` → `abortCapacityRamp`, with the per-step `benchProgress`
line driving the live status; a result table of `cameras`, `dropRatio`,
`e2eMs.p95`, `inferMs.p95`, `stallCount`, RSS delta, `pass` / `failReasons`; and
the verdict — `nMax`, `failedStep`, `engineLabel`, plus the two flags that
invalidate a reading if ignored, `contaminatedByActiveCameras` and
`shedSignal !== 'first-class'`.

⚠️ Nothing about the ramp has ever run on this cluster. Budget the first session
for the ramp being wrong, not the UI: run it once by hand (fire, poll, abort)
before building a surface on top of it.

---

## 5. Ship matrix

| Phase | Kind | Codegen | How it goes live |
| --- | --- | --- | --- |
| 0 | prerequisite | no | merge (CI only) |
| 1 | cleanup — delete a lie | no | `camstack deploy packages/addon-benchmark` |
| 2 | prevention | no | merge (CI only) |
| 3 | cleanup — fossils | no | `camstack deploy packages/addon-benchmark` |
| 4.1 / 4.3 | new capability | no | `camstack deploy packages/addon-benchmark` |
| 4.2 | new capability | no | `camstack deploy packages/addon-pipeline` **per node** |
| 5 | blocked on A | no | benchmark deploy (a NEW ui-library export would make it a framework train) |
| 6.1 | blocked on B | no | benchmark deploy |
| 6.2 | optional | **yes** | framework train + image rebuild |

---

## 6. The guard: `scripts/check-bench-step-keys.ts` <!-- drift-ok: proposed guard, does not exist yet -->

Modelled on `scripts/check-step-model-single-owner.ts` — same file walk, same
`Problem[]` reporting, same discipline: syntax that is present or absent, never
a judgement call, because a guard with false positives gets deleted.

**Scan roots:** `packages/addon-benchmark/src`, `packages/ui-library/src`,
`packages/addon-admin-ui/src`. Tests excluded — they restate rules in order to
assert on them.

### Rule 1 — an override form must be wired

Any JSX element `<AddonGlobalSettingsForm …>` whose attributes include
`mode="override"` must also include an `onOverrideChange` attribute within the
same element. Rationale, in the guard's header: the form prints *"applies to
this run only"* and drops every edit otherwise, and those are exactly the knobs
a bench exists to sweep.

Implementation note: match the element span across lines. A per-line regex
cannot see this, and a guard that silently matches nothing is worse than no
guard.

### Rule 2 — a step key a UI reads must be one something can write

Collect the **produced** set: every literal `id: '<kebab>'` in
`step-definitions.ts`, plus every literal written at a debug site (a `source:`
property inside a `stepTimings` array literal, and every literal key of an
`alternateLabels` object literal) anywhere under `packages/*/src`. Collect the
**consumed** set: every string literal compared against `.source`, or used to
index `alternateLabels[...]`, in a scanned UI file. Fail on consumed minus
produced.

This catches a typo and a renamed step. **Stated plainly: it does not catch
today's audio bug**, because `audio-classifier` IS a real `StepDefinition.id` —
it is simply not what the audio ANALYZER writes. Rule 2 is worth having and is
not the reason this guard exists; rule 3 is.

### Rule 3 — the audio debug source has one owner

The audio result's debug key is written in exactly two places, both as literals:
`provider.ts:4187` / `:4207` (bench path) and `audio-window-accumulator.ts:155`
(live path). The guard reads the literal from those path-anchored sites,
requires them to AGREE (a divergence is its own failure), and then requires: in
any scanned UI file that also references `AudioResult` or `runAudioTest`, every
literal used as an `alternateLabels` index or compared to `.source` must equal
that value.

Path-anchoring is deliberate. If either writer moves, the guard fails loudly
instead of quietly checking nothing — the failure mode that lets a guard rot
into decoration.

**A cleaner end state, when a framework train is due anyway.** Export the key as
a named constant from `@camstack/types` beside `AudioResult`, have both writers
and the UI import it, and reduce rule 3 to "no bare literal here" — the class
becomes unrepresentable rather than merely detected. Because of `import: false`
(§1.1) the benchmark page cannot use a new `@camstack/types` export until a
`@camstack/server` carrying it is installed. Do not block Phase 1 on it.

### Wiring

Append to the guard loop in `.github/workflows/ci.yml:114`. Do not add a
separate step: the loop exists so one failing guard does not hide the rest, and
`docs/reference/guards.md` is generated by searching that file for guard
filenames — a guard outside the loop is a guard the docs will call unenforced.

---

## 7. What must be read off the cluster, and when

Repo facts are settled. These three are not, and each gates a phase:

1. **Before Phase 4.2** — which nodes actually need the new `addon-pipeline`
   build, and which process the benchmark addon runs in
   (`node scripts/hub/hub.mjs GET addons.list '{}'`). The addon is
   `placement: any-node`, group `ml`
   (`packages/addon-benchmark/package.json:40`), so this is not derivable
   from the manifest.
2. **Before Phase 5** — the live device roster per node
   (`pipelineOrchestrator.getNodeInferenceDevices`), to confirm the tab's device
   column matches reality.
3. **Before Phase 6** — one manual ramp: `cacheBenchFrame` → `runCapacityRamp`
   → `getCapacityRampStatus` → `abortCapacityRamp`, on a paused hub. It has
   never run, and a UI built on an unrun measurement means debugging two things
   at once.

---

## 8. Deliberately not in scope

- **Tabs 3, 5, 6 and 7 are not redesigned.** `DecoderTab` is the correct
  precedent, not a defect. `PipelineTab` is already device-scoped. `WebRTCTab`
  and `HistoryTab` drift only in the ways Phase 1 and Phase 3 fix.
- **`runAudioTest` gaining an audio payload field** — a `*.cap.ts` change,
  therefore codegen plus a framework train plus an `addon-pipeline` deploy, for
  a control that has never worked. Fold it into a train that is happening
  anyway; until then P1.3 stands.
- **Cross-node custom actions (P6.2).** Named and costed, not recommended now.
- **Merging tabs 1 and 2.** Under A1 they answer different questions ("what does
  THIS camera do" versus "which model/device is fastest"). Merging them is a
  third decision, and nobody has asked for it.
