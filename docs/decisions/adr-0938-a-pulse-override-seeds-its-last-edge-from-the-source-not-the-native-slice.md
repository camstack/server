---
id: D938
title: A pulse override seeds its last edge from the source, not the native slice
status: accepted
date: 2026-10-25
supersedes:
applies-to:
  - packages/system/src/builtins/composer/pulse-seed.ts
  - packages/system/src/builtins/composer/pulse-seed-resolve.ts
  - packages/system/src/builtins/composer/composer.ts
  - packages/system/src/builtins/composer/composer.addon.ts
  - packages/system/src/builtins/composer/composition-runtime.ts
  - packages/system/src/builtins/composer/field-record.ts
  - packages/addon-admin-ui/src/components/device/customize/event/EventPulseCard.tsx
---

## Context

Camera 101's doorbell override is `latest(rose(active, changed, debounce))` over a
switch. After the block was deleted and created again (D937 releases the claim
before delete returns) the camera's native doorbell slice was still the
Hikvision stamp from weeks earlier. The composer reads that slice as the
field's initial value. `rose` with no new edge returns the current output, so
the claim was written equal to the native stamp and the card said the last ring
was that stamp.

Putting the seed inside `rose` or `latest` was the other option. The stored
formula is the contract: `compilePulseOverride` and `decodePulseOverride` must
round-trip exactly (D936). A timestamp baked into the expression would not.

A plain runner restart is different. Doorbell durability is `restored`, so the
claim's values stay on the row and a re-claim with an empty payload keeps them
(`device-state-mirror` `kept`). That stamp is this block's own answer and must
not be replaced by an empty history window.

## Decision

**A pulse timestamp is seeded in the composer runtime, never in the compiled
expression.** At start, `resolvePulseSeeds` decides from the source, best fact
first: the last off→on in the source field's device history; if that field is
not recorded, the source's `lastChangedAt` only while the source is off and the
change is newer than the target's native stamp (it bounds the ring from above —
it is the end of the last ring); otherwise an explicit null, so the native
stamp is not claimed. A history or level read that fails changes nothing: no
seed, and a stamp this block already claimed is not cleared (D49). A newer
history rise replaces the time and keeps the owned count. The card says no ring
has been seen since the block was created, instead of the native value.

## Consequences

The seed is a start-time fact. It does not count as a press. A source that
exposes history is never bounded by `lastChangedAt`, including when the raw
window is empty. One failed source does not hide another source's rise, and it
does veto concluding "no ring". Tests that build a `Composer` without
`readPulseHistory` keep the previous initial-slice behaviour.

## Enforcement

`pulse-seed.spec.ts`, the pulse cases in `composition-runtime.spec.ts`, the
doorbell composition end-to-end spec, and the doorbell re-claim in
`device-state-mirror-ownership.spec.ts`. No guard: the decision is which fact
wins, and the specs name each one.
