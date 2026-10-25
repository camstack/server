---
title: Phase 6 — the automation recipe, the block algebra, and three corrections to the chapter
date: 2026-08-09
status: Model + code generator BUILT and verified by RUNNING a probe automation on the live hub (compile alone proved nothing — see §1.1, three defects sat behind a green compile). Editor built, typechecked and unit-tested; NOT yet driven in a browser (§1.2) — that review needs a deployed admin-ui.  The mockup gate of the parent chapter was LIFTED by the operator on 2026-08-09 ("procedi tu con la UI, la vediamo insieme alla fine" [you proceed with the UI, we will look at it together at the end]) — the review happens at the end, on the working thing. Bounds verdict recorded below. `CoreBlock.source` persistence NOT built (deferred with a stated reason and a shipping order).
applies-to:
  - packages/types/src/automation/**
  - packages/types/src/expression/**
  - packages/addon-admin-ui/src/pages/build/**
  - packages/types/src/capabilities/core-blocks.cap.ts
  - packages/types/src/capabilities/notification-rules.cap.ts
---

# Phase 6 — the recipe

Parent chapter: [2026-08-08-automation-scripts-custom-devices.md](./2026-08-08-automation-scripts-custom-devices.md).
This document is Phase 6 of its plan and does not restate it. Read Part 2 (§2.1
the taxonomy, §2.4 the visual half), Part 3 (§3.2 the vertical flow, §3.2.1 the
algebra, §3.2.2 actions, §3.2.3 `vars`) and Part 8 (what the operator closed)
before this.

Everything here obeys the chapter's central sentence: **there is one noun — the
block.** An automation is a core block. There is no `addon-automations`, no
automation table, no second rule engine, and nothing in this phase adds one.

---

## 1. What landed

`packages/types/src/automation/` — pure, dependency-light, no I/O:

| File | What |
| --- | --- |
| `recipe.ts` | `AutomationRecipe` = triggers + condition tree + actions. Bounds (`validateRecipeBounds`, `conditionDepth`, `countConditionLeaves`) |
| `codegen.ts` | `generateAutomationBlock({name, recipe})` → the TypeScript of an ordinary core block |
| `index.ts` | module barrel, re-exported from `packages/types/src/index.ts` |

It lives in `@camstack/types` rather than in an addon for one reason: the bare
`@camstack/types` entry is **bundled** into addons (D15), so `addon-admin-ui`
gets the model and the generator client-side with no hub round-trip and no train.
That is what makes the editor work against the cluster as it stands today.

### 1.1 `coreBlocks.compile` returning `ok:true` is NOT proof

The first pass of this document claimed the generator was verified because the
live hub compiled its output. **That claim was wrong, and the way it was wrong
is the most useful thing in this document.** `coreBlocks.compile` answers "does
this bundle", not "does this run". Three defects sat behind a green compile, and
each one would have produced an automation surface that silently never fires:

| Defect | How it presented | Found by |
| --- | --- | --- |
| **`croner` is not resolvable in a materialised block** | the runner spawns and dies in a crash loop, with **no error line at all**, until the circuit-breaker trips | creating three probe blocks — a control, one importing `@camstack/types`, one importing `croner`. Only the croner one died |
| **`deviceState.getCapSlice` takes `capName`, not `cap`** | the call rejects, `readField` returns `undefined`, and EVERY condition leaf is false forever | `condition leaf unresolvable` on every tick, against a device whose slice plainly holds the field |
| **`ctx.api` is keyed by ROUTER name (`alarmPanel`), not cap name (`alarm-panel`)** | every `cap` action throws `no such device method` — the whole THEN half is dead | reading the emitted `actuate` while wiring the editor |

The schedule trigger therefore emits a **self-contained scheduler** rather than
importing a cron library: armed to the next minute boundary and re-armed from
the wall clock every tick, which keeps the anti-drift property croner was chosen
for (§2.4: "`setInterval(24h)` drifts and 'at 07:00' does not") while importing
nothing a block cannot resolve.

**What the real verification looks like.** A probe automation was created on the
live hub whose condition tree can never be true — so no action could run — with
a `* * * * *` schedule:

```
status: running, lastError: (none)
00:35:00.002 debug automation did not run — conditions were false
00:36:00.001 debug automation did not run — conditions were false
unresolvable-leaf warnings: 0
```

Two ticks, one minute apart, landing 1-2 ms after the minute boundary; the
expression leaf evaluated; the catalog leaf read the real `alarm-panel` slice and
compared it; the decision was logged; nothing actuated. That is the whole loop —
codegen → esbuild → fork → runner → trigger → condition → logged decision — and
it is the first evidence that means anything. The probe was deleted; the cluster
is back to `{"blocks": []}`.

**A gap worth its own line, because it is the failure mode this feature exists to
avoid:** a block that dies on an unresolvable import produces **no log line**.
The circuit-breaker message names no cause. That is a `core-blocks` defect, not
an automation one, and it is the reason three probe blocks were needed to find a
one-word answer.

### 1.2 Not verified: the editor in a browser

The editor typechecks, builds, and passes 65 tests in `pages/build` (990 across
the package). **It has not been driven in a browser.** The production bundle
boots through Module Federation and expects to be served by the hub; a local
static harness with `/trpc`, `/api` and `/addon` proxied to the live cluster
serves the assets and authenticates, but the app never issues a tRPC call and
stalls at `Loading…`. Vite's dev server is not an alternative here: it resolves
`@camstack/types` to source, and `utils/canonical-hash.ts` imports `node:crypto`
at module top level, which the browser externalizes — this reproduces on an
unmodified checkout and is unrelated to this work.

So the operator review of §3.2's flow has to happen against a **deployed**
admin-ui. That is the one outstanding verification, and it should be treated as
outstanding rather than assumed: this repo has shipped three layout regressions
that only the operator caught.

---

## 2. Three corrections to the chapter

Each was found by reading the code the chapter points at, not by re-deriving the
design. All three change what Phase 6 builds.

### 2.1 The condition leaf is NOT `NC_CONDITION_CATALOG`

§3.2.1 says the leaf renders "from the machine-readable descriptors that already
drive two NC editors with no client code". Read against
`packages/types/src/capabilities/notification-rules.cap.ts`, that catalog cannot
serve an automation:

`NC_CONDITION_CATALOG` is **detection-event shaped**. Its entries are `devices`,
`classes`, `classesExclude`, `minConfidence`, `zones`, `crossing`,
`labelEquals`; its `group`s are `scope`/`class`/`quality`/`zones`; its operators
are `in`/`notIn`/`anyOf`/`allOf`/`gte`/`fuzzyIn`/`withinSchedule`. Every entry
describes a predicate over **one pipeline event**. None of them addresses
`(deviceId, cap, field)`, which is precisely what §3.2.1's leaf is defined as.

The right source was already named by the chapter and already salvaged for it:
**`deviceManager.getWireableFields`**. Live shape, from the cluster:

```
GET deviceManager.getWireableFields {"deviceId":1453}
→ { caps: [ { cap: 'cover',
             fields: [ {path:'state',kind:'enum'}, {path:'position',kind:'number'},
                       {path:'tiltPosition',kind:'number'}, … ] }, … ] }
```

So the leaf's operator set is **derived from `kind`**, not hand-maintained:

| field `kind` | operators offered |
| --- | --- |
| `boolean` | `eq` · `ne` |
| `number` | `eq` · `ne` · `gt` · `gte` · `lt` · `lte` |
| `string` / `enum` | `eq` · `ne` · `contains` · `in` |

The two catalogs stay separate on purpose, and this is also the cleanest
statement of the boundary the chapter draws: **the NC's catalog describes what
happened in a frame; the automation's catalog describes what a device currently
is.** They share no entries because they are predicates over different things.

### 2.2 An NC action cannot target the device that triggered it

§2.4 and §3.2.2 both say actions reuse `NcRuleActionSchema` **verbatim**. The
runner should be reused verbatim — but the schema cannot be, and the reason is
structural:

```ts
// notification-rules.cap.ts
kind: z.literal('cap'),
deviceId: z.number().int(),          // ← a literal id, always
```

and the runner is explicit that its own subject device is not a routing input:

```ts
// rule-actions.ts — RunSequencesInput
/** Subject device — for the log tag, never for routing. */
readonly deviceId: number
```

For the NC this is correct and costs nothing: a notification rule already scopes
to its devices. For an automation it is fatal — "sound the siren of the camera
that saw the person" is unexpressible, and that is among the first things an
operator will ask for on a cluster with 17 cameras and 8 sirens.

**Resolution, and it keeps the reuse honest.** `AutomationActionSchema` is a
superset in exactly one field:

```ts
deviceId: z.union([z.number().int(), z.object({ $var: z.string().min(1) })])
```

The `{$var}` form is resolved from the run's `vars` bag **before dispatch**, so
the action runner still receives a number and `NcRuleActionRunner` is untouched —
its device-scope check, its stop-at-first-failure and its per-sequence throttle
are reused as they are. What was "verbatim" about the chapter's intent is the
RUNNER; the schema gains a resolved-before-dispatch variant, which is a strictly
smaller change than teaching the runner about variables.

`args` needed nothing: it is already `z.record(z.string(), z.unknown())`, so
`{{vars.x}}` slots fit with no schema change. They **substitute and do not
evaluate** (§3.2.3) — anything beyond substitution is the expression leaf.

### 2.3 The chapter's own wireframe uses devices that do not exist

§3.2's mockup is authored against `102 · Gate contact` and `812 · Front door
lock`. On the live cluster, **102 is `Camera parking`**, a camera, and
there is no device 812, no lock and no door/window contact anywhere in the 319
devices. This matters because the mockup was to be validated against "one real
automation the operator actually wants", and a wireframe built on props cannot
do that.

The live inventory the design must actually serve: 17 cameras · 8 sirens (each
attached to a camera) · 6 floodlights (likewise) · 1 alarm panel (1023 `Alarm`,
from `pipeline-analytics`) · 1 cover (1453 `Tapparella hall`) · 1 presence
(1027 `doorbell`) · 108 switches · 100 sensors · 11 buttons. **There is no
classic contact/lock estate.** An automation vocabulary designed around door
contacts would have shipped against a house that does not exist.

---

## 3. The bounds verdict — what the gate existed to validate

The chapter states the concept is approved and **the bounds are the open
question**: depth ≤ 3, ≤ 32 leaves. Expressed end to end against real devices:

**"Notte: chiudi e arma"** — at 23:30, unless we are already out, if the salon
shutter is open (or it is a cold night), close it and arm for the night. Every id
is live.

```
WHEN   schedule  30 23 * * *
AND ONLY IF
  ALL of                                                        ← depth 1
   ├── NOT                                                      ← depth 2
   │    └── 1023 Alarm · alarm-panel.state  is  armed-away      ← depth 3, leaf 1
   ├── ANY of                                                   ← depth 2
   │    ├── 1453 Tapparella hall · cover.position  >  0       ← depth 3, leaf 2
   │    └── ƒ  outdoor < 5                                      ← depth 3, leaf 3
   └── 1027 doorbell · device-status.online  is  true           ← depth 2, leaf 4
THEN
  1. ⚡ 1453 Tapparella hall → cover.close
  2. ⏱  wait 20 s
  3. ⚡ 1023 Alarm → alarm-panel.arm { mode: "night" }
```

**Verdict — the two bounds are not equally chosen.**

| Bound | Used by the first real automation | Verdict |
| --- | --- | --- |
| depth ≤ 3 | **3 of 3 — saturated** | **Keep, but know it is tight.** The first realistic automation uses the entire depth budget. |
| ≤ 32 leaves | 4 of 32 | **Loose, keep.** No realistic authoring pressure; it is a runaway guard, not a design constraint. |

Depth 3 survives scrutiny for a reason worth recording, because it is what makes
the tight budget safe: **`NOT` over a group is always rewritable by De Morgan** —
`not(any(a,b))` ≡ `all(not a, not b)`, which is one level shallower. So the
shapes that would want a fourth level have an equivalent at three. The refusal
message therefore does not merely say no; it names the rewrite:

> conditions nest 4 levels deep — the limit is 3. "not (any of …)" is the same as
> "all of (not …)", which is one level shallower

The real binding constraint on an expression leaf is not the leaf count at all —
it is the engine's own `MAX_EXPRESSION_BINDINGS = 32`, shared between device
bindings and `vars` in one identifier namespace.

---

## 4. Decisions this phase made (the §8.2 items it owns)

- **The generated code is regenerated, never stored for audit.** Storing it
  creates a second copy that can disagree with the recipe. It is shown read-only
  and labelled derived.
- **The recipe travels inside the generated file** as
  `const AUTOMATION_RECIPE = {…} as const`, which is what lets the editor
  re-open a visually-authored automation *before* `CoreBlock.source` ships. This
  is not a second store: there is still exactly one `core_blocks` row, and the
  recipe is part of the one artefact it holds. When the `source` union lands, the
  literal becomes redundant and is deleted in the same change that starts
  persisting the recipe properly — noted so it is not left behind as a leftover
  that describes the right design.
- **Bounds are enforced in the schema AND at generation**, so a recipe arriving
  over the wire cannot skip the check the editor applies, and generation refuses
  rather than emitting code the operator did not author.
- **A leaf that cannot be resolved is `false` and LOGS**, with
  `tags: { deviceId }`. It never throws the pass away and never counts as true.
  Every branch that declines to run logs why — the generated block logs the
  conditions-were-false path too, because "it never fired" must be answerable.
- **The `device-state` trigger reads the state mirror, not the event.** The event
  only WAKES an evaluation; a 15 s reconcile is the backstop. Under D8 a dropped
  event therefore DELAYS a trigger and does not lose it. This is the one place
  the chapter's lossy-trigger honesty is actually implementable, and it is
  implemented.

---

## 5. What is NOT built, and the order to ship it

1. **`CoreBlock.source` union** (`{kind:'code'} | {kind:'recipe'}`) — the proper
   home for the recipe. It is a `*.cap.ts` change, so: `npm run codegen`, then a
   **force-publish of `@camstack/system`** (nx-affected misses cap changes), then
   `applyServerUpdate`. Until then the `AUTOMATION_RECIPE` literal carries it.
   A boot migration maps existing `{code}` rows to `{kind:'code', code}`; it will
   find nothing on this cluster (`coreBlocks.list` → `{"blocks":[]}`, verified
   2026-08-09) and must exist anyway (D78).
2. **Phase 5 shapes** — a block registering `automation-control` IS an Automation
   device. That is a sibling agent's work, and it is what makes **Run actions**
   real: the button's authority is `automation-control.trigger`, which stores
   nothing. Until Phase 5 lands, the button is rendered disabled with the reason
   stated rather than wired to an invented second execution path.
3. **`vars` written by a trigger.** The bag is created and passed, and a code
   action can write it; auto-populating it from a `device-state` trigger's
   matched value is the natural next increment and is what makes `{$var}` action
   targets useful.
4. **The `{kind:'code'}` action's per-step deadline** (default 10 s, max 60) and
   `AbortSignal` — specified in §3.2.2, not yet emitted by the generator.
5. **Eject to code** as a one-way `kind` flip — needs (1). Today the editor can
   show the generated source and hand it to the Scripts editor, which is the
   same destination by a less formal route.

**Nothing in this phase requires a hub train to be useful today**, which is why
it was built in this order: the model and generator ride the bundled types entry,
and the editor saves through `coreBlocks.create`/`update`, both already live.
