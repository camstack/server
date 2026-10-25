---
id: D336
title: A rule's AI answer has a SHAPE derived from the row, and a word cap the delivery target defaults
status: accepted
date: 2026-09-02
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/rule-ai.ts
  - packages/addon-post-analysis/src/notification-center/rule-ai-analyst.ts
  - packages/addon-post-analysis/src/notification-center/rule-ai-policy.ts
  - packages/addon-post-analysis/src/notification-center/rule-ai-store.ts
---

## Context

AI text shipped first on the MULTI-CAMERA DIGEST (`summary/summary-ai.ts`): one
joint vision call over the window's tiles, one paragraph, `{{ai}}` in the body.
It is proven live — the operator's "Test summary" rule against
`mac-lmstudio-qwen3vl` produced a real Italian sentence and the first
`ai-summary` row `llm.getUsage` has ever held.

The ORDINARY rule — detection, sensor, occupancy, sound — had nothing. The
obvious move was to give `NcRule` the digest's `ai` section and call the same
analyst, and it is wrong twice.

**Wrong about the question.** An occupancy notification does not want a caption;
it CLAIMS a number, and the useful thing a model can do is agree or disagree
with it — a person counted twice, a van counted as a car. A `track-end` row is a
passage that has closed and can be narrated. An `immediate` row is one moment
and cannot: a track's birth is an `appearanceEvent` and is deliberately off the
notification bus, so `immediate` fires on an object-event insert (a
movement-state transition or a zone crossing) with whatever frame is in band at
that instant — "this instant", never "the first frame". Three questions, and one
prompt re-parameterised into three answers all three of them badly.

**Wrong about where the section lives.** `NcRule` is in `@camstack/types`, which
the addon resolves at runtime from the `@camstack/server` closure. A new key on
`NcRuleInputSchema` is SILENTLY STRIPPED at save until a framework train lands
and is installed — the failure `summary/summary-rule.ts` documents and the
timelapse rule paid for with three cascaded bugs in one day.

## Decision

An ordinary rule's AI section lives in the ADDON (`rule-ai.ts`), in its own
durable side table keyed by rule id, reached through `nc.getRuleAi` /
`nc.setRuleAi` — no cap, no codegen, no train.

Its answer has a **shape**, derived from the ROW and never authored:
`occupancy` when the row froze a count edge, `detection-track` on `track-end`,
`detection-immediate` otherwise. Each shape has its own system turn, its own
required JSON key, and its own INPUT: the immediate shape gets the one frame the
notification is about to ship (D52 — the picture described is the picture seen),
the track shape gets up to three whole-scene frames SPANNING the closed track.

The occupancy answer is STRUCTURED — `{confirmed, count, reason}` — and its
rendering is composed by the addon, not by the model: a refutation reads *NOT
confirmed — the camera shows 1, not 2* and only then the model's reason. The
model's prose is never the whole sentence.

Every answer carries a **word cap**. The rule may author one; absent, it is
derived from the DELIVERY TARGET's declared `TargetKindCaps.bodyMaxLen` — the
same number the degrade engine truncates the body on — logarithmically, so
zentik (500) gets 12 words and a webhook gets 120. Words, not lines: a model
counts lines badly and a notification wraps itself.

**Language is per RULE**, defaulting to the hub's text language. Never per
recipient — that would be one generation per language for one notification.

The pass NEVER suppresses. It has no `onFailure: 'skip'`: `NcConfirm` already
decides whether a notification fires, and a second suppression authority
disagreeing with the first is a defect this repo has shipped before. Zero frames
SKIP the pass entirely rather than failing open — an analyst asked about no
pictures confabulates, and a text-only notification is not a broken model.

## Consequences

- The section is invisible to `nc.listRules`. A client that wants to show it
  asks `nc.getRuleAi`, and one that does not know the action degrades to a rule
  with no AI — which is what every rule is today.
- The side table's lifetime is the rule's: `nc.deleteRule` clears the row,
  best-effort. A row that outlives its rule is inert.
- The dispatcher's target catalog now also reads `listTargetKinds`, once per
  target-cache refresh (60 s), for `bodyMaxLen`. A catalog that throws costs the
  DEFAULT (a push-shaped 24 words), never the targets.
- The narration runs AFTER the confirm gate, so a suppressed notification costs
  no vision call — and on the same picture the gate judged.
- Promoting the section into `packages/types` later is additive and needs no
  migration.

## Enforcement

`__tests__/rule-ai-analyst.spec.ts` and `__tests__/dispatcher-rule-ai.spec.ts`.
Each property was disarmed and confirmed red before it was trusted: rendering the
occupancy `reason` as a caption fails 4 tests; giving the track shape the
immediate contract fails 2; giving both detection paths the same frames fails 2;
flattening the word cap to one default fails 2; removing either zero-frame guard
fails 3. Beyond that, review only — there is no guard script.
