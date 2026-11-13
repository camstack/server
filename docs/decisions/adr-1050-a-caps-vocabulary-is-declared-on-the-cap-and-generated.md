---
id: D1050
title: A cap's vocabulary is declared on the cap, and the map is generated
status: accepted
date: 2026-11-13
supersedes: D920
applies-to:
  - packages/types/src/capabilities/capability-definition.ts
  - packages/types/src/device/cap-vocabulary/**
  - packages/types/src/generated/cap-vocabulary.ts
  - scripts/generate-cap-vocabulary.ts
  - scripts/lib/cap-vocabulary-project.ts
  - scripts/lib/cap-vocabulary-literal.ts
  - scripts/lib/cap-vocabulary-check.ts
  - scripts/check-no-handwritten-cap-vocabulary.ts
  - scripts/lib/handwritten-cap-vocabulary.ts
---

## Context

D920 put every cap's operator wording — actions, state triggers, event
phrases, the excuses for what is not offered — in one hand-written map (the
now retired `cap-vocabulary/entries/` files), next to the caps but outside
them. It worked as a vocabulary, and failed as a record of intent:
a method and the step that calls it lived in two files, so a new or reshaped
method was "done" in the cap and silently missing (or stale) as a step. When
steps moved to storing an `actionId` (D983, #517), every config method nobody
had written an entry for — PTZ presets and home, the heat pump's per-circuit
settings — stopped being a step at all, and the only trace of the decision
was a `notOperatorFacing` string in the other file ("Needs a circuit: set
from the device page"), which described a limitation of the vocabulary, not
of the method.

Putting the whole entry in one cap-level block was considered and refused: it
keeps the method and its step apart, only in the same file. Zod `meta` on
status fields for the state triggers was refused too: status schemas are
shared objects (one Zod object serves several caps' status), so the meta would
be shared or lost, and `power-source` has no `status` at all.

## Decision

A capability declares its own vocabulary, where the thing it describes is
declared. A method opts in as one or more ACTIONS in its options (`actions:
[{ id, label, phrase, icon, args?, openArgs?, effect? }]`, typed against the
method's input), or says why not (`notOperatorFacing`); an event carries its
`trigger` or its `notOperatorFacing`; the cap's `vocabulary` block holds the
rest — noun, picker `order`, state triggers, extra events, overrides by
`DeviceType` / `DeviceRole` — and, for a system cap, only its reason
(`NOT_A_DEVICE`). `npm run codegen` projects the declarations into
`packages/types/src/generated/cap-vocabulary.ts`, the same `CapVocabularyMap`
D920 defined, in the same order; every consumer (steps, BYS, MCP, remote
bindings, the Do catalogue) reads it unchanged. Nothing is whitelisted by
kind: a mutation becomes a step only by an explicit `actions` entry, so
deletes, resets and system configuration stay out unless a person decides
otherwise. A dynamic offer may read the status of a sibling cap of the same
device (`cap` on a `from: 'status'` offer), so a per-circuit method offers the
circuits `heat-pump-status` reports. What D920 decided about the map's
contents, its typing and how consumers resolve it still holds.

## Consequences

- A method and the step that calls it are reviewed in one diff; adding an
  operate method without an action or a reason fails the same guard as
  before, now pointing at the cap.
- The map is generated: editing `generated/cap-vocabulary.ts` is drift, and a
  hand-written entry anywhere is refused.
- A cap change that touches only wording is still a cap change: it ships as a
  `@camstack/server` publish like any other framework data.
- Picker order is a number on each device cap (families by thousand); two
  caps declaring one order are refused by the generator.

## Enforcement

`scripts/check-cap-vocabulary.ts` (judge `scripts/lib/cap-vocabulary-check.ts`)
keeps every D920 check, run over the generated map, plus the sibling-cap
offer (the cap must exist, be a device cap and declare the status field).
`scripts/check-no-handwritten-cap-vocabulary.ts` refuses a file under the
retired `entries/` directory, a value typed as a map entry outside the
generated file, and a `vocabulary.ts` that does not read the generated map.
`generated-vocabulary.spec.ts` proves the generated map is the last
hand-written one, cap by cap and in picker order, apart from an explicit list
of actions added on purpose. Codegen drift is caught by `codegen:check`.
