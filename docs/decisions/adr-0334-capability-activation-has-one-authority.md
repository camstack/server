---
id: D334
title: Capability activation has one authority, and a kernel JSON is not a place to keep a per-device switch
status: accepted
date: 2026-09-02
supersedes:
applies-to:
  - packages/system/src/kernel/capability-registry.ts
  - packages/system/src/kernel/config-manager.ts
  - scripts/check-capability-activation-single-authority.ts
---

## Context

A camera-migration analysis went looking for durable state that would survive a
device moving to a new provider, and surfaced a file nobody had thought about in
a long time: `{dataPath}/runtime-state.json`.

It held two maps, both keyed `{capability}/{addonId}` → boolean —
`systemActivation` for the whole system, `deviceActivation` nested under a
deviceId. Absence meant "use the addon manifest's `autoActivate` default".

The first read of it was wrong in the direction that matters, and is worth
recording: it looked like the answer to "does this camera support this
function". It is not. That question is answered by the BINDING —
`getBindings(deviceId)`, declared by the device provider, persisted in the
device-manager's store. `CapabilityRegistry.resolveForDevice` never consults a
binding; it iterates `state.providers`, the addons registered for the
capability, and filtered each one through these maps. So the maps did not
describe the device at all. They were a generic on/off switch sitting above
every function in the system, for every device at once.

Measured, not assumed:

- The file did not exist on either node of the reference cluster.
- `setDeviceActivation` had existed since the first commit and
  never gained a caller. Nothing has ever written the file.
- The read path was nonetheless live. A throwaway spec wired a hand-written
  file into a real `ConfigManager` and proved it: with
  `{"102": {"motion-detection/wasm-motion": false}}`, `resolveForDevice`
  returned `null` for device 102 and the provider for 101. A registered
  provider vanishing for exactly one camera, with nothing logged.
- It was invisible to every census. `docs/reference/storage.md` derives from
  `@durable` annotations on SQLite stores; this was a JSON file, so no
  inventory of durable state has ever listed it.

The reason it is JSON is sound and was not the problem: `CapabilityRegistry` is
kernel and must resolve providers before the storage addon exists, so the state
could not live in SQLite. Moving it there would have created a circular
dependency — the settings engine is itself an addon whose capability resolution
would need the settings engine.

The problem is that it should not exist in either place. [D62](./adr-0062.md)
already decided this: a per-camera function switch stores NOTHING; it reads and
writes the authority that already owned the function (`setDisabled`,
`setWrapperActive`, `RecordingConfig.enabled`, the notification mute) and names
it in `CameraSwitch.authority`. A second switch that disagrees with the first is
worse than no switch, and this repo has already shipped two knobs that wrote a
store nobody read.

## Decision

**Capability activation resolves from the addon manifest's `autoActivate` flag,
and from nothing else.** There is no persisted override layer, at system or
device scope. `runtime-state.json` is deleted along with every accessor that
reached it, and `CapabilityRegistry` no longer holds a `ConfigManager` — that
wiring existed for exactly this state.

**To turn a function off for one camera, write the authority that already owns
it** (D62). A generic map keyed `{capability}/{addonId}` is not that authority;
it is a rival to all of them simultaneously.

**Durable state the kernel must read before addons exist may be a JSON file —
but being outside SQLite means being outside the storage census.** A kernel JSON
is for machine-managed facts with no operator surface (`auto-update.json`,
`.restart-pending`). Anything an operator would ever want to inspect or correct
does not belong there, because nothing will ever show it to them.

## Consequences

`isActiveForDevice` is gone; the four resolution call sites in
`resolveForDevice` and `resolveCollectionForDevice` now call
`isActiveForSystem`, which is honest about what it reads. The `deviceId`
parameter still does real work on those paths — it selects the in-memory
per-device singleton pin (`deviceOverrides`) and the collection filter, both of
which are unaffected and remain.

No migration is needed and none is shipped: nothing ever wrote the file, so no
installation can hold one. A hand-written file is now ignored rather than
honoured, which is the behaviour change, and it only moves resolution back to
the manifest default.

This removes the only reader of `ConfigManager` inside the capability registry.
A future kernel component that genuinely needs config on the resolution path
must argue for it on its own terms, not inherit this wiring.

`DeviceRuntimeState` — the per-capability runtime-state slices backed by the
SQLite `device-runtime-state` collection — is a different and legitimate
mechanism that shares a word with this one and nothing else. It is untouched.

## Enforcement

`scripts/check-capability-activation-single-authority.ts`, wired into
`.husky/pre-commit`. It fails if any source file names `runtime-state.json`, if
any file references one of the removed accessors, or if `CapabilityRegistry`
holds a `ConfigManager` again. Each check is a literal or an import — present or
absent, never a judgement call. It was disarmed three ways before being trusted:
reintroducing the filename, reintroducing `isActiveForDevice`, and re-adding the
`ConfigManager` import each turned it red, and removing them turned it green.

It cannot see a hand-rolled activation map that never names itself. Nothing
conservative can. What it guarantees is that the removed surface, and the door
it came through, do not return by accident.
