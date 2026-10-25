---
id: D239
title: A per-camera knob whose consumer was deleted is removed, not defaulted
status: accepted
date: 2026-08-25
supersedes:
applies-to:
  - packages/types/src/interfaces/recording-config.ts
  - packages/ui-library/src/composites/cap-settings/recording-config-form.ts
---

## Context

`RecordingConfig.scrubThumbnails` was a five-step fidelity ladder
(`minimal`…`max`) for the sprite-sheet scrub tier: an enum, a geometry map, a
label map, an order array, a resolver, a form field, and its own test suite —
all of it round-tripped by `getDeviceConfig`/`setDeviceConfig` and rendered by
`recording-config-form`.

The sprite tier it drove was deleted on 2026-07-24 (D41 amendment) after serving
zero frames in production. The knob survived it with **zero consumers in the
recorder**. An operator could turn it, the value persisted, the settings page
read it back — and nothing anywhere acted on it.

This is exactly the shape D62 was written against: a switch that writes a store
nobody reads. Worse here, because the presets, the labels and the tests read as
a specification of a feature that does not exist — the 2026-08-25 teardown
found them and had to prove they were dead before it could trust anything else
in the file.

## Decision

A per-camera knob whose consumer has been deleted is REMOVED — schema, presets,
UI field, and tests — in the same pass that discovers it. It is not left in
place "harmlessly defaulted", and it is not kept as an accepted-but-ignored key.

Retirement is safe in both directions because the two schemas already differ on
purpose: the WIRE schema is `.strict()` so a stale caller fails loudly, and the
READ schema is `StoredRecordingConfigSchema = RecordingConfigSchema.strip()`
(`recorder/addon/config-store.ts`), so a row persisted before the retirement
keeps loading with the dead key dropped. A camera cannot stop recording because
of this.

## Consequences

An admin-ui bundle older than this change that still sends `scrubThumbnails` on
save will be REJECTED by the strict wire schema rather than silently stripped.
That is the intended direction — the same contract the 2026-07-30 retirement of
`schedule`/`triggers`/`rules` chose — and the surface is bounded: `ui-library`
ships inside the `@camstack/server` closure, and the viewer app never had this
field.

The retired key is now named in the `RecordingConfigSchema` docblock beside the
2026-07-30 retirements, so the next reader learns why a stored row may carry a
key the schema refuses.

## Enforcement

`packages/types/src/interfaces/__tests__/recording-config.spec.ts` asserts the
key is REJECTED, so re-adding it silently turns the suite red. Nothing enforces
the general rule beyond review; D62's `CameraSwitch.authority` requirement is
the closest structural guard and it only covers switches.
