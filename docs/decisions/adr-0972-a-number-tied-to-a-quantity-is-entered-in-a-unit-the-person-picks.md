---
id: D972
title: A number tied to a quantity is entered in a unit the person picks; readings store the base unit, method params their declared unit; a bare API value is the base unit with a warning
status: accepted
date: 2026-10-29
supersedes:
applies-to:
  - packages/types/src/units/**
  - packages/types/src/automation/**
  - packages/system/src/builtins/core-blocks/actions-service.ts
  - scripts/lib/cap-vocabulary-check.ts
---

## Context

D944 stores every reading in the base unit of its quantity (mass in kg). An
automation condition on `pet-feeder.bowlFood` therefore compared against
kilograms while the operator thinks in grams, and a method such as `feed` takes
grams. Each screen picked its own unit or showed a bare number. Rewriting
`feed` to kilograms would have meant a migration of every stored call.

## Decision

A number tied to a physical quantity is ENTERED in a unit the person picks and
STORED in a fixed one:

- a reading (a condition leaf on a device field) is stored in the quantity's
  base unit (D944);
- a cap method param declares its own quantity AND expected unit with
  `paramMeta({ quantity, unit })`, and is stored in that unit (`feed` keeps
  grams);
- the write form is `{ value, unit }` ("this number is in this unit"). The
  server converts it and stores the bare number plus the picked unit
  (`leaf.unit`, `step.argUnits[arg]`) so an editor can show the number as it
  was typed. A stored bare number is never converted again;
- a unit of another dimension, or a unit on a field that is not a quantity, is
  refused with a typed `QuantityUnitError`;
- a bare number through the API on a quantity field is ACCEPTED as the stored
  unit, reported in a `warnings` array of the save result and in a warn log
  tagged `{ deviceId }`. It is not rejected.

## Consequences

Option A (no migration): a param keeps the unit it always had. A vocabulary
offer for a quantity param carries `quantity` and its `unit` is the param's, so
a client converts the bounds. The warning is only raised when the quantity has
more than one selectable unit. Leaf conversion has no live server entry yet:
the editor saves generated code, so `normalizeRecipeUnits` is exported for the
editor or a later wiring.

## Enforcement

`check-cap-vocabulary` compares each number offer with the `paramMeta` of its
input. Specs: `normalize-units.spec.ts`, `quantity-input.spec.ts`,
`actions-service.spec.ts`, `check-cap-vocabulary-units.spec.ts`.
