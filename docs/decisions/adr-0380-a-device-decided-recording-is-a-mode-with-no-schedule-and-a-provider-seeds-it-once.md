---
id: D380
title: A device-decided recording is a MODE with no schedule — and the provider seeds it ONCE, gated on a durable mark, never on the current value
status: accepted
date: 2026-09-07
supersedes: D371
applies-to:
  - packages/types/src/interfaces/recording-config.ts
  - packages/addon-pipeline/src/recorder/addon/band-decision.ts
  - packages/addon-pipeline/src/recorder/addon/config-store.ts
  - packages/addon-provider-dreame/src/devices/dreame-recording-seed.ts
  - packages/ui-library/src/composites/cap-settings/RecordingSettings.tsx
---

## Context

[D371](./adr-0371-a-device-signal-is-a-level-the-recorder-holds-and-a-publisher-names-the-slot-its-stream-is.md)
got the MECHANISM right — a device's "record me" is a LEVEL the recorder holds
open, reconciled through the slice under a bound — and the SHAPE wrong. It made
the level a key inside a band: `RecordingTriggers.deviceSignal: true`, a boolean
alongside `motion`, on an `events` band with a weekday list, a start, an end and
a pre/post pad.

Two things were measured on the cluster before this record.

**Nobody turned it on.** The provider that publishes the signal never wrote a
recording config. Camera 4374 recorded only because the operator authored its
band by hand through the API; the second robot camera, **4373**, sat at
`{"enabled": false, "bands": []}` and would never have recorded a frame. A
capability that requires the operator to know it exists and to hand-author a
band around it is a feature that shipped switched off — the D62 shape, from the
other side.

**And the shape asks a question with no answer.** A band is an HOUR. This
feature has no hour: the device decides. Every field of the band the operator
had to fill in — days, start, end, pre, post — was either a formality (all days,
00:00–00:00) or a knob whose effect nobody could state, and the one field that
mattered was a checkbox hidden three levels down inside a table row. The
operator's own words: *"una modalità on-demand oppure on-device-decision, senza
bande ma solamente un flag per far capire all'utente che quel device può
registrare a seconda dell'implementazione interna."* [an on-demand or on-device-decision mode, without bands but only a flag to let the user know that the device can record depending on its internal implementation.]

The name `on-demand` was considered and rejected. In this repo's vocabulary a
"demand" is the recorder's own live window and, to an operator, "on demand"
reads as *I* start it. Naming a device-driven mode after an operator action is
exactly the control-whose-meaning-nobody-can-predict that D62 exists against.
`on-device-decision` says who decides, which is the whole feature.

## Decision

**A recording that the DEVICE decides is a first-level mode with no schedule
(`RecordingStorageMode: 'on-device-decision'`, authored as
`RecordingConfig.deviceDecision: true`, exclusive with `bands`), and a provider
may SEED it once, gated on a durable mark that is not the value.** Concretely:

1. `deviceDecision` is the only authored recording intent that is not a band.
   The schema REFUSES it together with `bands`: an always-on synthetic band and
   an authored one are two authorities over the same camera, and `activeBandAt`
   would silently let the first shadow the second. `deriveRecordingMode` checks
   it BEFORE the band count — a band-less enabled config is `off` for everything
   else, and reading this one that way is the "disabled looks like broken"
   inversion D62 forbids.
2. `triggers.deviceSignal` is RETIRED. `RecordingTriggersSchema` is a non-strict
   `z.object`, so the retired key is stripped SILENTLY on read: the camera whose
   only trigger it was would parse into an events band listing nothing —
   "enabled, and records nothing, forever" — with not one line in the log. The
   migration is therefore in code (`migrateLegacyDeviceSignalConfig`), pure,
   total and idempotent, applied on EVERY read (so a row behaves correctly from
   the first read of the boot) and persisted once per boot
   (`migrateLegacyDeviceSignalRows`, over rows read RAW — the read schema has
   already migrated by the time `readAll` answers). `enabled` is carried through
   untouched: a camera the operator had switched off comes out still off.
3. The recorder gains ONE new concept and no new policy: `effectiveBands(config)`
   is the single place a config becomes what the gates read, and for this mode
   it is `DEVICE_DECISION_BAND` — always on, `events`, one source (`signal`),
   the canonical `DEFAULT_EVENTS_BAND_BUFFER_SEC` pad. Every D371 guarantee is
   unchanged because it is the SAME code: `holdTrigger`/`releaseTrigger`, the
   reconcile that recovers a lost rise at once and needs two agreeing reads to
   release, the `SIGNAL_HOLD_MAX_MS` bound on a hold nobody confirmed. The
   marker is a field on an internal `EffectiveBand`, never on the wire — putting
   it on the wire is what this record is undoing.
4. **The provider seeds the mode at the camera's first initialisation, once,
   ever, gated on a DURABLE MARK and never on the current config.** An operator's
   `off` and a camera that was never seeded are byte-identical
   (`enabled: false, bands: []`), so a seed that consults the value re-enables
   the feature at every restart with nothing in the log to say who did it. The
   mark (`recordingSeededAt` on the Dreame child config) says "this camera was
   seeded", which stays true afterwards. The authority does not move: the
   provider writes a default through the same `recording.setDeviceConfig` an
   operator uses and keeps no second copy of the value (D62). The mark is
   written only AFTER the config write resolved — a seed that never landed has
   been seen by nobody, so retrying it costs nothing.
5. The mode is offered only where it can work — the camera must declare
   `recording-signal`, asked of its own bindings (D12) in four states (D315).
   `pending` and `unknown` render a DISABLED entry that says it is checking,
   never an absent one; `absent` renders disabled and says why; and a camera
   already in the mode can always be switched out of it, whatever the presence
   query knows.

## Consequences

- **`@camstack/types` changes, so nothing here is live until a
  `@camstack/server` carrying it is installed.** The hub validates every tRPC
  input with ITS copy of `RecordingConfigSchema`, which is `.strict()`:
  `deviceDecision` is REJECTED — not stripped — by the current hub, so the
  provider's seed fails loudly on an un-upgraded server rather than writing a
  band-less enabled config. That is the correct failure direction, and it is why
  the seed leaves no mark when the write fails.
- The migration converts 4374's operator-authored 5 s / 15 s pad to the
  canonical 15 s / 30 s. Strictly MORE footage is retained, never less, and the
  mode carries no per-camera buffers by design: its contract with the operator
  is one flag.
- A band that MIXED the retired key with other triggers keeps its other triggers
  and loses the signal; it is not folded into the mode, because that would
  silently delete a schedule the operator authored. The boot pass names those
  cameras in a warning. There are none on the fleet.
- The `on-device-decision` value now flows through every consumer of the derived
  mode. Two hand-copied enums were the reason it could have reached the recorder
  and not the status (`recording.cap.ts`, `pipeline-orchestrator.cap.ts`); both
  now read `RecordingStorageModeSchema`, and the orchestrator's status guard
  validates against the schema instead of a hard-coded list — a guard that
  rejects the block renders as "no recording cap", which is not-yet-known shown
  as not-installed (D315).
- `deviceIdsWithLostBands` must skip this mode for ever: it is the one config
  that is enabled, records, and has no band.

## Enforcement

- `scripts/check-recording-trigger-fed.ts` now also walks the CONFIG-level keys
  declared in `TRIGGER_KEY_TO_SOURCE_KIND` (`deviceDecision → signal`). A mode
  is exactly as able to ship as a dead knob as a trigger key was, and it would
  have lost that coverage the moment it stopped being one.
- `packages/addon-provider-dreame/src/__tests__/dreame-recording-seed.spec.ts` —
  the seed runs on a virgin camera, NEVER after the mark, leaves no mark when
  the write fails, and shouts when the mark cannot be persisted. Removing the
  mark gate turns the second test red.
- `packages/addon-pipeline/src/recorder/addon/__tests__/recording-controller-signal.spec.ts`
  — the whole D371 behavioural suite (rise/fall, boot reconcile, lost rise, two
  agreeing reads, failed read, the 4 h bound) now runs through the MODE, with no
  band anywhere in the fixture.
- `packages/addon-pipeline/src/recorder/addon/__tests__/band-decision-signal.spec.ts`
  — `effectiveBands` resolves the mode and only the mode; a stale object shaped
  like the old band trigger yields NO source.
- `packages/addon-pipeline/src/recorder/addon/__tests__/config-store.spec.ts`
  and `packages/types/src/interfaces/__tests__/recording-config.spec.ts` — the
  migration on 4374's exact stored row, its idempotence, and the operator's
  `off` surviving it.
- `packages/ui-library/src/composites/cap-settings/__tests__/recording-settings.test.tsx`
  — the mode saves no bands, `pending`/`absent` are disabled and say why, and a
  camera already in the mode can always leave it.
