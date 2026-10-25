---
title: Cluster settings census — every knob on the Cluster page and on Cluster → node, its true scope, and whether anything reads it
covers:
  - packages/addon-admin-ui/src/components/cluster/**
  - packages/addon-admin-ui/src/components/settings/**
  - packages/addon-admin-ui/src/pages/system/Settings.tsx
  - packages/types/src/addon/base-addon.ts
  - packages/types/src/addon/per-node-store.ts
  - packages/types/src/capabilities/addon-settings.cap.ts
  - server/backend/src/core/addon/addon-settings-provider.ts
  - server/backend/src/core/addon/addon-call-gateway.ts
  - packages/system/src/builtins/system-config/**
status: census + analysis (no code changed)
date: 2026-08-28
---

# Cluster settings census

> **Status, 2026-08-28 — R5 and R6 are DONE; §4 and §7 are history, not a
> to-do list.** Seven of the nine dead knobs were deleted and their stored
> values retired ([D268](../decisions/adr-0272-a-settings-key-nobody-reads-is-deleted-and-its-stored-value-retired.md));
> the other two (`tokenExpiry`, `bufferMaxPerDevice`) were wired the same day
> ([D267](../decisions/adr-0267-the-token-lifetime-has-one-default-and-is-validated-where-it-is-signed.md)).
> Two claims below did **not** survive re-verification and were left alone:
> `recorder.recordingPlacement` is LIVE (`placement-store.ts` reads and writes
> it every writer run) and is not deprecated, and R5's guard sketch would have
> caught four of the nine, not all nine — three died with a log-field read as
> their only reference, which no static rule can call dead. R1–R4 and R7 are
> still open.
>
> **What this is.** A row for every setting an operator can reach from the
> Cluster page and from Cluster → a node, with the one thing the UI does not
> tell them: whether the value they are editing belongs to **that node** or to
> **the whole cluster**. It changes nothing. Every claim carries a `file:line`
> or a named absence.
>
> **How it was built.** The render path was traced from `NodeCard.tsx` down to
> the store write, and then the *live* hub (<hub-ip>) was asked
> `addonSettings.getGlobalSettings` once per (node × addon) — 102 calls — so
> the field list is what the deployed cluster actually serves today, not what
> the repo would serve after a deploy. Where the two disagree, it is called out.
> The hub was mid-incident during the read; nothing below rests on a runtime
> *value*, only on schema shape and store contents, which that does not perturb.

## 0. The numbers

| | |
| --- | --- |
| Settings audited (distinct addon × key reachable from a node card) | **298** |
| …on the **hub** node card | 298 (40 addons contribute; 22 return an empty schema) |
| …on **each agent** node card | 158 (12 addons contribute) |
| Genuinely per-node (`perNode: true`) | **23** — 7.7% |
| Cluster-wide values drawn under an **agent** node heading | **133** |
| Cluster-wide key whose consumer is a per-node quantity | **22** |
| Dead knobs — written, never read | **9** |
| Display-only rows counted as settings by nobody but the eye (`info`/readout/action) | **26** |
| Settings reachable from **≥ 2** UI surfaces | **298 / 298** |
| …reachable from **≥ 4** surfaces | **240** |

## 1. The mechanism, in four facts

Everything in this document follows from these. Each is a line of code, not an
opinion.

**F1 — `perNode: true` is the only thing that makes a setting per-node.**
`ConfigFieldBase.perNode` (`packages/types/src/interfaces/config-ui.ts:275`)
scopes the persisted key to `<key>@<nodeId>`. Absent, the field is *"a
node-agnostic shared blob — a single value for the whole cluster"*. The write
path proves it: `BaseAddon.updateGlobalSettings`
(`packages/types/src/addon/base-addon.ts:343`) computes
`scoped = keys.size > 0 ? scopePatch(barePatch, keys, target) : barePatch` —
with no `perNode` field in the schema the `nodeId` argument is **discarded** and
the patch lands on the shared blob.

**F2 — `nodeId` never routes. It is data.** `addon-settings` declares
`nodeIdMode: 'data'` (`packages/types/src/capabilities/addon-settings.cap.ts:77`),
and the hub-side dispatcher confirms it: `AddonCallGateway.classify`
(`server/backend/src/core/addon/addon-call-gateway.ts:76`) resolves the host
node **first**, and `resolveNode` returns the hub for every addon the hub knows
and `'hub'` for every addon it does not
(`server/backend/src/core/addon/addon-registry.service.ts:570`). The
`explicitNodeId` branch is therefore unreachable on the hub. Selecting an agent
in the UI does not talk to that agent — it talks to the hub's copy of the addon
and passes the node id along as an argument that only `perNode` fields consult.

**F3 — the settings store is one, and it is the hub's.** `settings-store` is
`mode: 'singleton'` (`packages/types/src/capabilities/settings-store.cap.ts:148`)
and a forked addon's `ctx.settings` routes to it
(`packages/system/src/kernel/moleculer/addon-context-factory.ts:496`). There
is no per-node copy to diverge; divergence exists only as `@<nodeId>` suffixes
inside the one hub row.

**F4 — the node card and the System → Settings page are the same component,
same arguments.** `NodeDetailSettingsTab`
(`packages/addon-admin-ui/src/components/cluster/tabs/NodeDetailSettingsTab.tsx:36`)
renders `<NodeAddonsSettingsPanel nodeId={nodeId} addonIds={addonIds} level="global" selfTabbed />`;
`SettingsPage` (`packages/addon-admin-ui/src/pages/system/Settings.tsx:50`)
renders `<NodeAddonsSettingsPanel nodeId={hub.id} addonIds={addonIds} level="global" />`
with `addonIds = hub.addons.map(a => a.id)`. For the hub node the two are
byte-identical surfaces over the same 298 fields.

**Consequence.** The operator's suspicion is correct and understated. It is not
that *some* global settings leak onto the hub node. It is that **the node
Settings tab is a cluster-settings editor with a node's name on it.** On an
agent node card, 133 of the 158 editable fields write the cluster.

## 2. The four questions, answered

### 2.1 Does the node Settings tab show **orchestrator** settings on every node?

**No — and that is the one thing that is accidentally right.** `pipeline-orchestrator`
is `hub-only` (`docs/reference/addons.md`), so it is absent from
`nodes.topology[].addons` on both agents (verified live: each agent lists 20
addons, orchestrator is not among them). The "Cluster Roles" selectors
(`ingestNode`, `audioNode`, `motionNode`) and `nodeStressMode` therefore render
**once**, on the hub node card — plus System → Settings, plus Pipeline → Cluster
Settings, plus the Addons page card dialog.

They are cluster singletons and the code says so with unusual clarity:
`ingestNode` → `node-topology.ts:149`/`:154`/`:162`, `ingest-owner.ts:26`;
`audioNode` → `audio-subscription-controller.ts:269`; `motionNode` →
`placement-service.ts:212`, `dispatch-reconcile.ts:237`; `nodeStressMode` →
`node-stress-controller.ts:149`. One value, cluster-wide, by construction.

The split-behaviour trap the codebase names is nonetheless live here, one level
down. `stream-broker/joinBurstMaxSpanMs` is deliberately cluster-scoped, and
`packages/addon-pipeline/src/stream-broker/rtsp/join-burst-bound.ts:14` states
the reason in as many words:

> *"WHY THE DEFAULT IS CLUSTER-SCOPED AND NOT PER-NODE. The ingest node is a
> movable role (the orchestrator's `ingestNode` selector), so a per-node bound
> would make a camera's join behaviour depend on which node happened to own its
> ingest at the time — the split-behaviour trap D52/D56 exist to prevent."*

That field is drawn on **every** node card, under that node's name, with a Save
button. The design record forbids the per-node reading the UI implies.

### 2.2 What appears on the hub that does not appear on an agent, and is that intentional?

140 of the 298 fields are hub-only, from 28 hub-only addons. They fall in two
groups.

**Intentional (26 addons, 135 fields).** Integrations and providers
(`cloudflare-*`, `export-alexa`, `export-hap`, `mqtt-broker`, `matter-broker`,
`import-alexa`, the `provider-*` family, `homeassistant-export`), auth
(`auth-magic-link`, `auth-oidc`, `auth-webauthn`), and hub-resident services
(`alert-center`, `snapshot`, `local-network`, `ai`, `osd-manager`,
`recorder`'s cluster section, `pipeline-orchestrator`, `pipeline-analytics`'s
cluster sections). These are `hub-only` addons holding cluster-wide
configuration. Nothing is per-node about them. They appear on the hub card
because the hub card enumerates hub addons — an artefact, but a harmless one:
the hub *is* the cluster for these.

**An artefact, and not harmless: `system-config` (5 fields).** It is the one
addon whose presence is explained by hub-local yml. Its manifest is now hub-only,
but its own header still says *"we just let it run everywhere because it's
harmless"* (`packages/system/src/builtins/system-config/system-config.addon.ts:24`).
Three of its five fields (`port`, `host`, `dataPath`) are read-only bootstrap
values (`server/backend/src/main.ts:297`, `boot/boot-config.ts:218`) and
correctly `disabled` — they are the only fields on the whole page that are
genuinely a *fact of that node*, and they are the ones you cannot edit. The
fourth, `tokenExpiry`, is editable and **dead** (§4.1).

### 2.3 Which settings are per-node by nature and legitimately stay on the node card?

All 23 `perNode: true` fields, from four addons. This is the complete list —
grep `perNode: true` across `packages/` returns nothing else:

| Addon | Fields | Declared at |
| --- | --- | --- |
| `terminal` | `maxSessions`, `btmEnabled/Path/Args`, `topEnabled/Path/Args`, `glancesEnabled/Path/Args`, `allowShell`, `shellPath`, `customProfiles` (13) | `addon-terminal/src/addon.ts:794…945` |
| `detection-pipeline` | `batchMode`, `windowMs`, `maxBatchSize`, `concurrency`, `numWorkers` (5) | `addon-pipeline/src/detection-pipeline/index.ts:424…504` |
| `stream-broker` | `hwaccel`, `binaryPath` (2) | `addon-pipeline/src/stream-broker/addon.ts:1205`, `:1215` |
| `decoder-nodeav` | `hwaccel`, `probedBestHwaccel` (2) | `addon-decoder-nodeav/src/addon/index.ts:140`, `:150` |
| `audio-analyzer` | `probedBestAudioBackend` (1) | `addon-pipeline/src/audio-analyzer/addons/analyzer/index.ts:642` |

*(`decoder-ffmpeg` declares two more, `hwaccel`/`probedBestHwaccel`, but that
addon is installed on no node in this cluster.)*

`addon-terminal` is the model the rest should copy. Its section header says
*"Every setting below is per node — the values you see belong to the node
selected above"* (`addon.ts:783`) **and backs it with the flag on all thirteen
fields.**

The live store confirms the mechanism works: `settingsStore.get
{namespace:'decoder-nodeav', collection:'addon-settings', key:'root'}` holds
`probedBestHwaccel@hub`, `probedBestHwaccel@agent-a`,
`probedBestHwaccel@<agent-host>` — three different values. And a
cross-node diff of all 298 fields found **exactly four** that differ between
nodes: `probedBestAudioBackend`, `probedBestHwaccel`, `windowMs`, `numWorkers`.
Every one is `perNode`. The other 294 are the same value everywhere, because
they are one value.

### 2.4 Contradictory `min`/`max`/`default`, and descriptions of removed behaviour

See §5 and §6. Twelve range/default contradictions and fifteen stale
descriptions were found, including four in file and package headers that
describe settings sections deleted months ago.

## 3. Duplicates — the headline finding

Every one of the 298 is reachable from at least two places, and 240 from four or
more. No surface stores a second copy — they all write the same blob — so the
values never *disagree*. What they disagree about is **scope**, and that is
worse, because the operator cannot tell from the page which they are editing.

| Surface | Renders | Node scope it implies | Node scope it uses |
| --- | --- | --- | --- |
| Cluster → node → **Settings** | every addon on that node, `level:'global'` | that node | cluster (except 23 fields) |
| **System → Settings** | every addon on the hub, `level:'global'` | cluster | cluster |
| **Addons** → card → Settings dialog | one addon, `nodeId="hub"` hardcoded (`components/addons/AddonCard.tsx:939`) | that addon | **always the hub**, even for an agent addon |
| Cluster → **Pipeline** → Cluster Settings | `pipeline-orchestrator` + `pipeline-analytics`@`face-gallery` (`components/pipeline/tabs/ClusterSettingsTab.tsx:24,31`) | cluster | cluster |
| Cluster → **Pipeline** → node | `detection-pipeline`, `audio-analyzer`, `pipeline-runner`, `decoder-nodeav` (`components/pipeline/NodeDetail.tsx:91`) | that node | mixed |
| **System → Terminal** | `terminal`, `nodeId={selectedNodeId}` (`pages/system/Terminal.tsx:435`) | that node | that node ✅ |
| **System → Local Access** | `local-network`, `nodeId="hub"` (`pages/system/LocalAccess.tsx:75`) | hub | cluster ✅ |
| **Device → Provider Settings** | the provider addon, `nodeId="hub"` (`components/device/tabs/ProviderSettingsTab.tsx:42`) | **that camera** | the whole addon |

Three of these are defects in their own right, ranked:

**D1 — the node Settings tab (298 fields × 3 nodes).** Covered above. The tab's
own header comment still describes a shape the code no longer has: it claims
`system-config` contributes *"server / auth / ffmpeg / logging / recording /
retention"* (`NodeDetailSettingsTab.tsx:11`). Four of those six were removed;
`system-config` serves `server` and `auth` only
(`system-config.addon.ts:42`, and the deletion note at `:128-134`).

**D2 — the Addons card dialog pins `nodeId="hub"`.** For the five addons with
`perNode` fields, opening the Settings dialog from the Addons page and editing
e.g. `terminal.btmPath` writes `btmPath@hub` — regardless of which node the
operator has in mind, and with no node selector in the dialog to tell them
otherwise. The same field edited from Cluster → *agent-a* → Settings
writes `btmPath@agent-a`. Two reachable controls, same label, different
targets. This is the "second knob that disagrees with the first" case, and the
disagreement is invisible because both show a value.

**D3 — Device → Provider Settings is addon-wide under a device heading.** The
panel is titled *"Provider Settings"* and sits inside one camera, but renders
`level:'global'` for the provider addon
(`ProviderSettingsTab.tsx:42`). Editing `emailPushPort` there from camera 102
changes it for every Reolink camera. Out of scope for the Cluster page, listed
because the same component causes it.

## 4. Unread — knobs that write a store nobody reads

Nine. Each was traced from declaration to every reference in the workspace,
excluding tests and `dist/`.

### 4.1 `system-config.tokenExpiry` — the sharpest one

The chain breaks at exactly one line. The field is declared
(`system-config.addon.ts:120`), mapped to the `auth` yml section (`:55`) and
written by `updateGlobalSettings` (`:194`). Its only would-be reader is
`AuthManager.signToken` → `this.config.get<string>('auth.tokenExpiry')`
(`packages/system/src/auth/auth-manager.ts:56`). `AuthManager` is constructed in
one place, and the `reader` it is handed whitelists three paths
(`packages/system/src/builtins/local-auth/local-auth.addon.ts:104`):

```ts
if (path === 'auth.jwtSecret')     return resolvedJwtSecret
if (path === 'auth.adminUsername') return resolvedAdminUser
if (path === 'auth.adminPassword') return resolvedAdminPass
return undefined                    // ← auth.tokenExpiry lands here
```

`configured` is therefore always `undefined` and `auth-manager.ts:57` falls
back to a hardcoded `'30d'`. Three defaults disagree about a value nothing
reads: schema `'30d'` (`:124`), `RUNTIME_DEFAULTS['auth.tokenExpiry'] = '7d'`
(`packages/types/src/constants.ts:88`), hardcoded `'30d'`. A live, editable,
silently inert security control.

### 4.2 The rest

| Key | Addon | Why it is dead |
| --- | --- | --- |
| `maxDecodeFps` | `stream-broker` | Declared `addon.ts:101`/`:263`/`:1186`; no consumer anywhere. Description promises *"Maximum frames per second for decoded stream subscribers"* — nothing caps anything. |
| `initialReconnectDelayMs` | `stream-broker` | Real backoff is `INITIAL_RECONNECT_DELAY_MS = 1_000`, hardcoded at `stream-broker/stream-broker.ts:81`. |
| `maxReconnectDelayMs` | `stream-broker` | Real value hardcoded `MAX_RECONNECT_DELAY_MS = 30_000` at `stream-broker.ts:82`. **The whole "Reconnection" section is dead** — both fields, and the section description at `addon.ts:1270` describing an exponential backoff it does not control. |
| `runtime` | `embedding-encoder` | Only non-declaration use is `addon/index.ts:273`, inside `logger.withTags`. The `python`/`auto` options are equivalent no-ops. |
| `backend` | `embedding-encoder` | Same: `addon/index.ts:274`, a log tag. The CUDA/CoreML options do nothing; inference always runs ONNX in embedded Python. |
| `selectedAudioModel` | `audio-analyzer` | `analyzer/index.ts:942` is a log field. `createAudioPipeline` (`audio-pipeline.ts:80`) takes no model id, so the value never reaches inference. |
| `mediaAttachPolicy` | `pipeline-analytics` | Not present in `MediaSettingsSchema` (`media-settings.ts`), so it is never even resolved. The repo already knows: `docs/architecture/post-analysis.md:1151` says *"One form knob is dead: `mediaAttachPolicy` has no reader."* |
| `bufferMaxPerDevice` | `pipeline-analytics` | Resolved into `FaceSettings` (`face-settings.ts:144`) but the only prune site reads the module constant `FACE_DEFAULTS.bufferMaxPerDevice` (`index.ts:9536, 9543, 9556, 9563`). `docs/decisions/adr-0064.md:125` already records this. Worse: the same constant also caps the **plate** buffer (`index.ts:9556`), which the face-scoped label does not admit. |

**Why the existing guard did not catch these.**
`packages/addon-post-analysis/src/pipeline-analytics/__tests__/settings-schema-dead-knobs.spec.ts`
pins exactly two removed names (`trackTtlMs`, `maxPositionHistory`). It is an
allow-list of two strings, not a reachability check — which is why
`mediaAttachPolicy` and `bufferMaxPerDevice` survived beside it. A guard that
asserted "every non-`info`, non-`readonlyField` key resolves to at least one
non-declaration reference" would have failed on all nine.

### 4.3 Not dead, but not settings either (26 rows)

Counting these as knobs inflates every number, so they are separated: 15
`info`/`separator` rows, 8 readouts whose value is injected on each render
(`activeModelSubstitutions`, `suggestionThresholdReadout`,
`probedBestAudioBackend`, `probedBestHwaccel`, `load-series-cost`,
`load-series-cap`, `emailPushRecommendedHost`, and the read-only `port`/`host`/
`dataPath` trio), and 3 action buttons whose `key` is genuinely never read but
whose `action` string is live (`embedding.rebuild` / `.rebuildStatus` / `.wipe`,
declared `embedding-actions.ts:127`, handled `index.ts:12170`).

## 5. Mis-scoped — a cluster key with a per-node consumer

Twenty-two fields whose consumer is unambiguously a property of one machine, and
whose storage is one value for all of them. These are the ones where a Save on
one node card silently reconfigures the others, in the direction that hurts:
a Mac mini's RAM budget applied to the hub.

| Addon | Fields | Consumer is per-node because |
| --- | --- | --- |
| `pipeline-runner` | all 7 (`maxConcurrentInferences`, `maxQueueDepth`, `targetLoadPercent`, `minThrottledFps`, `maxConcurrentDecodeSpawns`, `maxLiveDecodeWorkers`, `nodeDecodeBudgetMb`) | semaphores, queues and a RAM ceiling on the node that decodes. `index.ts:4833` titles the section *"Per-node detection scheduler tuning"* and three descriptions say *"on this node"*. `grep perNode` in that file returns **nothing**. |
| `pipeline-orchestrator` | the 6 native-lease knobs | consumed inside `decode-worker-child.ts:200`, one decode worker per node; `nativeLeaseBudgetMb`'s own description says *"Lower it on a small host"* — which it cannot do. |
| `winston-logging` | `level`, `retentionDays` | each node writes its own `ctx.nodeDataDir/logs` (`winston-logging.addon.ts:23`); header says *"on this node"* (`:47`). |
| `console-logging` | `level` | each node has its own stdout (`console-destination.ts:27`). |
| `loki-logging` | `level` | each node ships its own logs, `node` label from `ctx.kernel.localNodeId` (`loki-logging.addon.ts:151`); description says *"Ship **this node's** logs"* (`:166`). |
| `metrics-native` | `samplingIntervalMs` | `onInitialize` starts a sampler on every node (`:241`). *(`loadSeriesCadenceSec`/`loadSeriesRetentionHours` are correctly cluster-wide and the code says so at `:668-671`.)* |
| `stream-broker` | `defaultPreBufferSec`, `rtspPort`, `catalogReconcileIntervalSec` | each node's broker holds its own ring and binds its own port (`addon.ts:367`, `:566`, `:660`). |
| `audio-analyzer` | `audioBackend` | each node resolves `'auto'` against its own `process.platform` (`analyzer/index.ts:821`); the sibling `selectedAudioModel` description even says *"live here at the node level"* — neither carries the flag, only `probedBestAudioBackend` does. |

The pattern is the same everywhere: **the description already makes the per-node
promise; only the flag is missing.** `addon-terminal` and `detection-pipeline`
made the same promise and shipped the mechanism —
`detection-pipeline/index.ts:390` documents having fixed exactly this for its
own section, so the fix is a known, applied move, not a design question.

## 6. Descriptions that describe behaviour the code no longer has

A stale description reads as verification. Fifteen were found; these are the ones
that would actively mislead a decision.

1. **`NodeDetailSettingsTab.tsx:11`** — claims `system-config` contributes
   *server / auth / ffmpeg / logging / recording / retention*. Four of six are
   gone.
2. **`system-config.addon.ts:11,16`** — the class header advertises a *"global
   ffmpeg binary path"* and lists an `ffmpeg (binaryPath, hwAccel, threadCount)`
   section that the same file deletes 110 lines later (`:128-134`).
   **`packages/system/package.json` repeats the stale claim** in the addon
   description.
3. **`system-config.addon.ts:24`** — *"we just let it run everywhere because
   it's harmless."* The manifest declares it hub-only; the comment describes an
   intent, not the shipped state.
4. **`loki-logging.addon.ts:5`** — *"`enabled` defaults to `false`."*
   `DEFAULTS.enabled` is `true` (`:46`) and `destinationConfig()` hardcodes
   `enabled: true` (`:151`); enablement moved to the orchestrator's
   per-destination toggle on 2026-07-30.
5. **`ClusterSettingsTab.tsx:29`** — the panel description says the tab holds
   *"enabled nodes"*. There is no `enabledNodes` field in the schema any more;
   the roles are the three singleton selectors. The live store still carries the
   orphans (§7).
6. **`settings-ui-schemas.ts:96` (`ingestNode`)** — *"Arbitrary ingest ≠ hub
   is a later phase."* It is implemented and live: `ingest-owner.ts`,
   `node-topology.ts:231`, the broker owner gate at
   `stream-broker-manager.ts:6411`, the recorder's cross-node pull at
   `recorder/addon/index.ts:548`.
7. **`settings-ui-schemas.ts:324` (`nativeLeaseAdmission`)** — quotes *"around
   80% less retained RAM"*. The authoritative docblock
   (`packages/types/src/pipeline/native-lease.ts:64`) measures ~50% *on this
   cluster* and says explicitly not to quote a number from the sketch.
8. **`stream-broker/addon.ts:1270`** — the "Reconnection" section describes
   an exponential backoff it does not control (§4.2).
9. **`confirmation-gate-settings.ts:48, 60-66`** — still says the gate is
   *"FAIL-OPEN"*. It has been fail-**deferred** since 2026-08-01, and the same
   file says so at `:19-26`. The form text is correct; the code comment is not —
   the file contradicts itself.
10. **`embedding-encoder/addon/index.ts:352, 363`** — *"Inference runtime"* and
    *"Hardware backend for inference acceleration"* over two dead selects.
11. **`winston-logging.addon.ts:47`, `console-logging.addon.ts:53`,
    `loki-logging.addon.ts:166`** — three separate *"this node"* promises with no
    `perNode` behind any of them (§5).

### Range and default contradictions

| Field | Contradiction |
| --- | --- |
| `pipeline-analytics/embeddingEnabled` | schema `default: false` (`settings-schema.ts:196`); the durable handle declares `default: true` (`index.ts:1941`). An operator who never touches it **sees OFF while the dispatcher runs.** The label — *"Leave OFF; it only burns CPU"* — describes a state the untouched system is not in. |
| `pipeline-runner/maxConcurrentInferences` | `min 1, max 16, default 16` — the shipped default sits at the max, so the slider can only ever be turned down. |
| `pipeline-runner/nodeDecodeBudgetMb` | description says the default admits **4** workers; the derivation `floor(8192/1438)` is **5**, and `live-worker-admission.ts:104` says so. |
| `nativeSceneBudgetMb` | excluded from `decodeWorkerFootprintMb` (`live-worker-admission.ts:118`), so raising it commits RAM the `nodeDecodeBudgetMb` ceiling cannot see — undercutting that field's own description. **Closed 2026-09-05 (D361): the footprint now charges `min(budgetMb, holdFrames × 25) + tileBudgetMb + sceneBudgetMb + baseline`.** |
| all 6 native-lease sliders | `readKnob`/`readAdmissionKnob` (`native-lease.ts:288`) return `null` when the value equals the default, so *choosing the declared default is a no-op* and any `CAMSTACK_SESSION_NATIVE_LEASE_*` env var wins. The sliders' `default:` values are unreachable as an operator choice. |
| `system-config/tokenExpiry` | three disagreeing defaults for a value nothing reads (§4.1). |
| `alerts/retentionDays` | `min: 1` — no "keep forever", unlike `ai/chatRetentionMaxAgeDays` which documents `0 = forever` and whose consumer honours it (`addon-ai/src/addon.ts:76, 276`). Inconsistent retention idiom. |
| `local-network/localHostname` | declares `maxLength: 253` and no `default`, while the runtime default is `''` (`:157`). Cosmetic. |
| 5 × `pipeline-analytics` | form range ⊂ zod range (`snapshotMaxIdleMs`, `snapshotMovementThreshold`, `packageDropMinFrames`, `packageDropDwellSec`, `packageDropActivityWindowSec`). Benign — no case was found where the form permits a value the resolver rejects. |

## 7. Deprecated — keys the live store carries that no schema declares

Read from the live hub with
`settingsStore.get {namespace:<addonId>, collection:'addon-settings', key:'root'}`.
Internal non-UI state (tokens, identities, broker lists, migration markers) is
excluded; what remains is residue.

| Addon | Orphan keys | Reading |
| --- | --- | --- |
| `pipeline-orchestrator` | `enabledNodes`, `enabledAudioNodes`, `enabledDecoderNodes`, `remoteSourcingNodes`, `nativeLeaseTtlMs` | the pre-singleton "enabled nodes" role model, replaced by `ingestNode`/`audioNode`/`motionNode`; `nativeLeaseTtlMs` was superseded by `nativeLeaseActivityMs`. Still the source of the stale *"enabled nodes"* copy in `ClusterSettingsTab`. |
| `recorder` | `recordingPlacement` | the schema declares `recordingNodeId` + `recordingHubHostname`, **neither of which is stored**; the retired key is. Worth a second look before assuming the two current fields have ever been written. |
| `decoder-nodeav`, `audio-analyzer` | bare `probedBestHwaccel`, bare `probedBestAudioBackend` alongside their `@<node>` copies | pre-`perNode` residue. `projectStore` deliberately drops bare per-node keys (`per-node-store.ts:89`), so these are unreachable, not merely redundant. |
| every hub | `backend@<nodeId>` | see below. |

**`backend@<nodeId>` — dead machinery, not just a dead key.** The claim in
`components/pipeline/NodeDetail.tsx:30` (*"persisted `backend@<nodeId>` rows
are left in the store and are not read"*) is **true**, and larger than it sounds:
`resolveDecoderBackend` (`addon-decoder-nodeav/src/shared/decoder-backend.ts:118`,
identical copy in `addon-decoder-ffmpeg`) takes `_api`, `_nodeId`, `_logger` —
all ignored — and unconditionally returns `DEFAULT_DECODER_BACKEND`. Both
`decoder-backend-keys.ts` modules (~106 lines each) and
`pickDecoderBackendFromSettings` are exercised **only by tests**. No schema
declares `key: 'backend'` for a decoder.

**The retired-keys registry already exists** and is where these belong:
`packages/system/src/builtins/sqlite-storage/retired-settings-keys.ts`.
`RETIRED_SETTINGS_KEYS` (`:164-176`) currently retires six `detection-pipeline`
keys (`pipelineSteps`, `pipelineEngine`, and the per-node engine cascade
`engineRuntime`/`engineBackend`/`engineDevice`/`probedBestEngine`);
`RETIRED_SETTINGS_ROWS` (`:216-244`) retires three `device-manager` blobs. Two
notes carry over: the purge is hub-only (`:130-133`), and `:180-197` records a
spec that was *"a no-op on every hub that ever ran it"* because it addressed the
scoped table for a hub builtin whose settings live in the unscoped one — so
`backend`'s owner (`pipeline-orchestrator`, per `decoder-backend.ts:50`) must be
confirmed before a spec is added.

**Undeclared live keys — the inverse gap.** `emailPushBindHost` and
`emailPushMaxMessageBytes` are **read** (`provider-reolink/email-push-server.ts:69`,
`:74-78`) but declared in no schema. Invisible to the operator, editable only by
writing the store directly.

## 8. A drift note the census forced into the open

The live hub serves a `pipeline-analytics` "Stationary objects" section
containing `promotionWindowMs`. Repo HEAD declares that section with
`sessionStillnessWindowMs` and `promotePersons` and **no** `promotionWindowMs`
(`settings-schema-sections.ts:552`). Deployed `pipeline-analytics` is
1.2.135; `admin-ui` is 1.2.107. This is the ordinary "your edit is probably not
running" gap, and it means the field list here is *what the operator sees today*
— two fields in HEAD are not yet on the page, and one field on the page is no
longer in HEAD. Every other addon's live schema matched HEAD.

## 9. Recommended end state

The reasoning, so a future reader can disagree with the conclusion and still see
the evidence.

**R1 — the node card's Settings tab renders only `perNode` fields.**
The tab's contract should be "what is true of *this machine*". Today that is 23
of 158 fields on an agent. The panel already knows which fields those are —
`BaseAddon.perNodeKeys` computes the set, and it is already transmitted to the
UI as part of the field object. A node card that showed only those would be
honest, short, and would need no per-addon allow-list.
*Counter-argument, recorded:* it makes the hub node card nearly empty, and
operators use it as a jumping-off point. The answer is that System → Settings
already exists and is the cluster surface — see R2.

**R2 — System → Settings becomes the only cluster-wide surface, and is not
addressed by node.** It renders the hub's addon list today only because that is
how the addon roster is discovered. Nothing about `nodeId="hub"` is meaningful
for a value stored once. Dropping the node argument from that page removes the
implication entirely.

**R3 — the Addons card dialog either gains a node selector or drops the
`perNode` fields.** `nodeId="hub"` hardcoded (`AddonCard.tsx:939`) is a silent
wrong answer for five addons. Dropping them is the cheaper fix and loses nothing:
those five all have a per-node home already (node card, Pipeline → node, System
→ Terminal).

**R4 — the 22 mis-scoped fields get `perNode: true`.** They are already
described as per-node; the flag is the only missing piece, the mechanism is
proven (`per-node-store.ts`, `addon-terminal`, `detection-pipeline`), and the
migration is benign — `projectStore` falls back to the schema default, never to
another node's value, so an unscoped store simply starts every node at the
default rather than at one node's accident.
*Counter-argument, recorded:* `stream-broker/rtspPort` per-node means three ports
to keep straight. That is the truth of the system, not a cost of the change.

**R5 — the 9 dead knobs are deleted, and a guard replaces the two-name
allow-list.** `settings-schema-dead-knobs.spec.ts` pins two names; a guard in
`scripts/` that walks every addon's `globalSettingsSchema()` and asserts each
non-`info`, non-`readonlyField` key has at least one non-declaration reference
would have caught all nine, and will catch the tenth. This repo's own rule —
*prefer a guard to a paragraph* — applies exactly.

**R6 — the orphan store keys go into `RETIRED_SETTINGS_KEYS`**, after confirming
each spec's addressing against the note at `retired-settings-keys.ts:180`.
The five `pipeline-orchestrator` orphans and `backend@<node>` are the population.

**R7 — the fifteen stale descriptions are corrected or deleted.** Priority to the
four that a reader would take as verification: `NodeDetailSettingsTab.tsx:11`,
the `system-config` header + `package.json` description,
`confirmation-gate-settings.ts:48`, and the three *"this node"* logging
descriptions (which should be corrected by R4, not by rewording).

**Ordering.** R5 and R6 are self-contained and remove rows before anything is
moved. R4 is next and changes behaviour. R1–R3 are the UI move and should follow
R4, so that the node card has its final population before it is rebuilt. R7 is
cosmetic and can ride along with whichever change touches each file.

## 10. The full census

One row per (addon, key) reachable from a node card, in render order. Columns:
where it is declared; its true scope; whether anything reads it; the verdict and
the evidence for it. `hub only` vs `hub and every agent node` is the *where it is
rendered* axis — every one of these is additionally reachable from System →
Settings and from the Addons card dialog, and the ones with a named extra surface
from that too.

##### `winston-logging` — hub only

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `level` | system/src/builtins/winston-logging/winston-logging.addon.ts:52 | select | **cluster key / per-node effect** | yes | **mark `perNode`** | each node writes its own nodeDataDir/logs |
| `retentionDays` | system/src/builtins/winston-logging/winston-logging.addon.ts:64 | number | **cluster key / per-node effect** | yes | **mark `perNode`** | per-node log dir |

##### `console-logging` — hub only

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `level` | system/src/builtins/console-logging/console-logging.addon.ts:55 | select | **cluster key / per-node effect** | yes | **mark `perNode`** | each node has its own stdout |

##### `loki-logging` — hub only

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `url` | system/src/builtins/loki-logging/loki-logging.addon.ts:171 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `level` | system/src/builtins/loki-logging/loki-logging.addon.ts:179 | select | **cluster key / per-node effect** | yes | **mark `perNode`** | each node ships its own logs |
| `job` | system/src/builtins/loki-logging/loki-logging.addon.ts:191 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `extraLabels` | system/src/builtins/loki-logging/loki-logging.addon.ts:198 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `tenantId` | system/src/builtins/loki-logging/loki-logging.addon.ts:207 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `username` | system/src/builtins/loki-logging/loki-logging.addon.ts:215 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `password` | system/src/builtins/loki-logging/loki-logging.addon.ts:222 | password | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `batchIntervalMs` | system/src/builtins/loki-logging/loki-logging.addon.ts:228 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `batchSize` | system/src/builtins/loki-logging/loki-logging.addon.ts:239 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `timeoutMs` | system/src/builtins/loki-logging/loki-logging.addon.ts:249 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |

##### `metrics-native` — hub **and every agent node**

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `samplingIntervalMs` | system/src/builtins/native-metrics/native-metrics.addon.ts:711 | number | **cluster key / per-node effect** | yes | **mark `perNode`** | onInitialize runs on every node |
| `loadSeriesCadenceSec` | system/src/builtins/native-metrics/native-metrics.addon.ts:728 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `loadSeriesRetentionHours` | system/src/builtins/native-metrics/native-metrics.addon.ts:740 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `load-series-cost` | system/src/builtins/native-metrics/native-metrics.addon.ts:752 | info | display | display | keep (display) | `type: info` — no persisted value |
| `load-series-cap` | system/src/builtins/native-metrics/native-metrics.addon.ts:759 | info | display | display | keep (display) | `type: info` — no persisted value |

##### `snapshot` — hub only

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `staleTtlMs` | system/src/builtins/snapshot/snapshot.addon.ts:1068 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |

##### `alert-center` — hub only

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `maxAlerts` | system/src/builtins/alerts/alerts.addon.ts:196 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `retentionDays` | system/src/builtins/alerts/alerts.addon.ts:206 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |

##### `system-config` — hub only

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `server-restart-note` | system/src/builtins/system-config/system-config.addon.ts:83 | info | display | display | keep (display) | `type: info` — no persisted value |
| `port` | system/src/builtins/system-config/system-config.addon.ts:90 | text | cluster-wide | readout | keep (not a knob) | read at bootstrap main.ts:297; UI disabled |
| `host` | system/src/builtins/system-config/system-config.addon.ts:97 | text | cluster-wide | readout | keep (not a knob) | read at bootstrap main.ts:298; UI disabled |
| `dataPath` | system/src/builtins/system-config/system-config.addon.ts:104 | text | cluster-wide | readout | keep (not a knob) | read at bootstrap boot-config.ts:218; UI disabled |
| `tokenExpiry` | system/src/builtins/system-config/system-config.addon.ts:120 | text | cluster-wide | **NO** | **delete-dead** | AuthManager reader whitelist drops it, local-auth.addon.ts:104 |

##### `local-network` — hub only; also on System→Local Access

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `httpEnabled` | system/src/builtins/local-network/local-network.addon.ts:426 | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `httpPort` | system/src/builtins/local-network/local-network.addon.ts:433 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `localHostname` | system/src/builtins/local-network/local-network.addon.ts:444 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |

##### `ai` — hub **and every agent node**

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `chatRetentionMaxAgeDays` | addon-ai/src/addon.ts:75 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `chatRetentionMaxCount` | addon-ai/src/addon.ts:84 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |

##### `auth-magic-link` — hub only

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `enabled` | addon-auth/src/magic-link/auth-magic-link.addon.ts:183 | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `displayName` | addon-auth/src/magic-link/auth-magic-link.addon.ts:191 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `icon` | addon-auth/src/magic-link/auth-magic-link.addon.ts:195 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `publicOrigin` | addon-auth/src/magic-link/auth-magic-link.addon.ts:198 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `deliveryMode` | addon-auth/src/magic-link/auth-magic-link.addon.ts:206 | select | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `defaultRole` | addon-auth/src/magic-link/auth-magic-link.addon.ts:218 | select | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `ttlSec` | addon-auth/src/magic-link/auth-magic-link.addon.ts:228 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |

##### `auth-oidc` — hub only

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `providers` | addon-auth/src/oidc/auth-oidc.addon.ts:251 | editable-array | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |

##### `auth-webauthn` — hub only

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `rpName` | addon-auth/src/webauthn/auth-webauthn.addon.ts:171 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `rpID` | addon-auth/src/webauthn/auth-webauthn.addon.ts:178 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `origin` | addon-auth/src/webauthn/auth-webauthn.addon.ts:186 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `challengeTtlSec` | addon-auth/src/webauthn/auth-webauthn.addon.ts:194 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |

##### `cloudflare-tunnel` — hub only; also on Integrations

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `mode` | addon-cloudflare/src/tunnel/cloudflare-tunnel.addon.ts:842 | select | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `localHost` | addon-cloudflare/src/tunnel/cloudflare-tunnel.addon.ts:862 | addon-action-select | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `customHelp` | addon-cloudflare/src/tunnel/cloudflare-tunnel.addon.ts:887 | info | display | display | keep (display) | `type: info` — no persisted value |
| `customApiToken` | addon-cloudflare/src/tunnel/cloudflare-tunnel.addon.ts:907 | password | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `customZoneId` | addon-cloudflare/src/tunnel/cloudflare-tunnel.addon.ts:915 | addon-action-select | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `customHostname` | addon-cloudflare/src/tunnel/cloudflare-tunnel.addon.ts:929 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `localPortMode` | addon-cloudflare/src/tunnel/cloudflare-tunnel.addon.ts:939 | select | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `localPort` | addon-cloudflare/src/tunnel/cloudflare-tunnel.addon.ts:960 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `noTLSVerify` | addon-cloudflare/src/tunnel/cloudflare-tunnel.addon.ts:972 | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `originServerName` | addon-cloudflare/src/tunnel/cloudflare-tunnel.addon.ts:981 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `httpHostHeader` | addon-cloudflare/src/tunnel/cloudflare-tunnel.addon.ts:991 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `pruneStaleTunnelsAction` | addon-cloudflare/src/tunnel/cloudflare-tunnel.addon.ts:1001 | addon-action-button | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `debugHelp` | addon-cloudflare/src/tunnel/cloudflare-tunnel.addon.ts:1025 | info | display | display | keep (display) | `type: info` — no persisted value |
| `debugLogging` | addon-cloudflare/src/tunnel/cloudflare-tunnel.addon.ts:1036 | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `protocol` | addon-cloudflare/src/tunnel/cloudflare-tunnel.addon.ts:1044 | select | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |

##### `cloudflare-turn` — hub only; also on Integrations

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `turnHelp` | addon-cloudflare/src/turn/cloudflare-turn.addon.ts:64 | info | display | display | keep (display) | `type: info` — no persisted value |
| `accountId` | addon-cloudflare/src/turn/cloudflare-turn.addon.ts:88 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `apiToken` | addon-cloudflare/src/turn/cloudflare-turn.addon.ts:97 | password | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `testCredentials` | addon-cloudflare/src/turn/cloudflare-turn.addon.ts:106 | addon-action-button | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `usageHelp` | addon-cloudflare/src/turn/cloudflare-turn.addon.ts:117 | info | display | display | keep (display) | `type: info` — no persisted value |

##### `decoder-nodeav` — hub **and every agent node**; also on Pipeline→node

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `hwaccel` | addon-decoder-nodeav/src/addon/index.ts:133 | select | **per-node** | yes | **keep-here** | `perNode: true` at declaration |
| `probedBestHwaccel` | addon-decoder-nodeav/src/addon/index.ts:144 | text | **per-node** | readout | keep (not a knob) | auto-seed gate, addon/index.ts:217 |

##### `export-alexa` — hub only; also on Integrations

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `__setup-banner` | addon-export-alexa/src/export-alexa.addon.ts:1120 | info | display | display | keep (display) | `type: info` — no persisted value |
| `publicHubUrl` | addon-export-alexa/src/export-alexa.addon.ts:1131 | select | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `__redetect-hub-url` | addon-export-alexa/src/export-alexa.addon.ts:1140 | button | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `skillMode` | addon-export-alexa/src/export-alexa.addon.ts:1150 | select | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `region` | addon-export-alexa/src/export-alexa.addon.ts:1166 | select | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `__public-skill-info` | addon-export-alexa/src/export-alexa.addon.ts:1207 | info | display | display | keep (display) | `type: info` — no persisted value |
| `__alexa-link-status` | addon-export-alexa/src/export-alexa.addon.ts:1225 | info | display | display | keep (display) | `type: info` — no persisted value |
| `__unlink-alexa-accounts` | addon-export-alexa/src/export-alexa.addon.ts:1237 | button | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `__resync-discovery` | addon-export-alexa/src/export-alexa.addon.ts:1249 | button | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `staleEndpointPurgeInput` | addon-export-alexa/src/export-alexa.addon.ts:1259 | textarea | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `__purge-stale-endpoints` | addon-export-alexa/src/export-alexa.addon.ts:1268 | button | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `__ingress-token-info` | addon-export-alexa/src/export-alexa.addon.ts:1280 | info | display | display | keep (display) | `type: info` — no persisted value |
| `__regenerate-ingress-token` | addon-export-alexa/src/export-alexa.addon.ts:1288 | button | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `enforceIngressToken` | addon-export-alexa/src/export-alexa.addon.ts:1298 | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |

##### `export-hap` — hub only; also on Integrations

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `bridgeName` | addon-export-hap/src/hap-export.addon.ts:1004 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| ~~`port`~~ | addon-export-hap/src/hap-export.addon.ts:1014 | number | — | — | **removed 2026-10-07** | never read: the bridge and every standalone accessory publish on an ephemeral port |
| `fixedPin` | addon-export-hap/src/hap-export.addon.ts:1024 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `interfaceName` | addon-export-hap/src/hap-export.addon.ts:1034 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `ptzPulseMs` | addon-export-hap/src/hap-export.addon.ts:1044 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |

##### `import-alexa` — hub only; also on Integrations

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `accountHelp` | addon-import-alexa/src/addon.ts:495 | info | display | display | keep (display) | `type: info` — no persisted value |
| `proxyLogin.proxyHost` | addon-import-alexa/src/addon.ts:518 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `proxyLogin.proxyPort` | addon-import-alexa/src/addon.ts:524 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |

##### `matter-broker` — hub only; also on Integrations

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `fabricHelp` | addon-matter-broker/src/addon.ts:381 | info | display | display | keep (display) | `type: info` — no persisted value |

##### `model-studio` — hub **and every agent node**

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `plusCatalogPlusApiKey` | addon-model-studio/src/model-studio.addon.ts:230 | password | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |

##### `mqtt-broker` — hub only; also on Integrations

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `brokers` | addon-mqtt-broker/src/mqtt-broker.addon.ts:1262 | editable-array | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `embeddedEnabled` | addon-mqtt-broker/src/mqtt-broker.addon.ts:1305 | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `embeddedPort` | addon-mqtt-broker/src/mqtt-broker.addon.ts:1314 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `embeddedAllowAnonymous` | addon-mqtt-broker/src/mqtt-broker.addon.ts:1324 | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `embeddedUsername` | addon-mqtt-broker/src/mqtt-broker.addon.ts:1333 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `embeddedPassword` | addon-mqtt-broker/src/mqtt-broker.addon.ts:1342 | password | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `embeddedClients` | addon-mqtt-broker/src/mqtt-broker.addon.ts:1360 | editable-array | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `embeddedAcl` | addon-mqtt-broker/src/mqtt-broker.addon.ts:1391 | editable-array | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |

##### `osd-manager` — hub only

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `tickSeconds` | addon-osd-manager/src/addon.ts:214 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |

##### `pipeline-runner` — hub **and every agent node**; also on Pipeline→node

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `maxConcurrentInferences` | addon-pipeline/src/pipeline-runner/index.ts:4839 | slider | **cluster key / per-node effect** | yes | **mark `perNode`** | per-node semaphore |
| `maxQueueDepth` | addon-pipeline/src/pipeline-runner/index.ts:4853 | slider | **cluster key / per-node effect** | yes | **mark `perNode`** | per-node queue |
| `targetLoadPercent` | addon-pipeline/src/pipeline-runner/index.ts:4864 | slider | **cluster key / per-node effect** | yes | **mark `perNode`** | per-node governor |
| `minThrottledFps` | addon-pipeline/src/pipeline-runner/index.ts:4876 | slider | **cluster key / per-node effect** | yes | **mark `perNode`** | per-node governor |
| `maxConcurrentDecodeSpawns` | addon-pipeline/src/pipeline-runner/index.ts:4887 | slider | **cluster key / per-node effect** | yes | **mark `perNode`** | per-node spawn gate |
| `maxLiveDecodeWorkers` | addon-pipeline/src/pipeline-runner/index.ts:4899 | slider | **cluster key / per-node effect** | yes | **mark `perNode`** | per-node worker pool |
| `nodeDecodeBudgetMb` | addon-pipeline/src/pipeline-runner/index.ts:4911 | slider | **cluster key / per-node effect** | yes | **mark `perNode`** | that host's RAM |

##### `detection-pipeline` — hub **and every agent node**; also on Pipeline→node

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `activeModelSubstitutions` | addon-pipeline/src/detection-pipeline/index.ts:378 | text | cluster-wide | readout | keep (not a knob) | write-only readout, index.ts:553 |
| `batchMode` | addon-pipeline/src/detection-pipeline/index.ts:407 | select | **per-node** | yes | **keep-here** | `perNode: true` at declaration |
| `windowMs` | addon-pipeline/src/detection-pipeline/index.ts:431 | slider | **per-node** | yes | **keep-here** | `perNode: true` at declaration |
| `maxBatchSize` | addon-pipeline/src/detection-pipeline/index.ts:449 | slider | **per-node** | yes | **keep-here** | `perNode: true` at declaration |
| `concurrency` | addon-pipeline/src/detection-pipeline/index.ts:469 | slider | **per-node** | yes | **keep-here** | `perNode: true` at declaration |
| `numWorkers` | addon-pipeline/src/detection-pipeline/index.ts:488 | slider | **per-node** | yes | **keep-here** | `perNode: true` at declaration |

##### `audio-analyzer` — hub **and every agent node**; also on Pipeline→node

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `probedBestAudioBackend` | addon-pipeline/src/audio-analyzer/addons/analyzer/index.ts:632 | text | **per-node** | readout | keep (not a knob) | self-seeding probe readout, index.ts:846 |
| `audioBackend` | addon-pipeline/src/audio-analyzer/addons/analyzer/index.ts:653 | select | **cluster key / per-node effect** | yes | **mark `perNode`** | each node resolves 'auto' against its own platform |
| `selectedAudioModel` | addon-pipeline/src/audio-analyzer/addons/analyzer/index.ts:661 | select | cluster-wide | **NO** | **delete-dead** | never reaches inference; audio-pipeline.ts:80 takes no model id |

##### `stream-broker` — hub **and every agent node**

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `defaultPreBufferSec` | addon-pipeline/src/stream-broker/addon.ts:1165 | number | **cluster key / per-node effect** | yes | **mark `perNode`** | each node's broker ring |
| `rtspPort` | addon-pipeline/src/stream-broker/addon.ts:1176 | number | **cluster key / per-node effect** | yes | **mark `perNode`** | each node binds its own port |
| `maxDecodeFps` | addon-pipeline/src/stream-broker/addon.ts:1186 | number | cluster-wide | **NO** | **delete-dead** | no consumer; addon.ts:101/263/1186 only |
| `hwaccel` | addon-pipeline/src/stream-broker/addon.ts:1196 | select | **per-node** | yes | **keep-here** | `perNode: true` at declaration |
| `binaryPath` | addon-pipeline/src/stream-broker/addon.ts:1209 | text | **per-node** | yes | **keep-here** | `perNode: true` at declaration |
| `joinBurstMaxSpanMs` | addon-pipeline/src/stream-broker/addon.ts:1219 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `preRollMs` | addon-pipeline/src/stream-broker/addon.ts:1231 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `recordingPreRollMs` | addon-pipeline/src/stream-broker/addon.ts:1243 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `catalogReconcileIntervalSec` | addon-pipeline/src/stream-broker/addon.ts:1255 | number | **cluster key / per-node effect** | yes | **mark `perNode`** | per-node timer |
| `initialReconnectDelayMs` | addon-pipeline/src/stream-broker/addon.ts:1276 | number | cluster-wide | **NO** | **delete-dead** | backoff hardcoded stream-broker.ts:81 |
| `maxReconnectDelayMs` | addon-pipeline/src/stream-broker/addon.ts:1287 | number | cluster-wide | **NO** | **delete-dead** | backoff hardcoded stream-broker.ts:82 |

##### `recorder` — hub **and every agent node**

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `recordingNodeId` | addon-pipeline/src/recorder/addon/index.ts:2099 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `recordingHubHostname` | addon-pipeline/src/recorder/addon/index.ts:2107 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |

##### `pipeline-orchestrator` — hub only; also on Pipeline→Cluster Settings

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `ingestNode` | addon-pipeline-orchestrator/src/settings-ui-schemas.ts:93 | node-select | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `audioNode` | addon-pipeline-orchestrator/src/settings-ui-schemas.ts:102 | node-select | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `motionNode` | addon-pipeline-orchestrator/src/settings-ui-schemas.ts:111 | node-select | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `fpsMinThreshold` | addon-pipeline-orchestrator/src/settings-ui-schemas.ts:128 | slider | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `nodeStressMode` | addon-pipeline-orchestrator/src/settings-ui-schemas.ts:141 | select | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `fpsLowWindowMs` | addon-pipeline-orchestrator/src/settings-ui-schemas.ts:154 | slider | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `clusterModel:face-embedding` | (computed key) | select | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `clusterModel:clip-embedding` | (computed key) | select | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `clusterStepSetting:face-embedding:minLandmarkFaceSize` | (computed key) | slider | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `detailCropPaddingRatio` | (computed key) | slider | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `detailCropSquare` | (computed key) | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `nativeLeaseHoldFrames` | (computed key) | slider | **cluster key / per-node effect** | yes | **mark `perNode`** | consumed per decode worker (per-node RAM) |
| `nativeTileBudgetMb` | (computed key) | slider | **cluster key / per-node effect** | yes | **mark `perNode`** | per decode worker |
| `nativeSceneBudgetMb` | (computed key) | slider | **cluster key / per-node effect** | yes | **mark `perNode`** | per decode worker |
| `nativeLeaseBudgetMb` | (computed key) | slider | **cluster key / per-node effect** | yes | **mark `perNode`** | per decode worker |
| `nativeLeaseActivityMs` | (computed key) | slider | **cluster key / per-node effect** | yes | **mark `perNode`** | per decode worker |
| `nativeLeaseAdmission` | (computed key) | select | **cluster key / per-node effect** | yes | **mark `perNode`** | per decode worker |
| `onDisconnect` | addon-pipeline-orchestrator/src/settings-ui-schemas.ts:336 | select | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `pinnedOnDisconnect` | addon-pipeline-orchestrator/src/settings-ui-schemas.ts:349 | select | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `onReconnect` | addon-pipeline-orchestrator/src/settings-ui-schemas.ts:359 | select | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |

##### `embedding-encoder` — hub **and every agent node**

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `modelId` | addon-post-analysis/src/embedding-encoder/addon/index.ts:343 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `runtime` | addon-post-analysis/src/embedding-encoder/addon/index.ts:350 | select | cluster-wide | **NO** | **delete-dead** | log tag only, addon/index.ts:273 |
| `backend` | addon-post-analysis/src/embedding-encoder/addon/index.ts:361 | select | cluster-wide | **NO** | **delete-dead** | log tag only, addon/index.ts:274 |

##### `pipeline-analytics` — hub **and every agent node**; also on Pipeline→Cluster Settings (face cap)

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `postProcessingNodeId` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:183 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `embeddingEnabled` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:191 | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `rebuildEmbeddingsButton` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:217 | addon-action-button | cluster-wide | readout | keep (not a knob) | action key inert; action embedding.rebuild is live |
| `rebuildStatusButton` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:229 | addon-action-button | cluster-wide | readout | keep (not a knob) | action key inert; action live |
| `wipeEmbeddingsButton` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:241 | addon-action-button | cluster-wide | readout | keep (not a knob) | action key inert; action live |
| `saveThumbnails` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:282 | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `snapshotIntervalMs` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:289 | slider | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `snapshotMovementThreshold` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:302 | slider | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `snapshotMaxIdleMs` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:316 | slider | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `mediaAttachPolicy` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:330 | select | cluster-wide | **NO** | **delete-dead** | not in MediaSettingsSchema; never resolved |
| `audioMetricsReportEnabled` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:351 | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `audioMetricsReportThresholdDb` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:359 | slider | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `retentionMode` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:381 | select | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `trackRetentionDays` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:396 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `packageDropEnabled` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:417 | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `packageDropPickupEnabled` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:425 | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `packageDropMinFrames` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:432 | slider | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `packageDropDwellSec` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:444 | slider | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `packageDropMinBboxAreaFrac` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:457 | slider | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `packageDropMaxBboxAreaFrac` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:469 | slider | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `packageDropActivityWindowSec` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:481 | slider | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `classificationMinScore` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:502 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `levelDeviationDb` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:512 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `levelWindowSec` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:522 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `levelMaxWaitSec` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:532 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `audioMarkerEnabled` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:551 | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `audioMarkerBaselineSec` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:559 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `audioMarkerMinDbfs` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:570 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `audioMarkerMinDeviations` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:582 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `audioMarkerMinDeviationDb` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:592 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `audioMarkerMotionQuietSec` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:603 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `audioMarkerCooldownSec` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:614 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `audioMarkerMaxPerHour` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:624 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `audioMarkerMaxPerDay` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:633 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `audioEpisodeEnabled` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:652 | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `audioEpisodeOpenHoldSec` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:660 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `audioEpisodeCloseGapSec` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:671 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `audioEpisodeCooldownSec` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:682 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `enabled` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:552 | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `similarityThreshold` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:709 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `margin` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:720 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `minFaceConfidence` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:731 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `minFacePx` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:741 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `recognitionMinFacePx` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:752 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `suggestionThresholdReadout` | (computed key) | text | cluster-wide | readout | keep (not a knob) | injected per render, index.ts:13040 |
| `minIdentitySamples` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:779 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `confirmFrames` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:789 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `maxEmbeddingMagnitude` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:802 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `bufferMaxPerDevice` | addon-post-analysis/src/pipeline-analytics/settings-schema.ts:812 | number | cluster-wide | **NO** | **delete-dead** | prune uses FACE_DEFAULTS constant, index.ts:9536 |
| `minTrackAge` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:29 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `cooldownSec` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:38 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `minHits` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:48 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `stationaryThresholdSec` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:57 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `confirmationGateEnabled` | (computed key) | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `confirmationGateMinConfidence` | (computed key) | slider | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `confirmationGateMinCropPx` | (computed key) | slider | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `confirmationGateTimeoutMs` | (computed key) | slider | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `confirmationGateMaxDeferralMs` | (computed key) | slider | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `confirmationGateMaxAttempts` | (computed key) | slider | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `iouThreshold` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:156 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `maxMissedMs` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:167 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `minTrackAgeMs` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:178 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `resurrectionWindowMs` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:189 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `rescueIouThreshold` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:200 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `rescueCentroidFactor` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:211 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `stationarySpeedPx` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:221 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `maxTrackLifetimeSec` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:232 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `predictiveCoasting` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:243 | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `classGating` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:251 | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `occlusionEnabled` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:258 | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `occlusionContainment` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:266 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `occlusionMaxMissedMs` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:276 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `dedupEnabled` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:286 | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `dedupSpawnIou` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:294 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `dedupMergeIou` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:305 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `dedupMergeFrames` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:316 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `personAnimalDedup` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:326 | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `animalOverPersonMaxScore` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:334 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `animalOverPersonIou` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:345 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `dropoutSkipEnabled` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:356 | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `dropoutMaxSkipFrames` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:364 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `classVotingEnabled` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:374 | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `classVoteMinFraction` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:382 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `perClassMinScoreEnabled` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:393 | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `minScorePerson` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:401 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `minScoreAnimal` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:411 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `minScoreVehicle` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:422 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `confirmBypassEnabled` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:433 | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `confirmBypassScore` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:441 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `byteTrackEnabled` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:452 | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `byteTrackHighThreshold` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:460 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `byteTrackLowIouThreshold` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:471 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `minSpawnAreaEnabled` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:482 | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `minSpawnAreaFracPerson` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:490 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `minSpawnAreaFracAnimal` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:501 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `minSpawnAreaFracVehicle` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:512 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `classGroupAssoc` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:523 | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `zoneMembershipMinOverlap` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:531 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `enabled` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:552 | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `suppressIou` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:560 | slider | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `wakeAssocIou` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:572 | slider | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `promotionWindowMs` | (computed key) | slider | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `entryTtlMs` | addon-post-analysis/src/pipeline-analytics/settings-schema-sections.ts:606 | slider | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |

##### `provider-dreame` — hub only; also on Device→Provider Settings

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `username` | addon-provider-dreame/src/config.ts:105 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `password` | addon-provider-dreame/src/config.ts:112 | password | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `region` | addon-provider-dreame/src/config.ts:127 | select | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `pollIntervalMs` | addon-provider-dreame/src/config.ts:141 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |

##### `provider-dreo` — hub only; also on Device→Provider Settings

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `email` | addon-provider-dreo/src/config.ts:96 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `password` | addon-provider-dreo/src/config.ts:103 | password | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `region` | addon-provider-dreo/src/config.ts:118 | select | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |

##### `provider-homeassistant` — hub only; also on Device→Provider Settings; Integrations

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `brokerHelp` | addon-provider-homeassistant/src/addon.ts:447 | info | display | display | keep (display) | `type: info` — no persisted value |

##### `homeassistant-export` — hub only; also on Integrations

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `exportTo:ha_001` | (computed key) | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `publicBaseUrl` | addon-provider-homeassistant/src/ha-export/ha-export.addon.ts:2776 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `reconcileIntervalSec` | addon-provider-homeassistant/src/ha-export/ha-export.addon.ts:2784 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |

##### `provider-homematic` — hub only; also on Device→Provider Settings; Integrations

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `brokerHelp` | addon-provider-homematic/src/addon.ts:580 | info | display | display | keep (display) | `type: info` — no persisted value |

##### `provider-petkit` — hub only; also on Device→Provider Settings

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `email` | addon-provider-petkit/src/config.ts:143 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `password` | addon-provider-petkit/src/config.ts:150 | password | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `region` | addon-provider-petkit/src/config.ts:165 | select | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `timezone` | addon-provider-petkit/src/config.ts:179 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `pollIntervalMs` | addon-provider-petkit/src/config.ts:186 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |

##### `provider-reolink` — hub only; also on Device→Provider Settings

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `emailPushEnabled` | addon-provider-reolink/src/email-push-schema.ts:29 | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `emailPushRecommendedHost` | addon-provider-reolink/src/email-push-schema.ts:35 | info | display | readout | keep (not a knob) | info field built from listLanHosts() |
| `emailPushPort` | addon-provider-reolink/src/email-push-schema.ts:41 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `emailPushDomain` | addon-provider-reolink/src/email-push-schema.ts:49 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `emailPushRequireAuth` | addon-provider-reolink/src/email-push-schema.ts:65 | boolean | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `emailPushAuthUsername` | addon-provider-reolink/src/email-push-schema.ts:71 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `emailPushAuthPassword` | addon-provider-reolink/src/email-push-schema.ts:76 | password | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |

##### `provider-tuya` — hub only; also on Device→Provider Settings

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `accessId` | addon-provider-tuya/src/config.ts:106 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `accessSecret` | addon-provider-tuya/src/config.ts:113 | password | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `region` | addon-provider-tuya/src/config.ts:127 | select | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `discoveryTimeoutMs` | addon-provider-tuya/src/config.ts:134 | number | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |

##### `provider-wyze` — hub only; also on Device→Provider Settings

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `email` | addon-provider-wyze/src/settings-schema.ts:22 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `password` | addon-provider-wyze/src/settings-schema.ts:29 | password | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `apiKey` | addon-provider-wyze/src/settings-schema.ts:36 | password | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |
| `apiId` | addon-provider-wyze/src/settings-schema.ts:43 | text | cluster-wide | yes | **move** → cluster surface | no `perNode` ⇒ one blob for the cluster (base-addon.ts:343) |

##### `terminal` — hub **and every agent node**; also on System→Terminal

| Key | Declared at | Type | True scope | Read? | Verdict | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `maxSessions` | addon-terminal/src/addon.ts:788 | number | **per-node** | yes | **keep-here** | `perNode: true` at declaration |
| `btmEnabled` | addon-terminal/src/addon.ts:811 | boolean | **per-node** | yes | **keep-here** | `perNode: true` at declaration |
| `btmPath` | addon-terminal/src/addon.ts:819 | text | **per-node** | yes | **keep-here** | `perNode: true` at declaration |
| `btmArgs` | addon-terminal/src/addon.ts:829 | tags | **per-node** | yes | **keep-here** | `perNode: true` at declaration |
| `topEnabled` | addon-terminal/src/addon.ts:846 | boolean | **per-node** | yes | **keep-here** | `perNode: true` at declaration |
| `topPath` | addon-terminal/src/addon.ts:854 | text | **per-node** | yes | **keep-here** | `perNode: true` at declaration |
| `topArgs` | addon-terminal/src/addon.ts:862 | tags | **per-node** | yes | **keep-here** | `perNode: true` at declaration |
| `glancesEnabled` | addon-terminal/src/addon.ts:880 | boolean | **per-node** | yes | **keep-here** | `perNode: true` at declaration |
| `glancesPath` | addon-terminal/src/addon.ts:888 | text | **per-node** | yes | **keep-here** | `perNode: true` at declaration |
| `glancesArgs` | addon-terminal/src/addon.ts:898 | tags | **per-node** | yes | **keep-here** | `perNode: true` at declaration |
| `allowShell` | addon-terminal/src/addon.ts:916 | boolean | **per-node** | yes | **keep-here** | `perNode: true` at declaration |
| `shellPath` | addon-terminal/src/addon.ts:924 | text | **per-node** | yes | **keep-here** | `perNode: true` at declaration |
| `customProfiles` | addon-terminal/src/addon.ts:943 | editable-array | **per-node** | yes | **keep-here** | `perNode: true` at declaration |