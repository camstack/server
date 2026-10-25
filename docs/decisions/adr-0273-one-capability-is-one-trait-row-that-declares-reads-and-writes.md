---
id: D273
title: One capability is ONE trait row that declares, reads and writes — or it is not exported
status: accepted
date: 2026-08-28
supersedes:
applies-to:
  - packages/addon-export-google/src/google-home/trait-catalog.ts
  - packages/addon-export-google/src/google-home/cap-dispatch.ts
  - packages/addon-export-google/src/google-home/device-model.ts
---

## Context

Every ecosystem exporter in this repo does the same three jobs for each
capability: **declare** it to the ecosystem, **read** its state, and **write** a
command to it. All three existing exporters split those jobs across files that
nothing binds together.

`addon-export-alexa` is the clearest case: `endpoints/builder.ts` declares,
`handlers/report-state.ts` reads, and `handlers/power-controller.ts` +
`handlers/brightness-controller.ts` write. A capability can therefore be
declared and unreadable, or readable and uncommandable, and the compiler is
content either way.

This is not hypothetical drift — the repo already carries a guard for the same
failure arrived at from the other direction.
`scripts/check-export-coverage.ts` exists because three hand-written mapping
tables (`CAP_ENTITY_MAP` in Home Assistant, `SENSOR_MAP` in
`device-control-resolution.ts`, `HAP_CAP_SERVICES` in HomeKit) disagree about
which status FIELD carries a capability's value — `celsius`/`temperature`,
`percent`/`humidity`, `lux`/`illuminance` — and exactly one side can be right.
Its own docblock records the measured cost of the related bug: 177 of 293
devices carrying Home Assistant entities that could never receive a value,
because an unrecognised capability still fell through a default branch and
produced one.

The first sketch of the Google exporter mirrored Alexa's layout — an
`intents/sync.ts` that knew the trait names, an `intents/query.ts` that knew the
status fields, an `intents/execute.ts` that knew the command names. Three files,
three independent lists of capability names, and no way to ask "is everything I
declare also commandable?" without reading all three.

## Decision

In `addon-export-google`, a capability is exported by exactly one
`TraitDescriptor` row in `packages/addon-export-google/src/google-home/trait-catalog.ts`,
and that row owns all four things the ecosystem can ask about it: the trait it
declares (`trait`, `attributes`), the capability status it reads (`reads`,
`projectState`), the commands it answers (`commands`, `resolveCommand`) and the
state a successful command establishes (`statesAfterCall`). SYNC, QUERY and
EXECUTE all walk the same array; none of them carries its own list of capability
names. **A capability with no complete row is not exported at all** — never
declared-but-inert.

`resolveCommand` and `projectState` are PURE: they return data (`CapCall`) or
`null`, never perform I/O. The single place that turns a `CapCall` into a real
`ctx.api` invocation is `cap-dispatch.ts`, whose two switches are exhaustive
over their unions and closed with a `never` binding.

## Consequences

- **Cameras are not exported by this addon.** Google's `CameraStream` trait
  answers `GetCameraStream` with a playable URL or a WebRTC signaling endpoint;
  neither exists here, so no row can satisfy the rule, so the trait is absent
  rather than declared. `buildSyncDevice` returns `null` for a camera and the
  caller logs the drop with `tags: { deviceId }`. This is the rule doing its
  job, not a gap in it.
- `listSupportedDeviceKinds` — a UI filter that nothing enforces on
  `exposeDevice` — is derived from the catalog rather than hand-listed, and
  `exposeDevice` refuses a device with no matching row instead of accepting one
  that every later SYNC would silently drop.
- Widening the export is one row plus one `CapCall` variant. Forgetting the
  dispatch arm is a compile error, not a runtime 404.
- The cost: the catalog file grows with the integration, and a trait needing a
  genuinely stateful resolver (Google's relative commands, `BrightnessRelative`
  and `openRelativePercent`, need the current value) cannot be expressed by a
  pure resolver. Those are refused with `functionNotSupported` and a logged
  reason rather than resolved by guessing.
- This addon does not adopt `packages/types/src/utils/export-reconciler.ts`, and
  neither does anything else — its docblock claims to be "shared by the camera
  export addons (Alexa, HAP)" and only HAP uses it.

## Enforcement

`packages/addon-export-google/src/__tests__/trait-catalog.spec.ts` walks
`TRAIT_CATALOG` and asserts the invariant over every row: each row names a
capability and a read path, advertises at least one command, ANSWERS every
command it advertises (a row that returns `functionNotSupported` for its own
advertised command fails), and rejects a status payload that is not the
capability's own schema shape. A new row that is declared but not readable or
not commandable fails that spec.

Exhaustiveness of the dispatch is enforced by the compiler, not by a test: both
switches in `cap-dispatch.ts` end in a `never` binding.
