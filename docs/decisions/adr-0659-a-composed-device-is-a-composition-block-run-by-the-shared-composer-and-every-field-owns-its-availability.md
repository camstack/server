---
id: D659
title: A composed device is a composition block run by the shared composer — sources by (addonId, stableId), every field owns its availability, only a GONE source fails the block until the operator acts
status: accepted
date: 2026-09-27
supersedes:
applies-to:
  - packages/types/src/composition/**
  - packages/types/src/capabilities/composer.cap.ts
  - packages/types/src/capabilities/core-blocks.cap.ts
  - packages/system/src/builtins/composer/**
  - packages/system/src/builtins/core-blocks/**
---

## Context

Phase 4 proved once (device 1836) that a core block can declare a device and
derive its state through the salvaged expression engine, but every composed
device was hand-written TypeScript in its own runner, re-deriving the same
plumbing. The 2026-09-27 spec asks for a generic, declarative composition:
type → features → a source per field, API-driven first.

Tried first, on paper: storing numeric source ids (what wiring did). A resync
reissues them and orphans the composition. `stableId` alone is not unique
either: it is unique per owning addon.

What went wrong during slice 1, each caught in review before it shipped:

- The spec says "source deleted, **or its cap removed** → the block goes
  `failed`". A provider restart (or a hub restart, before the provider has
  re-registered) unregisters its natives exactly like a removal does, and two
  back-to-back binding reads are one correlated read, not two opinions. Failing
  the block there would have failed every composition on every provider
  respawn, sticky, until an operator acted.
- `DeclaredDevices` sweeps every undeclared row. One apply that omitted a block
  would delete its device; a fresh composer (empty memory) handed the empty list
  that a failed `core_blocks` read produces at boot would sweep ALL of them; a
  block whose row fails to parse, or whose plan no longer resolves after a
  release renames a cap, would read as deleted.
- The first `evaluate` dropped an outcome whose value had not changed, so the
  deadline timer kept an old deadline and re-armed `setTimeout(0)` until the
  window closed — a poll by another name.
- `SourceTracker.sync` built its next map across awaits; an event that landed
  mid-way was overwritten when the map was assigned.
- The composition reads answered `[]` before the store loaded (D315), and two
  unserialized writes could each pass the cycle check against a store the other
  was about to change.

D224 says a consumer never keeps a second copy of a device fact. The composer
keeps one — `SourceTracker` — and this record names the boundary below.

## Decision

A composition is a `core_block` with `source.kind === 'composition'`, run by the
shared `composer` builtin (`execution.isolate` + `group: composer`, a group of
ONE), never compiled. Every source is a `{ addonId, stableId }`. Each state
field has exactly one source (`from` or `expression`; `code` reserved), is
evaluated from the events its sources already emit, and owns its availability:

- **stale** (last value kept) — the source is offline, a re-read failed or
  answered "no report", or its sole wrapper was deactivated;
- **unavailable, non-fatal** — the provider unregistered the cap at runtime, or
  the cap is not bound on a device whose row exists. Never a stale number (spec
  §2, D393); healed by the source's own `native-registered`;
- **unavailable, fatal** — the source DEVICE row is gone and two index reads
  agreed. The field is `null` where the cap allows it, else the composed device
  goes offline; the block goes `failed` naming the source, and stays so until
  an operator edit or restart (no auto-repair).

Only a gone device fails a block. Nothing is declared or withdrawn while the
`core_blocks` store has not loaded, a device is withdrawn only when two applies
agree, and a row the composer cannot plan or read is held by a placeholder, not
deleted. Nothing polls and nothing waits on a timer. Saves are validated and
refused by name; the variants of later slices are in the wire shape and refused
by name.

## The rules, each with its reason and its cost

**Wire shape (refines spec §1, controller ruling R7a).**
- A source is `{ addonId, stableId }`, not a bare `stableId` — `stableId` is
  unique only per addon. Cost if wrong: one schema rename before slice 2.
- `target.new` carries no `name`: the block's name is the device's name (spec
  §1, D62 — one writer of the name). Cost: none; a rename is a block rename.
- The composer's cap method is `composer.applyBlocks`, not `apply`: tRPC
  reserves `apply` on a router proxy. Cost: none.

**Availability (deviates from spec §2).** A removed or unbound cap on an
existing device is UNAVAILABLE and non-fatal, for the reason in Context. Cost: a
cap removed for good shows unavailable with its reason, forever, and never
fails the block — the operator sees the reason on the field, not on the block.
A deactivated sole wrapper keeps the value stale (spec: offline/unreadable →
stale). Cost: a stale value may be shown longer than the wrapper's owner meant.

**D224 boundary (R7d).** What the tracker holds is the INPUT of a field the
composition owns. It is served to no other consumer — no cap method or getter
reads it; the composed device's slice is the only output. It is fed by
`device.state-changed`, `device.unregistered` and `device.bindings-changed`,
hydrated by one read, and a read that fails changes nothing in it (D49).
Reconcile for dropped events (D8, R7c) is the source's own (re)registration:
a `native-registered` or wrapper toggle re-reads that cap, `device-status`
re-reads `online`, and a source found under a new id is re-read at once. A
resolved source is otherwise never re-read. Cost: a dropped
`device.state-changed` leaves a field at its last value until the source
changes again, re-registers, or the operator edits/restarts the block.

**Boot safety (D49).**
- `Composer.apply` declares and withdraws NOTHING while the `core_blocks` store
  has not loaded (`storeLoaded` rides every apply; `load()` is retried on each
  converge and logs once per transition). Cost: a block deleted while the store
  is unreadable keeps its device until the store reads.
- The withdrawal gate is seeded from the composer's persisted rows, so a restart
  is never the first miss.
- An EMPTY own-rows seed is trusted only when the next apply's read also returns
  `[]`; until then that apply reports `starting`. No timer. Cost: one converge.
- A block whose row exists but whose plan fails (a release renamed a cap), and a
  row that fails to parse (sent as a typed malformed block), declare a
  PLACEHOLDER: the device is kept with no caps, the block is `failed` naming the
  reason. A release that renames a cap never deletes a device.

**Writes (D3).** A seed the target refused stays pending and the whole cap is
re-written on the next pass; a target that throws is caught, logged once per
transition, and marked write-pending — it never escapes the runtime; `stop()` is
terminal. There is no retry timer: the next source event or deadline is the
retry. A windowed expression arms one deadline, and EVERY evaluation is stored
so a moved deadline reaches it; only writes and logs are value-driven.

**API.** `createComposition` / `updateComposition` / `getComposition` /
`listCompositions` / `validateComposition` on `coreBlocks`, admin-only, the
tiers proven through the live router. Reads are a union with `not-loaded` while
the store has not loaded (D315 — never an empty list that means "unknown").
Writes run on one serialized chain, and `updateComposition` requires
`expectedUpdatedAt` (the `updatedAt` the caller read): a stale edit is refused,
not merged. Cost: a client must re-read after a conflict.

**Save-time cycle check.** It sees every READABLE stored composition. It cannot
see through a row that fails to parse. Accepted: an unreadable block does not
run (it is a placeholder), so no value flows through the edge it would have
contributed. Cost: a cycle through such a row surfaces only once the row is
repaired, and is refused then.

**`getStatus` is the kernel default.** A composed cap registers an EMPTY native
provider; `getStatus` is answered by the kernel's default over the runtime slice
(`packages/system/src/kernel/moleculer/device-cap-proxy.ts`), on both the
registry and the UDS path. The validator refuses a cap without `runtimeState`,
so the default always has a slice to serve — and the default is only RIGHT
because every composable cap's `status.schema` and `runtimeState` are one
shape (`composed-device.spec.ts` pins it; slice 3's `recording-signal` will be
the first cap that breaks it).

## Consequences

- **ROLLBACK WARNING.** A build older than D659 does not know
  `CoreBlock.source`: it strips it and rewrites the row, and every composition
  becomes an empty code block. **Export the compositions
  (`coreBlocks.listCompositions`) before rolling back below D659.**
- A composed device is a normal device row: `getBindings` lists its caps,
  `getProviderForDevice` resolves them, and exporters, the NC, HomeKit and
  `getDeviceStatusAggregate` see it unchanged.
- A non-nullable field has no `null`, so its fatal unavailability is device-wide
  offline. Other fields keep updating. An exporter that ignores `online` shows
  the last written number next to the offline flag — accepted for slice 1.
- A cap with a method (e.g. `motion.isDetected`) cannot be composed until
  commands arrive (slice 3): the room's occupancy is `binary.on`.
- Block status reaches the operator on the supervisor's existing 15 s converge.
- `group: 'composer'` is a group of ONE: the D29 guard refuses any addon that
  joins the group of a device-owning builtin (`DEVICE_OWNING_BUILTINS`).
- The composer is a new forked runner that imports `ALL_CAPABILITY_DEFINITIONS`
  (D28 measured the barrel at +84 MB RSS per forked runner); the spec accepts
  the runner.
- `any`, `all`, `within`, `latest` are expression builtins now; `for` waits for
  history.
- **Live verification, not covered by a test** (passive checks on the first
  deploy — no load on the cluster):
  1. the forked-runner path: the shipped composer runs in `udsMode` (no
     capability registry; natives land in `workerNativeCaps`, served by the UDS
     dispatch), while `room-device.e2e.spec.ts` proves the hub-style registry
     path. Confirm `deviceManager.getBindings(composedId)` lists the caps and
     `getDeviceStatusAggregate` shows their values;
  2. the kernel's `device.unregistered` reaching the composer's subscription
     (`composer.addon.ts`) — the tests drive `Composer.onDeviceUnregistered`
     directly;
  3. one composed room device created through the API on the hub, read back
     through `getComposition` and the device's status;
  4. the cost of the `device.state-changed` fan-out: the hub forwards EVERY
     device state change to the forked composer over UDS, which filters by
     `deviceId` after transport. Read the composer child's
     `event-plane-report` after an hour on the hub.

## Enforcement

- `validate-composition.spec.ts` (every refusal and reserved variant, by name);
  `expression-kinds.spec.ts` (every builtin has a kind rule);
  `composition-graph.spec.ts` (cycles, the candidate replaces its stored peer).
- `source-tracker.spec.ts` (two reads before "gone"; one promise chain; an
  unbound cap is unavailable and non-fatal, healed by `native-registered`; a
  resolved source is not re-read);
  `composition-runtime.spec.ts` (a moved deadline is stored; pending writes
  retried whole; a throwing target never escapes; stop is terminal);
  `composition-declarations.spec.ts` (two applies before a withdrawal; gate
  seeded from persisted rows);
  `composer.spec.ts` (nothing declared while the store has not loaded; empty
  seed trusted only on agreement; placeholders);
  `source-deleted.spec.ts` (no auto-repair);
  `composer.spec.ts` also: a block whose device never built does not re-open a
  source it shares with a healthy block (no poll, no auto-repair);
  `deadline-timer.spec.ts` (a deadline beyond Node's largest delay is reached in
  legs — never a 1 ms spin).
- `composed-device.spec.ts` (every composable cap's `status.schema` and
  `runtimeState` are one shape — what the kernel default `getStatus` stands on).
- `block-supervisor.spec.ts` (an owed empty apply is paid only by one the
  composer says it `acted` on).
- `room-device.e2e.spec.ts` (native providers and the kernel default `getStatus`
  through the real registry).
- `composer-manifest.spec.ts` (sole member of its group) +
  `scripts/check-runner-group-isolation.ts` `DEVICE_OWNING_BUILTINS` (D29).
- `composition-api.spec.ts` (not-loaded reads, serialized writes,
  `expectedUpdatedAt`) and
  `core-blocks-composition-admin-only.router.spec.ts` (admin tiers through the
  live router).
- The rollback hazard: nothing, review only — and this record.
