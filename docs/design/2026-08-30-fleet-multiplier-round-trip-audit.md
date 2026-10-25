---
title: Fleet multiplier × per-operation cost — the round-trip audit the load analysis could not see
date: 2026-08-30
status: investigation
covers:
  - packages/system/src/builtins/device-manager/device-queries.ts
  - packages/system/src/kernel/moleculer/cap-usage-registry.ts
  - packages/system/src/kernel/moleculer/trpc-links.ts
  - packages/system/src/kernel/moleculer/addon-context-factory.ts
  - packages/system/src/kernel/settings-door-view.ts
  - packages/system/src/builtins/liveness-monitor/liveness-monitor.addon.ts
  - packages/addon-osd-manager/src/osd-manager.ts
  - packages/addon-pipeline-orchestrator/src/node-lifecycle-handler.ts
  - packages/types/src/device/system-mirror.ts
---

# Fleet multiplier × per-operation cost

**Investigation. Nothing here is fixed, and nothing here should be fixed from this
document alone** — each entry names a call site and a multiplier; the repair
belongs to whoever owns the file.

## Why this pass exists, and what it measures

The 2026-08-19 load analysis (D181) measured **consumption**: heap, GC, CPU share,
event-bus fan-out. It found a real defect and it missed
`deviceManager.getAllBindings` entirely, because that defect consumes nothing —
the process *waits*. Its cost is

> **fleet multiplier × per-operation latency**, paid once per UI boot.

That moves no average, appears in no resource graph, and shows up only as a user
saying the page will not load. `getAllBindings` was measured at **740 s** against
`SystemMirror.init`'s 15 s budget; the cause was **1 + 1019 sequential settings-door
round trips** for a persisted blob of **775 bytes holding six devices**.

This document is the sweep for every other instance of that shape.

### The deployment, measured

One `deviceManager.listAll({projection:'slim'})` against the live hub today
(**5.77 s**, 603 331 bytes — measured):

| | count |
| --- | --- |
| devices | **1 019** |
| of which cameras | **30** |
| parents that have children | **116** |
| **children** (`parentDeviceId != null`) | **896** |
| children owned by a **forked** provider addon | **896 — all of them** |
| types | 432 sensor, 180 switch, 95 container, 95 control, 49 button, 31 update, 30 camera, 27 event-emitter, 13 siren, 13 cover, … |

Children by owner: `provider-homeassistant` 606, `provider-dreame` 191,
`provider-ecowitt` 28, `provider-gree` 25, `provider-reolink` 18,
`provider-homematic` 15, `provider-hikvision` 13. **Not one is hub-in-process** —
which decides the multiplier in finding #1.

Nodes: 4. Addons: ~70. Capabilities: ~150.

### The cost model used for ranking

| operation | cost | how known |
| --- | --- | --- |
| a **settings-door read** (`ctx.settings.*`, `door.query/get/set`) | ~2.9 s today, mid-drain; normally ~5–50 ms | measured by the coordinator today; `settingsStore.get` = 2.9 s |
| `deviceManager.getBindings` for ONE device | 2.5–5.2 s today | measured (was two sequential door reads; now one round trip of latency) |
| a cross-node `broker.call` | network + remote work, 5 s timeout ceiling | code |
| an in-memory `Map`/array/registry lookup | free | code |

**Rank by shape, not by today's wall clock.** The 101 838-file drain has the
settings door at 10–20× its normal price; the number that survives the drain is
*how many round trips*, so that is what the table sorts on.

---

## 1 · The instrument we already built is blind, and I found why

`nodes.getCapUsageGraph {windowSeconds: 300}` returns `[]` on the live hub —
**re-measured independently today: `[]`, in 0.21 s**, which is an in-memory read
of an empty map, not a timeout. A hub with 1 019 devices and a running drain does
not make zero inter-addon cap calls.

There are **four independent reasons**, and *any one of them alone* produces an
empty graph. All four are true at once.

### 1a · The reader and every writer are in different processes

`getCapUsageRegistry()` is a **module-level per-process singleton**
(`packages/system/src/kernel/moleculer/cap-usage-registry.ts:118` —
`let singleton: CapUsageRegistry | null = null`).

- The only writer is `packages/system/src/kernel/moleculer/addon-context-factory.ts:418`
  (`observer: (obs) => usageRegistry.recordCall(obs)`), and that factory runs only
  inside a **forked addon-runner** (`addon-runner.ts` → `createUdsAddonContext`) or
  an **agent** (`server/backend/src/agent/main.ts`).
- The only reader is `server/backend/src/api/core/cap-providers.ts:775`
  (`const reg = getCapUsageRegistry()`), in **hub-main**.

Hub-main's instance is never written. Every runner's instance is never read, and
nothing ships it anywhere. There is no aggregation path in the tree —
`getCapUsageRegistry` appears in exactly two production files, those two.

### 1b · Hub-main's own `ctx.api` has no observer at all

Every hub-in-process builtin (device-manager, storage-orchestrator, alerts,
doorbell, liveness-monitor, snapshot, the aggregators …) gets its `ctx.api` from
`AddonRegistryService.getBrokerApi()`:

```
server/backend/src/core/addon/addon-registry.service.ts:393
  links: [localProviderLink(resolver), brokerTransportLink(this.moleculer.broker)],
```

Neither link is given `observerOpts`. So even if 1a were fixed, hub-main's own
traffic would still be invisible.

**And this one cannot be repaired by passing the options in.** `brokerApi` is a
*single* lazily-built client cached in `this.brokerApi` and shared by every addon
(and by the REPL's `SystemManager`). `CapUsageObserverOptions.callerAddonId` is a
constant baked into the chain — there is no per-caller identity to record on a
shared client. Observing here means one client per addon, or threading the caller
through the op context.

### 1c · Even inside a runner, only *co-located* calls are recorded

In `uds` mode the chain is
`[localProviderLink(workerResolver, observerOpts), ipcParentLink(…)]`
(`addon-context-factory.ts:432`). Two consequences:

- `localProviderLink` records at `trpc-links.ts:225`, which is reached **only on
  the branch where it resolves a co-located provider**. Every `return next(op)`
  path — i.e. every call that leaves the process — is silent.
- `ipcParentLink` (`trpc-links.ts:821`) **takes no observer parameter at all**.

So a forked addon's `ctx.api.deviceManager.listAll.query()` — the traffic this
audit is about — is not recorded even in its own process. Only `broker` mode gets
a terminating observer (`addon-context-factory.ts:438`), and forked runners no
longer run a broker.

### 1d · The callee side records nothing

A call arriving at hub-main over UDS lands in `LocalChildRegistry` →
`onUnownedCall` → `CapRouteResolver.dispatch`. Nothing there records. So the hub
cannot count what is done *to* it either.

### Why the earlier fix did not help

`UNRESOLVED_PROVIDER_ADDON_ID` (`trpc-links.ts:112-133`) was introduced precisely
because this graph came back empty, and it fixed the *provider-name* half — in a
process nobody reads. The docblock's own account ("returned an EMPTY ARRAY on the
live hub while the engine logged 39 717 calls a minute") is still the current
state.

### The repair that is small, and where it goes (NOT implemented)

The cheapest honest repair is **1d, not 1a**: record on the **callee** side, in
hub-main, where the cluster's traffic converges — and where the caller identity
already exists as trustworthy data:

- `packages/system/src/kernel/transport/local-child-registry.ts:742` stamps
  `callerAddonId: childId` off the UDS connection the frame arrived on — *"rather
  than trusting anything the child claims in its args"*
  (`child-cap-protocol.ts:160-172`).
- `packages/system/src/kernel/transport/parent-unowned-call.ts:425` already
  forwards it into `resolver.dispatch(...)`.

One `recordCall` at that junction puts every cross-process cap call — including
**every forked addon's `ctx.settings.*`, which is `ctx.api.settingsStore.*`**
(`addon-context-factory.ts:496-511`) — into the same registry
`nodes.getCapUsageGraph` already reads. That is the expensive traffic, with a real
caller, in one place.

It does **not** cover hub-main→hub-main in-process calls (1b), which need the
per-addon client. I would take 1d first and leave 1b as a known, stated gap
rather than pretend the graph is complete.

---

## 2 · Ranked candidates

Sorted by (round trips × how often × how user-visible). "door read" = one
settings-store round trip.

| # | call site | iterates | ×  | per-iteration cost | seq? | when | user-facing |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `packages/system/src/builtins/device-manager/device-queries.ts:419` | non-live child rows | **896** | `await pctx.settings.readDeviceStore(m.id)` — 1 door read | seq | boot accessory reconcile (`getChildrenBatch`), every `getChildren` | **yes** — device page, HAP/Alexa export |
| 2 | `packages/addon-osd-manager/src/osd-manager.ts:429` | the **whole fleet** | **1 019** | `getBindings.query({deviceId})` — 1 cross-process cap call each | seq | per request | **yes** — opening an OSD slot editor |
| 3 | `packages/addon-pipeline/src/detection-pipeline/provider.ts:4531` | the **whole fleet** | **1 019** | `clearDeviceStore(id)` — 1 door **write** each | seq | per request | **yes** — "reset node pipeline defaults" |
| 4 | `packages/system/src/builtins/doorbell/virtual-doorbell.addon.ts:366` (via `:554`) | configured cameras | ≤30 | `addonSettingsRaw.getGlobal({addonId:'device-manager'})` — the **whole fleet's** bindings record, re-read per camera | seq | ring path, ≤1 per 60 s | **yes** — doorbell latency | <!-- drift-ok: deleted in slice 6 (D671), task 17 -->
| 5 | `packages/system/src/builtins/liveness-monitor/liveness-monitor.addon.ts:133` | cameras | **30** (60 calls) | `recording.getAvailability` ×1–2 | seq | periodic, 5 min | indirect |
| 6 | `packages/addon-pipeline-orchestrator/src/node-lifecycle-handler.ts:205`+`:206` | cameras on the dead node | ≤30 (60 reads) | 2 × full `readAddonStore()`, **identical every iteration** | seq | node failover | **yes** — failover time |
| 7 | `packages/addon-pipeline-orchestrator/src/node-lifecycle-handler.ts:420` and `:487` | cameras | ≤30 | `resolvePipelineForDevice` ≈3–4 door reads, two of them fleet-wide blobs | seq | runner readiness, ×4 nodes; `:487` again 3 s later | indirect |
| 8 | `packages/system/src/builtins/doorbell/virtual-doorbell.addon.ts:541` | cameras | **30** | `readDeviceStore(camera.id)` — 1 door read | seq | same as #4 | **yes** | <!-- drift-ok: deleted in slice 6 (D671), task 17 -->
| 9 | `server/backend/src/core/agent/agent-registry.service.ts:929` + `:941` | remote nodes | **3** (6 RPCs) | `broker.call` @ 5 s timeout ×2 per node → up to 30 s | seq | per request **and** 30 s topology heartbeat | **yes** — Cluster page (15 `useNodesTopology` observers) |
| 10 | `packages/addon-provider-homeassistant/src/ha-export/ha-export.addon.ts:995` | exposed devices | 30…1 019 | ≈6–9 door/cap reads each | seq | periodic 300 s + boot + expose | **yes** |
| 11 | `packages/system/src/kernel/settings-door-view.ts:67` | **keys of the whole addon store** | store size | `door.set` per key, after a `deleteWhere` | seq | **every** `writeAddonStore` / `writeDeviceStore` | **yes** — any settings save |
| 12 | `packages/addon-export-alexa/src/sync-engine.ts:145` | exposed devices | operator set | `pushDevice` = `getDevice`+`getBindings`+`getChildren`+per-child `getBindings`+`ptz.getPresets`+HTTPS POST | seq | "Re-sync devices" button | **yes** |
| 13 | `packages/addon-provider-unifi/src/devices/unifi-controller-device.ts:264` (+`:395`) | one controller's children | tens | `ctx.devices.loadConfig(child.id)` — uncached, via device-manager | seq | **every poll tick**, twice | indirect |
| 14 | `packages/system/src/builtins/alerts/alerts.addon.ts:731` (+`:714`) | expired alert ids | ≤500 | `backend.delete.mutate` per id, **after two unbounded full-table reads** | seq | **per alert emitted** | **yes** — alert center |
| 15 | `server/backend/src/api/core/auth.router.ts:402` | login-method providers | few | `provider.getLoginMethods()` cross-process, **no cache, no timeout** | seq | every hit of the **public** login page | **yes** — login screen |
| 16 | `packages/system/src/builtins/addon-widgets-aggregator/addon-widgets-aggregator.addon.ts:289` | files in each widget bundle dir | widgets × 30–100 files | **`fs.statSync` ×2 per file + `readdirSync`** — synchronous, blocks hub-main | n/a | per request, admin UI boot | **yes** |
| 17 | `server/backend/src/api/core/cap-providers.ts:1767` | installed packages | ~70 | `setAddonAutoUpdate` → a full config rewrite each | seq | per request | **yes** — "apply channel to all" |
| 18 | `packages/system/src/kernel/config-manager.ts:507` | keys in the patch | K | `door.set` per key | seq | per request | **yes** — global settings save |
| 19 | `server/backend/src/core/addon/addon-package.service.ts:1648` | installed packages | ~70 | public npm registry HTTPS round trip | seq | periodic auto-update | indirect |
| 20 | `server/backend/src/api/core/logging-settings.ts:182` (`:198`), `load-contributions.ts:53`, `failure-contributions.ts:54` | `log-channel` / load / failure providers | subset of ~70 | cross-process `provider.list()` | seq | per request — system page | **yes** |

Everything above #10 is worth an owner. Below #16 the multipliers are small
enough that the fix is a tidy-up, not a defect.

---

## 3 · The findings that matter, in detail

### #1 — `projectChildren` is the same defect as `getAllBindings`, one file over

```
packages/system/src/builtins/device-manager/device-queries.ts:419
  const persistedConfig = (await pctx.settings.readDeviceStore(m.id)) as Record<string, unknown>
```

`getChildrenBatch` (`device-queries.ts:526`) did the hard half correctly and stopped
one step short. Its own docblock is explicit — *"TWO store reads for the whole set,
not two per parent"* — and it delivers: ownership is one `rows.getMany`, children
are one `rows.listByParentMany`, and the live half is one pass over `getAll()`
rather than 256 registry sweeps. Then it calls `projectChildren` per parent, and
`projectChildren` issues **one settings-door read per child that is not in the live
registry**.

**The multiplier is measured, not assumed: 896.** All 896 children on this hub
belong to forked provider addons, so hub-main's `pctx.registry` holds none of them
and every one takes the persisted branch. The file's own comment says so: *"live
(hub-registry) wins, persisted fills in devices owned by forked workers."*

The caller that makes this a fleet sweep is the accessory reconcile:
`packages/system/src/kernel/moleculer/device-cap-proxy.ts:1292` coalesces every
reconcile in flight into **one** `getChildrenBatch` — *"Measured 1 024 calls for
919 rows on a 120-second boot before it existed."* The RPC N+1 was removed; the
door N+1 behind it was not.

**The fix already exists 321 lines above, in the same file.**
`readDeviceConfigs` (`device-queries.ts:98`) resolves the whole set through
`readDeviceStoreBatch`, whose own docblock (`settings-door-view.ts:100-128`)
describes exactly this defect being removed from `listAll` on 2026-08-25: *"one
`readDeviceStore` per device, sequentially, on hub-main's event loop: 967 round
trips per full-projection fleet listing, measured at 9 229 `query
addon-device-settings` a minute steady-state."* `projectChildren` never adopted it.

**Attempted measurement, and what actually happened.** I issued
`deviceManager.getChildren {parentDeviceId: 408}` (93 children) against the live
hub at 15:52. It had returned nothing after **32 minutes**, at which point I
stopped it. I am deliberately *not* reporting that as "93 door reads took 32
minutes": `hub.mjs` retries a failed fetch up to four times, so the client may have
re-issued the query, and I cannot separate one very slow answer from four. What it
does establish is that **a single-parent `getChildren` on this hub does not answer
within the client's entire retry envelope**, which is the same failure mode
`getAllBindings` had. It also means I stopped measuring: re-running it would put
the query on the hub again during the drain.

### #2 — `getSourceCatalog` walks 1 019 devices to build one camera's dropdown

```
packages/addon-osd-manager/src/osd-manager.ts:425-431
  const devices = await this.safeListDevices()            // listAll, UNFILTERED — 1019 rows
  for (const device of devices) {
    capsByDevice.set(device.id, await this.deps.listDeviceCaps(device.id))   // getBindings, per device
  }
```

`listDeviceCaps` (`packages/addon-osd-manager/src/addon.ts:128`) is
`ctx.api.deviceManager.getBindings.query({ deviceId })`. So **1 + 1 019 sequential
cross-process cap calls**, each of which is itself a store-backed resolve.

The same file already knows better. `listCameras` (`addon.ts:121`) passes
`isCamera: true` with a comment that names this exact mistake: *"the reconcile has
no business reading the other 946 rows of a 976-device directory … shipping every
row to `.filter()` here would be the same defect one layer down."* `getSourceCatalog`
calls `listDevices`, not `listCameras`.

Trigger is a plain operator action — `useOsdManagerGetSourceCatalog` in
`packages/addon-osd-manager/src/components/CameraOsdRow.tsx:58`, fired when a slot
editor opens. At today's per-call price this cannot complete inside any client
timeout. **Inferred, not measured** — I did not call it against the live hub, on
purpose.

### #3 — a 1 019-write loop behind one button

```
packages/addon-pipeline/src/detection-pipeline/provider.ts:4531
  await this.clearDeviceStore(device.id)
```

The enumeration was already fixed (`projection: 'slim'`, with a comment counting
"967 of them on this hub"). The loop under it was not. Writes are the expensive
direction: each `clearDeviceStore` is a `deleteWhere` over a key range, and
`sqlite-settings` is synchronous and single-threaded (D181), so 1 019 of them
occupy that child end to end while every other addon's config read queues behind.

### #4 and #8 — the doorbell re-reads the whole fleet's bindings, per camera

`refreshBindingMirror` → `readDurableAuthority`
(`packages/system/src/builtins/doorbell/virtual-doorbell.addon.ts:366`) fetches <!-- drift-ok: deleted in slice 6 (D671), task 17 -->
**device-manager's entire global settings record** — the wrapper-activation blob for
all 1 019 devices — and then reads one camera's row out of it, inside a loop over
cameras (`:553-555`). That is category 3 verbatim: a fleet-wide read performed per
item instead of once per pass. The loop above it (`:541`) adds one
`readDeviceStore` per camera, where one `readDeviceStoreBatch(cameraIds)` would do.

This sits in front of a doorbell ring. The TTL is 60 s, so the first qualifying
event after each expiry pays the whole sweep — and the events that qualify come
from **180 switch + 49 button** devices.

### #6 — a comment that promises the hoist, and a caller that does not take it

```
packages/addon-pipeline-orchestrator/src/node-lifecycle-handler.ts:201-207
  for (const { deviceId, config } of affected) {
    const decision = balance({
      …
      nodeCaps: await this.deps.settingsStore.buildNodeCaps(),
      weights:  await this.deps.settingsStore.buildNodeWeights(),
```

Both are `await this.agentSettingsState.get()` — and `DurableState.get()
(packages/types/src/addon/durable-state.ts:35)` is an **uncached full
`readAddonStore()`** every time. Both return a value that is identical for every
iteration.

`buildNodeCaps`' own docblock says it exists *"so the balancer can honour
operator-set per-node maximums **without polling the store on each decision**"* —
and the caller polls it on each decision. The correct shape is already in the
repo, one file over: `placement-service.ts:705-706` hoists exactly these two calls
above its loop. This is the "leftover that describes the right design" hazard
`CLAUDE.md` names, and it is worse than no comment because it reads as verification.

### #9 — `listNodes` serialises the cluster fan-out, twice per node

`server/backend/src/core/agent/agent-registry.service.ts:929` and `:941` — two
`broker.call`s per online remote node, sequential, each with an independent 5 s
timeout, so three remote nodes is up to 30 s of wall clock. The class's own doc
already flags the cost, and `listNodeLiveness()` exists solely so `/health` can
avoid it. The sibling remote fan-out immediately below in
`cap-providers.ts:700` *is* `Promise.all`-wrapped, which makes this the odd one out.

It is reached from `computeTopology` (the 30 s heartbeat), `clusterAddonStatus`,
and the agents router — and `useNodesTopology` has **15 observers** across the
admin UI's pipeline pages.

### #11 — every addon-settings write is N door writes

`packages/system/src/kernel/settings-door-view.ts:67`: `replacePrefixed`
`deleteWhere`s the key range and then issues **one `door.set` per key**,
sequentially. `writeAddonStore` (`:86`) calls it with `{...existing, ...patch}` —
the *union*, not the patch — so the cost of changing one field is the size of the
whole store. This is the read-side amplification D181 removed, still present on the
write side.

---

## 4 · The UI side: where D274's window does and does not reach

D274 moved the `deviceManager.listAll` caching window onto the query client
(`packages/ui-library/src/lib/fleet-query-defaults.ts`) and
`scripts/check-fleet-query-defaults.ts` guards the two holes that leaves. Both the
helper's and the guard's docblocks are the best statement of this defect class in
the repo. The guard is sound for what it watches. **It watches two things:
`new QueryClient(` and `useDeviceManagerListAll(`.**

### The hole: raw tRPC calls the guard cannot see

`applyFleetQueryDefaults` protects React-Query *observers*. A call made straight
through `system.trpcClient` never touches the query client, gets no window, dedupes
with nothing, and is invisible to the guard's regex. There are **twelve** such
`deviceManager.listAll.query(...)` call sites today:

| file:line | projection |
| --- | --- |
| `packages/types/src/device/system-mirror.ts:251` | **full** |
| `packages/addon-admin-ui/src/pages/system/NotificationSimulate.tsx:98` | **full** |
| `packages/addon-admin-ui/src/pages/system/NotificationRules.tsx:209` | **full** |
| `packages/addon-admin-ui/src/pages/system/NotificationRules.tsx:247` | **full** |
| `packages/addon-admin-ui/src/pages/system/NotificationHistory.tsx:91` | **full** |
| `packages/types/src/automation/codegen.ts:364` | **full** |
| `NotificationRules.tsx:231`, `NotificationAlarm.tsx:123`, `automation-data.ts:43`, `AiTestChat.tsx:717`/`:776`, `NotificationSummaries.tsx:102`, `NotificationTimelapses.tsx:95` | slim |

Six of them take the **full** projection, which the cap's own docblock warns
against (`device-manager.cap.ts:615`): *"A full listing of 293 devices measured
271 KB, of which `config` was 113 KB and `metadata` 22 KB."* Scaled to 1 019
devices against my measured 603 KB slim, the full payload is ~1.3 MB
(**inferred**).

### The boot gate is where this lands

`packages/addon-admin-ui/src/App.tsx:240` **blocks the entire React tree** on
`system.init()`. `SystemMirror.init` (`packages/types/src/device/system-mirror.ts:245`)
issues three concurrent calls, each under a 15 s timeout:

1. `deviceManager.getAllBindings({})` — the one just fixed,
2. `deviceState.getAllSnapshots({})` — in-memory, cheap in round trips,
3. `deviceManager.listAll({})` — **full projection, 1 019 rows, no window, no dedupe.**

So the admin UI's very first act is a full-fleet listing that its own 29
`useDeviceManagerListAll` observers will not reuse and D274 does not cover.

### Is there another fleet-shaped query needing D274's treatment?

I counted every hook call site across `addon-admin-ui/src` and `ui-library/src`.
`useDeviceManagerListAll` is 29 — by a wide margin the largest fleet-shaped one.
The next candidates are **not** fleet-shaped: `useNodesTopology` 15 (nodes),
`useAddonsList` 11 (addons), `useDeviceManagerGetDevice` 10 (one device),
`useAddonsListCapabilityProviders` 7 (caps). `getAllBindings` has exactly **one**
consumer and it is not a React Query observer.

**So the answer to "is there another `listAll`?" is no — and that is the wrong
question.** The residual risk is not a second hook with many observers; it is the
twelve raw-client call sites above, which the current guard is structurally unable
to see. If the guard is extended, the thing to add is
`trpcClient.deviceManager.listAll.query(` with a full-projection check, not another
`staleTime` rule.

---

## 5 · What is NOT a candidate, and why

This section is here so the next pass does not re-investigate them.

**Already batched or concurrent — correct today**

- `packages/system/src/builtins/device-manager/device-queries.ts:108` —
  `readDeviceConfigs`' per-device loop is a **fallback**, taken only when the view
  cannot batch (a forked runner's UDS view, per D294). On hub-main the door-backed
  view implements `readDeviceStoreBatch`, so the batch path is the live one.
- `packages/system/src/builtins/device-manager/device-bindings-store.ts` — the
  reference defect; fixed. `getBindings`/`getBindingsBatch`/`getAllBindings` now
  resolve the bindings blob once per pass and hand it down.
- `getChildrenBatch`' own row reads (`rows.getMany`, `rows.listByParentMany`) and
  the live-registry bucketing — one pass each. Only `projectChildren` under it is
  wrong.
- `Promise.all`-wrapped fan-outs: `cap-providers.ts:700` (remote nodes),
  `health.routes.ts:229`, `hwaccel.router.ts:139`, `cap-router-runtime.ts:258`,
  `cap-mount-helpers.ts:161`, `snapshot.addon.ts:723`, `addon-terminal/src/addon.ts:390`,
  and the pages/widgets aggregators' `settleSourcesWithTimeout`
  (`builtins/shared/settle-sources.ts:42`).
- `packages/addon-export-alexa/src/handlers/discovery.ts:85` — looks like a serial
  `for(;;)` with an await; it is a worker inside a bounded lane pool joined by
  `Promise.all`. This is the model fix for #12.
- `packages/addon-post-analysis/src/pipeline-analytics/services/event-kinds.ts:344`
  — the per-camera loop is a fallback; the primary path is
  `getLinkedDevicesBatch` at `:335`.

**In-memory only — a loop, but free**

- `deviceState.getAllSnapshots` (`device-state-mirror.ts:309`) — iterates the
  whole mirror, but it is a `Map` walk and a clone. It costs hub-main CPU, not
  round trips. Different problem; not this one.
- `capabilities.router.ts:89`/`:121`, `capabilities.router.ts:192` — pure
  `capabilityRegistry` Map mutations, no await in the loop.
- `packages/system/src/kernel/transport/cap-route.ts:367` — snapshot predicate scan.
- `packages/system/src/builtins/system-config/system-config.addon.ts:157` — reads
  like a per-section door read; the door-backed `getSection` delegates to
  `ConfigManager.getSection`, an in-memory read. There are also only **two**
  sections (`server`, `auth`). *(Its comment says "in parallel" while the code is a
  `for … await` — a leftover worth deleting, but not a cost.)*

**Wrong multiplier — nodes, addons or pages, not devices**

- `native-metrics/load-series-store.ts:424`/`:524`/`:527`, `container-memory-series.ts` —
  4 nodes, bounded pages.
- `reconcile-controller.ts:329`, `model-studio.addon.ts:357`,
  `update-check-scheduler.ts:166`, `addon-upload.ts:287` — 3–4 nodes.
- `storage-orchestrator/*` (`storage-migration-coordinator.ts:285`/`:502`,
  `provider-discovery.ts:38`) — storage locations, single digits.
- every `addon-post-analysis/src/pipeline-analytics/store/*.ts` loop
  (`event-store.ts:527`, `media-store.ts:829`, `track-store.ts:1680`, …) —
  **pagination**: iteration scales with rows and each round trip returns a page.
  Correct shape, do not "fix" it.
- the integrations-restore shape repeated in ~9 provider addons
  (`addon-matter-broker/src/addon.ts:262` and siblings) — 1–3 integrations each.

**Boot one-shots, deliberately serial**

- `device-manager.addon.ts:521` — the `idToAddonId` warm; one `listAll`, once.
  Already excluded by hand in `fleet-read-census.ts`'s docblock.
- `addon-registry.service.ts:1016-1048`/`:2637`/`:2692`, `agent/main.ts:1374`,
  `lifecycle-job-engine.ts` apply phase — ordering is the point.
- retry loops that look like fan-outs: `device-cap-proxy.ts:383`,
  `parent-unowned-call.ts:560`, `zone-mirror-hydration.ts:156`.

**Guarded once-per-process**

- `pipeline-analytics/index.ts:9907` and `:9995` — per-device migration reads,
  but gated by `retiredSettingsChecked` / `storedSuggestionCheckedDevices`, and
  the device set is already narrowed to ~30 cameras. The shape is there; the cost
  is not.

---

## 6 · Should there be a SQLite statement counter?

**A statement counter already exists and is always on** — the coordinator's read
that "nothing reports statements-per-request" is right about the *API* and wrong
about the *engine*.

`packages/system/src/builtins/sqlite-storage/query-profiler.ts` (`SqliteOpProfiler`)
is constructed for every production `SqliteSettingsBackend`
(`sqlite-settings-backend.ts:377`), armed before the first statement
(`:442`), and aggregates by **`(op, collection, SQL shape)`** with calls, rows,
duration and an `EXPLAIN QUERY PLAN` on the slow-call WARN. Its cost is two
`Date.now()` calls and a `Map` lookup per statement. It is what produced D181's
"4 149 calls and 4 219 533 rows in one 66-second boot window".

So the gap is narrower and more specific than "we have no counter":

1. **It reports to the log, not to an API.** Reading it means a Loki query, and
   the hub's in-memory ring holds ~35 minutes. `settingsStore` exposes
   `get/query/count/aggregate/histogram` and nothing that surfaces this.
2. **It names a statement, not a caller.** `(op, collection, shape)` is a table.
   That is exactly the limitation `FleetReadCensus`
   (`device-manager/fleet-read-census.ts`) was written to work around, for one
   collection — and its docblock says why picking the plausible caller by hand
   is not acceptable: *"An attribution is a measurement or it is a guess."*
3. **It has no per-request bucket.** A 740 s `getAllBindings` and a healthy boot
   look the same in a windowed aggregate; the thing you want is "this request
   issued 1 020 statements".

**My recommendation: do not build a third instrument.** The counter exists and the
attribution mechanism exists; what is missing is that they cannot be *read*
together. The highest-value single change is §1's repair — a working
`nodes.getCapUsageGraph` answers "who is hammering what" for cap traffic, which is
the layer above SQLite and the layer where the fleet multipliers actually live. If
after that a statement-level question remains, the cheap follow-up is exposing
`SqliteOpProfiler.rows()` through the `settingsStore` cap rather than a new
counter — one method, no new bookkeeping, and it makes an already-paid-for
measurement queryable.

---

## 7 · Coverage — what I swept, and what I did not

**Swept, with a TypeScript-AST scan for `await <expensive>` inside a loop body,
plus hand verification of every finding reported:**

- `packages/system/src/` — all of it (kernel, transport, moleculer, every builtin)
- `server/backend/src/` — all of it (routers, `core/addon`, `core/agent`, health, auth)
- `packages/types/src/`, `packages/sdk/src/`, `packages/ui-library/src/`
- every `packages/addon-*` except `addon-admin-ui`
- `packages/addon-admin-ui/src/` — data-fetching only (hook census, `useQueries`
  fan-outs, raw `trpcClient` calls). **Not** its rendering or state code.

**Not reached, and where the next pass should start:**

- **`.map(async …)` chains not joined by `Promise.all` in the same expression.**
  My scanner detects an `await` lexically inside a loop; a fan-out built in one
  place and awaited in another is outside it. Hand review covered the obvious ones.
- **Cost behind an abstraction I did not open.** A loop calling
  `this.deps.somethingCheap()` that turns out to be a door read three layers down
  would be missed. I opened the ones that looked plausible; I did not open all.
- **`packages/cli`, `packages/desktop`, `packages/shm-ring`, `tools/`, `e2e/`, `tests/`** — not scanned. <!-- drift-ok: deleted in D763 -->
- **The `camstack/` viewer submodule** — out of scope, but it has its own
  fleet-query surface and the D274 reasoning applies there too.
- **`__tests__` directories** — excluded everywhere by design.
- **Per-frame paths.** I looked for fleet multipliers, not frame-rate ones; a
  per-frame `await` would need a different sweep.
- **Anything only reachable at runtime.** Two of the four cap-usage causes were
  found by reading construction order, not by tracing a live call. If the graph
  is repaired, re-run this audit against its output — a measured caller list will
  beat this list.

**Measured vs inferred.** Measured on the live hub today: the fleet composition
and the 5.77 s / 603 KB slim `listAll`; the empty `getCapUsageGraph` in 0.21 s;
the non-answer of `getChildren {parentDeviceId: 408}` within 32 minutes (with the
retry caveat in §3). **Everything else in the table is inferred from call shape** —
number of round trips × the coordinator's measured 2.9 s door read. I stopped
measuring after the `getChildren` attempt so as not to load the hub during the
drain.

---

## 8 · The three I would fix first

### 1. `projectChildren`'s per-child door read (`device-queries.ts:419`)

**Cost to fix: the smallest in this document.** Hoist one
`readDeviceConfigs(pctx, childRows.map(r => r.meta.id))` above the loop and read
from the map — the helper is in the same file, already tested, already the
batching path everywhere else. `projectChildren` stops being `async`.

**Return: the largest.** 896 sequential door reads on a boot-time sweep and on
every device page, in the one addon that runs on hub-main's event loop, removed
outright. It is also the *same* defect that just broke the admin UI's boot probe,
in the *same* package, and the fix that was applied there is the fix here. Leaving
it is choosing to be surprised by it a second time.

### 2. Make `nodes.getCapUsageGraph` observe (§1d)

**Cost: one `recordCall` at the parent-side UDS junction**, where
`callerAddonId` is already stamped off the connection
(`local-child-registry.ts:742`) and already threaded to the resolver
(`parent-unowned-call.ts:425`). No new bookkeeping, no new transport, no per-call
cost when the window is empty.

**Return: this list stops being a code-reading exercise.** Every cross-process cap
call in the cluster — including every forked addon's `ctx.settings.*` — becomes
countable with a real caller, permanently. Every finding in §2 could then be
*ranked by measurement*, and the next one would be found the day it ships rather
than the day it breaks a page. It must ship with the honest caveat that hub-main's
in-process traffic (§1b) is still invisible; an instrument that overstates its
coverage is how this graph came to be trusted while returning `[]`.

### 3. `getSourceCatalog`'s 1 019 `getBindings` (`osd-manager.ts:429`)

**Cost: two lines.** Switch `safeListDevices` to the `listCameras` path that
already exists in the same file (`addon.ts:121`, `isCamera: true`), and replace the
loop with one `getBindingsBatch({ deviceIds })` — the method that exists precisely
because *"between `getBindings` (one device) and `getAllBindings` (all 988) there
was nothing"*.

**Return: a user-facing action that currently cannot complete, completes.** 1 020
round trips become 2. I put it third only because it is one screen; the two above
it are on the boot path and on the instrument that would have caught all three.

---

*Written 2026-08-30 against the shared checkout. No code was changed, no hub state
was written, and the drain was not touched.*
