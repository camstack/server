---
title: Automations, scripts and composed devices — the assessment, the one noun that replaces wiring, and the "Build-your-self" page
date: 2026-08-08
status: Phases 1-3 BUILT 2026-08-08. Phase 1 (the `DeclaredDevices` ownership primitive) is live on the hub; Phase 2 (delete the wiring) is committed and train-bound; Phase 3 (`/build` + Scripts) is committed and train-bound. Phases 4-7 not started. The wiring measurement was RE-RUN on 2026-08-08 before the deletion — 302 devices, 0 `deviceLinks`, 0 `kind:'linked'` bindings, 0 read errors. Operator UX decisions of 2026-08-08 morning folded in (Part 3); the operator's answers of the same afternoon closed EVERY open question on the active plan (route `/build`, no test button on scripts, "Run actions" on automations, algebra concept approved, the block name is the authority, `vars` IN v1, a deleted source fails the composite visibly) and DEFERRED device customization in full (Part 4, now at the end under "Deferred — future work", with its two questions deferred with it).
applies-to:
  - packages/system/src/builtins/core-blocks/**
  - packages/types/src/expression/**
  - packages/types/src/capabilities/device-manager.cap.ts
  - packages/types/src/capabilities/core-blocks.cap.ts
  - packages/types/src/capabilities/device-export.cap.ts
  - packages/types/src/capabilities/notification-rules.cap.ts
  - packages/addon-admin-ui/src/pages/Build.tsx
  - packages/addon-admin-ui/src/pages/build/**
  - packages/addon-admin-ui/src/pages/DeviceDetail.tsx
---

# Automations, scripts and composed devices

The operator's request, paraphrased: *establish the real state of automation
blocks, scripts, and custom device creation + wiring; I believe wiring should be
eliminated entirely in favour of creating custom devices composed from other
devices or from custom scripts. Practically a new chapter.*

This document does the assessment first, because the assessment changes the
proposal. Three things in the premise turn out to be wrong about the code, one
turns out to be righter than expected, and one measurement settles the question
that the design was going to have to argue about.

**Later the same day the operator settled the surface.** The page is called
**"Build-your-self"**, it lives at **`/build`**, and it holds three sections —
Automations, Scripts, Custom Device. That is Part 3; it **specialises** the "one
noun: the block" model of Part 2 rather than replacing it.

**A fourth family — *device customization* — was designed and is now DEFERRED.**
Operator, 2026-08-08 afternoon: *"ci lavoriamo in futuro."* The analysis is kept
verbatim under [Deferred — future work](#deferred--future-work) at the end of
this document (it is still Part 4, and every `§4.x` reference in the text still
points at it), because it is where the model gets its sharpest test and that test
should not have to be re-derived. Nothing about it is on the active plan: the
three customization families whose authorities **already exist**
(`setType`/`setRole`, `setDisplay`, `device-export`) stay **unexposed** until the
operator reopens the chapter. The open question it strains the model with (§2.0)
is deferred with it, not answered.

**The measurement.** On the live cluster, 2026-08-08: **302 devices, 0 of them
carry a single `deviceLink`.** The wiring UI has been mounted on the device
detail page since 2026-07-04. Nobody has ever used it. Deleting it breaks
nothing, and no migration of operator data is required — only one in-repo
producer has to move.

---

## Part 1 — Assessment

### 1.0 The table

| Area | What actually exists | State | Live usage on the cluster (2026-08-08) |
| --- | --- | --- | --- |
| **Automation engine (generic)** | Nothing. `pages/build/AutomationsTab.tsx` ships *declared empty* with an explainer | **does not exist, on purpose** | — |
| **NC rule engine** | `notification-rules` cap (1398 l) + `rule-engine.ts` — 4 trigger kinds, 22-entry condition catalog, `{wait\|cap}` action sequences | shipped, the only thing that evaluates and fires | **5 rules, 4 enabled.** ZERO use `actions`; ZERO use buttons. Only the notify half is exercised |
| **`automation-control` cap** | Device cap modelling *Home Assistant's* `automation.*` — `enable`/`disable`/`trigger` | shipped, mirrors somebody else's engine | **0 providers live.** No HA automation entity has been imported |
| **`script-runner` cap** | Device cap modelling *HA's* `script.*` — `run({variables})`/`stop` | shipped, same | **0 providers live** |
| **Core blocks ("Scripts")** | `core-blocks` cap + kernel table `core_blocks` + esbuild → materialised addon package → forked runner under `CrashSupervisor`; Monaco editor against the real `.d.ts` | **shipped 2026-08-05, hub-only.** The genuine user-code surface | **0 blocks.** Never used |
| **REPL** | `repl.execute` core router, `node:vm`, 5 s timeout, admin-only | shipped, dev tooling. Explicitly *not* a security boundary | ad hoc |
| **Terminal** | `terminal-session` cap, real pty, profile allowlist; `shell` profile default OFF | shipped, hub-only, own runner | present |
| **Custom actions** | `defineCustomActions()`, dispatched via `addons.custom` | shipped, ~10 catalogs — but **developer-authored, in an addon bundle**. No runtime authoring, no storage, and **no event can trigger one** | operator buttons only |
| **Expression engine** | `packages/types/src/expression/**` — Pratt parser, whitelisted AST, no member access, no loops, bounded (2 KB / 256 nodes / 4096 steps) | shipped, correct, **single consumer: the wiring link source** | 0 (see below) |
| **Custom / virtual device creation** | Every create path is `(addonId, integrationId)`-scoped off `IntegrationDetail.tsx`. **No provider-agnostic "add a device"** | shipped for vendors only | 302 devices, all from 8 providers + 1 synthetic |
| **Device owned by a non-provider** | `ensureAlarmPanel` — a fixed integration + `ctx.kernel.devices.create` from `pipeline-analytics`, which is *not* a device provider | **works, and it is the proof of the whole design.** The generic primitive the spec called for (`ctx.devices.declare`) was **never extracted** | **1 device live: id 1023 `nc-alarm-panel`, integration `int_0018`** |
| **Virtual doorbell** | Wrapper provider for the `doorbell` cap; reads other devices' state, projects a cap onto a **camera** | shipped, and the live precedent for cross-device composition | **bound on camera 101**, feeding NC rule "Campanello (front door)" [Doorbell (entrance)] |
| **Wiring / `deviceLinks`** | 4 source kinds (`field`/`literal`/`global`/`expression`), 3 transforms, cycle guard, virtual binding, read-overlay + push re-emit, `WiringTab` UI | **fully built and it works** | **0 links on 302 devices; 0 `kind:'linked'` bindings anywhere** |
| **`getLinkedDevices`** (a *different* thing) | camera ↔ companion association via `_linkedDevicesMode` / `_linkedDeviceIds` | shipped, used by analytics + camera detail | **2 devices** (104, 101), both `mode: auto` |
| **Scheduling** | `croner` — backups only. `NcSchedule` weekly windows used as a *condition*, never a trigger. NC timelapse has a window state machine with **no tick, no CRUD, no UI** | one real scheduler, one half-built | backups only |

### 1.1 Automation blocks — there is no automation engine, and that is deliberate

Nothing in the repo is called an automation addon; no `camstack.addons[]` entry
mentions one. `packages/addon-admin-ui/src/pages/build/AutomationsTab.tsx`
(`pages/automation/` until Phase 3 renamed the directory) renders an explainer
saying so, on the operator's 2026-08-04 decision that an
automation must not become a second notification-rule engine.

The only thing that evaluates a condition and fires is the Notification Center:

- Cap `packages/types/src/capabilities/notification-rules.cap.ts`; engine
  `packages/addon-post-analysis/src/notification-center/rule-engine.ts`.
- **Triggers are 4, and the enum is declared frozen** —
  `['immediate','track-end','device-event','package-event']`. Each is a
  *pipeline persistence moment*, not a device event. There is no device-state
  trigger, no time trigger, no manual trigger.
- **Conditions are a flat AND** of 22 catalog entries with machine-readable
  `group`/`valueType`/`operator` descriptors served over the wire, so both
  editors render from data. No OR, no nesting, no expression.
- **Actions are already generic**: `NcRuleActionSchema` =
  `{kind:'wait',seconds}` | `{kind:'cap',deviceId,cap,method,args}`, run by
  `NcRuleActionRunner` with a device-scope check, stop-at-first-failure and a
  per-sequence throttle. This is the piece worth reusing verbatim; it is also
  the piece nobody on this cluster has used yet.

Everything else wearing the vocabulary is not automation: `zone-rules` is a
pipeline gating filter with no action side; `motion-trigger` is a single boolean
that asks the *camera firmware* to flip a switch; `scene-monitor` produces a
state and actuates nothing (and is registered by no provider live).

### 1.2 Scripts — the user-code surface exists, is good, and has never been used

`core-blocks` is the real answer to "scripting", and it is better than the name
suggests. A block is TypeScript (≤ 200 KB) stored in the kernel table
`core_blocks`, transpiled with esbuild, **materialised on disk as a synthetic
addon package**, and forked by the ordinary addon runner with the ordinary UDS
`ctx` under `CrashSupervisor`. Author contract: `export default (ctx) => disposer`.

The cap's own docblock is the honest statement of what that means: *"a block has
an addon's powers … it is a plugin with no review step. What makes that
survivable is not a sandbox, it is process isolation."* All 8 methods are admin.

Two facts that matter for the design:

- **Execution is hub-only** (`core-blocks.addon.ts` refuses on a non-hub node),
  because `addon-runner` loads off local disk and nothing materialises the
  package on an agent. A prerequisite hazard must be closed first: the cap
  registers on every node while each node has its own settings store, so an
  agent's provider serves an empty list and shadows the hub's.
- **`coreBlocks.list` returns `{blocks: []}` on the live hub.** Shipped three
  days, zero adoption.

`script-runner` is *not* a script engine — it is the device cap for HA's
`script.*`. Notably it is device-scoped, so an NC rule action can already invoke
one: `{cap:'script-runner', method:'run', args:{variables}}`. That is the
existing bridge from a rule into arbitrary user logic.

There is exactly one `node:vm` in the repo (the REPL), exempted by name in
`scripts/check-no-dynamic-eval.ts`, which otherwise bans `eval`, `new Function`,
`vm2`, `isolated-vm` and `quickjs` repo-wide.

### 1.3 Custom devices — the primitive works and was never extracted

The kernel's device model already supports composition, and this is the single
most important fact in the assessment:

- A device is `(addonId, stableId) → numeric id` plus a persisted meta row. Its
  existence in `listAll` is the persisted index; nothing else gates it.
- **Capabilities are bound per device, from five independent sources**, each
  entry carrying its own `providerAddonId`/`providerNodeId`: persisted operator
  wrapper activations, `defaultActive` wrappers, hub-local natives, remote
  natives from forked/agent runners, and link-synthesised. `CapabilityRegistry`
  rejects only a duplicate `(cap, device)` pair. **One addon per (cap, device);
  N different addons across the caps of one device.** Camera 101 lives this
  today — `camera-streams` from `provider-hikvision`, `snapshot` from the
  snapshot wrapper, `doorbell` from `virtual-doorbell`, `motion-detection` from
  `motion-wasm`.
- **`ctx.kernel.devices.create()` is on every addon's kernel services, not only
  a `BaseDeviceProvider`'s.** `pipeline-analytics` — the addon that owns the
  whole pipeline and is emphatically not a device provider — owns device 1023,
  the NC alarm panel, under a *fixed* integration (`info.fixed = true`, no
  operator add/delete flow). Both exporters see it through their ordinary device
  mapping; nothing had to learn about alarms.

What does **not** exist:

- The generic surface the 2026-08-04 spec specified —
  `ctx.devices.declareIntegration()` / `ctx.devices.declare()` /
  `ctx.devices.setState()`. `declareIntegration` appears nowhere in the repo.
  The one caller inlines it as a hand-rolled `ensureAlarmPanel` with 8 injected
  deps, and it shipped with a real bug the file documents (`info.fixed` written
  only on the create path, so existing installs never received the flag).
- A provider-agnostic "add a device" UI. `AddDeviceDialog` and
  `AdoptDevicesModal` are mounted only from `IntegrationDetail.tsx`, both
  parameterised by `(addonId, integrationId)`. `Devices.tsx` has no add button.
- Any notion of a device *template*, or of `composite`/`synthetic` as a first
  class thing.

**The virtual doorbell** is the live precedent, and it is worth being precise
about what it is: a **wrapper cap provider**, not a device. It subscribes to
`DeviceStateChanged`, detects a false→true edge on a source device's cap with a
per-camera debounce, and projects the `doorbell` cap onto a *camera* — byte
identical to a native Reolink ring. It creates nothing; the doorbell has no row
and no id. It is the proof that cross-device derivation works and, in its own
D49/D72 scar tissue, the proof of how it fails: one fallible `getBindings` read
once looked exactly like an unbind and destroyed three real presses.

### 1.4 Wiring — it works; three parts of the premise are wrong; nobody uses it

The premise recorded on 2026-08-07 was: *"DeviceLink/wiring copies VALUES into a
status; no events/edge/debounce; its `devicesWithLinks` is itself an
unreconciled mirror; the right generalisation is `ctx.bindings.isBoundFor` in
the kernel."* Read against the code:

| Claim | Verdict |
| --- | --- |
| copies values into a status | **true, and it is the real problem** — see below |
| no events / edge / debounce | **wrong, and more wrong than it looks.** There are TWO resolution channels. Pull: the generated cap mount calls `resolveLinkedStatus` on every `getStatus`. Push: `DeviceStateMirror.applySingleCapUpdate` walks `linkDependents` and re-emits `DeviceStateChanged` for every dependent target — with **two** edge guards (`shallowEqual` on the source slice, `lastEmittedOverlay` on the emitted overlay) and a 1 s debounce on the disk write. The residual truth: a provider that only implements `getStatus` and never mirrors gets no push edge |
| `devicesWithLinks` is an unreconciled mirror | **the charge lands, for a different reason than stated.** It *is* maintained — warmed at boot from persisted meta (`device-manager.addon.ts:538-542`), added/removed on `setDeviceLinks` (`:768-769`) and `removeDevice` (`:392`). What makes it a hazard is that it is process-local, never re-read, and a miss returns `null` **silently** — indistinguishable from "this device has no links". That is exactly the D49 shape. Any write to the store that does not go through `setDeviceLinks` (a backup restore, a DB edit) leaves it stale until the next hub restart, and the overlay vanishes cluster-wide with no log line |
| `ctx.bindings.isBoundFor` is the generalisation | **it does not exist**, anywhere. `grep isBoundFor` and `grep "ctx.bindings"` both return zero. It was a proposal in conversation, never built |

The mechanism, accurately: `DeviceLink { id, source, target:{cap,fieldPath,itemKey?}, transform? }`
persisted on the **target** device's meta. Sources: `field` (a sibling
accessory), `literal`, `global` (any device, by re-sync-stable `stableId`),
`expression` (the bounded engine over N named bindings, no nesting). Transforms:
`identity` | `enum-map` | `linear`. Author-time cycle detection via DFS, plus a
`linkResolveInFlight` re-entrancy guard for cycles that only become resolvable
later. A misconfigured link never corrupts a response: `mergeLinkedStatus`
re-parses the merged object against the cap's status schema and discards the
whole overlay on failure.

`getBindings` grew a **fifth binding kind** (`kind:'linked'`, owner
`device-manager`) plus a *virtual binding* so a cap built entirely from links —
with no provider at all — still renders a panel and appears in the bindings
table.

**Storage.** There is no `device_links` table. Links are JSON inside the
device-manager builtin's settings blob: collection `addon-settings`, scoped
table `device-manager:addon-settings`, row key `deviceMeta`, shape
`{ [deviceIdString]: PersistedDeviceMeta }`. There is also **no ADR** for device
links — the design record is four specs under (planning repo: superpowers/specs)
(`2026-06-09-device-property-wiring-design.md`,
`2026-06-09-device-link-overlay-runtime-state-design.md`,
`2026-06-09-device-link-authoring-ui-design.md`,
`2026-07-04-wiring-p2e-crossdevice-source-design.md`).

**Why it should go anyway.** Not because it is broken. Because it is the wrong
granularity, in four ways that no amount of polish fixes:

1. **No identity.** A wired value's only handle is
   `(targetDeviceId, cap, fieldPath)` on *someone else's* device. It cannot be
   named, exported, gated, muted or reasoned about. It also means a second
   authority writes a field the provider owns — the field-level form of the sin
   D62 bans at feature level.
2. **Status only, no methods.** A mirrored switch shows its state and cannot be
   switched. Half a device, permanently.
3. **It cost the kernel a concept.** A fifth binding kind and a virtual-binding
   path exist solely so link-only caps render. A composed *device* needs none of
   that: its caps are native to it.
4. **Expressiveness dead end.** The expression engine is deliberately
   non-Turing — correct for what it is. Every real request beyond it (edge,
   debounce, latch, for-duration, schedule, "and then call this") is a step
   toward a second language living in a device meta blob.

And the empirical verdict, which is the one that settles it: **0 links across
302 devices, a month after the UI shipped.** The Wiring tab *is* rendered on
essentially every device — but `getWireableFields` on this cluster offers only
`device-status.online` and `feature-probe.*` as targets, which is close to
useless, so the tab reads as broken rather than as unused.

**Who would break — what the design docs claim, and what the cluster says.**
This deserves its own paragraph, because reading the code alone gives the wrong
answer. The 2026-06-09 specs and the surviving doc comments describe three live
dependencies: the HA container's `battery` cap synthesized entirely from sibling
entities; the Dreame vacuum's `vacuum-control.cleanWater/dirtyWater` tank fields
overlaid over a provider that returns nulls; and `consumables` item-array links.
On that reading, deleting wiring would take out low-battery alerting for every
HA device.

Checked against the live hub, per device:

| Claimed dependency | Live |
| --- | --- |
| HA container battery (device 1026 `Doorbell`) | **no `battery` binding at all.** Bindings are `device-status`/`feature-probe`/`device-ops`, all `native/provider-homeassistant` |
| Dreame vacuum tanks + consumables (devices 319, 409) | **`vacuum-control` and `consumables` are `kind:'native'`, provider `provider-dreame`.** Not overlaid, not synthesized |
| any `kind:'linked'` binding anywhere | **zero**, on every device inspected |

So the "what breaks" section that the code comments imply is, on this cluster,
**empty**. This is the exact failure mode CLAUDE.md warns about — a doc comment
that describes the right design and reads as verification. Do not delete wiring
on the strength of the comments either way; the measurement is the evidence.

The one thing that must still move is the only in-repo **writer**:
`HaContainerDevice.persistBatteryLinks()`
(`packages/addon-provider-homeassistant/src/devices/ha-container-device.ts:356`)
+ `buildBatteryLinks`. It is a provider-internal derivation that should never
have been a link — the container can compute the slice itself and
`setCapSlice` it. Live it produces nothing, so it is a code move, not a data
migration. The kernel's `create()` pre-seed path
(`device-cap-proxy.ts:1003`, `initialMeta.deviceLinks` → `setDeviceLinks`) goes
with it.

**What must be salvaged, not deleted:**

- `packages/types/src/expression/**` — the bounded expression engine. It is a
  standalone module in `types`; it survives untouched and gains a better
  consumer.
- `deviceManager.getWireableFields` — a schema-walk field catalog per device.
  It becomes the *source picker* of the composition editor.

### 1.5 Two live defects found while measuring

Neither is this topic, both are real and should be logged rather than lost.

- **`deviceManager.getAllBindings` returns `[]` on the live hub**, while
  `getBindings({deviceId})` answers correctly for every device tried. The
  whole-fleet dump iterates `ctx.kernel.deviceRegistry.getAll()` and returns
  `[]` when the registry is absent (`device-bindings-store.ts:371`). Its stated
  consumer is `SystemManager.init()` warm-boot, so warm boot is getting nothing.
- **`automation-control` and `script-runner` have zero providers live** even
  though `addon-provider-homeassistant` implements both. No HA automation or
  script entity has been adopted. If the operator expects HA automations to
  appear in CamStack, they currently do not.

---

## Part 2 — The new chapter

### 2.0 The proposal in one sentence

**There is one noun — the block — and a device is what it produces.** A block is
user-authored logic running in its own supervised process; a *composed device*,
a *script* and an *automation* are three shapes of one block, distinguished only
by which capability the block registers on the device it declares. Wiring is
deleted; its expression engine and its field catalog are reused as the
derivation language and source picker of a composition.

> **The sentence stands as written, for the active plan.** The one thing that
> strained it — device customization needing a block that registers a cap on a
> device it did *not* declare, the wrapper shape `virtual-doorbell` already
> has — is **deferred with Part 4**, so no edit to the model is required now. The
> strain, and the proposed resolution in §4.2, are preserved in the deferred
> section: whoever reopens customization reopens this sentence with it.

This is not a new idea in this repo — it is the conclusion the 2026-08-04 spec
already reached and then put out of scope. What is new here is (a) the decision
to delete wiring rather than extend it, (b) the composed-device shape, and (c) a
way to get a *visual* automation editor without a second engine or a second
store.

### 2.1 The taxonomy that minimises concepts

Three angles on one artefact. Nothing else is introduced.

| Angle | It is a block that… | Registers | Becomes |
| --- | --- | --- | --- |
| **Composed device** | declares a device and derives its cap slices from other devices | any device-scoped caps | a device the exporters, the NC and the UI treat like any other |
| **Script** | declares a device and exposes one invocable entry point | `script-runner` | a `DeviceType.Script` device; invocable from an NC rule action *today*, and exported to HA as `script.*` |
| **Automation** | declares a device, and subscribes/schedules in its own process | `automation-control` | a `DeviceType.Automation` device the operator can `enable`/`disable`/`trigger` — and export as `automation.*` |

Why this is the concept-minimal answer:

- **One store.** `core_blocks`. No automation table, no composite table, no
  second registry. The 2026-08-03 DB remediation work and D62 both say the same
  thing: a second store that disagrees with the first is worse than no store.
- **One runtime.** The addon runner + `CrashSupervisor` (D5, D6). No in-process
  hot reload, no `node:vm`, no scheduler owned by the system.
- **One lifecycle and one on/off switch.** An automation's enabled state is not
  a field in a block record *and* a toggle in a UI — it **is**
  `automation-control.enable/disable` on its own device, the authority the cap
  already owns. D62, applied: the switch stores nothing.
- **One name** (operator decision, 2026-08-08 — closes the "two names for one
  artefact" question). **The block's `name` is the authority**; the device the
  block declares **follows it**, on every reconcile pass, not only at create
  time. Renaming from the device row is **disabled for a block-declared device**
  — the row points at the block instead of offering a field that would be
  overwritten on the next pass. D62 applied to a name: two writers of one string
  is the same sin as two writers of a switch, and the losing writer is the one
  that looks broken.
- **One visibility model.** A composed device is a device row with bindings, so
  HomeKit / Alexa / HA-MQTT / the NC / the mobile app get it for free. All three
  exporters were checked: each enumerates `deviceManager.listAll`/`getDevice`
  and keys off `getBindings(deviceId).entries[].capName`. None knows anything
  about providers or hardware. **This is the whole value of the pattern**, and
  it is already true — the alarm panel proves it in production.

### 2.2 What a composed device is, concretely

A composed device is an ordinary device whose caps are served by a block.

```
integration  (fixed, owned by the block host — no operator add/delete)
  └── device  (stableId minted from the block id; type chosen by the author)
        ├── cap A  ← native, provider is the block
        ├── cap B  ← native, provider is the block
        └── config/settings  ← the block's declared schema
```

The author writes the derivation, so a composed device can do the two things a
link cannot:

- **Methods.** A composed switch that forwards `switch.turnOn` to a source
  device's `switch.turnOn` is a provider method, three lines, and there is
  nothing to invent — `ctx.api` / `createDeviceProxy` is the only cross-addon
  layer and already exists.
- **Semantics.** Edge, debounce, for-duration, latch, hysteresis and "any of
  these five sensors" are code, not a schema the kernel has to grow.

**Staleness is part of the contract.** From the 2026-08-04 spec, and it must not
be dropped: a composed device's cap slice carries the liveness of its host
block. When the block is `stopped` or `failed`, its caps become **unavailable,
not stale** — because the NC's `deviceState` rule gate reads
`loadRuntimeState`, and a fossil value leaves a rule armed on data nobody is
producing. What "unavailable" means is per capability (a virtual switch nobody
touched for three months is still on; a sensor fed by a dead block is not), so
it is declared on the cap, not globally.

**When a source device is DELETED, the composite falls and says so.** Operator
decision, 2026-08-08 — closed, and it is the strict reading on purpose:

- **No silent re-pointing, ever.** The system never picks a substitute source, by
  name, by type or by similarity. A composed device is defined by *which* devices
  it reads; a composite that quietly starts reading a different one is a lie with
  the operator's name on it.
- **The block goes `failed`, with the reason.** Its declaration references a
  device id that no longer resolves, so the reconcile pass fails the block rather
  than starting it degraded — `lastError` names the missing source
  (`source "gate" → device 102: not found`), tagged `{ blockId, deviceId }`.
- **The composite's device row survives, in `error`.** It is not deleted — the
  row is the operator's handle on the problem, and deleting it would take the
  name, the exports and the rules referencing it with no trace. Its caps are
  **unavailable** (the rule above), so nothing downstream reads a fossil, and the
  Custom Device roster shows the row as `error` with the missing source named.
- **The state ends only when the operator ends it** — by repairing the block
  (pointing the source at a device they chose) or deleting the block, which
  deletes its device. There is no timeout that cleans it up: a composite in
  `error` is a question for a human, and a question that expires unanswered is
  the failure this repo has paid for repeatedly.

### 2.3 Where it runs

The block runner, unchanged. **Hub-only today**, and the two prerequisites are
already written down: `core-blocks` must become a hub-only *provider* (it
currently registers its cap on every node while each node has its own settings
store, so an agent's empty list shadows the hub's), and an agent-placed block
needs its package materialised on that agent. Neither is in scope for the first
phases; both are named in Phase 7.

Rules that constrain this and must not be worked around: one addon = one process
(D2); a block is never grouped with a device provider or a data-plane runner
(D29); frames never cross a process boundary at frame rate (D9/D18) — so a
composed device derived from *pixels* is out of scope, and should stay out.

### 2.4 The visual half, without a second engine

Code-only is not the whole answer: the operator said on 2026-08-04 that an
operator wants to build an automation visually. The trap is obvious — a visual
editor becomes a second rule engine with a second store.

**Proposal: the recipe is stored inside the block record, and the code is
generated from it.**

```ts
CoreBlock.source:
  | { kind: 'code';   code: string }          // authored in Monaco (today)
  | { kind: 'recipe'; recipe: CompositionRecipe }   // authored visually
```

- One table (`core_blocks`), one runtime, one lifecycle, one status.
- `compile` generates TypeScript from the recipe; the generated source is
  **never stored and never hand-edited** while `kind === 'recipe'` — it is
  derived, exactly like a cap router.
- **"Eject to code" is a one-way `kind` flip** that materialises the generated
  source. It must be presented as one-way, because it is.
- The editor is derived, not hand-written: the trigger/condition/action forms
  render from machine-readable descriptors the same way `NC_CONDITION_CATALOG`
  already drives two editors with no client code.

**The recipe's three vocabularies, each one already existing:**

| Part | Vocabulary | Provenance |
| --- | --- | --- |
| **Triggers** | `device-state` (a cap field crossing a predicate, with `edge`, `debounceMs`, `forMs`) · `device-event` (a cap event topic) · `schedule` (cron via `croner`) · `manual` (`automation-control.trigger`, which already exists) | the **only** genuinely new surface; four members, and none of them touch `NcDelivery` |
| **Conditions** | the salvaged **expression engine** over named device bindings — `field` / `literal` / `global` bindings, exactly the `DeviceLinkExpressionSource` shape, minus the device-meta storage | wiring's one good part, given the consumer it should always have had |
| **Actions** | `NcRuleActionSchema` **verbatim** (`{wait}` | `{cap,method,args}`), run by `NcRuleActionRunner` | already shipped, already bounded to device-scoped caps, already stop-at-first-failure with a per-sequence throttle |

A composed device's field **derivations** use the same expression language as
the conditions. That is the concept-minimising move: **one expression language,
three positions** (derive a value, gate a trigger, compute an argument). The
deferred customization chapter would have added a fourth position — transforming
a customized value (§4.3) — again without adding a language; that it fits without
straining is one of the reasons the analysis is kept rather than discarded.

The recipe's condition half is elaborated into a concrete chip vocabulary in
§3.2.1; the operator-facing shape of all of this is Part 3.

Two things this deliberately refuses:

- **The system owes a code block no scheduler.** A block is a real process with a
  real Node runtime; scheduling is code its author writes and re-arms on start.
  A scheduler in the recipe exists because a recipe has no `setInterval` to
  write — and it uses `croner`, the one already in the repo, because
  `setInterval(24h)` drifts and "at 07:00" does not.
- **An automation is not a notification rule** (operator, 2026-08-04). The
  action half is shared; the trigger and condition surfaces are the
  automation's own and must not be bolted onto `notification-rules`.

### 2.5 Architecture compliance — the specific rules this touches

- **Caps carry the contracts.** `core-blocks` gains the `source` union; a
  composed device's caps are ordinary `*.cap.ts` contracts registered natively.
  Any change here runs `npm run codegen` and force-publishes `@camstack/system`.
- **Events are telemetry (D8/D11).** A block reacts to `ctx.eventBus`, but a
  trigger that must not be missed is not an event-only path. The recipe's
  `device-state` trigger evaluates against the **state mirror**, which is
  reconciled, and an event only wakes the evaluation. A dropped event delays a
  trigger; it does not lose it.
- **Reconcile, never one-shot (D49).** The block supervisor already converges
  every 15 s and on every write. A composed device's declaration is
  `get-or-create` by `stableId` on every start, and a source that is temporarily
  unresolvable makes the derived cap *unavailable*, never destroys it. A read
  that contradicts the mirror in the direction that destroys work needs a second
  read to agree — the exact scar the virtual doorbell carries.
- **UI is derived (D14).** No hand-written
  `getDeviceSettingsContribution`/`applyDeviceSettingsPatch` for a composed
  device: its settings come from its declared `deviceConfig` schema.
- **Every log line about a device carries `tags: { deviceId }`** — including the
  block's own, with both the composed device's id and the block id.

### 2.6 What we deliberately do NOT build

- A second rule engine. The NC keeps its four pipeline triggers; automations get
  their own four and share the action runner.
- A sandbox. Process isolation is the boundary, and it is admin-only. That was
  already decided and it stays decided.
- An LLM that acts on devices. `addon-ai` is text in / text out with no
  tool-calling, and nothing in this chapter changes that.
- A pixel-derived composed device. Frames do not cross a process boundary at
  frame rate.
- A "composite device" abstraction in the kernel. The kernel already has
  everything: a device row, per-device bindings from N addons, and
  `ctx.kernel.devices.create` on every addon.

---

## Part 3 — The page: "Build-your-self"

Operator decision, 2026-08-08. The page currently mounted at `/automation`
(`pages/Automation.tsx`, two tabs, one of them declared empty) becomes
**Build-your-self** at **`/build`** — the route is settled, not a question — and
it holds three sections:

| Section | What it lists | Runtime underneath |
| --- | --- | --- |
| **Automations** | automations, list + detail | a block (§2.1), authored as a recipe |
| **Scripts** | core blocks, list + detail | a block, authored as code — **shipped, and never exposed** |
| **Custom Device** | composed devices, list + detail | a block that declares a device |

The page's existing docblock already argues why it is a root route and not a
`/system/*` one — *"a script is content the operator authors, like a camera or a
notification rule"*. That reasoning survives the rename and the move to `/build`,
and extends to all three sections.

**The route: `/build`, closed.** `/automation` keeps working as a **redirect**,
because existing links carry `?tab=automations|scripts` — the **tab ids do not
change**, whatever the route does. Nav label and page title are
"Build-your-self".

**Customization is not a fourth section, and it is not on this plan at all.** It
is deferred (see [Deferred — future work](#deferred--future-work)). The *Custom
Device* section therefore lists **composed devices only** — devices a block
declared — as a filter over `deviceManager.listAll`. There is no
"Customize a device…" picker until the chapter is reopened.

### 3.1 Scripts — the section that costs the least and is worth the most

The runtime is already there and correct (§1.2). What is missing is the operator
surface: today `ScriptsTab.tsx` offers **Add / Edit / Enable / Delete**, and the
editor offers **Save / Cancel**. The operator asked for edit · stop · restart ·
show logs on the list, and compile · restart · save · logs in the editor.

Every one of those maps onto an authority that either exists or is a one-method
addition. **Nothing here needs a new store, and nothing here needs the recipe.**

| Button | Authority | State |
| --- | --- | --- |
| **Compile** | `coreBlocks.compile({code})` — type-check without saving | shipped, already called by Monaco |
| **Save** | `coreBlocks.create` / `update` — compiles server-side and *refuses* code that does not compile | shipped |
| **Stop / Start** | `coreBlocks.setEnabled({blockId, enabled})`. **The stop button stores nothing** — it writes the field the supervisor already reconciles against (D62). There is no second "running" flag | shipped |
| **Restart** | **new**: `coreBlocks.restart({blockId})`. The supervisor already stops and respawns a runner when the code hash changes (`block-supervisor.ts`); this exposes that path deliberately. It stores nothing — it is a nudge, and the next reconcile pass is still the authority | one cap method |
| **Logs** | `<LogStream addonId="core-block-<blockId>" />`. A block's runner id **is** `blockAddonId(blockId)` (`block-package.ts:29`), and `LogStream` already scopes by `addonId` over `logs.query` + `logs.subscribe`. **No new cap, no new store, no new component** — only the id has to reach the UI | shipped, unwired |

So the list is `coreBlocks.restart` and one wiring job. **`coreBlocks.test` is
not built** — see immediately below.

#### 3.1.1 There is no test button on a script — closed, 2026-08-08

The first pass proposed `coreBlocks.test({code, seconds})`: compile → materialise
under a scratch addon id → spawn a real runner → stream its logs for a bounded
window → dispose. **The operator refused it: a test button on a script does not
mean anything to the operator.** That is the right call, and the reasoning is
worth keeping because it is why the button could never have been good:

- A block's contract is `export default (ctx) => disposer`. There is **no pure
  function to call**, so "test" is necessarily *run it* — with real side effects
  on the real cluster.
- The only way to make it feel safe would be a faked `ctx`, and this repo has
  paid twice for that exact shape: a green result because the fake supplied the
  value production forgot to fetch. **A restricted `ctx` is a fake `ctx`.**
- Everything a test button would have delivered already exists in a better form:
  **Compile** answers "does it type-check" without saving, **Save + Restart**
  answers "does it run", and **Logs** answers "what did it do". The loop is
  already there; a fourth verb only blurred whose side effects were real.

Consequence for the plan: Phase 3 has **no blocked item** — the whole Scripts
section is `setEnabled`, one new `restart`, and wiring `LogStream` to an id that
already exists. The "test semantics" open question of the first pass is closed by
deletion, not by decision.

**What the operator does want, and it is on the automation, not the script:** a
**Run actions** button — §3.2.

#### 3.1.2 Wireframe — list and editor

```
Build-your-self                                        [ Automations | Scripts | Custom Device ]

Scripts                                    2 not running          [ + New script ]
┌──────────────────────────────────────────────────────────────────────────────┐
│ ● Failed   Garage light follower        hub    edited 2h ago                 │
│            TypeError: cannot read 'on' of undefined                          │
│                              [Edit] [Restart] [Logs] [Disable] [⋯ Delete]    │
├──────────────────────────────────────────────────────────────────────────────┤
│ ○ Stopped  Night siren arm              hub    edited yesterday              │
│                              [Edit] [Restart] [Logs] [Enable]  [⋯ Delete]    │
├──────────────────────────────────────────────────────────────────────────────┤
│ ● Running  Water-tank calibration       hub    edited 3d ago                 │
│                              [Edit] [Restart] [Logs] [Disable] [⋯ Delete]    │
└──────────────────────────────────────────────────────────────────────────────┘
   ↑ broken rows sort first, and "N not running" is in the header — the existing
     rules in `core-block-status.ts`, unchanged.

Edit: Garage light follower                       placement [ hub ▾ ]  ● Running
┌─────────────────────────────────────────────┬────────────────────────────────┐
│ 1  export default (ctx) => {                │  Logs — core-block-b7f2        │
│ 2    const off = ctx.eventBus.on(…)         │  12:04:11 info  started        │
│ 3    return () => off()                     │  12:04:11 warn  no source dev  │
│ 4  }                                        │  12:04:26 error TypeError: …   │
│                                             │  ▸ live (subscribe) + history  │
└─────────────────────────────────────────────┴────────────────────────────────┘
  [Compile]  [Save]  [Restart]  [Logs ⇄]                      errors: 0
   ↑ No Test button (§3.1.1). Save stays blocked on Monaco's errors, as today.
     Restart is disabled while the editor is dirty in a way Save has not
     accepted — a restart that silently runs the OLD code is the failure mode
     to avoid, and it is the whole reason Compile → Save → Restart is the loop.
```

### 3.2 Automations — the vertical flow

Same skeleton as Scripts: a list with edit / enable-disable / **Run actions** /
logs, and a detail view. The difference is authoring: **creation is a vertical
flow** where the operator stacks combinations from three groups — trigger,
conditions, actions.

The enable/disable authority is `automation-control.enable/disable` **on the
automation's own device** (§2.1). Neither stores a second flag.

#### 3.2.0 "Run actions" — the one execution verb, and exactly what it does

Operator decision, 2026-08-08: the script gets no test button (§3.1.1); **the
automation gets a button that runs its actions.**

**Semantics, stated so nobody has to guess:** *Run actions* executes the THEN
half of the rule — the real action sequence, against the real devices, with real
side effects — **without evaluating the trigger and without evaluating the
conditions**. Pressing it on "arm the siren" arms the siren. It is not a
simulation and the UI must not present it as one.

- **Authority: `automation-control.trigger`**, which already exists and is
  exactly this verb (the same semantics as `automation.trigger` in the system
  `automation-control` was modelled on: fire the actions, skip the conditions).
  **It stores nothing** — no "last test" field, no second run state.
- **A disabled automation still runs its actions when the operator presses the
  button.** The disable switch gates the *trigger*, not a manual invocation, and
  an operator who presses a button expects it to do the thing. The button label
  says `Run actions` on both, and the row keeps saying `Disabled` — an off
  switch is reported off (D62).
- **Bounds are the sequence's own**: the action runner's device-scope check,
  stop-at-first-failure and per-sequence throttle (§3.2.2). A manual run gets no
  privileges a triggered run does not have.
- **`trigger` is `{kind:'manual'}`** in the injected fact (§3.2.2), so a code
  action can tell a manual run from a real one and a log line records who
  pressed it. **The vars map starts empty** (§3.2.3) — a manual run has no
  trigger values, and a step that reads a var the trigger would have set must
  handle its absence. That is the one real difference from a triggered run, and
  the editor says so next to the button.

```
Automations                                 1 disabled            [ + New automation ]
┌──────────────────────────────────────────────────────────────────────────────┐
│ ● Enabled   Arm the siren when the gate opens at night    fired 2h ago       │
│                       [Edit] [Run actions] [Logs] [Disable] [⋯ Delete]       │
├──────────────────────────────────────────────────────────────────────────────┤
│ ○ Disabled  Porch light on motion                         never fired        │
│                       [Edit] [Run actions] [Logs] [Enable]  [⋯ Delete]       │
└──────────────────────────────────────────────────────────────────────────────┘
   ↑ "Run actions" runs the THEN half for real — no trigger, no conditions.
     It is enabled on a disabled automation too, and it says what it does.
```

```
New automation                                                    [ Save ] [ Cancel ]
Name  [ Arm the siren when the gate opens at night          ]

  ┌ WHEN ────────────────────────────────────────────────────────────────┐
  │  ▸ Device state                                                      │
  │    device  [ 102 · Gate contact ▾ ]   cap [ contact ▾ ] field [entryOpen ▾]
  │    becomes [ true ▾ ]                                                │
  │    edge  ☑ only on change     for [ 5 ] s     debounce [ 0 ] ms      │
  │                                                    [+ add a trigger] │
  └──────────────────────────────────────────────────────────────────────┘
                                   │
  ┌ AND ONLY IF ─────────────────────────────────────────────────────────┐
  │  ALL of                                                        [⋯]   │
  │   ├── sun is below the horizon                                 [⋯]   │
  │   ├── ANY of                                                   [⋯]   │
  │   │    ├── 1023 · Alarm panel   state  is  armed-away          [⋯]   │
  │   │    └── 1023 · Alarm panel   state  is  armed-night         [⋯]   │
  │   └── NOT                                                      [⋯]   │
  │        └── 104 · Driveway  person present  is  true            [⋯]   │
  │                              [+ condition]  [+ group]  [ƒ expression]│
  └──────────────────────────────────────────────────────────────────────┘
                                   │
  ┌ THEN ────────────────────────────────────────────────────────────────┐
  │  1. ⏱  wait 2 s                                                [⋯]   │
  │  2. ⚡ 1023 · Alarm panel  →  alarm-panel.trigger  { zone: "gate" }   │
  │  3. { } run code                                    ▸ 14 lines  [⋯]  │
  │                                    [+ action]  [+ wait]  [+ code]    │
  └──────────────────────────────────────────────────────────────────────┘

  [ Run actions ]  ← runs THEN for real, skipping WHEN and AND ONLY IF (§3.2.0)
                     disabled while unsaved: it runs the SAVED sequence

  ▸ Generated code (read-only)                                    22 lines
  ⚠ Eject to code — one way. After ejecting this automation is a script.
```

Three properties of that layout are load-bearing:

- **The three groups are always present and always in that order.** A trigger is
  not optional and cannot be reordered below a condition — the vertical axis is
  evaluation order, and an editor that lets an operator draw something the
  engine will not run is worse than one that refuses.
- **Conditions render as a tree, but the operator never builds a tree first.**
  Adding a second condition puts it in the implicit `ALL`. A group is created by
  selecting rows and choosing "group as ANY" — grouping is an operation on
  existing rows, never an empty container the operator has to fill.
- **The generated code is visible and read-only**, and eject is presented as
  one-way at the point of ejection, not in a tooltip (§2.4).

#### 3.2.1 The block algebra — the minimum that covers real cases

The vocabulary the operator asked to design — and **the concept is approved**
(2026-08-08): the operator asked for the if / and / or of an automation's
conditions, and `ALL`/`ANY`/`NOT` over two leaf kinds is it. What is *not* yet
settled is the **bounds**, which remain a guess to be validated at Phase 6's
mockup gate against one real automation (see the end of this section, and §8).

The rule applied throughout: *a chip earns its place by covering a case the
others cannot, not by being expressible.*

**Three containers, two leaves. Nothing else.**

| Chip | Arity | Means |
| --- | --- | --- |
| `ALL` | n ≥ 1 | every child true (AND). The implicit root |
| `ANY` | n ≥ 1 | at least one child true (OR) |
| `NOT` | exactly 1 | the child is false |
| leaf `condition` | — | one catalog entry: `(deviceId, cap, field, operator, value)`, rendered from the machine-readable descriptors that already drive two NC editors with no client code |
| leaf `expression` | — | the salvaged bounded engine over named device bindings — the escape hatch, and the only place arithmetic between two device fields lives |

That covers "OR groups of ANDs", arbitrary nesting, and negation, which is the
whole of what the shipped NC condition surface (a flat AND of 22 entries) cannot
express.

**Bounded, because a UI that grows without a bound becomes a language:** depth
≤ 3, ≤ 32 leaves per automation, and the expression leaf keeps the engine's own
limits (2 KB / 256 nodes / 4096 steps). The bounds are a guard in the schema,
not a paragraph. They are also **the only part of the algebra still to be
validated** — the concept is approved, the numbers are a guess, and Phase 6's
mockup gate moves them once, deliberately, if one real automation needs it.

**Deliberately refused, and why each one:**

| Asked-for | Where it actually goes |
| --- | --- |
| `for 5 minutes` / sustained | **`forMs` on the trigger.** A duration is a property of an observation over time. In a boolean tree it forces per-node timers and turns the tree into a state machine — that is how a condition editor becomes an engine |
| `changed to` / edge | **`edge` on the trigger**, same reason |
| debounce | **`debounceMs` on the trigger**, same reason |
| `XOR`, `NAND` | `NOT` over `ALL`/`ANY`. Expressible ⇒ no chip |
| `A.temp > B.temp` | the **expression** leaf. Power lands in one leaf instead of growing the tree |
| time-of-day, weekday windows | a **condition** leaf from the catalog (the NC already has `NcSchedule` weekly windows as a *condition*), plus `schedule` as a trigger. Not a container |

**Evaluation, stated so the generated code is predictable:** short-circuit,
left-to-right, children in authored order; a leaf whose device or cap is
currently unresolvable evaluates to **false and logs** (D-rule: a branch that
drops work silently logs it) — it never throws the pass away, and it never
counts as true.

#### 3.2.2 Actions, and the code action's `ctx`

The declarative half is `NcRuleActionSchema` **verbatim** — `{kind:'wait',seconds}`
| `{kind:'cap',deviceId,cap,method,args}` — run by `NcRuleActionRunner` with its
device-scope check, stop-at-first-failure and per-sequence throttle (§2.4).
Already shipped, already bounded, and reusing it is what keeps this from being a
second engine.

The operator also asked for **custom code as an action, with an injected `ctx`**.

**Decision proposal: a code action IS a script fragment — same esbuild, same
fork, same supervision. There is no third runtime, and there is no `vm`.**

Two shapes, and they ship in this order:

**(b) reference an existing Script — available today, zero new code.**
`{kind:'cap', deviceId:<script device>, cap:'script-runner', method:'run',
args:{variables}}`. `script-runner` is device-scoped, so it already passes the
action runner's boundary check. If Phase 5 lands (a block registering
`script-runner` is a Script device), this works the moment an operator writes a
script — no schema change anywhere.

**(a) inline code in the recipe — `{kind:'code', code}`.** This costs less than
it looks: **the automation is already a block**, so an inline fragment is a
function inside that block's *generated source*. No extra process, no extra
package, no extra supervisor entry. It inherits the automation's own
`CrashSupervisor`, so a throwing fragment fails the automation visibly instead
of disappearing.

The injected argument is not a new context. It is the block's own `ctx` plus
what the run knows:

```ts
interface AutomationActionContext {
  /** Verbatim the AddonContext a block gets — devices, ctx.api, eventBus,
   *  storage, the scoped logger. Not a subset: a narrowed ctx is a fake ctx. */
  readonly ctx: AddonContext
  /** What fired this run. */
  readonly trigger: AutomationTriggerFact
  /** The run's variable bag (§3.2.3). Readable by every step, and writable
   *  HERE: `vars.plate = …` is visible to the steps that follow. Its scope is
   *  ONE execution — nothing in it survives to the next run. Empty on a manual
   *  "Run actions" (§3.2.0). */
  readonly vars: Record<string, unknown>
  /** Already tagged { blockId, deviceId } — the per-device tag rule applies
   *  to a code action exactly as it applies to everything else. */
  readonly log: IScopedLogger
  /** Fires at the step deadline. A fragment that ignores it is killed with
   *  the automation's runner, not left running. */
  readonly signal: AbortSignal
}

interface AutomationTriggerFact {
  readonly kind: 'device-state' | 'device-event' | 'schedule' | 'manual'
  readonly at: number
  readonly deviceId?: number
  readonly cap?: string
  readonly field?: string
  readonly from?: unknown
  readonly to?: unknown
}
```

Bounds and refusals:

- **Per-step deadline** (default 10 s, max 60) and the sequence's own throttle.
  A code action is not allowed to be the thing that never returns.
- **No sandbox, on purpose.** Process isolation is the boundary and authorship
  is admin-only — decided in §2.6 and unchanged. A code action has an addon's
  powers because it *is* addon code.
- **No dynamic evaluation.** `scripts/check-no-dynamic-eval.ts` stays: the
  fragment is bundled by esbuild at compile time like the rest of the block.
- **`ctx` is passed whole, never narrowed into a "safe" subset.** A curated ctx
  would drift from the real one exactly the way a hand-stubbed `.d.ts` would —
  which is the reason `coreBlocks.getTypeDefs` serves 3.4 MB of real
  declarations instead of a stub.

#### 3.2.3 `vars` — run-scoped variables, IN v1 (operator decision, 2026-08-08)

**The recommendation in this document was v1 WITHOUT `vars`** — let the actions
read the trigger's own data, and add variables when a real case demands them.
**The operator decided the other way:** *"serve un sistema di variabili di
automazione durante una esecuzione. Teniamolo per la v1."* [we need a system of automation variables during an execution; let us keep it for v1] Recorded as an
inversion on purpose, because a later session must not read the old
recommendation as the decision.

The minimum shape, and it is deliberately the smallest thing that is still
useful:

| Property | v1 |
| --- | --- |
| **Scope** | **one execution of one automation.** Created when the run starts, discarded when it ends. Never persisted, never shared between runs, never shared between automations. There is no store, so there is nothing to reconcile and nothing to migrate |
| **Shape** | a flat `Record<string, unknown>`. No scoping rules, no nesting rules, no declaration block — a name is created by the step that writes it |
| **Who writes** | (1) a **condition/trigger step that extracts a value** — the value that matched, named; (2) a **code action**, by assigning to `ctx.vars` (§3.2.2). Both write into the same flat bag |
| **Who reads** | (1) **templates** — `{{vars.x}}` in an action argument, resolved when the step runs; (2) **the expression leaf**, as a named binding alongside the device bindings; (3) any later **code action** |
| **Ordering** | strictly the authored order of the sequence. A step reads what the steps *before it* wrote — never what a later step will write |
| **Missing name** | reads as `undefined` and **logs** (a branch that drops work silently logs it). It is not an error that aborts the sequence, and it is never silently coerced to `""` — a manual "Run actions" legitimately has an empty bag (§3.2.0) |

Two refusals that keep this from becoming a language:

- **No persistence, and no `vars` at rest anywhere.** The moment a variable
  survives a run it is state with an owner, a lifetime and a reconcile problem —
  a second store next to `core_blocks`, which is the thing this whole chapter
  exists to avoid.
- **No computation in the template.** `{{vars.x}}` substitutes; it does not
  evaluate. Anything beyond substitution is the expression leaf, which already
  has bounds (2 KB / 256 nodes / 4096 steps) and already knows how to read a
  named binding.

Implementation-wise this costs almost nothing, which is part of why the
operator's call is easy to honour: **the automation is already a block**, so the
bag is one object living in the generated `run()` function's scope. It is not a
kernel concept, not a cap field, and not a row.

### 3.3 Custom Device — creation as a vertical flow

Same three-part rhythm, different nouns: **sources → caps → methods**.

```
New custom device                                                [ Save ] [ Cancel ]
Name [ Front door ]   type [ Sensor ▾ ]   role [ contact-sensor ▾ ]   placement [ hub ▾ ]

  ┌ FROM ────────────────────────────────────────────────────────────────┐
  │  gate    = 102 · Gate contact                                  [⋯]   │
  │  lock    = 812 · Front door lock                               [⋯]   │
  │                                                   [+ add a source]   │
  └──────────────────────────────────────────────────────────────────────┘
                                   │
  ┌ EXPOSES ─────────────────────────────────────────────────────────────┐
  │  contact                                                       [⋯]   │
  │    entryOpen  ←  ƒ  gate.contact.entryOpen or not lock.lock.locked   │
  │  battery                                                       [⋯]   │
  │    percent    ←  min(gate.battery.percent, lock.battery.percent)     │
  │                                            [+ cap]   [+ field]       │
  └──────────────────────────────────────────────────────────────────────┘
                                   │
  ┌ CAN DO (optional) ───────────────────────────────────────────────────┐
  │  lock-control.lock    →  forwards to  812 · lock-control.lock  [⋯]   │
  │                                                     [+ method]       │
  └──────────────────────────────────────────────────────────────────────┘

  ▸ Generated code (read-only)          ⚠ Eject to code — one way.
```

- The **source picker is `deviceManager.getWireableFields`**, salvaged from
  wiring exactly as §1.4 says it should be. Every field the old Wiring tab could
  target, this can read.
- The **derivation language is the same expression engine** as the conditions —
  one language, three positions (derive a value, gate a trigger, compute an
  argument). It reads named device sources and, inside an automation, the run's
  `vars` (§3.2.3).
- **"CAN DO" is the row wiring could never have.** A forwarded method is three
  lines through `ctx.api` / `createDeviceProxy`, and it is the difference between
  a mirrored switch and a switch.
- The result is a **device row**: it has identity, a name (the block's — §2.1),
  an on/off authority, bindings, and it reaches HomeKit / Alexa / HA-MQTT / the
  NC with no exporter change.
- The **roster** lists composed devices with their block's status, and a
  composite whose source was deleted appears as **`error` with the missing
  source named** (§2.2) — never quietly re-pointed, never quietly gone.

---

## Part 5 — Migrating the wiring

There is no operator data to migrate. The work is a code move and a deletion.

**Step 0 — re-measure before deleting.** Run the link sweep again on the day the
work starts (`scratchpad/_linkscan.mjs`, and `getBindings` grepped for
`kind:'linked'`). Zero on 2026-08-08 is not a promise about a later date, and
the doc comments will tell you the opposite.

**Step 1 — move the one producer.** `HaContainerDevice.persistBatteryLinks()`
derives a container's battery from its sibling entities. Replace it with an
in-provider derivation writing the container's `battery` slice via
`setCapSlice`. Same values, one authority, no link. Delete `buildBatteryLinks`,
the kernel `create()` pre-seed of `initialMeta.deviceLinks`
(`device-cap-proxy.ts:1003`), and the specs that assert the link shape.

**Step 2 — delete, in this order.**

| Delete | Keep |
| --- | --- |
| `deviceLinks` from `DeviceMetaSchema` / `DeviceInfoSchema` / `SavedDeviceRowSchema` / `DeviceMeta` / `IDeviceInitialMeta` | `packages/types/src/expression/**` (the engine) |
| `deviceManager.setDeviceLinks` + `DeviceLinkSchema` and its 4 source kinds | `deviceManager.getWireableFields` (becomes the recipe source picker) |
| `device-link-resolver.ts`, `device-link-overlay.ts`, `device-link-cycle.ts` | `DeviceLinkExpressionSource`'s *shape*, re-homed as the recipe's binding type |
| the `kind:'linked'` branch of `getBindings`, the virtual-binding path, and the `'linked'` member of the binding-kind enum | the `linked`-adjacent tests, rewritten against the recipe |
| `resolveLinkedStatus` and both call sites in `cap-mount-helpers.ts` (the overlay branch AND the no-provider synthesize branch) | |
| the `linkDependents` walk, `overlayedSlice`, `lastEmittedOverlay`, `snapshotForDeviceOverlayed`, `allSnapshotsOverlayed` in `device-state-mirror.ts` | |
| `devicesWithLinks`, `devicesWithLinksHas` (used only by tests), `expectedSourceStableIds`, `rebuildLinkDependents` | |
| `packages/addon-admin-ui/src/components/device/wiring/**` and the `wiring` tab in `DeviceDetail.tsx` | | <!-- drift-ok: this table names what Phase 2 DELETES; the paths are gone on purpose -->
| ~9 `device-link-*.spec.ts` files across `system`, `types` and `addon-provider-homeassistant` | |

**Step 3 — a boot migration deletes the retired meta key** (D78: retired
settings keys are deleted by a boot migration, never by hand). It will find
nothing on this cluster; it must exist anyway for installs that are not this
cluster.

**Step 4 — a guard.** `scripts/` gains a check that `deviceLinks` does not
reappear in a cap schema or a meta type, wired into `.github/workflows/ci.yml`.
Prefer a guard to a paragraph.

Note what does *not* need migrating: `getLinkedDevices` /
`_linkedDevicesMode` / `_linkedDeviceIds` is a **different feature** (camera ↔
companion association, 2 devices live) and is untouched by any of this. The
name collision is unfortunate and worth renaming while the wiring name is being
freed.

---

## Part 6 — Phases

Ordered so the dead thing goes early — nobody should build on wiring while this
is in progress.

**The active sequence, after the operator's 2026-08-08 answers, is six phases:**

> **1 primitive → 2 delete wiring → 3 Scripts exposed on `/build` →
> 4 block-declared devices → 5 shapes → 6 the visual recipe (mockup gate)**,
> then 7 as the "first-class everywhere" tail.

Two changes from the first pass, both from operator decisions:

- **Exposing the Scripts section moved up, to Phase 3.** It is the one piece
  where the runtime is shipped and only the surface is missing, and the operator
  named it as the first step. It depends on nothing in Phases 4–6. It also got
  *smaller*: no `coreBlocks.test` (§3.1.1).
- **Customization left the plan entirely.** What was Phase 6 (families (a),
  (c-display), (d) over authorities that already exist) is **deferred** — see
  [Deferred — future work](#deferred--future-work). The recipe and the
  first-class tail moved up one number to fill the gap.

**Standing rule for this chapter — mockups before components.** The operator's
co-design rule for new complex UI: **the vertical flow (§3.2) and the
`ALL`/`ANY`/`NOT` block algebra (§3.2.1) get mockups reviewed and approved
before a single component is written.** The reason is specific to this
feature — a condition editor is where a UI silently becomes a language, and the
cheapest place to notice that a chip should not exist is a mockup. **Phase 6 is
the one gate**, and it is strict; no other active phase has one.

**Phase 1 — extract the ownership primitive.**
`ctx.devices.declareIntegration({id,name})` / `ctx.devices.declare({...})` /
`ctx.devices.setState(...)`, as the 2026-08-04 spec specified and nobody built.
Idempotent, `fixed` re-asserted on every boot (the bug `ensure-alarm-panel.ts`
documents), hub-guard included so an addon that runs on every node does not race
to own a singleton. Migrate `ensureAlarmPanel` onto it and **delete the
hand-rolled version** — a leftover that describes the right design is worse than
nothing. Guard: no second get-or-create device helper.

**Phase 2 — delete the wiring.** Part 5 above, all four steps. Cheap, and it is
cheap *now*: 0 links. **The vacated tab slot is removed, not reserved** — with
customization deferred there is nothing to rename it into, so the `wiring` entry
leaves `STRUCTURAL_TABS_ALL` and a `?tab=wiring` link falls back to the device's
default tab rather than resolving to an empty tab. (This reverses the first
pass's "rename, don't remove"; §4.5 carries the note.)

**Phase 3 — the page skeleton at `/build`, and Scripts fully exposed.** *(moved
up on the operator's decision; nothing else depends on it.)* `/automation`
becomes **Build-your-self at `/build`**, with `/automation` redirecting and the
`?tab=` ids unchanged, and three sections (Automations · Scripts · Custom
Device); Automations and Custom Device keep the declared-empty explainer that
`AutomationsTab.tsx` already gets right. Scripts gains what §3.1 lists: `stop`
(= `setEnabled`, no new field), the new `coreBlocks.restart`, and **Logs wired to
`LogStream addonId="core-block-<id>"`** (no new cap — the runner id already
exists). **No test button** (§3.1.1), so this phase has **no blocked item left**.
*No model changes, no recipe, no mockup gate* — this is a skeleton over a
runtime that already works, and it turns "shipped three days, zero adoption"
into something an operator can actually drive.

**Phase 4 — a block declares a device (code authoring only).** The block runtime
gains the ownership primitive and `registerNativeCap`. Prove it with **one real
composite that replaces something that exists** — the HA container battery is
the natural candidate, since Phase 2 just moved it. Acceptance: the composite
appears in `listAll`, in `getBindings`, in HA-MQTT and in Alexa with no exporter
change.

**Phase 5 — shapes.** A block registering `script-runner` is a Script device; a
block registering `automation-control` is an Automation device — and
`automation-control.trigger` is what the **Run actions** button calls (§3.2.0).
The block's `name` is the authority for the device's name, and the device row's
rename control is disabled for a block-declared device (§2.1). Decide the one
question the spec left: whether the shape is declared by an exported marker in
the code or by a field on the stored record. Three things then follow with no
further code: an NC rule can run a block (`script-runner` is device-scoped and
already passes the action boundary), it exports to HA as `script.*`/`automation.*`,
and it composes with the `deviceState` gate in both directions. It also makes
the code action's shape (b) — reference a Script — usable with **zero** further
work (§3.2.2).

**Phase 6 — the recipe, the vertical flow, and the block algebra.** *(was Phase
7.)* `CoreBlock.source` union, the four triggers, the expression engine as the
condition/derivation language, **run-scoped `vars` (§3.2.3 — in v1, on the
operator's call)**, `NcRuleActionSchema` for actions plus the `{kind:'code'}`
action of §3.2.2, code generation, the derived editor, one-way eject. This is
the phase that fills the Automations section and the Custom Device creation
flow, including the roster's `error` state for a composite whose source was
deleted (§2.2).
**Mockup gate, and it is the strict one:** the vertical flow, the
`ALL`/`ANY`/`NOT` chips, the grouping interaction ("select rows → group as ANY",
never an empty container), and the refusals table of §3.2.1 are reviewed with
the operator **before any component is written**. What gets validated in the
mockup is the vocabulary, not the pixels: one real automation the operator
actually wants, expressed end to end, is the acceptance test for the bounds
(depth ≤ 3, ≤ 32 leaves) — **the concept is already approved; the bounds are
what this gate exists to validate** (§3.2.1).

**Phase 7 — first-class everywhere.** *(was Phase 8.)* The gaps that keep a
composed device from being fully equal to a vendor device:
- `export-hap` is **camera-gated**, so a composed non-camera reaches HA-MQTT and
  Alexa but not HomeKit.
- For the NC to see a composed device's events, its cap must be in
  `EVENT_KIND_BY_CAP` (guarded by `scripts/check-event-kind-coverage.ts`) **and**
  the device must be a camera or linked to one — otherwise no `SensorEvent` is
  persisted and no rule can ever fire for it. This is the most likely silent
  failure for a new composite, and it deserves a log line rather than silence.
- Agent placement for blocks, behind the hub-only-provider fix.
- A provider-agnostic "add a device" surface, or `device-provider` on the block
  host so the existing dialog is inherited.

---

## Part 7 — Decisions this implies

To be written as records when the corresponding phase starts, not before:

1. **Owning a device is a kernel surface, not a provider privilege** —
   `ctx.devices.declare*` is the one way, and a fixed integration is re-asserted
   every boot.
2. **A cross-device derivation produces a DEVICE, never a field on someone
   else's device** — wiring is deleted, and the reason is identity, not
   correctness.
3. **One noun: the block.** A composed device, a script and an automation are
   the same artefact distinguished by the capability it registers. One store,
   one runtime, one on/off authority (D62).
4. **A visual automation compiles to a block; it does not get an engine.** The
   recipe is stored, the code is generated, eject is one-way.
5. **A composed cap carries its host's liveness** — a dead block makes its
   device's caps unavailable, not stale, and what "unavailable" means is
   declared per capability.
6. **A condition tree is `ALL`/`ANY`/`NOT` over two leaf kinds, bounded, and
   nothing else.** Duration, edge and debounce belong to the trigger; arithmetic
   belongs to the expression leaf. The chips that were refused are refused on the
   record, so the next session does not re-add them.
7. **A code action is a script fragment, compiled into the automation's own
   block.** No third runtime, no per-action process, no `vm`, and the injected
   `ctx` is the block's own — never a curated subset, which would drift the way a
   hand-stubbed `.d.ts` drifts.
8. **A block-authored artefact has ONE name — the block's** — and the device it
   declares follows it, with the device-row rename disabled (§2.1, D62).
9. **`vars` are run-scoped and nothing else.** One execution, flat bag, never
   persisted, never shared between runs or automations; templates substitute and
   do not evaluate (§3.2.3).
10. **An automation has exactly one manual verb — Run actions — and it is real.**
    It executes the THEN half against real devices, skipping the trigger and the
    conditions, over `automation-control.trigger`, and it stores nothing. A
    script has **no** test verb at all: Compile / Save+Restart / Logs is the loop
    (§3.1.1, §3.2.0).
11. **A composed device whose source is deleted FAILS VISIBLY.** No silent
    re-pointing: the block goes `failed` naming the missing source, its device
    row stays in `error` with its caps unavailable, and only the operator ends
    that state — by repairing or deleting (§2.2).

*Deferred with Part 4:* **a customization is an overlay with a single named
authority, and removing it restores the original.** It stays written down in the
deferred section; it is not a record to be filed while nothing implements it.

## Part 8 — Questions: what the operator closed, what the phases still own

**Nothing on the active plan is waiting on the operator.** Every question the
Build-your-self design raised was answered on 2026-08-08; what remains is
(8.2) decisions each phase makes for itself while building, and (8.3) the items
deferred with the customization chapter.

### 8.1 Closed by the operator, 2026-08-08

| Question | Decision | Where it lives now |
| --- | --- | --- |
| The page's route | **`/build`.** `/automation` redirects; `?tab=` ids unchanged | Part 3, Phase 3 |
| A test button on a script | **No.** It means nothing to an operator, and the only honest implementation is "run it for real" — which Compile / Save+Restart / Logs already is. `coreBlocks.test` is not built | §3.1.1 |
| Testing an automation | **Yes, and it is a different verb: "Run actions".** Executes the THEN half for real — real devices, real side effects — skipping trigger and conditions, over `automation-control.trigger`. Stores nothing | §3.2.0 |
| The condition algebra | **Concept approved** (`ALL`/`ANY`/`NOT` over a catalog leaf and an expression leaf) — the operator asked for it. Only the **bounds** remain to be validated, at Phase 6's mockup gate | §3.2.1, Phase 6 |
| Two names for one artefact | **The block's `name` is the authority.** The device it declares follows the block, and the device row's rename is **disabled** for a block-declared device | §2.1, Phase 5 |
| `vars` in v1 | **In v1** — *"serve un sistema di variabili di automazione durante una esecuzione"* [an automation-variables system during an execution]. Run-scoped, flat, never persisted. **This inverts the recommendation in this document**, which was v1-without; the operator's call is the decision | §3.2.3 |
| Overriding one field of a native cap | **Offer nothing** — confirmed. One addon per `(cap, device)` is the kernel enforcing D62, and the UI refuses clearly rather than accepting an edit that does nothing | §4.2 (deferred section) |
| A composed device whose source is deleted | **The composite falls and shows an error.** No silent re-pointing; block `failed` with the missing source named, device row in `error`, caps unavailable, cleared only by the operator repairing or deleting | §2.2 |
| Device customization as a whole | **Deferred** — *"ci lavoriamo in futuro"* [we will work on it in the future] | [Deferred — future work](#deferred--future-work) |

### 8.2 Not operator questions — decisions each phase makes while building

These were never waiting on the operator; they are engineering choices, listed
so the phase that owns each one does not rediscover it late.

- **Shape declaration: exported marker in the code, or a field on the record?**
  The marker keeps the code self-describing; the field keeps the list query
  cheap. *Phase 5.*
- **Is the generated code stored for audit, or regenerated on every compile?**
  Storing it creates a second copy that can disagree — which argues for
  regenerating and showing it read-only. *Phase 6.*
- **A composed device whose sources live on another node.** The state mirror is
  hub-side, so a hub-placed block sees everything and an agent-placed block does
  not. A reason to keep composed devices hub-only past Phase 7. *Phase 7.*
- **Renaming `getLinkedDevices` / `_linkedDeviceIds`** while the "link" name is
  being freed by Phase 2. *Phase 2, optional.*
- **Whether the NC's four pipeline triggers should eventually be expressible as
  automation triggers.** Not now — that is the merge the operator explicitly
  rejected on 2026-08-04.

### 8.3 Deferred with the customization chapter — prerequisites of reopening it

Neither is answered. Both are the *first* things to settle when the operator
reopens Part 4, and neither blocks anything on the active plan.

- **The model's one sentence.** §2.0 says *"a device is what the block
  produces"*. Customization needs a block that registers a cap on a device it did
  **not** declare — a wrapper, which is what `virtual-doorbell` already is. §4.2
  argues this does not break the model, because a projected cap has the identity
  a wired field lacked (it appears in `getBindings` with a named provider, and
  `setWrapperActive` turns it off) — but the sentence would have to become
  something like *"a block produces caps — usually on a device it declares,
  sometimes on one it wraps"*, and that is the operator's call. Related: does a
  wrapper-shaped block still declare a device just to own an on/off switch, or is
  `setWrapperActive` the authority? (Proposal: `setWrapperActive`.)
- **Overlay identity across a device's re-adoption.** `setDisplay` and the meta
  overlays are keyed by the **numeric device id**, which is never reissued — so a
  device removed and re-adopted comes back with a new id and **loses its
  customization silently**. Should overlays be keyed by
  `(integrationId, stableId)`, the re-sync-stable key wiring's `global` source
  already used? A real data-loss shape, not a hypothetical — and the reason it is
  *safe* to defer is that no overlay surface ships until the chapter reopens.

---

# Deferred — future work

Everything below this line was designed and is **not on the plan**. It is kept
because it is analysis that would otherwise have to be re-derived, and because
one part of it is the sharpest test the Part 2 model has. It is **not** a
backlog: nothing here is scheduled, and no phase depends on it.

## Part 4 — Device customization — DEFERRED

> **Operator decision, 2026-08-08 (afternoon): out of scope for now** —
> *"ci lavoriamo in futuro."* The design below stands as written and is **not**
> being deleted; what changes is that none of it is built and none of it is
> exposed.
>
> **What that means concretely, so nobody half-implements it:**
>
> - **The three families whose authorities ALREADY EXIST stay unexposed.**
>   (a) identity recast over `deviceManager.setType` / `setRole` / `setName`,
>   (c-display) `deviceManager.setDisplay`, and (d) the "Visible on" matrix over
>   `device-export`'s `listExposedDevices` / `exposeDevice` / `unexposeDevice`
>   are all shipped *as cap methods* and reachable by an API caller. They get **no
>   operator surface** — no Customize tab, no matrix, no roster entry — until the
>   operator reopens this chapter. "It was cheap" is not a reason to ship half of
>   a deferred feature; a partial customization surface is exactly the second
>   half-authority D62 bans.
> - **The Customize tab does not exist**, so the tab slot the Wiring tab vacates
>   in Phase 2 is **removed, not reserved** — see Phase 2. §4.5 below describes
>   the slot as reserved; that sentence is superseded by the deferral.
> - **The open questions this part raised are deferred with it**, not answered:
>   the model's one sentence (a block that registers a cap on a device it did not
>   declare — §2.0, §4.2), and overlay identity across a device's re-adoption
>   (§8.3). Both are prerequisites of reopening, listed in §8.3.
> - **The one thing that is NOT deferred** is the constraint §4.2 documents,
>   because it is a kernel fact and it applies to composed devices today:
>   `CapabilityRegistry` accepts **one addon per `(cap, device)`**, so nothing can
>   override a native cap's field. The operator confirmed the answer to "what do
>   we offer instead": **nothing** — confirmed by the operator (§8.1).

Operator decision, 2026-08-08 morning, formalised here for the first time — and
deferred the same afternoon, per the banner above.

### 4.0 The claim

**Customization and creation are the same primitive.** A customized device is a
**thin composite that wraps exactly one device**. It is an *overlay*:

- **Single authority.** Every customized property names the one authority that
  already owned it (`CameraSwitch.authority`'s rule, generalised — D62). A
  customization never becomes a second writer of a field a provider owns.
- **The underlying device is untouched.** Nothing is written back to it.
- **Removing the overlay restores the original**, exactly, because there was
  nothing to restore.

That third property is the test the design has to pass, and it is what makes
this different in kind from wiring: wiring *wrote into someone else's cap
status* and left no way to name, mute or reverse the result (§1.4).

### 4.1 Family (a) — role recast

*camera → doorbell · contact → door · switch → light · device class for the
exports.*

Two halves, and they must not be confused:

**The classification half already has authorities.** `deviceManager.setType`
(`DeviceType`), `deviceManager.setRole` (`DeviceRole`), and the batched
`applyInitialMeta`. `switch → luce` is `setType(Light)` plus a role. `contatto →
porta` is a `DeviceRole` — and the export follows for free: the Home Assistant
export's role→`device_class` lookup is a **lookup** off `DeviceRole` onto HA's `device_class` (`contact-sensor` →
`door`, and nine more), because `DeviceRole` was designed against HA's classes.
So a recast reaches Home Assistant with the right icon and the right state words
**with no exporter change**. Customization's job here is to *surface* those
setters in one coherent place, not to invent a store next to them.

**The behavioural half is a wrapper cap, and it already exists once.**
`camera → doorbell` is not a label: it is the `doorbell` cap appearing on a
camera. The builtin `virtual-doorbell` does exactly this today — it subscribes
to `DeviceStateChanged`, detects a false→true edge on a source device's cap with
a per-camera debounce, and projects `doorbell` onto a camera, byte-identical to a
native ring. Its persisted shape is already deliberately extensible
(`doorbellSources: [{deviceId}]`, "an OBJECT rather than a bare id so future
per-source options can be added without another migration").

**Generalise it declaratively** — the same recipe vocabulary as §3.2:

```
recast: {
  targetDeviceId: 101,
  cap: 'doorbell',
  from: { deviceId: 812, cap: 'button', field: 'pressed',
          edge: 'false→true', debounceMs: 1500 }
}
```

which is `parseDoorbellSources` + `trigger-engine.ts` with the trigger *derived*
instead of hardcoded — the direction that file already took once when it dropped
its explicit `doorbellTrigger` key in favour of deriving the reaction from the
source cap.

Carry its scar tissue forward, unchanged: **D49.** A one-shot projection never
gates on a fallible read; a `getBindings` that contradicts the in-memory mirror
in the direction that destroys work needs a second read to agree. That bug cost
three real doorbell presses.

### 4.2 Family (b) — slice surgery

*hide · rename · graft a slice from another device.*

**Hide and rename already exist and are already an overlay.**
`deviceManager.setDisplay({deviceId, display})` persists
`{icon, label, unit, precision, hidden, perCap}` on the meta row, with `null`
clearing it entirely. That is a per-device, reversible, single-authority
overlay — the customization model, shipped, for the display layer. The Customize
view **reads and writes that**, and stores nothing of its own.

**Grafting is the new half, and it is the compositional successor of wiring.**
Instead of copying a value into a field someone else owns, the block **registers
the cap it derives, on the target device, as a named provider**. The difference
is not cosmetic:

| | wired field | grafted cap |
| --- | --- | --- |
| authority | `device-manager`, unnameable | the block, named in `getBindings` |
| identity | `(targetDeviceId, cap, fieldPath)` on someone else's device | `(cap, device)` with a provider row |
| turn it off | nothing to turn off | `setWrapperActive(false)` |
| methods | impossible | ordinary provider methods |

**A constraint that must be stated to the operator, not discovered:**
`CapabilityRegistry` accepts **one addon per `(cap, device)`** and rejects a
duplicate pair. So a graft can only add a cap the device does **not** already
have — it cannot override a native cap's field. That is not a limitation to work
around, it is precisely the "second authority" sin D62 bans, enforced by the
kernel. The UI must therefore *refuse clearly* — "102 already has `battery` from
`provider-homeassistant`" — rather than accept the edit and silently do nothing.

What to offer the operator who genuinely wants to override one field of a native
cap (the Dreame water-tank case the old wiring comments claimed, and which §1.4
found does not exist live): **nothing, deliberately.** If it is ever real, the
answer is a *derived sibling cap on a composite*, never an overlay on the
provider's own cap. **Confirmed by the operator, 2026-08-08 — closed** (§8.1):
offer nothing.

### 4.3 Family (c) — value transformations

*offsets and calibration · units · thresholds into derived states · enum
mapping.*

The line that matters here is **display versus value**, and it is easy to get
wrong:

| Want | Authority | Kind |
| --- | --- | --- |
| show °F instead of °C; 1 decimal instead of 3; a different label or icon; hide a slice | `setDisplay` (`unit`, `precision`, `label`, `icon`, `hidden`, `perCap`) — normalized at write so the render path's `UNIT_TABLE` always hits canonical spellings | **display only.** The stored and exported value does not change |
| a calibration offset (−0.4 °C on a sensor that reads high) | **a derivation on a composite**, not a display override | **value.** Everything downstream reads it |
| a threshold producing a derived boolean (`temp > 30` → "hot") | the **expression** leaf on a derived cap | value |
| an enum remap (`vendorState:'clean'` → `idle`) | the `enum-map` transform | value |

**A calibration is not a display setting.** If the number an exporter publishes,
a rule evaluates and the history stores is not the number the operator
calibrated, the calibration is a lie in three places. So it produces a derived
cap slice, which means it is family (b) — and that is the right answer, because
a derived value should have a provider.

The transform vocabulary is salvaged from wiring **verbatim**, because it is
already written, already bounded, already tested:

- `identity`
- `linear { scale, offset, clamp?: [min,max] }` — every calibration and every
  unit *conversion* (as opposed to unit relabelling)
- `enum-map { mapping, fallback? }`

Anything those three cannot express is the expression leaf. So the count in
§2.4 *would* become **one expression language, four positions** — derive a
composed field, gate a trigger, compute an action argument, transform a
customized value. On the active plan it stays at three; the fourth arrives with
this chapter, if it is reopened.

### 4.4 Family (d) — visibility per surface

*HomeKit / Alexa / HA-MQTT / the NC, in one view, reconciled with the
per-exporter selections that already exist.*

There **is** an existing authority and it is a good one: `device-export` is a
**collection** cap (`device-export.cap.ts`) with `listExposedDevices`,
`exposeDevice`, `unexposeDevice` per provider, plus `exposesDeviceSettings:true`
so each exporter contributes its own per-device Export panel (preferred stream,
discovery prefix, addon-specific knobs).

**The new thing is the unified READ, not a new store.** One matrix on the
device's Customize view:

```
  Visible on                                    (nothing here is stored twice)
  ┌───────────────────────────────────────────────────────────────────┐
  │ Home Assistant (MQTT)   [ on  ]   3 entities   ▸ discovery prefix │
  │ Alexa                   [ on  ]   1 endpoint   ▸ per-device knobs │
  │ HomeKit                 [ n/a ]   this surface exports cameras only│
  │ Notification Center     [ off ]   muted — switched off, not broken │
  │ Viewer / mobile         [ on  ]                                    │
  └───────────────────────────────────────────────────────────────────┘
```

Rules this view obeys:

- **Each toggle reads `listExposedDevices` and writes `exposeDevice` /
  `unexposeDevice` on that provider.** It has no state of its own. The NC row is
  the existing mute. (D62: the switch stores nothing, and it names its
  authority.)
- **Per-exporter knobs stay where they are** — in the exporter's own contributed
  panel. This view answers "who can see this device", not "how".
- **An unsupported surface renders as unsupported, never as an off toggle.**
  `export-hap` is camera-gated (§ Phase list), so a non-camera composite must say
  "cameras only" — an off-looking switch that cannot be turned on is the shape
  D62's second half bans: *an off switch is reported off; disabled must never
  look like broken.*

### 4.5 Where customization lives

> **Superseded by the deferral for the tab-slot half.** Phase 2 now *removes* the
> Wiring tab rather than renaming it, because there is nothing to rename it into
> yet; `?tab=wiring` falls back to the device's default tab. When this chapter is
> reopened, the tab is added back — the position argument below is still the
> right one.

**Primary: the device page**, in the tab slot the Wiring tab vacates.
`DeviceDetail.tsx`'s `STRUCTURAL_TABS_ALL` has
`{ id: 'wiring', label: 'Wiring', cameraOnly: false }`. It becomes
`{ id: 'customize', label: 'Customize', cameraOnly: false }` — same position,
same non-camera-visible policy, so the Phase-2 deletion leaves **no hole in the
tab strip** and no dangling `?tab=wiring` link that resolves to nothing.

The tab's four sections are the four families, in this order — cheapest and most
reversible first:

```
  Customize · 102 Gate contact
  ┌ Identity ─────────────────────────────────────────────┐  setType/setRole/setName
  │ shown as [ Front door ]   type [ Sensor ▾ ]             │
  │ behaves as [ contact-sensor ▾ ]  → HA device_class: door
  ├ Slices ───────────────────────────────────────────────┤  setDisplay + graft
  │ contact.entryOpen    shown · "Aperto"                 │
  │ battery.percent      hidden                           │
  │ + graft a slice from another device…                  │
  ├ Values ───────────────────────────────────────────────┤  derivation (composite)
  │ (none)   + calibrate · remap · threshold…             │
  ├ Visible on ───────────────────────────────────────────┤  device-export
  │ … the matrix above …                                  │
  └───────────────────────────────────────────────────────┘
     Remove all customization — the device returns to what its provider reports.
```

**Secondary: Build-your-self → Custom Device.** The roster of every device that
is composed *or* customized, plus "Customize a device…" which opens a picker and
lands on the same tab. It is a **filter over `listAll`**, not a second store —
"has an overlay" is answerable from the meta row and the bindings.

---

## How the live numbers in this document were obtained

Against the live hub, read-only, 2026-08-08:

```bash
cd scratchpad
node hub.mjs GET deviceManager.listAll '{}'                 # 302 devices
node hub.mjs GET deviceManager.getDevice '{"deviceId":<id>}' # deviceLinks, per device — 0/302
node hub.mjs GET deviceManager.getBindings '{"deviceId":101}'   # also 319, 409, 1026
node hub.mjs GET deviceManager.getWireableFields '{"deviceId":101}'
node hub.mjs GET deviceManager.getAllBindings '{}'          # [] — see §1.5
node hub.mjs GET capabilities.listCapabilities              # 149 caps + providers per cap
node hub.mjs GET coreBlocks.list '{}'                       # {"blocks":[]}
node hub.mjs POST addons.custom '{"addonId":"pipeline-analytics","action":"nc.listRules","input":{}}'
```

The per-device link sweep is `scratchpad/_linkscan.mjs` (batched `getDevice`
over every id from `listAll`); it was run twice, once against `loadMeta` and once
against `getDevice`, and both returned zero. The `kind:'linked'` check was run
separately on the devices the design docs name as dependents — the two Dreame
vacuums (319, 409) and the HA container (1026) — because `getAllBindings` cannot
be trusted for it (§1.5).

**There is no `listAllLinks` cap method.** A cluster-wide answer is a
client-side filter over `listAll`/`getDevice`, which is why the sweep is a
script rather than a call.
