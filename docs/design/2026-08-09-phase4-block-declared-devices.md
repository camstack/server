---
title: Phase 4 — a block declares a device — what was proven live, the blocker that stops it shipping, and the Phase 5 shape decision
date: 2026-08-09
status: Phase 4 PROVEN end-to-end on the live hub (device 1836, composed from two real sensors through the expression engine, surviving a restart by adoption). BOTH halves of the ownership fix are now built and tested — the contract half (`DeclaredDevicesSpec.integrationId`) and the host half (`core-blocks` owns one shared integration; `createIntegration` refuses a principal the reads would hide; a filtered-out read logs that it hid something) — see [D97](../decisions/adr-0097.md). Nothing is LIVE: it ships only in a `@camstack/server` closure. `int_0021` / `int_0022` remain, deliberately (§2). Phase 5's open question is decided: the shape is DERIVED from the registered caps, neither a code marker nor a record field.
applies-to:
  - packages/types/src/device/declared-device.ts
  - packages/system/src/builtins/core-blocks/**
  - server/backend/src/core/addon/integration-visibility.ts
supersedes-question-in: docs/design/2026-08-08-automation-scripts-custom-devices.md (Part 8.2, "Shape declaration")
---

# Phase 4 — a block declares a device

This continues [the Build-your-self design](2026-08-08-automation-scripts-custom-devices.md).
Phases 1–3 are built; this is the record of Phase 4's proof, the blocker it
found, and the Phase 5 decision that no longer needs to be rediscovered.

## 1. What was proven, on the live hub

A block was authored, stored through `coreBlocks.create` and run by the ordinary
supervisor — **no deploy, no publish, no framework change**. Block code is stored
in `core_blocks` and materialised at runtime, so the whole of Phase 4 is
reachable on a running hub today. That is worth stating plainly because it
inverts the usual cost model for this repo: the primitives were already there,
and only their ergonomics and one ownership bug are missing.

The composite: **"Temperature Delta"** — a `numeric-sensor` whose value is
`indoor - outdoor`, derived through the salvaged expression engine from two real
Ecowitt sensors addressed by re-sync-stable `stableId`.

Measured, 2026-08-09:

| Acceptance (design Phase 4) | Result |
| --- | --- |
| appears in `deviceManager.listAll` | **yes** — id 1836, `type: sensor`, `addonId: core-block-<uuid>`, `stableId: temp-delta` |
| appears in `getBindings` | **yes** — `numeric-sensor`, **`kind: "native"`**, provider = the block |
| derives a real value | **yes** — `25.8 - 16.6 = 9.2`, refreshed on a 10 s tick; `deviceState.getCapSlice` returned `{value: 9.1, unit: "°C", precision: 1}` |
| survives a restart | **yes** — `created: false`, **same device id 1836**, adopted rather than re-created (the D49 second-read path) |

`kind: "native"` is the whole point of the chapter and it is now measured rather
than argued: a composed device's caps are native to it, so every consumer that
keys off `getBindings(deviceId).entries[].capName` — the exporters, the NC, the
UI — sees it with no change of any kind.

**What was NOT verified:** that an exporter actually publishes it. `deviceExport`
is opt-in per device (`exposeDevice`), so nothing is exported until an operator
asks. HA-MQTT could not be checked at all — that package is being deleted by
concurrent work. The binding-level evidence above is the mechanism the exporters
consume, so this is a gap in the evidence, not a known failure.

### Traps found while proving it

- **`ctx.addonId` is `null` on a block.** The addon id is `ctx.id`
  (`core-block-<uuid>`). This matters because `deviceManager.listAll({addonId})`
  does **not** reject a null filter — it silently returned **all 319 devices**.
  A `DeclaredDevices` wired with `ctx.addonId` therefore gets a device index
  containing the whole cluster, and its `stableId` lookups can collide with
  another addon's. Nothing errors.
- **`ctx.kernel.localNodeId` reads `hub/core-block-<uuid>`** — the forked-child
  suffix `declarationOwnerNodeId` already strips. Comparing it raw skips the hub.
- A block resolves `@camstack/types` **and** `zod`; `BaseDevice`,
  `DeclaredDevices`, `evaluateExpressionSource`, `numericSensorCapability`,
  `scriptRunnerCapability` and `automationControlCapability` are all reachable
  from block source.

## 2. The blocker: a core block cannot own an integration

`DeclaredDevices.reconcile` get-or-creates a FIXED integration per `addonId`.
For a block that is structurally impossible.

`server/backend/src/core/addon/addon-registry.service.ts` →
`createFilteredRegistry` gates every integration **read** on
`installedAddonIds.has(addonId)`. A block's addon id is never in that set — a
block is materialised and spawned via `$process.spawnRunner`, it is not an
installed addon. So:

- `getIntegrationByAddonId('core-block-…')` → **always `null`**;
- `createIntegration` is **unfiltered** and succeeds;
- therefore **every block start mints a new integration row**;
- `listIntegrations` filters them out, so the operator never sees them;
- `getIntegration` filters too, so `integrations.delete` answers
  *"Integration not found"* — **they cannot be removed through the API.**

Measured: two starts of one block left `int_0021` and `int_0022` orphaned and
unreachable on the live hub. Re-confirmed the same night, after the fix was
written: `integrations.get` and `integrations.delete` still both answer
*"Integration not found"* for them. They are still there — deliberately, see
§2.1.

The same filter also gates `getDevice` / `getDeviceByStableId` / `listDevices` /
`listCameras` on whether the device's integration belongs to an installed addon —
so a block-owned integration would additionally make its devices invisible to
those registry reads. (`deviceManager.listAll` reads the device-manager's own
meta store and is unaffected, which is why the composite was visible at all.)

### The fix, in two halves

> **Both halves are now BUILT and tested.** The rule they encode is
> [D97](../decisions/adr-0097.md). What follows is the reasoning as it was
> written; the "NOT built" note below is superseded by §2.1.

**Half one — committed.** `DeclaredDevicesSpec.integrationId?`: when supplied,
the integration is used verbatim and nothing is minted or re-asserted. A
declarer that cannot *read* an integration must not try to *own* one. Two
discriminating tests cover it (each fails when the fix is removed).

**Half two — BUILT (`blocks-integration.ts`).** `core-blocks` — an installed builtin, so it
passes the filter — owns ONE shared integration that every block's devices hang
from:

1. `CoreBlocksAddon.onInitialize` reconciles its own integration by running
   `DeclaredDevices` with `addonId: 'core-blocks'` and **`devices: []`**. This is
   the existing primitive, not a second get-or-create, so the ownership guard
   (`scripts/check-declared-device-single-owner.ts`) stays satisfied and `fixed`
   is re-asserted every boot for free.
   **The trap to comment at that call site:** an empty `devices` list makes every
   row under the integration a withdrawal candidate. It is safe *only* because
   blocks' devices are owned by `core-block-<uuid>` addon ids, so
   `listOwnDevices('core-blocks')` is empty. If `core-blocks` ever declares a
   device of its own, that safety disappears.
2. A block reads the id with
   `ctx.api.integrations.getByAddonId.query({ addonId: 'core-blocks' })` — legal,
   because `core-blocks` *is* installed. No new cap method is required.
3. The block passes it as `integrationId`. Device ownership is untouched: that is
   `(addonId, stableId)`, and `listOwnDevices` stays addon-scoped — which is what
   keeps one block's withdrawal sweep away from another block's devices, now that
   the integration no longer distinguishes them.

`CoreBlockInputSchema.integrationId` already documents exactly this — *"Absent =
the system integration blocks share"* — so this is the contract being
implemented, not a new idea.

**Rejected alternative:** teaching `createFilteredRegistry` to accept
`core-block-*` ids. It would work, but it widens a filter that every device read
in the product goes through, to fix a problem one shared integration solves at
the edge. Blast radius decides it.

### 2.1 What was actually built, and the third thing it needed

Half two landed as specified, plus two pieces the spec did not name:

- **`server/backend/src/core/addon/integration-visibility.ts`** — the filter,
  extracted out of `AddonRegistryService` so the rule is testable on its own,
  with the asymmetry closed: `createIntegration` REFUSES an `addonId` that is not
  installed. Half two alone would have stopped blocks leaking rows; it would not
  have stopped the *next* declarer that is not an installed addon. The refusal
  normalises `addon:<id>` first — a co-located builtin's `ctx.id` carries the
  prefix (D72), and without that, the guard would reject `core-blocks` itself on
  its first boot.
- **The suppression log.** `getIntegration` / `getIntegrationByAddonId` now warn
  when they hide a row that EXISTS, and stay silent when there is none. Both
  branches returning a bare `null` is what let a mint-on-every-start survive
  unnoticed; a rule that cannot be seen failing is not enforced.
- **Two owner footguns**, because both are how a wrong owner reaches the
  primitive in the first place: `deviceManager.listAll` refuses an owner filter
  that is PRESENT but is not an addon id (`{addonId: null}` used to answer with
  all 319 devices), while an OMITTED filter stays permissive; and
  `DeclaredDevices` refuses ports whose `addonId` is not a real id, at
  construction rather than at the first destructive pass.

**`int_0021` / `int_0022` were NOT purged, on purpose.** They carry `info.fixed`,
written by the very mint branch that created them, so a delete that could see
them would be refused by the fixed guard — the guard that once deleted the NC
alarm panel because it fired *after* the cascade. They reference no device
(`listAll` returns 319, none of them). Two inert rows are not worth relaxing that
guard, and the class that produces them is now closed. Purging them needs a
maintenance path that does not exist and should be designed, not improvised.

### Also missing: the port wiring is 8 lines of trap

Every declarer hand-wires `getIntegration` / `createIntegration` /
`updateIntegration` / `listOwnDevices` onto `ctx.api` (see
`pipeline-analytics/index.ts` `declareAlarmPanel`). For a block that is where
`ctx.addonId`-vs-`ctx.id` goes wrong silently. A single
`declaredDevicePortsFrom(ctx)` factory in `@camstack/types` — returning
`DeclaredDevicePorts`, pinning `ctx.id`, resolving the shared integration —
removes the trap and de-duplicates the alarm panel's copy. Not built; the
constructor guard added in §2.1 turns the mistake into a loud throw, which is a
floor rather than a fix.

## 3. Phase 5 — the shape decision

> The design (Part 8.2) left this to the phase: *is the shape declared by an
> exported marker in the code, or by a field on the stored record?*

**Decided: neither. The shape is DERIVED from the caps the block's device
actually registers**, read back through `getBindings(deviceId)` —
`script-runner` → Script, `automation-control` → Automation, anything else →
composed device.

Why the two offered options are both wrong:

- **Both are a second declaration of a fact the binding table already holds.**
  The taxonomy in §2.1 *defines* a shape as "which capability the block
  registers". A marker or a record field restates it, and can disagree with it —
  D62's sin at artefact level, and this repo has already shipped it: Phase 2 had
  to delete a cap `z.enum` that was "a second authoritative declaration".
- **Only the binding table cannot lie.** It is written by the registration
  itself. A block exporting `shape = 'script'` while registering
  `automation-control` would render as a Script with no entry point — a UI that
  offers a verb the device cannot perform.
- The record-field argument is *"it keeps the list query cheap"*. It is already
  cheap: the roster needs the device row anyway (name, status, `lastError`), and
  `getBindings` is the same call the device detail page and every exporter
  already make.

The one real consequence, and it is correct rather than a defect: **a block that
has never started has no shape.** The roster shows it by its block status
(`stopped` / `failed` / `starting`) and offers no shape-specific verb. That is
the design's own rule — a dead block's caps are *unavailable, not stale* (§2.2) —
applied to the artefact instead of the value. Showing a Script's Run button for a
block that has never registered `script-runner` would be exactly the fossil the
chapter bans.

This decision costs nothing to reverse into a cached field later if a roster
query ever proves expensive, because a cache derived from the bindings has one
writer; a hand-authored marker does not.

## 4. What remains, in order

1. ~~**Half two of the integration fix**~~ — DONE (§2.1), together with the
   create-side refusal and the suppression log ([D97](../decisions/adr-0097.md)).
   It is not LIVE: it ships only in a `@camstack/server` closure.
2. **`int_0021` / `int_0022`** are left in place on purpose (§2.1). If they are
   ever to go, it needs a maintenance path for a `fixed` row whose declaring
   addon no longer exists — designed, not improvised, because the fixed guard
   firing late is what destroyed the alarm panel once.
3. **`declaredDevicePortsFrom(ctx)`** in `@camstack/types`, and migrate
   `declareAlarmPanel` onto it — the duplicate wiring is where the
   `ctx.addonId` trap lives.
4. **A worked composed-device example** shipped as a block template
   (`block-template.ts` already exists for Scripts), so an author starts from the
   proven shape rather than rediscovering `registerNativeCap`.
5. **Phase 5 proper** — implement the derived shape above; disable the
   device-row rename for a block-declared device (§2.1); wire
   `automation-control.trigger` to "Run actions".
6. **The `EVENT_KIND_BY_CAP` gap** the design flags: a composed device's cap must
   be in that map *and* the device must be a camera or linked to one, or no
   `SensorEvent` is persisted and no NC rule can fire. `numeric-sensor` on a
   non-camera composite hits this. It deserves the log line the design asks for
   rather than silence — not built.
7. **Deliberately deferred:** agent placement (Phase 7), the recipe/visual editor
   (Phase 6, mockup-gated, another agent's), device customization (deferred in
   full by the operator).

## 5. Shipping

Nothing here is live. In order:

1. `@camstack/types`, `@camstack/system` and `server-backend` must all be
   **published and installed as a `@camstack/server` closure** —
   `DeclaredDevicesSpec.integrationId` and the `DeclaredDevices` ports guard are
   in types, `core-blocks` and the `listAll` owner guard are in system, and
   `integration-visibility.ts` is in the backend. Per `update-and-release.md`
   none of it is live until that closure is installed
   (publish train → `applyServerUpdate`). `CORE_BLOCKS_ADDON_ID` was added to
   `core-blocks.cap.ts` but it is a plain constant — `npm run codegen` produced
   no drift, so no cap-router regeneration is involved.
2. Nothing needs `camstack deploy` — no addon package changed, and
   `camstack deploy` cannot ship framework packages on an image hub anyway.
3. Block authoring itself needs no shipping at all, which is why Phase 4 could be
   proven before any of this.
