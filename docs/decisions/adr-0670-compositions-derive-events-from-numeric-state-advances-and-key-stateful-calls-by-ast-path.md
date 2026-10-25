---
id: D670
title: Compositions derive declared events from numeric state advances and key stateful calls by AST path
status: accepted
date: 2026-09-28
supersedes:
applies-to:
  - packages/types/src/capabilities/capability-definition.ts
  - packages/types/src/capabilities/doorbell.cap.ts
  - packages/types/src/catalogs/sensor-active-state.ts
  - packages/types/src/expression/evaluator.ts
  - packages/types/src/expression/builtins.ts
  - packages/types/src/composition/composition-events.ts
  - packages/types/src/composition/evaluate-field.ts
  - packages/system/src/builtins/composer/composition-runtime.ts
  - packages/system/src/builtins/composer/composition-evaluation.ts
---

## Context

A composed doorbell must emit the same `doorbell.onPressed` event that an
ordinary provider emits, but its event source is a rising sensor edge and its
event time is a composed state field. Emitting on every evaluation would replay
the seed and repeated level notifications; emitting after the owned-field write
would lose a real press when that write fails. A replacement field also cannot
become a second event authority beside the native provider. Finally, stateful
expression calls need memory that survives reevaluation without depending on
source offsets, traversal order or object identity.

## Decision

A capability declares the event name, payload schema and numeric state field
whose strict advance represents the event. Composition planning separately
maps each supported event name to an `EventCategory` and validates that the
declared payload can be built from `{ deviceId, timestamp }`; the mapping is
explicit rather than inferred from a string, so unsupported event categories
fail closed. Only `new` and `add` features may plan state-derived events;
`replace` leaves event ownership with the native provider.

Stateful calls are keyed by deterministic structural AST paths: `root`,
`/operand`, `/left`, `/right`, `/test`, `/consequent`, `/alternate`, and
zero-based `/arg:<index>` segments. Per-field stateful memory is evaluated
transactionally and is committed only with the field result. `rose` shares the
catalogue's sensor-level edge predicate: a first sighting is eligible only
when its transition timestamp is no older than the 30-second freshness window
and no earlier than runtime start; rises across call paths share one output
field debounce clock, defaulting to 2 seconds. `count` starts on its first ANSWERED
input: a finite value seeds the high-water without incrementing, an answered
`null` starts it with no high-water (so the next finite value counts 1), and
an input that did not answer does not start it. Its accumulator output is
initialized from the target's effective value; it then increments only for a
strict finite advance. (Amended 2026-09-29, see Consequences.)

Existing-target state is seeded before any graft, claim or write side effect.
At runtime the event high-water advances before the event bus emit, and emit
precedes the owned-field write. A failed event-bus delivery is logged but does
not block the state write; a failed later write cannot cause the event to be
emitted twice. If an accumulator source is unavailable after it has a value,
the last value is retained as stale rather than reset. A disabled feature
remains serialized and structurally validated but contributes no source reads,
graph edges, fields, events, declarations, grafts, claims, writes or emits.

## Consequences

Capability declarations remain the source of event and payload truth, while
the composition category map is a deliberately small allowlist. A numeric
monotone field is the event high-water; non-finite and null values cannot
advance it. Within a live runtime, the high-water prevents duplicate events
across write retries. It is not durable event deduplication: after a crash
before the composed state is persisted, a restart seeded from older state may
emit the edge again. This deliberately favors a possible duplicate ring over
silently losing one.

**Amendment, 2026-09-29 — what camera 101 showed.** The first real press after
the cutover (09-29 08:09Z) found the composer serving nothing on 101, and the
count it finally wrote was 0. Two defects, both in this record's design:

- *A composition read its own ADDED field through the hub.*
  `pressCountSinceStart = count(lastPressedAt)` read `doorbell.lastPressedAt`
  on the camera in the effective view. That slice exists only once the
  composer's claim lands; the claim lands only once every required field has a
  value; `pressCountSinceStart` is required. With no doorbell slice on 101
  before the migration, this was circular, and for 12 h nothing served 101's
  doorbell state (`composed capability not seeded yet, missing
  [pressCountSinceStart]`). A read of the composition's OWN output — an added
  cap on its existing target, or a field of its composed device — is now
  answered from the runtime's own record (`composition-evaluation.ts`,
  `own-field-reads.ts`; `isOwnRead` wired by the composer), never from the
  hub. It answers what the runtime PUBLISHES for the field — an unavailable
  field under the `null` policy reads `null`, as the hub would have served it
  — so a source that answers late at boot still primes `count` (fix round 1:
  answering "unavailable" there left it unprimed, and the first press after
  boot was swallowed again). A pass evaluates derived fields
  before accumulators and re-evaluates, in the same pass, every field reading
  an own field that changed; the hub's echo of the runtime's own write re-runs
  nothing. Replaced fields are still read in the native view (rule 6).
- *`count` took its first FINITE input as the seed.* The wrapper's write of
  the press itself was that input, so the press was swallowed. `count` now
  starts on the first answered read (see Decision): after apply on a camera
  with no doorbell slice the state is `{ lastPressedAt: null,
  pressCountSinceStart: 0 }` and the claim lands; the first press makes it
  `{ edge, 1 }`.

"Since start" remains the LIFETIME count: `doorbell` is `restored`, the
accumulator is re-initialized from the effective value after a restart. A
restart does not count the last press again because `rose` returns its
current output — the restored `lastPressedAt` — when there is no new edge, and
`count` takes that first finite value as its seed. `lastPressedAt` is always
evaluated before the count in the same pass, so the count never sees it
unevaluated. One exception, accepted: when a source answers LATE at boot, an
older rule's first pass evaluates `lastPressedAt` with that source unavailable
and writes `null` over the restored value, which stays `null` until the next
press. The count stays right — it was seeded from the restored slice and a
`null` cannot advance it.

A third, separate loss is D677 (fixed on its own branch): the restored doorbell slice on 101 was
dropped from its runtime-state row at a hub boot (09-28 17:04:57Z, 9 → 5 caps);
it is why the seed was null, and it would drop any restored accumulator. Before
this amendment such a loss surfaced as "not seeded yet"; now it seeds a clean
`{ null, 0 }`, so the composer names it: an ADDED `restored` cap seeded from no
slice logs `composed restored capability seeded from nothing` (info, tagged
with the device) once per runtime build.

## Enforcement

Focused tests enforce the planner, stateful evaluator, edge predicate, seed and
runtime ordering. In particular:

- `packages/types/src/composition/__tests__/composition-events.spec.ts` checks
  add/replacement and disabled-feature event planning.
- `packages/types/src/composition/__tests__/composition-graph.spec.ts` checks
  disabled features do not contribute graph edges.
- `packages/types/src/expression/__tests__/builtins.spec.ts` checks shared
  debounce, first-sighting rules and count seed/high-water behavior.
- `packages/system/src/builtins/composer/__tests__/composition-runtime.spec.ts`
  checks finite-seed suppression, event-before-write, event-bus failure,
  write-retry deduplication, accumulator retention and disabled behavior, and
  that an own-field read is answered by the runtime (seeds `{ null, 0 }` with
  no slice on the hub, counts the first press), that a source late at boot
  still counts the first press (`{ null, 0 }` → `{ T, 1 }`; restored
  `{ T0, 2 }` → `{ T, 3 }`), and that the hub's echo runs no pass.
- `packages/system/src/builtins/composer/__tests__/composer-existing.spec.ts`
  checks the seeded-from-nothing line.
- `packages/types/src/composition/__tests__/evaluate-field.spec.ts` checks
  that an answered `null` starts `count` and an unavailable read does not.
- `packages/system/src/builtins/composer/__tests__/doorbell-composition.e2e.spec.ts`
  starts camera 101 with NO doorbell slice (the production state) and checks
  `{ null, 0 }` after apply, `{ edge, 1 }` and one state change after a
  press, and the lifetime count across a restart.

The AST path is guarded by
`packages/types/src/expression/__tests__/evaluator.spec.ts`; effective target
seeding before ownership is covered by
`packages/system/src/builtins/composer/__tests__/composer-existing.spec.ts`.
