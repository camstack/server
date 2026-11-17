---
id: D1061
title: A commanded value is held by the hub until the device confirms it; no client patches what it shows
status: accepted
date: 2026-11-17
supersedes:
applies-to:
  - packages/system/src/builtins/device-manager/command-holds.ts
  - packages/system/src/builtins/device-manager/command-holds-wiring.ts
  - packages/system/src/builtins/device-manager/device-state-mirror.ts
  - packages/system/src/kernel/command-hold-overrides.ts
  - packages/types/src/device/command-hold.ts
  - packages/types/src/device/cap-vocabulary/**
  - packages/ui-library/src/hooks/use-device-command.ts
  - scripts/check-no-ui-optimism.ts
---

## Context

A control has to move the moment it is commanded. Until now each surface
guessed on its own: the ui-library patched a control's display through
`useOptimisticSlice` / `applyOptimisticAction` (about 40 files), the viewer
kept per-control optimistic state, and the Alexa thermostat Response projected
the commanded state from the slice read before the command (D874). Three
problems followed.

- **A slow integration snapped back.** A cloud poller (VeSync, a cloud
  thermostat) answers its next poll with the OLD value for seconds. The client
  patch expired on its own timer (4 s, or 30 s while the call was pending) and
  the stale poll then flipped the control back, then forward again when the
  device caught up.
- **Two clients disagreed.** The patch lived in the browser that sent the
  command; a second browser, the viewer and Alexa each showed something else.
- **Each guess restated the effect.** A purifier speed set in Auto also leaves
  Auto; the patch on the card, the Alexa projection and the viewer each had to
  know that, or each got it wrong separately.

## Decision

The hub holds what a command leads to. Every device command the hub sees (its
tRPC mount, the UDS parent for a forked addon, an in-process addon's
`ctx.api`, the D1022 seams) arms a hold in `DeviceStateMirror`: the
vocabulary's effects for that method (D920/D983, now a list, with
`sideEffects` conditional on the current slice) are laid over the slice the
device reported. The mirror serves and emits the EFFECTIVE slice; the slice it
stores, persists and records stays the device's. Each held field remembers
what the device reported for it when the command arrived, and judges every
new reading of that field:

- equal to the pre-command value (or to a value an older command on the field
  held, before a newer one replaced it): STALE, the device has not acted yet —
  the hold stays;
- equal to the held value — a number within the effect's tolerance, the step
  of the arg it was copied from (brightness ±1, a temperature target ± its
  0.5 step): CONFIRMED — the hold ends;
- anything else (`locking`, `jammed`, `arming`, `opening`, a value rounded
  beyond the step): the DEVICE'S OWN ANSWER — the hold ends at once and the
  device's value is served, logged at debug with `tags: { deviceId }`, the
  cap, the field and reason `device-answered`.

A held field also ends when the call is refused (rolled back at once), when
the limit elapses with the device still stale (30 s, the D1022 match window;
reverted and warned with `tags: { deviceId }`), or when a newer command names
the same field (latest wins). The held value carries no pending marker. A
`negate` side effect (`switch.toggle`) holds the opposite of what the person
saw, held values included.

What reads which:

- UIs, voice and exporters read the effective slice (the default).
- History, automations and every decision read the CONFIRMED slice:
  `DeviceStateChanged` carries `confirmed` while a hold changes the slice,
  `getCapSlice` / `getAllSnapshots` take `confirmed: true`, and generated
  automation code asks for it.

A provider may override a method at `registerNativeCap(cap, provider,
{ commands })`: `{ hold: 'never' }`, another limit (`holdMs`, at most 120 s),
or replaced / extra effects. The override never lives in the manifest or the
`*.cap.ts` (D4).

No client patches what a control shows. A control renders the served slice and
runs its command through `useDeviceCommand`, which only reports a refusal.
This supersedes the client-side optimism recorded in D77 (the admin switch
group's optimistic-with-rollback) and amends D874: the Alexa Response re-reads
the slice after the command, which is the effective slice.

## Consequences

- One place knows what a command leads to; a new multi-field effect is a
  vocabulary entry, not a patch in each client.
- A restart drops every hold (memory only); the device's next report decides.
- A command the hub does not see (a provider writing its device on its own, a
  device changed by hand) holds nothing: there is nothing to hold.
- Overrides registered by an agent's child process do not reach the hub's
  override registry yet (a broker-mode agent's provider registrations do not
  carry them); its devices get the vocabulary default. No provider sets an
  override today; carrying them is a follow-up.
- Input smoothing is not optimism: a slider may still debounce its trailing
  commit before sending.
- A stored automation the generator wrote before this change is regenerated
  once at boot through its `AUTOMATION_RECIPE` (core-blocks migration
  `2026-11-17-automation-confirmed-view`), so its device reads take the
  confirmed view. One whose code is not the generator's output (hand-edited,
  or written by an older generator) is left as it was and logged per
  automation; saving it in the editor moves it. Hand-written code blocks and
  the SDK `SystemMirror` still read the effective view — a confirmed default
  for them is a follow-up.

## Enforcement

- `packages/system/src/builtins/device-manager/__tests__/command-holds.spec.ts`
  (the stale-poll, refusal, revert, `never`, multi-field, latest-wins,
  stale / confirmed-within-step / device-answered, device-removal, shutdown
  and confirmed-view cases), `cap-vocabulary/__tests__/command-catalog.spec.ts`
  (tolerance, `negate`, the effects of each cap), `shared/__tests__/device-state-changed.spec.ts` (the
  confirmed readers) and the automation codegen specs.
- `scripts/check-no-ui-optimism.ts` refuses the old hook and its patch in any
  UI source (ui-library, admin UI, an addon `.tsx`).
