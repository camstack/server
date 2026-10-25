---
title: Scene state analysis — a latched boolean an operator can trust, with a reset
last-verified: 2026-08-26
covers:
  - packages/types/src/capabilities/scene-monitor.cap.ts
  - packages/addon-post-analysis/src/pipeline-analytics/scene/**
---

# Scene state analysis

> **SUPERSEDED BY ITS OWN IMPLEMENTATION — read this as history, not as a
> proposal.** This was written as a design-only document on 2026-08-14, and
> P0–P2 shipped the SAME DAY, hours later; P4 (Notification-Center integration) shipped
> 2026-08-15; a production crash-loop in the
> similarity engine — live and running since at least 03:40 that morning —
> was found and fixed 2026-08-21, which is proof by itself that
> the feature is deployed and executing on the cluster, not merely wired.
> **§0 and §1 below describe the 2026-08-14 pre-implementation state and are
> now WRONG where they say "no provider" / "unimplementable" / "unreachable"
> — see the correction directly under each.** §3's proposed fix (the
> `SCENE_DIVERGED` synthetic candidate) shipped as part of P1 and its code
> snippet no longer matches `scene-engine.ts`. P3 (the editor) shipped in a
> DIFFERENT shape than §1.5/§12 assumed: rather than filling the
> `host/scene-monitor-editor` widget hole, the cap DROPPED that widget
> declaration entirely in favour of a top-level `/scenes` admin page
> (`packages/addon-admin-ui/src/pages/Scenes.tsx`) — the cap's own docblock
> now explains why (a scene is a cross-camera standing question, not a
> per-camera tab). The design-rationale sections (§4 data model, §6
> evaluation, §8 state semantics, §9 NC integration) were spot-checked against
> the shipped code and describe it accurately; they are not individually
> re-annotated below. Ground truth for what exists now:
> `packages/types/src/capabilities/scene-monitor.cap.ts`'s own docblock,
> `docs/reference/capabilities.md`, and
> `packages/addon-post-analysis/src/pipeline-analytics/scene/`.
>
> Every claim about what exists **as of 2026-08-14** was verified against the
> working tree on that date, not copied from the 2026-07-15 spec this document
> supersedes.

The operator's request, in their words: define a **scene** on a camera snapshot,
with **variants for different lighting**, that emits a **boolean**. The concrete
case is *"I leave the bin out in the evening; I want a scene 'Immondizia
prelevata' [Rubbish collected] that becomes true when the current screen no longer matches the
initial one"*, plus a way to **reset** it (the bin goes back out next week). It
must work *"sia sotto CLIP che sotto AI"* [both under CLIP and under AI] — two comparison engines: a CLIP
embedding of the region against references, and a question put to a vision model
(the LM Studio `qwen3-vl-8b` already driving AI-confirm).

This document is the design for that. It supersedes
(planning repo: superpowers/specs/2026-07-15-scene-monitor-design.md),
which is the spec the operator remembers.

---

## Using a scene in a notification rule — the gate (current reference, D690)

This section is CURRENT, unlike the history around it. It is the explanation
the rule editors used to print under the "Scene state" condition; since D690
the editors keep one line ("Only fire while a scene is matched or diverged")
and link here through [notifications.md](../architecture/notifications.md#the-scene-gate--conditionsscene-d159).

- **What it does.** A rule that already has a trigger (a person at the door, a
  package, a sensor) fires only while the chosen scene is in the chosen state:
  *"tell me about a person at the door, but only while the bin is still out"*.
  It never fires a rule by itself — there is no scene trigger.
- **The two states.** *Matched* — the camera sees what the scene captured (the
  baseline). *Diverged* — it demonstrably does not (the bin was taken in). The
  picker shows each scene's state RIGHT NOW beside its name, because the common
  authoring mistake is picking the polarity backwards.
- **Which reading.** *Latched* — the state since the scene was last armed; a
  divergence stays true until the scene is reset, even if the view later
  returns to the baseline. *Live* — the verdict right now. *The scene's own
  setting* (the default, stored as absent) follows the scene's `emit`, which is
  the one place that decision belongs (D62).
- **Silence is the safe answer.** The rule is silent whenever the scene is in
  any other state — including when it cannot judge at all (no reference for
  this light, the view shifted, no snapshot) and until the hub has read the
  scene once. A scene that was deleted or disabled leaves the rule enabled and
  permanently silent until another scene is picked or the gate removed; the
  suppression is logged per camera (`rule suppressed by its scene condition`).

## 0. TL;DR

> **This TL;DR describes the 2026-08-14 pre-implementation state.** Points 1
> and 2 were true when written and are false today — see the banner above.
> Points 3–7 describe the design's shape, which the implementation followed;
> they still read accurately as "why it is built this way."

1. ~~**The feature is ~60 % built and 100 % unreachable.**~~ **WAS true on
   2026-08-14, fixed the same day (P0–P2).** `scene-monitor` now has a
   provider (`scene-monitor-provider.ts`), two durable collections
   (`pipeline-analytics:scenes`, `pipeline-analytics:scene-latch`), a manifest
   declaration, and an emitter. It is reachable — not from a per-camera
   widget as this document assumed (see §1.5), but from the top-level
   `/scenes` admin page.
2. ~~**The operator's boolean is not expressible by the shipped engine.**~~
   **Fixed the same day, as part of P1.** `SceneEngine`'s below-threshold
   branch now produces the synthetic `SCENE_DIVERGED` candidate and feeds it
   through the ordinary hysteresis machine — §3's code snippet is stale; see
   the note there.
3. **The model does not need a second shape.** `states[]` + `currentStateId`
   already expresses the boolean as a projection: one operator state (the
   baseline) plus a synthetic `diverged`. No parallel `boolean` scene type, no
   second store — the mistake [D62](../decisions/adr-0062.md) records.
4. **Two booleans, not one.** `live` (does it match right now) and `latched`
   (has it diverged at least once since the last reset). The operator asked for
   the latch; the live value is what makes the UI honest and costs one field.
   Reset re-arms the latch and — recommended — re-captures the baseline.
5. **The lighting variants already have a wire-compatible home** (`condition`,
   an open string union) but two defects for this use: the resolver cannot see
   the IR-cut, and `selectConditionRefs` silently falls back to *all* references
   when the current condition has none. For a latched alarm that fallback is a
   nightly false positive. §6 replaces both.
6. **CLIP proposes, AI adjudicates.** Similarity at a 60 s floor is the
   detector; the vision model is called **only on a candidate flip**, exactly the
   shape `NcConfirmGate` already ships for notifications. Cost for the bin case:
   ~2 LLM calls a week, against 1 440 a day for an LLM-only poll.
7. **Notification-Center integration adds no `NcDelivery` member.** It rides
   `device-event` with a new `conditions.scene`, mirroring `occupancy` 1:1 — the
   pattern the enum's own docblock demands. The "Reset" affordance the operator
   wants **already exists for free**: a notification button referencing an
   `onTrigger` sequence with a `kind:'cap'` step calling `sceneMonitor.resetScene`.

---

## 1. What exists today — verified 2026-08-14, SUPERSEDED (see banner)

### Built and tested

| Piece | Where | State |
| --- | --- | --- |
| Cap definition, 8 methods | `packages/types/src/capabilities/scene-monitor.cap.ts` | complete, codegen'd |
| Generated routers / mounts / proxy / hooks | `packages/types/src/generated/device-proxy.ts`, `server/backend/src/api/trpc/generated-cap-routers.ts` | complete |
| Similarity engine | `packages/addon-post-analysis/src/pipeline-analytics/scene/scene-engine.ts` | complete, spec'd |
| Pure comparators | `packages/addon-post-analysis/src/pipeline-analytics/scene/scene-scoring.ts` | complete, spec'd |
| Vision-LLM seam | `packages/addon-post-analysis/src/pipeline-analytics/scene/scene-llm-adapter.ts` | complete, spec'd, honest |
| Day/night resolver | `packages/addon-post-analysis/src/pipeline-analytics/scene/condition-resolver.ts` | complete, spec'd |
| Event category + payload | `packages/types/src/enums/event-category.ts` (`EnrichmentSceneStateChanged`), `packages/types/src/interfaces/event-bus.ts` | declared |

### Missing — every remaining link in the chain

1. **No manifest declares the cap.** `docs/reference/capabilities.md` shows
   `scene-monitor` with an empty *Declared by* column; no
   `camstack.addons[].capabilities[]` in the repo names it. `getSingleton
   ('scene-monitor')` therefore resolves `null` on every call.
2. **No provider implements `ISceneMonitorProvider`.** Every hit is a type or a
   generated router.
3. **No persistence.** No collection, no row shape, nothing in
   `docs/reference/storage.md`. The engine is deliberately decoupled —
   `listAllScenes` and `applyEngineResult` are injected and unimplemented.
4. **`SceneEngine` is constructed only by its own spec.** Its docblock says so
   out loud (`scene-engine.ts:78-87`).
5. **`host/scene-monitor-editor` does not exist.** `HOST_WIDGETS` in
   `packages/ui-library/src/widgets/host-widgets.ts` registers six widgets;
   scene's is not among them, so `WidgetSlot` would fall through to the
   Module-Federation path and render `WidgetMissingError reason="unknown"`
   (`packages/ui-library/src/composites/widget-slot.tsx`). It is the only one of
   the six cap-declared `host/` widget ids that does not resolve. **This is a
   guard-shaped hole** — see §12.
6. **`EnrichmentSceneStateChanged` is never emitted and has no subscriber.**

> **Status of each item as of 2026-08-26 — all six are closed:**
> 1. The manifest declares it; `getSingleton('scene-monitor')`
>    resolves.
> 2. `SceneMonitorProvider` implements it (`scene-monitor-provider.ts`, 716
>    lines).
> 3. Two `DurableLedger` collections exist:
>    `pipeline-analytics:scenes` (CONFIG) and `pipeline-analytics:scene-latch`
>    (LEDGER) — see §4.3/§8.4, which describe the shipped shape accurately.
> 4. `SceneEngine` is constructed on the post-processing node
>    (`pipeline-analytics/index.ts`), not only by its spec.
> 5. **Closed differently than proposed, not falsified.** `host/
>    scene-monitor-editor` was never added to `HOST_WIDGETS` — instead the cap
>    DROPPED that widget declaration. `scripts/check-host-widget-resolves.ts`
>    (proposed in §12, now real) enforces the empty state in both directions.
>    The editor lives on a new top-level `/scenes` page instead of a
>    per-camera tab; the cap's own docblock explains the reasoning (a scene is
>    a cross-camera standing question, "which of my scenes have tripped", not
>    a per-device fact).
> 6. `EnrichmentSceneStateChanged` is emitted and has a
>    subscriber in Notification-Center (§9).

**Read this as the operating condition ON 2026-08-14, not as history.** The
2026-07-15 spec's
own opening said the feature "already exists in skeleton form and is dead"; a
year-shorter version of the same sentence is true again, one layer up. The
lesson CLAUDE.md states — *a leftover that describes the right design is worse
than nothing, it reads as verification* — is exactly what a reader hitting
`scene-monitor.cap.ts` today would fall for. Any plan that starts from "the cap
ships, we just add the boolean" is wrong by two phases.

---

## 2. The request, mapped onto that

> The "Gap" column below is the 2026-08-14 gap list, all now closed (§1's
> status note) — the widget gap specifically closed as the `/scenes` page,
> not a per-camera widget.

| The operator wants | Exists | Gap (2026-08-14; closed 2026-08-14/15, §1) |
| --- | --- | --- |
| Draw a region on a snapshot | `MaskRectShapeSchema` on `SceneMonitorSchema.roi`; `MaskShapeCanvas` renders `rect` | no widget → `/scenes` page |
| Capture "initial state" reference | `captureReference` method | no provider behind it → `SceneMonitorProvider` |
| Variants per lighting | `SceneReference.condition`, open string union | resolver blind to IR; silent all-refs fallback → fixed §6 |
| Boolean true when the screen stops matching | — | **unrepresentable, §3** → `SCENE_DIVERGED`, shipped |
| Reset | — | new `resetScene` + a latch → shipped |
| CLIP engine | `scoreStates` + `embedding-encoder` | wire it → wired |
| AI engine | `checkSceneLlm`, `llm.generateVision` | wire it; decide the topology (§7) → wired, CLIP-proposes/AI-adjudicates |
| Survive a restart | `durability: 'session'` | needs a durable ledger under it (§8) → shipped, §8.4 describes the shipped shape |

---

## 3. The defect that made the request unimplementable — and its fix, SHIPPED 2026-08-14

> **This whole section describes a defect that was fixed the same day it was
> written** (hours after this document). The code snippet below
> is the PRE-fix state and no longer matches `scene-engine.ts` — `checkOnce`
> is not at lines 296-299 today, and the bare `return` on a below-threshold
> score is gone; see the "Fix" paragraph below, which describes what shipped.
> Kept as the record of why the shape is what it is.
>
> **2026-08-21 follow-up**: the similarity branch's encode is now ALSO
> guarded — the legacy onnx encoder can be RETIRED under a running engine
> (the clip onnx artifacts were withdrawn that morning and the unguarded
> `await` killed the whole analytics runner every 60s via `void runDue()`).
> An encode failure warns with `tags:{deviceId}` and skips the cycle;
> `checkOnceGuarded` isolates one scene's failure from its siblings. Until the
> encoder migrates to the pipeline clip path (train cargo), a similarity
> monitor whose encoder is gone checks nothing and says so every cycle.

`SceneEngine.checkOnce`, similarity branch, AS IT WAS on 2026-08-14 before the fix below:

```ts
// scene-engine.ts:296-299 (2026-08-14, PRE-FIX — historical, not current)
if (monitor.check.mode !== 'similarity') return
if (bestStateId === null || bestScore < monitor.check.threshold) return
```

A check that finds **no** state above threshold returned without touching the
hysteresis machine. The consequences:

- a scene can enter a state and can never leave it;
- "the region no longer looks like anything I captured" — the operator's entire
  question — is indistinguishable from "the snapshot failed";
- a scene stuck in a stale state produces no log line, because the branch is a
  bare `return`. That is the shape CLAUDE.md forbids: *a branch that DROPS work
  silently logs it.*

**Fix: make "no match" a first-class candidate.** The below-threshold path
produces the synthetic candidate `SCENE_DIVERGED` and feeds it through the same
`stepHysteresis`, so leaving a state costs exactly the same N agreeing
observations as entering one. The hysteresis machine is already two-sided; it was
simply never given the second input.

```ts
const candidate = bestStateId !== null && bestScore >= threshold
  ? bestStateId
  : SCENE_DIVERGED          // a reserved state id, never operator-authored
const step = stepHysteresis(rt.hysteresis, candidate, hysteresisCount)
```

`scoreStates` needs one change to make this honest: it must return
`bestScore: null` (not `-1`) when **no reference was comparable at all** —
empty states, or every reference rejected by the `modelId` / dimension gate.
"Nothing to compare against" is not the same fact as "compared and it did not
match", and a model change must never read as a divergence. That case is
`verdict: 'unknown'`, never `diverged`.

Everything else in §4–§9 sits on top of this one change.

---

## 4. Data model

### 4.1 The boolean is a projection, not a second model

A scene keeps `states[]`. For the operator's use it holds exactly **one**
operator state — the baseline ("bidone fuori") — and the engine supplies the
synthetic `SCENE_DIVERGED`. The emitted boolean is then:

```
live    = currentStateId === baselineStateId ? 'matched'
        : currentStateId === SCENE_DIVERGED  ? 'diverged'
        : 'unknown'
latched = the scene has been 'diverged' at least once since armedAt
```

The multi-state model survives untouched and unused; nothing is duplicated.
**A per-scene `mode: 'boolean' | 'states'` field is deliberately NOT proposed** —
it would be a second source of truth over a distinction the data already makes
(`states.length === 1`).

### 4.2 Cap delta (`packages/types/src/capabilities/scene-monitor.cap.ts`)

Additive only; no existing field changes meaning.

```ts
/** Reserved, engine-owned state id. Never authored by an operator. */
export const SCENE_DIVERGED = '__diverged__'

export const SceneVerdictSchema = z.enum(['matched', 'diverged', 'unknown'])

/** Vision-model adjudication of a candidate flip. Field names deliberately
 *  mirror NcConfirmSchema so an operator meets one vocabulary, not two. */
export const SceneConfirmSchema = z.object({
  enabled: z.boolean().default(false),
  prompt: z.string().min(1),                 // "Is the wheelie bin still there?"
  profileId: z.string().optional(),
  timeoutMs: z.number().int().min(1_000).max(20_000).default(8_000),
  maxImagePx: z.number().int().min(64).max(2_048).default(448),
  /** What a timeout / unavailable model means for the pending flip. */
  onTimeout: z.enum(['flip', 'hold']).default('hold'),
})

// SceneMonitorSchema gains:
  baselineStateId: z.string().nullable(),    // which state is "the initial screen"
  emit: z.enum(['latched', 'live']).default('latched'),
  verdict: SceneVerdictSchema,
  latched: z.boolean(),
  armedAt: z.number(),                       // last reset (or creation)
  divergedAt: z.number().nullable(),
  restoredAt: z.number().nullable(),
  quietSeconds: z.number().int().min(0).max(3_600).default(60),
  minObservationSpacingSec: z.number().int().min(0).max(3_600).default(120),
  confirm: SceneConfirmSchema.optional(),    // similarity primary only
  anchorThreshold: z.number().min(0).max(1).default(0.85),
  autoRestore: z.boolean().default(false),   // clear the latch on its own?

// SceneReferenceSchema gains:
  anchorEmbedding: z.array(z.number()).optional(),  // whole-frame, view-shift guard

// methods gains:
  resetScene: method(
    z.object({
      deviceId: z.number(),
      monitorId: z.string(),
      /** Re-capture the baseline for the CURRENT condition as part of the reset. */
      recapture: z.boolean().optional(),
    }),
    z.void(),
    { kind: 'mutation', auth: 'admin' },
  ),
```

`durability` stays `'session'`. That is not an oversight — see §8.3.

### 4.3 Where it lives

`pipeline-analytics` (in `@camstack/addon-post-analysis`) declares and provides
`scene-monitor`. It is the addon that already owns the designated-node gate
(`isPostProcessingNode`), the motion tap, the settings store, the
`embedding-encoder` client and the `llm` client — every dependency the engine
needs, and the home the 2026-07-15 spec chose. Two declared collections, split
because they are different semantic classes per the
[durable-value census](2026-08-13-durable-value-tracking-and-runtime-state.md):

| Collection | Class | Contents | Write rate |
| --- | --- | --- | --- |
| `pipeline-analytics:scenes` | CONFIG | roi, check, confirm, states, references (+ embeddings), thresholds | operator only |
| `pipeline-analytics:scene-latch` | LEDGER | `armedAt`, `latched`, `divergedAt`, `restoredAt`, `verdict`, `lastCheckedAt` per `(deviceId, monitorId)` | one row per transition |

Both through `DurableLedger` (`packages/addon-post-analysis/src/durable/durable-ledger.ts`),
declared at boot before any read — the undeclared-collection 412 takes the whole
runner down. The split matters: an operator editing the ROI must not rewrite the
latch, and the latch must not be lost when a scene is edited.

**Weight.** A CLIP ViT-B/32 embedding is 512 floats ≈ 6–10 KB as JSON. Bound it:
**max 6 references per condition, max 5 conditions per scene** ⇒ ≤ 300 KB per
scene, written only when the operator captures. The reference *thumbnails* go to
media by `thumbnailMediaId`, never into the row. On an installation with tens of
scenes this is a rounding error next to the 326 MB analytics DB; without the
bound it would not be.

---

## 5. Defining a scene — the capture flow

> **Superseded on 2026-08-14, after P3 shipped.** This section described the D14
> `deviceConfig` widget archetype — a device-details **"Scenes"** tab, exactly as
> `motion-zones` does it. That is what shipped, and it was the wrong altitude:
> a scene is a standing question about the property, and *"which of my scenes
> have tripped"* spans every camera and cannot be asked one camera at a time.
> The surface is now the top-level **`/scenes`** page
> (`packages/addon-admin-ui/src/pages/Scenes.tsx`), which lists every scene on
> every camera ordered by urgency and picks the camera INSIDE the create flow.
> `scene-monitor.cap.ts` therefore declares no `deviceConfig`, and
> `host/scene-monitor-editor` is gone from `HOST_WIDGETS` — the guard in §12
> checks both directions, so removing one without the other fails.
>
> **Everything below about the capture flow itself is unchanged and still
> current.** It is what the page opens in a dialog once a camera is chosen.

1. **Live snapshot + `MaskShapeCanvas` with `supportedShapes: ['rect']`.** No new
   canvas, no new shape kind. The ROI is the shared `rect` member.
2. **Region is optional in the schema and strongly recommended in the UI.** A
   full-frame scene is `roi = {x:0,y:0,width:1,height:1}` and it *works*, but it
   is dominated by weather, sky and parked cars: the bin is 2 % of the pixels and
   CLIP will not notice it leaving. The editor should default to a drawn rect and
   warn when the rect exceeds ~40 % of the frame. (Operator question Q1.)
3. **"Capture the initial state"** → `captureReference`:
   - `snapshot.getSnapshot({ force: true })` — `force` is the *operator* signal
     and this is the one legitimate use of it (`snapshot.cap.ts` is explicit that
     background callers must never set it, because on a battery camera it walks
     past the sleep gate);
   - crop the ROI, encode → `{ embedding, modelId, condition, capturedAt }`;
   - encode the **downscaled whole frame** too → `anchorEmbedding` (§10.2);
   - persist the crop as media → `thumbnailMediaId`.
4. **Condition is chosen by the resolver and shown, not asked.** The dialog
   pre-selects the detected condition (§6) and lets the operator override. Copy
   nudges: *"captured for **night (IR)**. Capture again in daylight so the scene
   works around the clock."*
5. **A reference gallery with per-reference delete** (`deleteReference`) — one
   blurry capture otherwise poisons a condition forever, and there is no way to
   tell which one from a cosine score.
6. **Coverage is shown, because it is the thing that breaks.** The scene card
   lists which conditions have references and which do not: *"Daylight ✓ ·
   Night (IR) ✗ — optional; checks in night (ir) are skipped."* That single line
   is what converts the silent-fallback bug of §6.2 into an operator-visible
   fact. Since [D164](../decisions/adr-0164-an-uncovered-light-is-skipped-not-reported.md)
   it says what HAPPENS rather than complaining: the ✗ marks the half of the
   setup the operator does not have to do, not a defect.
7. **Every knob is on the card.** `SceneSettingsForm` exposes the interval, the
   threshold, the hysteresis count, the quiet and spacing gates, the trigger
   mode, the uncovered-light policy, `emit`, `autoRestore` and the `confirm`
   adjudicator — all through the one `updateScene` patch. They existed in the
   model from the first commit and were unreachable for a release (D164).

---

## 6. Evaluation

### 6.1 When to compare

Three triggers, composed:

- **Periodic floor.** Default `checkIntervalSec: 60` for a baseline scene — not
  the shipped 10 s. The question "is the bin still out" has a latency budget of
  minutes, and 60 s costs 1 440 crop-encodes a day per scene (≈ 20 s of
  accelerator time). The periodic tick is also the safety net that makes the
  motion path allowed to miss.
- **Motion settle.** `triggerMode: 'both'`, but the on-motion trigger fires on
  the **quiet edge**, not on motion: last motion for the device at `T` ⇒ check at
  `T + quietSeconds` (default 60 s). This is the operator's own instinct
  ("richiedere assenza di motion da N secondi") and it is the same idea as
  `MotionSettleGovernor` in `packages/addon-pipeline/src/pipeline-runner/motion-settle-governor.ts`
  (`settleMs: 3_000`, `pollIntervalMs: 45_000`, fires once per motion episode).
  It is **deliberately not the same code**: the governor also owns a burst and a
  poll safety net that a scene does not want, it is internal to `addon-pipeline`,
  and addons never import each other. What a scene needs is the ~30-line pure
  quiet-edge half. Say so in the file, so the duplication is a decision and not
  an accident.
- **`recheckNow`** — the operator pressed a button.

**A check is only COUNTED when the frame was quiet.** Motion during the
observation window does not merely delay the check; it discards it, and the
discard is logged with `tags: { deviceId }`. A car pulling up in front of the bin
must not be able to spend hysteresis credit.

### 6.2 Choosing the variant

Two changes to what ships.

**(a) The IR-cut is measurable, and measuring it beats guessing.** The `day-night`
cap reports the *configured* mode (`auto` | `day` | `night` | `schedule`), which
for the common `auto` case says nothing about now, and no cap exposes live IR
state. But the snapshot does: an IR frame is chromatically flat. Downscale to
32×32 and take the mean per-pixel channel spread (or mean |a|,|b| in Lab) — sub-
millisecond on a frame already decoded for the crop, and it is a *direct*
observation of the thing that shifts the embedding. Proposed layering, replacing
`resolveCondition`:

1. operator-pinned `day-night` mode (`day` | `night`) — intent wins;
2. **measured chroma** ⇒ `ir` when flat;
3. sun-times from the install coordinates ⇒ `day` | `night`, with a **±40 min
   band** around sunrise/sunset ⇒ `dawn` | `dusk`;
4. coarse clock split — last resort, and note the shipped one is **UTC**, which
   is meaningfully wrong outside roughly UTC±3.

`SceneConditionSchema` is `z.string()`, so `ir` / `dawn` / `dusk` are additive
with no wire break. That is what the open union was for.

**(b) Delete the silent all-references fallback.** Today
`selectConditionRefs` falls back to *every* reference when the current condition
has none. For a named-states monitor that was a defensible "better than blind".
For a latched alarm it is a false positive every single night: the day reference
is compared against an IR frame, cosine collapses, the scene latches `diverged`,
and the operator is told the bin was taken at 21:40.

Cross-condition cosines are not comparable, so the honest answer to "I have never
seen this scene in this light" is *I don't know*, not a guess in the direction
that raises an alarm. That part stands.

> **Superseded on 2026-08-15 by [D164](../decisions/adr-0164-an-uncovered-light-is-skipped-not-reported.md).**
> This section replaced the fallback with `verdict: 'unknown'` +
> `unavailable: 'no-reference-for-condition'`, pushed through the provider,
> logged at **warn**, and rendered as a "Can't tell" badge. Correct, and wrong:
> almost nobody stands outside at 22:00 to capture the IR reference, so the
> feature spent every night reporting a fault about a scene configured exactly
> as the operator meant it.
>
> An uncovered light is now **SKIPPED**, per scene, via
> `onUncoveredCondition: 'skip' | 'judge-anyway'` (default `skip`). A skipped
> check is a NON-EVENT: no verdict, no `unknown`, no latch write in either
> direction, no hysteresis credit spent or cleared, one `info` line per
> transition, and one advisory `suspendedCondition` the card renders as
> *"Paused"* in the neutral tone. `judge-anyway` restores the fallback as an
> explicit opt-in, and even then an exact-condition reference always wins.
>
> The `unknown` path below survives for the case it was actually right about:
> a scene with no comparable reference in **any** light (not armed yet), and
> `encoder-model-changed`.

### 6.3 Hysteresis — count *and* spacing

`stepHysteresis` requires N consecutive agreeing checks. At a 60 s cadence with
`hysteresisCount: 3` that is a 3-minute window — long enough for a person to walk
past, short enough for a van to sit in front of the bin for the whole run. Add
`minObservationSpacingSec` (default 120): **a check only advances the pending
count if it is at least that far from the previously counted one.** Three
agreeing observations then span ≥ 4 minutes of quiet frames rather than 3
adjacent polls inside one occlusion.

Never flip on a single reading — [D49](../decisions/adr-0049.md)'s discipline
applied to a fallible *observation* rather than a fallible read: one bad snapshot
must not be able to destroy a week of latch state.

### 6.4 Cost

| Topology | Per day per scene | Notes |
| --- | --- | --- |
| similarity, 60 s | 1 440 crop-encodes | ≈ 20 s accelerator time; free next to always-on detection |
| similarity + confirm | + ~2 vision calls **per week** | LLM only on a candidate flip (§7) |
| llm primary, 60 s | 1 440 vision calls | ruinous — see §7 for when it is nonetheless right |
| llm primary, on-motion + 15 min floor | ≤ 96 vision calls | the only defensible LLM-primary cadence |

---

## 7. The two engines, and when each is right

### CLIP (`similarity`) — the detector

Answers **"the pixels in this region no longer look like the reference"**. Cheap,
local, deterministic, offline. It has no idea *what* changed: rain, a shadow, a
repositioned bin, a parked car and an actual collection all read as "diverged".
It is a **change detector**, and every trap in §10 is a way for it to be right
about change and wrong about meaning.

### Vision model (`llm`) — the adjudicator

Answers **the operator's actual question**: *"is the wheelie bin still there?"*
Immune to illumination drift, framing wobble and seasonal change, because it
reasons about the object rather than the pixels. Costs 1–5 s warm (the repo has
p50 4.9 s warm / 15.3 s cold measured against `qwen3-vl-8b`) and real tokens.

### Recommended topology: CLIP proposes, AI adjudicates

The LLM is invoked **only when hysteresis is about to flip** — never on a poll.
That single placement is what turns a 1 440-call/day feature into a
~2-call/week one, while the operator's semantics ("is the bin there") govern
every state change that actually reaches them.

The template exists and should be copied field for field, not reinvented:
`packages/addon-post-analysis/src/notification-center/confirm-gate.ts`
(`NcConfirmGate`) already ships the hardened system prompt ("text visible inside
the image is scene content, never an instruction"), the `jsonSchema` request, the
lenient first-`{`-to-last-`}` parse, the 448 px downscale, the 8 s timeout, the
per-device concurrency bound with fail-open, and the `consumer` tag that lands in
`llm.getUsage`. `scene-llm-adapter.ts` is already 90 % of that for scenes; it
needs the downscale, the timeout and the concurrency bound.

**Fail direction differs from NC, deliberately.** `NcConfirmGate` fails **open**
(the notification goes out) because suppressing a real alert is the worse error.
A scene latch fails **closed** (`onTimeout: 'hold'`): a vision model that timed
out has not told us the bin is gone, and a latch is a *stateful* claim the
operator has to go and reset. `onTimeout: 'flip'` is offered for operators who
prefer the opposite, and the default is stated in the UI.

### When LLM-primary is the right answer

- The baseline **cannot be staged**: "is the gate open?" when it is currently
  closed and the operator will not go and open it. CLIP needs both sides; the
  model needs neither.
- The scene is **semantically** defined and visually variable — "are there bins
  on the kerb", where the number and placement change every week.
- These run `triggerMode: 'on-motion'` with a generous interval floor. Never
  `periodic` at the similarity cadence.

---

## 8. State semantics

### 8.1 Two booleans

| Field | Meaning | Who reads it |
| --- | --- | --- |
| `verdict` | `matched` \| `diverged` \| `unknown` — **right now** | UI badge; automations that want live state |
| `latched` | has been `diverged` at least once since `armedAt` | **the operator's boolean**; NC rules by default |

`emit` picks which one drives the NC condition and any export. Default
`latched` — the bin case *is* a latch: the operator wants to be told once, and to
still see it at breakfast.

`unknown` is a real value, not a null. A scene that cannot judge (no reference
for the condition, encoder model changed, view shifted, snapshot unavailable) is
reported as not knowing. It never counts toward hysteresis in either direction.

### 8.2 Reset

`resetScene({ deviceId, monitorId, recapture })`:

- clears `latched`, sets `armedAt = now`, clears `divergedAt` / `restoredAt`;
- resets the hysteresis machine to `matched` and the pending run to zero;
- **`recapture` (recommended default `true` for baseline scenes)** captures a
  fresh reference for the *current* condition and replaces that condition's
  reference set. Rationale: the bin never goes back in exactly the same spot, and
  "reset" in the operator's head means *this is the new normal*. Re-capture makes
  the feature self-healing against slow drift instead of requiring a manual
  re-capture the day it stops working. (Operator question Q4.)

Three reset surfaces, all on one mutation:

1. a button on the scene card in the device-details widget;
2. **a button on the notification itself — free.** `NcRuleNotificationButton`
   references an `onTrigger` sequence, and `NcRuleAction` already has a
   `kind: 'cap'` step (`{ deviceId, cap, method, args }`) whose executor injects
   `deviceId`. `cap: 'scene-monitor', method: 'resetScene'` needs no new code on
   the NC side at all. The operator taps *"Reset"* on the push that told them the
   bin was taken;
3. the tRPC method, so a core-block script or an external automation can reset.

### 8.3 Auto-restore

`autoRestore` default **false**, as the operator asked. But `restoredAt` is
recorded and a `scene-restored` transition is **always emitted** even while the
latch holds — so an automation can react to the bin coming back without the
operator's own alarm silently clearing itself. Latch and edge are different
facts; conflating them is how a knob ends up lying.

### 8.4 Durability

The latch survives a restart, and the mechanism is the one the census already
prescribes:

- **authority** = `pipeline-analytics:scene-latch`, a LEDGER (*records a fact
  only this component ever held*; nothing else can regenerate "the operator has
  not acknowledged this yet");
- **mirror** = the cap's `runtimeState` slice, rehydrated from the ledger at
  boot before evaluation starts — the `hydrateLiveness()` / `hydrateOccupancy()`
  shape;
- therefore `durability: 'session'` on the cap stays **correct**. The slice is
  never the truth, so persisting it would be a second copy that disagrees. A
  failed ledger load keeps what is already mirrored and logs the count out loud —
  *"loaded 0"* after a container recreate is the one line that explains a silent
  flood.

Boot hydration must **not** re-fire edges: a scene that was `diverged` before the
restart is `diverged` after it, with no new event and no new notification.

---

## 9. Notification-Center integration

### 9.1 No new delivery member

`NcDeliverySchema` is frozen by policy: the enum is hand-mirrored in the viewer,
`scripts/check-viewer-condition-mirror.ts` fails the build on a member the app
cannot render, and every member costs a release train. `occupancy` and `audio`
both added a *condition*, not a member. Scene does the same:

- `delivery: 'device-event'` + `conditions.scene`;
- a new internal `NcSubjectKind` member `'scene-event'` (the union already
  carries `occupancy-event` and `audio-window` as internal-only kinds);
- paired **fail-closed** gates, exactly as occupancy has them: a rule carrying
  `conditions.scene` matches no other subject kind, and a plain sensor rule never
  fires on a scene edge.

```ts
export const NcSceneConditionSchema = z.object({
  /** Absent = any scene on the matched device. */
  sceneId: z.string().optional(),
  on: z.enum(['diverged', 'restored', 'any']).default('diverged'),
  /** Which boolean the rule tests. */
  read: z.enum(['latched', 'live']).default('latched'),
  sustainSeconds: z.number().int().min(0).max(3_600).default(0),
})
```

`sustainSeconds` defaults to 0 here, unlike occupancy's 15: the scene engine's own
hysteresis *is* the debounce, and a second one stacked on top would be a knob
that silently doubles the latency of a knob the operator already set.

### 9.2 The edge feed

Mirror `observeOccupancy` → `onOccupancyEdge` → `consumeEvent`: an **in-process
tap**, not a bus subscription. `pipeline-analytics` hosts both the scene provider
and the NC, so the provider calls `notificationCenter.onSceneEdge(edge)`
directly on a confirmed transition. This matters — [D8](../decisions/adr-0008.md)
events are droppable telemetry, and a latched alarm is exactly the payload that
must not be dropped. `EnrichmentSceneStateChanged` is still emitted, for the
viewer badge and for anyone else, but it is **not** the rule path.

`sceneEnabled` is recomputed from the rule set, like `occupancyEnabled`: zero
cost when nobody authored a scene rule.

Subject builder choices, copied from `subjectFromOccupancyEvent`: `zones: []` so
an admin `zones` condition fails closed; a `recordId` carrying the edge direction
and timestamp so the outbox never collapses a `diverged` with a later `restored`.

### 9.3 The rule card — `nc.getRuleStatus`

**Not a cap method** — an `addons.custom` action on `pipeline-analytics`, so a
new status kind needs **no release train**. Add a `kind: 'scene'` member to
`NcRuleStatusSchema`, a branch in `ruleStatusFor`, the hand-mirrored client type
and sentence builder, and a branch in `NotificationRuleStatus.tsx`:

```ts
kind: 'scene'
deviceId: int
sceneLabel: string
verdict: 'matched' | 'diverged' | 'unknown'
latched: boolean
since?: int                 // divergedAt, or armedAt when matched
lastCheckedAt?: int
condition?: string          // 'day' | 'night' | 'ir' | 'dusk' | …
engine: 'similarity' | 'similarity+llm' | 'llm'
unavailable?: 'no-reference-for-condition' | 'view-shifted'
            | 'no-vision-profile' | 'encoder-model-changed' | 'no-snapshot'
```

Everything **derived**, nothing stored — a persisted status would be a second
copy of the engine's state and would lie the first time a render failed. The
`unavailable` enum is the point of the whole card: this feature's failure mode is
*silence that looks like "nothing has happened"*, and one sentence — *"cannot
judge: no reference captured for dusk"* — is the difference between a five-minute
fix and a session of guessing.

### 9.4 Kind registration

`NC_RULE_KIND_SPECS` and `ruleKindOf` in
`packages/types/src/notification/rule-kinds.ts` gain a
`'scene'` member with its `excluded` map and `carriesMedia: true` (a scene
notification should carry the ROI crop). Its spec checks both directions against
the real catalog, and `scripts/check-viewer-condition-mirror.ts` gates the
viewer — both will fail loudly if this is half-done, which is the intent.

---

## 10. The traps, and where each is absorbed

| # | Trap | Absorbed by |
| --- | --- | --- |
| 1 | **Dawn / dusk** — light no variant covers | §6.2: `dawn`/`dusk` are real conditions with a ±40 min band; with no reference for them the scene reports `unknown`, never `diverged` |
| 2 | **IR switch** | §6.2(a): measured chroma is a *direct* observation, ahead of sun-times; `ir` is its own condition with its own references |
| 3 | **Camera moved / PTZ** | §10.2 below |
| 4 | **Transient occlusion** (car parked in front of the bin) | §6.1 quiet gate + §6.3 spacing: the observation is discarded, not merely delayed; three agreeing quiet observations span ≥ 4 min |
| 5 | **Slow drift** (leaves, seasons, a repainted wall) | `recapture` on reset (§8.2) re-baselines on the operator's own cadence; `lastConfidence` on the card shows the margin eroding before it fails |
| 6 | **Encoder model changed** | the `modelId` + dimension gate already exists in `scoreStates`; §3 makes it report `unknown` instead of `diverged`, and the card names it so the operator knows to re-capture |
| 7 | **Battery camera** | the engine reads cached snapshots (`force: false`); only the operator's capture forces. A camera asleep for hours reports `unknown` — stale but honest |
| 8 | **Camera offline** | no snapshot ⇒ `unknown` + `unavailable: 'no-snapshot'`; never a latch |
| 9 | **Vision model down** | `onTimeout: 'hold'` (§7): the pending flip does not commit, `unavailable: 'no-vision-profile'` is visible |
| 10 | **Prompt injection from frame text** | already solved in `scene-llm-adapter.ts` — the contract lives in the system turn and declares image text to be scene content |
| 11 | **Whole-frame ROI** | §5.2: warn above ~40 % of frame; the failure is silent insensitivity, which is the worst kind |

### 10.2 View shift — the anchor

The ROI is normalized coordinates. Bump the camera, run a PTZ preset, or have an
installer re-aim it, and the rect now frames a different piece of world; the scene
diverges and stays diverged forever, with a perfectly plausible cosine.

**Every reference also stores an `anchorEmbedding`** — the whole frame,
downscaled. It is checked **lazily, only when hysteresis is about to flip**
(one extra encode per candidate transition, not per poll, the same discipline as
the LLM confirm). If the anchor cosine has fallen below `anchorThreshold`
(default 0.85) the flip is refused: `verdict: 'unknown'`,
`unavailable: 'view-shifted'`, logged with `tags: { deviceId }`. A moved camera
then reads as *"I can no longer trust this scene"* instead of as a theft.

Vendor-neutral and PTZ-agnostic, which matters: most cameras here expose no
usable position feedback, and the ones that do disagree about what a preset means.

---

## 11. Phases

> **Status, 2026-08-26: P0–P5 shipped** (P0/P1/P2 on 2026-08-14, same day as
> writing; P4 on 2026-08-15; P5 confirmed wired — `scene-llm-adapter.ts` calls
> `deps.llm.generateVision`). P3 shipped in a different shape — see §1.5's
> status note (top-level `/scenes` page, not a per-camera widget). P6's guard
> (§12 item 1) exists. P7 (HA export) not checked. Estimates below are the
> ORIGINAL plan, not a record of actual time spent.

Estimates are working days for one engineer who has read this document. "Train"
= ships inside `@camstack/server` and is not live until a release carrying it is
installed; "deploy" = `camstack deploy <pkg>`, live immediately.

| # | Phase | Ships via | Est. | Depends on |
| --- | --- | --- | --- | --- |
| P0 | Cap delta (§4.2) + `NcSceneConditionSchema` + `SCENE_DIVERGED` + `npm run codegen` | **train** | 0.5 | — |
| P1 | Engine: divergence candidate (§3), `bestScore: null`, quiet gate, spacing, condition resolver v2 (§6.2), anchor (§10.2) — all pure/unit-testable | deploy | 1.5 | P0 |
| P2 | Provider: manifest declaration, two `DurableLedger` collections, boot hydration without re-firing edges, `SceneEngine` construction on the post-processing node, `EnrichmentSceneStateChanged` emit, `resetScene` | deploy | 2.0 | P0, P1 |
| P3 | Editor: canvas, capture, reference gallery, coverage line, reset button, live badge — plus the top-level `/scenes` page that lists them across cameras (§5). Removing the camera tab is a cap change, so this half is **train** | deploy (`ui-library` + admin-ui); cap delta **train** | 2.0 | P2 |
| P4 | NC: `scene-event` subject kind, fail-closed gates, in-process edge tap, `sceneEnabled` recompute, `kind:'scene'` rule status, kind registration + viewer mirror | deploy (P0 carried the schema) | 1.5 | P0, P2 |
| P5 | LLM adjudication: wire `deps.llm`, downscale + timeout + per-device concurrency, `confirm` on candidate flip only | deploy | 0.5 | P2 |
| P6 | Guards (§12) | deploy | 0.5 | P3 |
| P7 | *Optional:* HA export — mint one `binary_sensor` per scene at reconcile time | deploy | 1.5 | P2 |

**Train-bound is only P0.** Everything with behaviour in it is an addon deploy —
which is the right shape, and the reason the cap surface should be finalised in
one pass rather than discovered in three.

A defensible smaller first cut: **P0 → P1 → P2 → P3**, which gives the operator
the working bin scene with a UI, a CLIP engine and a reset, with rule
integration (P4) and the vision model (P5) following. It is not smaller by much,
because P2 is where the unreachability actually is.

---

## 12. Guards this work should leave behind

*Prefer a guard to a paragraph.*

1. **`scripts/check-host-widget-resolves.ts`** — SHIPPED. Every
   `deviceConfig.ui.widgetId` starting `host/` declared by a `*.cap.ts` must
   exist in `HOST_WIDGETS`, and vice versa. This document proposed it to close
   the `scene-monitor` widget hole (§1.5); the hole was instead closed by
   REMOVING the widget declaration (§1.5's status note), and the guard now
   enforces both directions — a registration nobody declares fails exactly as
   loudly as a declaration nobody registers.
2. **A latch is never seeded from a fallible read.** The boot hydration must
   fail into "keep the mirror" and log the loaded count — assert it in a spec, and
   *remove the fix and confirm the spec fails*. A green suite has twice passed
   here because the fake supplied what production forgot to fetch.
3. **No silent condition fallback.** A spec asserting that a scene with only
   `day` references reports `unknown` — not a score — when the resolver says
   `night`. This is the single most likely regression, because the fallback reads
   as robustness.

---

## 13. Questions for the operator — batched, each with a recommendation

**Q1 — Is the region mandatory, or is full-frame acceptable?**
*Recommendation: optional in the schema, effectively mandatory in the UI* — the
editor starts in draw mode and warns above ~40 % of the frame. A full-frame bin
scene will not work and will look broken rather than misconfigured.

**Q2 — Which boolean should a rule fire on: the latch, or the live state?**
*Recommendation: latch, by default* (`emit: 'latched'`), with `live` selectable.
The bin case is a latch; a "gate left open" scene is live.

**Q3 — Manual reset only, or optional auto-restore?**
*Recommendation: manual only by default* (`autoRestore: false`), as asked — but
`scene-restored` is emitted regardless, so an automation can react to the bin
coming back without the operator's alarm clearing itself.

**Q4 — Should a reset also RE-CAPTURE the baseline?**
*Recommendation: yes, default on.* The bin never returns to exactly the same
spot; reset means *"this is the new normal"*. Without it the feature degrades
silently over weeks. The alternative (re-arm only) is one flag away if you
disagree.

**Q5 — Is the AI a confirmation of CLIP, or an alternative?**
*Recommendation: both, with confirmation as the default.* CLIP proposes at 60 s;
the vision model is asked **only on a candidate flip** (~2 calls/week for the bin,
against 1 440/day for an LLM poll). LLM-primary stays available for scenes whose
baseline cannot be staged ("is the gate open?"), on-motion only.

**Q6 — How many lighting variants, and which?**
*Recommendation: four seeded — `day`, `night`, `ir`, plus `dusk`/`dawn` as a
±40 min band* — with the operator required to capture only `day` and `ir`/`night`
to start. Anything uncovered reports `unknown` rather than guessing. Is `dusk`
worth its own capture for your cameras, or should dusk simply suspend evaluation?

**Q7 — Does the hub have configured coordinates?**
Sun-times need a lat/long. Without them the fallback is a **UTC** clock split,
which is wrong for Italy by an hour or two at the edges. If coordinates are not
already configured, that is a one-field prerequisite worth doing in P1.

**Q8 — What is the acceptable detection latency?**
*Recommendation: ~4 minutes* (60 s cadence × 3 agreeing observations ≥ 120 s
apart). Tightening it to under a minute measurably raises the false-positive rate
against occlusions; loosening it to 15 minutes makes the whole thing nearly free.

**Q9 — When the vision model is unreachable, should a pending flip commit?**
*Recommendation: no* (`onTimeout: 'hold'`). A latch is a stateful claim that
costs the operator a trip to reset. This is the opposite of `NcConfirmGate`'s
fail-open, deliberately.

**Q10 — Is the Home-Assistant export (P7) wanted?**
`scene-monitor` is currently **excluded** from the HA entity catalog because
`monitors` is an array and a static descriptor table cannot mint per-scene
entities. A per-scene `binary_sensor` ("Immondizia prelevata") needs
reconcile-time minting — real work, and out of scope unless you want it.

---

## 14. Non-goals (v1)

- Classical pre-filtering (histogram / SSIM) ahead of CLIP — one encode per
  minute per scene is not a cost worth a second comparator with its own
  false-negative mode.
- Per-condition prompt variation for LLM scenes.
- Polygon or multi-rect ROIs — `rect` only, reusing the shared shape.
- Cross-camera scenes.
- Automatic re-capture on a schedule. Re-baselining is an operator act
  (§8.2); a scene that silently re-learns the world is a scene that can never
  report that the world changed.
