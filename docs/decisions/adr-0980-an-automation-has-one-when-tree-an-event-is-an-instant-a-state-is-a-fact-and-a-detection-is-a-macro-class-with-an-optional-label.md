---
id: D980
title: An automation has one `when` tree — an event is an instant, a state is a fact, and a detection is a macro class with an optional label
status: accepted
date: 2026-10-30
applies-to:
  - packages/types/src/automation/when.ts
  - packages/types/src/automation/detection-subject.ts
  - packages/types/src/automation/legacy-recipe.ts
  - packages/types/src/automation/recipe.ts
  - packages/types/src/automation/condition-eval.ts
  - packages/types/src/automation/codegen.ts
  - packages/types/src/automation/trace.ts
  - packages/cli/src/mcp/configure-automations.ts
---

## Context

The recipe was `triggers[]` plus an optional `conditions` tree. Two vocabularies
described the same world: "the door opens" was a trigger, "the door is open"
was a condition, and the editor had to teach the difference as two sections.
They also could not be combined in the ways people speak: "when the light turns
on while the door is open" and "when the door opens while the light is already
on" are different automations, and `triggers: [light, door]` plus a condition
could express only one of them, and silently as an OR.

Tried first and rejected: keep two sections, **When** and **Only if**, and make
the editor friendlier. It left the OR-of-triggers semantics in place, kept two
parsers and two evaluators, and gave `not` no meaning over a trigger.

A detection leaf had the same problem one level down: `classes: ['dog']` mixed
a macro class (`animal`) and a raw class (`dog`) in one string list, with no
place for "this person is Ann" or "this car has that plate".

## Decision

**One `when` tree.** Containers are `all`, `any`, `not`. Leaves are **event
leaves** (device-state "becomes", device-event, schedule, interval, manual,
detection, stationary) or **state leaves** ("is", stationary-present,
expression). The distinction between an instant and a fact is carried by the
leaf's verb, not by a section.

1. A tree with event leaves fires when ONE event occurs and the whole tree is
   true at that instant. The event that occurred is true; every other event leaf
   is false in that instant.
2. A tree of states only fires on false → true. The first evaluation only
   seeds, so a tree already true at start never fires. An evaluation that read
   an unknown value neither seeds nor moves the edge — unknown is not false
   (D49).
3. Two events that can only be satisfied together are refused at author time
   (`validateWhenTree`), with a sentence that says why. The check normalises
   negation first (De Morgan), so `not(any(A, B))` and `all(not A, not B)` are
   one shape; a negated event is refused on its own ("it did not happen" is true
   at every other moment).
4. Run mode, cooldown and `for` keep their meaning. Depth 4 and 32 leaves.

**Conversion is read-time, one-way and lossless.** `{ triggers, conditions }`
becomes `all(any(triggers), C)`, or `any(triggers)` without `C`; a single
trigger is not wrapped; the old `condition` leaf becomes "is". It runs in the
schema (`AutomationRecipeSchema` is a union whose legacy member transforms), so
every parser — the core-blocks cap, the MCP tool, a server reader — applies it
by parsing. New writes emit only the new shape. Blocks compiled before this
change keep running: the generated source imports legacy wrappers
(`evaluateConditionTree`, `collectMirrorSources`, the trigger filters) that
convert on the way in.

**A detection leaf is ONE macro class plus an OPTIONAL label.** The taxonomy is
`COCO_TO_MACRO` — no second list. `animal` takes a sub-class, `person` takes a
known face (an identity of the `face-gallery`), `vehicle` takes a plate or a
sub-class, `package` takes a sub-class; `other` keeps a class the taxonomy does
not know. A stored `dog` converts to `animal` + `dog`. A sub-class label must
belong to its macro (refused by the schema). With no label the leaf is any
subject of the class.

Identity is decided late (D683): face recognition and plate reading land after
the track starts, and the `pipeline-analytics.track-lifecycle` `update` event
carries the newly resolved `label` / `plateText`. A leaf WITH a label therefore
fires when the subject GETS the label, not at first detection — it rejects the
first `start`, and the filter's once-per-track memory is spent only by the
fire. No timer or poll is involved; if the event does not arrive the leaf does
not fire. Two honest limits: `identityId` is declared on the event but not set
at the emit site, so a person label matches by the identity's NAME; and the
parked-object event carries a class and zones only, so a stationary leaf
refuses a face or plate label in its schema instead of letting it sit dead.
The editor lists labels through the galleries' own methods
(`face-gallery.listIdentities`, `plate-gallery.listPlates`) and
`subClassesOf(macro)`; `DETECTION_LABEL_SOURCES` names them.

**The trace follows the tree.** The trigger trace is the fired event leaf with
its vars (a detection's vars carry the matched `label`) and its path; condition
nodes cover the whole tree under `when`. A step trace carries `args`, bounded
and with a secret redacted by name or keychain marker. Old traces still parse.

## Consequences

- The engine subscribes from the event leaves, plus the mirror sources of the
  state leaves for rule 2, with one evaluation path (`evaluateWhenTree`).
- Old compiled blocks stay readable until they are next saved; the legacy
  wrappers cannot be deleted before then.
- The admin editor and its fixtures still speak the old shape; they work through
  the same conversion until the editor is rewritten.
- A label that never arrives (no recognised face) means the leaf never fires.
  That is the rule, not a defect: the alternative is a timer deciding for the
  recogniser.

## Enforcement

`packages/types/src/automation/__tests__`: `generated-block.spec.ts` runs the
generated block (rules 1 and 2, with the light/door pair that differ only by
which side is the instant), `when-tree.spec.ts` (rule 3, the conversion,
args, the macro set equal to the taxonomy's), `detection-trigger.spec.ts`
(label fires on the label event). Each was watched failing with its rule
removed.
