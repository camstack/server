---
id: D663
title: A customization owns single fields of an existing device by a CLAIM at the hub write chokepoint — the native slice is kept as a shadow, a replaced field whose source is confirmed gone is handed back, and removing the customization restores the native slice exactly
status: accepted
date: 2026-09-28
supersedes:
applies-to:
  - packages/system/src/builtins/device-manager/field-ownership.ts
  - packages/system/src/builtins/device-manager/field-claims-index.ts
  - packages/system/src/builtins/device-manager/device-state-claims.ts
  - packages/system/src/builtins/device-manager/device-state-claim-views.ts
  - packages/system/src/builtins/device-manager/claimed-status-overlay.ts
  - packages/system/src/builtins/composer/claim-gate.ts
  - packages/system/src/builtins/composer/held-claims.ts
  - packages/system/src/builtins/composer/graft-host.ts
  - packages/system/src/builtins/composer/composer-grafts.ts
  - packages/system/src/builtins/composer/owned-fields-target.ts
  - packages/system/src/kernel/status-overlay.ts
  - packages/system/src/kernel/transport/claimed-get-status.ts
  - packages/types/src/interfaces/status-overlay.ts
  - packages/types/src/composition/customization-name.ts
  - scripts/check-field-claims.ts
  - scripts/check-owner-only-events.ts
  - scripts/check-claimed-get-status.ts
  - scripts/composed-methods-guard.ts
covers:
  - packages/system/src/builtins/device-manager/device-state-mirror.ts
  - packages/system/src/builtins/device-manager/mirror-row-writer.ts
  - packages/system/src/builtins/device-manager/migration-refused.ts
  - packages/system/src/builtins/device-manager/__tests__/mirror-harness.ts
  - packages/system/src/builtins/composer/slice-assembler.ts
  - packages/types/src/composition/composition-items.ts
  - scripts/check-composed-methods.ts
  - packages/system/src/kernel/capability-registry.ts
  - packages/system/src/kernel/transport/parent-unowned-call.ts
  - packages/system/src/builtins/device-manager/migrate-hardware-state.ts
  - packages/system/src/kernel/moleculer/device-cap-proxy.ts
---

## Context

Slice 1 ([D659](adr-0659-a-composed-device-is-a-composition-block-run-by-the-shared-composer-and-every-field-owns-its-availability.md))
builds NEW devices out of other devices' fields. Slice 2 lets a composition
target an EXISTING device: add a cap it lacks (the HA-imported PetKit feeder
gains `consumables` and `battery`), or replace one field of a cap it has
("invert state", "battery from…"), with one authority per field and an exact
restore when the customization is removed. The spec left open HOW a replaced
field is kept away from the native provider without touching that provider.

Where state was written, read and resolved (measured at 908d8cf05):

| Path | Where | What it does |
| --- | --- | --- |
| Native write | `packages/types/src/device/base-device.ts`, `packages/types/src/device/device-runtime-state.ts` | the provider's writer sends its WHOLE slice through `deviceState.setCapSlice` every time |
| Foreign writes | `packages/addon-pipeline/src/pipeline-runner/index.ts`, `packages/addon-pipeline-orchestrator/src/zone-rules-provider.ts`, `packages/system/src/builtins/doorbell/virtual-doorbell.addon.ts` | the same `setCapSlice`, from addons that do not own the device | <!-- drift-ok: deleted in slice 6 (D671), task 17 -->
| The chokepoint | `packages/system/src/builtins/device-manager/device-manager.addon.ts` | `setCapSlice` → `DeviceStateMirror` → `emitStateChanged` (the ONLY emitter of `DeviceStateChanged`) → debounced row write |
| Boot seed | `packages/system/src/builtins/device-manager/device-meta-actions.ts` (`loadRuntimeState`) | reads the row, seeds the mirror, hands the blob to the worker |
| State reads | `deviceState.getCapSlice` / snapshots, `DeviceProxy` state handles, the composer's `SourceTracker` | all read the MIRROR or its events |
| `getStatus` | `server/backend/src/api/trpc/cap-mount-helpers.ts`, `packages/system/src/builtins/device-manager/device-aggregation.ts` → `getProviderForDevice` | reaches the NATIVE provider, whose default `getStatus` reads its own in-process runtime state |
| Native registration | `packages/system/src/kernel/capability-registry.ts` | exactly one native per `(cap, deviceId)`; a second one throws |
| Bindings (D12) | `packages/system/src/builtins/device-manager/device-bindings-store.ts` | a native always beats a wrapper for a `deviceNative` cap |

The alternative was (b), a derived OVERLAY cap beside the native. It fails on
four counts:

1. `battery` and `consumables` are `deviceNative`: their mount returns the
   native provider before any wrapper or system provider is looked at, so an
   overlay is never consulted for exactly the caps the feeder needs, and it
   cannot register as a second native (the registry throws).
2. The native keeps writing the same `(device, cap)` slice, so the mirror,
   `DeviceStateChanged`, `DeviceProxy`, the notification center and the HA
   export would all keep showing the native value — unless the mirror merges
   the overlay in, which is the cross-device overlay with a reverse index the
   mirror deleted on 2026-08-08 ("one writer per field", D62).
3. Overlay state under a different cap name means every consumer (HomeKit,
   Alexa, NC, HA export, UI) must learn to read it — the spec's invariant is
   that a customized device is a normal device row.
4. A wrapper-style overlay needs a manifest `wrapper` for every composable cap
   plus a per-device `setWrapperActive` row: a second store for one decision
   (D62).

What went wrong during the slice, each caught in review before it shipped:

- The first claim contract inferred the claimed field set from the value's
  keys; a claimed field with no value yet then read as native (S5).
- `swapHardwareState` swaps whole runtime blobs: a claim would have moved to
  the other camera's row while the claims index still named the old one (S7).
  The first fix refused the migration AFTER both cameras were switched off,
  leaving them off.
- A malformed claims index loaded as "no claims" and the next write erased
  `$owned` from the row; a competing claim overwrote the index before the row
  refused it.
- `getStatus` of a claimed cap was overlaid in the registry only; the sibling
  short-circuit of `LocalChildRegistry` and the hub's `callCapabilityOnNode`
  each reached the native runner directly and answered the pre-customization
  value. A device whose claims were not known yet was answered native.
- A composer that failed its first native read at boot RELEASED a persisted
  claim; another source's failed first read did the same; a release that failed
  was given up. Each would hand a native field back, or pin a stale composed
  one, for good.
- A graft could shadow a native that registered in the plan window; a graft
  binding outlived a composer respawn; a refused graft was not in the verdict.
- The cycle check reported one DFS path per revisit, so a cycle through the
  candidate AND an unreadable peer could be accepted.
- The HA desiccant sensor has a unit and no `device_class`, so HA maps it to
  `enum-sensor` with a STRING value; the composition could not read it as a
  number at all.

## Decision

**A customization of an existing device is a composition whose fields the
composer CLAIMS at the hub's write chokepoint.** The hub decides, per field,
who the authority is; the composer derives the values; no provider changes.

Claims and the row:

- **The row holds the native slice plus `$owned: { owner, mode, fields,
  values }`** per cap (`field-ownership.ts` is the only file that names the
  key). The mirror keeps the native write as a SHADOW and serves the MERGED
  slice; a release restores the shadow — exact by construction. The claimed
  field set is EXPLICIT (`claimFields({ fields, values })`); a claimed field
  with no value is `held` (`null`/not reported), never native (S5). Every
  write of the row — debounced, write-through, drain, flush — goes through one
  queue per device in `mirror-row-writer.ts`, extracted from the mirror (M-7).
- **Claims are write-through, index before row.** The claims index
  (`field-claims-index.ts`) is a LISTING PROJECTION (D3/D62): the row is the
  merge authority. Claim writes the index, then the row; release writes the
  row, then the index — so an orphan is always an index entry, never a hidden
  row claim. The index is pruned on `removeDevice` and self-heals when a
  release answers `not-claimed`. A LOADED index is authoritative (no entry →
  native, no row read); a malformed index is `not-loaded`, never "empty".
- **The seed of an unseeded device is index-first and single-flight** (S6): a
  loaded index naming no claim applies with no read; the row is read only when
  the index names the device or has not loaded; a seed never overwrites memory;
  a failed row read refuses the native write on BOTH sides with a line each
  (`row-unreadable`; D49, D447, D391).
- **The native shadow is owner-only.** `device.native-shadow-changed` reaches
  the composer alone — every public event path (tRPC subscribe, `getRecent`,
  `eventBusProxy`, the picker) filters it, `limit` applied after the filter —
  and `getNativeCapSlice` is admin-only (D224) — the pre-customization value
  was once `getCapSlice({ view: 'native' })` at the default tier (§4-10);
  `getCapSlice` has no `view` now. Two guards:
  `scripts/check-owner-only-events.ts` (one subscriber, every public path
  filtered) and `scripts/check-field-claims.ts` (only the composer claims;
  its definers allowlisted; only `field-ownership.ts` names `$owned`).
- **A device under customization is not migratable**: `swapHardwareState`
  refuses by name while either row carries a claim, checked before `swapIds`
  (S7), and a claim/patch/release during a migration is refused
  `migration-in-flight`. A refusal before rows move restores both cameras'
  prior switches exactly; a `swapHardwareState` throw leaves them off with an
  operator-action ERROR; a failed in-flight write refuses the drain. A claim
  that passed the gate just BEFORE the migration began, and whose
  write-through had not landed when the rows were read, is caught by a second
  look at the mirror once its writer is held and drained
  (`ClaimLandedDuringMigrationError`, nothing moved, switches restored); the
  mirror refuses (`migration-in-flight`) any claim that reaches it after the
  hold went up, so none can land between that look and the swap.

`getStatus`:

- **A claimed cap's `getStatus` is the merged slice for every caller** (S3):
  a `Proxy` in the D13 resolver (`status-overlay.ts`; every other method
  forwarded by `Reflect.get` — never a spread, which loses `wakeForStream` /
  `reset`) AND one shared function, `answerClaimedGetStatus`
  (`claimed-get-status.ts`), asked by EVERY transport entry that resolves a
  cap call by name: the `LocalChildRegistry` sibling short-circuit,
  `createParentUnownedCallHandler`, and `callCapabilityOnNode`. A device whose
  claims cannot be known yet is answered "not reported", never native. A cap
  with no `runtimeState` can never be claimed and is answered unclaimed before
  anything is asked (no row read, no false "unknown").
  `scripts/check-claimed-get-status.ts` fails a production file that resolves
  by name without it. **Known gap** (open item 1): an agent-resident consumer
  of an agent-resident device never reaches the hub.
- The slice-1 composable-cap invariant is **"status ⊆ runtimeState"** (S4).
- **`composedMethods`** on a cap answer, or refuse by name, the methods a
  composed cap has no provider for (`battery.wakeForStream` answers
  `{ awoke: false }`; `consumables.reset` refuses until slice 3);
  `scripts/check-composed-methods.ts` checks keys are methods and answers parse.

The composer side:

- **Which claims the hub HOLDS is what landed, never the plan** (`held-claims.ts`):
  seeded from the index, moved by an `ok`, a confirmed release; a throw changes
  nothing. While a claim RPC is in flight a `device.state-changed` is neither
  native nor composed. The target's own fields are read in the NATIVE view.
- **A field is released only on CONFIRMED unavailability** of its source (the
  row gone, or an unregistration a bindings re-read agrees with) — never on a
  failed, first or empty read; that holds the last value and the block reports
  `starting` naming it (D49).
- **Unavailable modes on an existing target (S1 + S1b-final).** `constant` and
  `clock` fields are exempt. EVERY REPLACED derived field is `'release'`,
  nullable and enum included: its source unavailable hands the field back to
  the native (one authority at a time, D393), the block is `degraded` naming
  source and field, and the field is re-claimed when the source returns. The
  device's own reading is the honest fallback — a replaced field never shows
  `null`/`'unknown'` where the native has a value. STALE keeps the composed
  value (D49). An ADDED derived field is `'null'` / `'unknown'` when it can say
  so, else `not-replaceable` (there is no native to hand back to). New-device
  compositions are untouched. This deviates from D659's `offline` for existing
  targets. The hub half is the NARROWING re-claim (`fields` replaced, dropped
  values gone) and `releaseClaim`. A flap costs one RPC per transition; there
  is no hold-down.
- **A narrowed claim goes out at once, under a claim EPOCH**: a claim that
  settles under an older epoch claimed a stale field set and does not land.
  `owned-by-other`, `invalid-slice`, `unknown-device` are TERMINAL — the cap is
  not written again by that runtime; every other refusal is retried on the next
  pass.
- **Withdrawal releases never give up** (`claim-gate.ts`): two agreeing
  applies (seeded from the index) before a block's claim is handed back, then
  retried on every apply until it lands, logged once per transition. A
  forgotten orphan claim would pin a stale composed value until restart.
- **Grafts.** An ADDED cap is served by a method-serving native on the foreign
  device (`graft-host.ts`), decided at plan time only, through the new OPTIONAL
  `DeviceContext.unregisterNativeCap`, implemented in all three context
  branches. NATIVE ALWAYS WINS: the store refuses a graft over a native, a
  later native replaces the graft and the composer ungrafts (the claim stays),
  and it never re-grafts. A respawn retracts orphan grafts a previous process
  left. A refused or displaced graft is named in the block verdict
  (`degraded`, or `failed` when every added cap is unserved; D391).
  `remoteNativeCaps` deleted entries regardless of addon — fixed.
- **Item arrays** go through `status.itemArray` (slice 6 must KEEP
  `itemArray`: it now has a live caller); every item leaf is keyed
  `<cap>.items[<key>].<path>`. An item-leaf release releases the whole
  `items` field — item-level merge into a native list is not supported.

Blocks:

- **One composition per existing target, by BLOCK IDENTITY** (S2):
  `CompositionPeer.blockId` drops only the candidate's own old version; a
  different block on the same target is `duplicate-target`.
- **The implicit name `customize:<addonId>/<stableId>`** (or a sha256 form past
  120 chars) is derived by the SERVER (`@camstack/types/node`), refused when a
  client sends a name, and never displayed — the UI shows the device's current
  name.
- **Cycles are decided per strongly connected component** (Tarjan): a save is
  refused iff a candidate node is in a cyclic SCC, naming an unreadable device
  when it is in it. An unreadable peer is over-approximated as replacing
  NOTHING (it only adds edges; "all replaced" would remove self-edges and hide
  cycles), so it never blocks an unrelated save.
- **`number(x)`** is an expression builtin: a finite number or a numeric
  string → number, else `null` (never 0, D393). The one bridge from a
  string-valued source — the HA sensor with a unit and no `device_class`.
- **D648's `graft` slot shape is retired** (amends D648): a device that gains a
  cap from other devices is a composition. `battery.deviceTypes` gains
  `Container` and `PetFeeder`.

## Consequences

- **Amended by [D677](adr-0677-the-runtime-state-row-writer-never-writes-a-row-this-process-has-not-read.md)
  (2026-09-29): S6 branch (c) no longer applies to WRITES.** A loaded index
  that does not name a device vouches for its claims, not for the native
  slices on its row; the writer that trusted it replaced unread rows at hub
  boot (159 shrinks, 15 cameras, 65 of 82 restarts). Every row write now
  requires the row to have been read in this process — the writer reads it;
  the claimed-status read and the native-write RPC keep branch (c).
- Claims are hub-authoritative. Every write, event and `getStatus` that
  reaches the hub sees one authority per field; nothing that does not reach the
  hub does.
- **Rollback warning.** An older hub seeds `$owned` into its mirror as if it
  were a cap (its `seedMirror` copies every object key of the row): until the
  device's next write it serves a pseudo-cap named `$owned` in
  `snapshotForDevice` / `getAllSnapshots`. Its `persistableBlob` drops that key
  (`runtimeStatePolicyFor('$owned')` is session), so the device's first durable
  write ERASES the claims from the row, while the claims index keeps its
  entries. It no longer merges, so native values reappear, and it ignores an
  `unregisterNativeCap` it does not know, so a graft stays routable until the
  composer respawns. Re-upgrading is safe: the index is still a superset of the
  rows, a device it names is read and found with no claim, and the composer
  re-claims on its next write — the native shows in between. **Release every
  customization (delete the blocks) before rolling back below D663** anyway,
  and export them first with `coreBlocks.listCompositions`.
- **Release note — providers not republished.** A provider addon that is not
  republished with this release bundles the old `DeviceRuntimeState`: it
  swallows the hub's new `row-unreadable` refusal of a native write and does
  not re-send an unchanged value. Only the failed-row-read path is affected,
  and it heals on the provider's next value change.

### Open items (each named so silence is not read as a decision)

1. **Agent-resident `getStatus`.** An agent-resident consumer calling
   `getStatus` of an agent-resident device resolves on the agent, never
   reaches the hub's overlay or hook, and sees the native value. Honouring
   claims there would round-trip every agent `getStatus` through the hub.
2. **N-6.** A cap never reported under a persisted claim stays `starting`,
   named — it is not released and not degraded.
3. **HA mapping.** A `sensor.*` with a unit and no `device_class` maps to
   `enum-sensor` (`packages/addon-provider-homeassistant/src/ha-domain-mapping.ts`).
   `number()` bridges it; remapping to `numeric-sensor` is a follow-up that
   needs a migration (it moves every such adopted child's cap).
4. **`setType` is not durable** for provider devices: `registerDevice`
   re-stamps `type` on every registration. Slice 5's Identity section must fix
   it before offering type presets.
5. **Type-level tests are not enforced repo-wide** (`__tests__` is excluded
   from the tsconfigs and `vitest --typecheck` skips them).
6. **A SUCCESSFUL migration turns every switch on** (pre-existing); it should
   restore the prior states like a refused one does.
7. **T5(b).** `effectivelyEqual` compares `$owned` under `policyFor('$owned')`,
   blind to clocks inside owned values: a `lastUpdated` change inside a claim
   costs a commit (the 526-writes shape).
8. **T5(d).** Releasing an `add` emits no removal, so consumer mirrors
   (SystemManager, DeviceProxy) keep the last composed value until they
   re-read.
9. **§4-9.** A cap bound only by a WRAPPER has `nativeAddonId: ''` in
    `getBindings`, and the validator reads it as `add` (a graft beside a
    wrapper).
10. **Add-mode derived fields that can say neither `null` nor `'unknown'`**
    stay `not-replaceable` (S1b covers `replace` only); it bites a preset that
    ADDS a cap whose required field is such a value.
11. **Item-level merge** (one composed item inside a native consumables list)
    is not supported: `items` is owned whole.
12. **HA export** keeps the retained MQTT battery value when it turns unknown.
13. **The native shadow crosses the wire.** `device.native-shadow-changed` is
    `broker.broadcast` cluster-wide like every category; agents drop it by
    interest and nothing on an agent subscribes. "Never leaves the hub" holds
    for every consumer surface, not for the wire. The composer is hub-only, so
    skipping the cross-node broadcast for `OWNER_ONLY_EVENT_CATEGORIES` would
    cost nothing — not done in this slice.
14. **`device-manager.addon.ts`** is over 800 lines (1041 at the end of this
    slice; it already was before it).

### Live verification (not covered by a test — Task 16)

1. `createContext` of a graft on a FOREIGN device id in the shipped forked
   composer runner (`udsMode`: the graft lands in `workerNativeCaps`, the hub
   learns it through the runner's UDS `updateCaps`).
2. `LocalChildRegistry` stops routing the `(cap, device)` to the composer
   after a retract.
3. The UDS paths themselves: the sibling short-circuit and `callCapOnChild`
   asking `answerClaimedGetStatus`.
4. The EVENT PLANE over UDS to the forked composer: `DeviceStateChanged`,
   `device.bindings-changed`, and the owner-only `device.native-shadow-changed`
   reaching its one legitimate subscriber.
5. `getBindings` of the feeder lists the grafted `battery` / `consumables`
   next to the HA natives with `providerNodeId: 'hub'` (the Kernel ruling's
   code reading: hub-local UDS children feed `remoteNativeCaps`).

## Enforcement

- Every spec of the slice, Task 5b included — the mirror, the claims index,
  the claim methods, the overlay at every entry, the owned-fields target, the
  claim gate, held claims, grafts, core-blocks peers and cycles, and the
  acceptance test on the real components
  (`packages/system/src/builtins/composer/__tests__/feeder-customization.e2e.spec.ts`);
  each gate was disarmed and seen red.
- `scripts/check-field-claims.ts` — only the composer claims; only
  `field-ownership.ts` names `$owned` (definers allowlisted).
- `scripts/check-owner-only-events.ts` — one shadow subscriber; every public
  event path filtered.
- `scripts/check-claimed-get-status.ts` — every by-name resolution entry asks
  `answerClaimedGetStatus`.
- `scripts/check-composed-methods.ts` — `composedMethods` keys are methods and
  answers parse.
- `scripts/check-method-tiers.ts` — the four claim methods,
  `getNativeCapSlice` and `getCustomization` pinned at `admin`.
- The agent-resident gap and the open items above: nothing, review only.
