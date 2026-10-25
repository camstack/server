---
id: D671
title: Doorbell sources migrate to stable composition references before the virtual wrapper is deactivated
status: accepted
date: 2026-09-28
supersedes:
applies-to:
  - packages/system/src/builtins/composer/composer.addon.ts
  - packages/types/src/catalogs/sensor-active-state.ts
---

## Context

Camera 101 stores its virtual-doorbell source as a numeric device id, while a
composition must follow a provider's stable identity across re-registration.
Turning off the wrapper before the replacement composition is bound can leave
the camera without a doorbell provider. Treating an empty native owner as a real
owner made the wrapper-only cap look native and planned a `replace` instead of
an `add`; after that was corrected, the active wrapper exposed Composer as its
underlying native owner, so checking only the top-level provider still made the
cutover wait forever.

## Decision

Migrate configured doorbell sources to a canonical enabled composition using
stable `{ addonId, stableId }` references, and deactivate the virtual wrapper
only after the composer binding is observed. Camera 101 is
`{ addonId: 'provider-hikvision', stableId: 'mac-40acbf7be9f7' }`; source 1031
is `{ addonId: 'provider-homeassistant', stableId:
'ha:ha_001:dev:bf38dbc6816ab9fdbd7f8f6b1eb4638b-switch.doorbell_bussano' }`.
The migration writes NO seed. History is preserved by the composer, which
initializes the fields from the camera's effective doorbell slice at apply time
(`readExistingTargetSeeds`) and never replays a historical press. When no slice
exists the state starts at `{ lastPressedAt: null, pressCountSinceStart: 0 }`
and the claim lands at once — even while the trigger source has not answered
yet, because an unanswered `lastPressedAt` is published `null` and `count`
reads that (D670 amendment, fix round 1). (This paragraph used to say the
migration seeds `1790587990669` / `2`: those were the values the composer WOULD
have read on 101, and on 2026-09-28 that slice had already been dropped, so
the seed was null.)

The migration writes the composition before cutover, accepts Composer ownership
whether Composer is the active provider or the native owner beneath the
wrapper, and disables the wrapper only when that binding is present. Its
durable fleet-complete marker is written only after every configured camera is
settled. Re-running after a crash is safe: an absent customization is created,
an identical canonical feature is kept, an incomplete cutover is retried, and
an unrelated or disabled existing block is refused rather than overwritten.
Lifecycle and provider-readiness events coalesce retries; there is no polling
timer. The legacy numeric setting and wrapper remain available for one release
as an overlap/fallback while the stable-ref composition is established.

At runtime the event is emitted before its deferred owned-field write. This
chooses a possible duplicate ring after a crash over silently losing a ring
when the write fails; the high-water prevents ordinary retries from duplicating
the event.

## Consequences

The old `doorbellSources` setting remains readable during migration but is no
longer the long-term identity. A camera is never deliberately switched off
before Composer can serve its doorbell. A migration error keeps the wrapper
available, is logged with the camera id and reason, and is retried on the next
relevant lifecycle/provider event. A conflicting operator customization is
not silently merged or replaced.

During the overlap the virtual wrapper still watches camera 101's numeric
source, so it must not ring on top of the composer. It stays silent when two
independent reads agree: the derived bindings view names another `doorbell`
provider (the composer), and the durable `deviceBindings` row names no
wrapper. The durable read is paid on the ring path whenever the mirror is short
of `bound` on such a camera, which covers the first reload cycle after every
restart. An unreadable store still rings (D49): the cost of that choice is a
possible duplicate ring while the settings store cannot answer.

The wrapper asks the owner for that durable activation:
`deviceManager.getWrapperActivation` (D675), three-way (value / missing /
failed). `value` with `null` — the operator's explicit off — and `missing` (the
store answered, and the doorbell cap is not `defaultActive`) are an unbind;
`failed`, which includes a store that could not produce the `deviceBindings`
row at all, is `unreadable` and never silences a press. Until 2026-09-29 the
wrapper read `addonSettingsRaw.getGlobal`, which answers `{}` on a door-backed
hub, and so every read graded `unreadable`. `getBindings` cannot serve instead,
because it is the derived view this read exists to corroborate. (The branch
that first fixed this read the physical `addon-settings` row through the
`settings-store` cap; the release took D675's cap method instead, so the
wrapper no longer depends on device-manager's storage encoding.)

**Found 2026-09-29 (first press after the cutover).** With no doorbell slice
on 101 the composer's claim waited for its own count (D670 amendment) and
served nothing for 12 h, so the still-active wrapper's ring was the only
doorbell state on 101 — and the claim landed only on the wrapper's write, 7 ms
after it. That produced two `DeviceStateChanged(101, doorbell)` for one press;
the second marker projection was debounced into `null`, and its notification
— the one that won the rule — shipped without a still. Three changes close it:
the composer serves `{ null, 0 }` from apply (D670 amendment), the wrapper
stays silent under the composer (the settings-store read above), and a
debounced marker projection shares the window's marker instead of none
(`SyntheticTrackMaterializer.materializeOrShare`, `reason: debounced`). The
wrapper-silence change must not ship without the first: silenced alone, 101
would ring HomeKit (event-first) but get no state, no notification and no
timeline marker. The acceptance fixture had pre-written the doorbell slice on
every run, so it never started from the production state — it now starts from
none, and a test opts in to the wrapper's history by name.

- **Slice 6 done (2026-10-01).** The overlap is over: `virtual-doorbell`, its
  migration and the `doorbell-source` slot are deleted, on the understanding
  that no camera's `doorbell` binding still names the wrapper. 101's
  `{ wrapperAddonId: null }` row and the addon's own store rows stay, inert.
  **That understanding was NOT verified in the session that deleted the code:
  its preflight was not run (no access to the live hub). It is the operator's
  gate, immediately before the server release:** `deviceManager.listDeviceIdsByCaps`
  for `doorbell`, then `deviceManager.getBindingsBatch` for the ids answered: no
  `doorbell` entry may name `virtual-doorbell` (101 is expected on `composer`).
  Optionally, the migration marker: `settingsStore.get` of collection
  `addon-settings`, key `virtual-doorbell.doorbell-source-composition-migration-v1`,
  reads `.value.complete === true` (no row = not migrated). If any camera still
  names the wrapper the release must not ship. Rollback below this release needs
  a server that still ships the wrapper. A stored binding to the retired wrapper
  is never routed (the cap resolves to its native) and is WARNed once per
  (device, cap) with the recovery call, from
  `packages/system/src/builtins/device-manager/stale-wrapper-activations.ts`.

## Enforcement

`packages/system/src/builtins/doorbell/__tests__/doorbell-composition-migration.spec.ts` <!-- drift-ok: deleted in slice 6 (D671), task 17 -->
checks canonical stable refs, idempotent recovery, conflict refusal, lifecycle
coalescing and Composer-binding-before-deactivate, including Composer as the
underlying native owner. The end-to-end acceptance
`packages/system/src/builtins/composer/__tests__/doorbell-composition.e2e.spec.ts`
uses the real composition components and exact camera/source identities; it
checks seed preservation, wrapper cutover, event-before-write, debounce,
write retry, source loss and restart without replaying an event.
