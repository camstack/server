---
id: D162
title: The digest mosaic carries NO burnt-in text by default, and a disabled field must LOOK disabled
status: accepted
date: 2026-08-15
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/summary/mosaic-renderer.ts
  - packages/addon-post-analysis/src/notification-center/summary/summary-rule.ts
  - packages/addon-post-analysis/src/notification-center/summary/summary-producer.ts
  - packages/ui-library/src/primitives/select.tsx
  - packages/ui-library/src/primitives/input.tsx
---

## Context

Two operator reports arrived together the morning after the six-tab summary
editor landed. They look unrelated and share one shape: **something correct that
gave the operator no way to tell.**

**1. *"Il selettore della lingua nella tab AI non si apre — il dropdown non
risponde al click."*** [The language selector in the AI tab does not open — the dropdown does not respond to the click.] It opened fine. It was `disabled`, correctly: the AI
section's master switch is off on a new rule and every control under it is gated
on that switch. The first hypothesis — a `Select` inside a top-layer `<dialog>`
losing its popup to a portal or a stacking context — was wrong, and cost an hour:
the `Select` is a native `<select>`, and a component test proved it enabled,
three-optioned and changeable the moment the switch was clicked.

What made an inert field a *bug report* is the primitive. `Select` pins
`bg-surface`, `text-foreground` **and** `appearance-none`, which is exactly the
set a browser uses to grey out a disabled control — so the greying never
happened and the dead dropdown was pixel-identical to a live one. `Button` and
`IconButton` have carried `disabled:opacity-50` since the first commit; `Select`
and `Input` never did. The `<textarea>` two rows below the language dropdown, on
the same tab, gated on the same switch, carries `disabled:opacity-50` inline —
which is precisely why the operator read the prompt box as *off* and the
dropdowns as *broken*.

Two smaller things fed the same conclusion: the language dropdown was the only
control on the tab with no hint sentence under it, and its two topmost options
read `English (default)` and `English`, so even a successful pick moved the
trigger text by two words.

**2. The mosaic had no way to turn text off, and the operator wants pictures.**
`renderMosaic` drew two text layers unconditionally: a `camera · HH:MM · class`
strip across the bottom 14% of every tile, and a title band above the grid. Both
are burnt into a durable artefact that an operator re-reads days later, and the
strip covers the part of the frame nearest the ground — feet, wheels, parcels.

The question that had to be answered before removing anything: **does the AI
judge read those pixels?** It does not. `summary-producer.ts#analyse` hands the
model the RAW per-track JPEGs — the same buffers the renderer copies from, never
its output — and `summary-ai.ts#buildSummaryAiPrompt` supplies camera name,
class and time as prompt text. Had it been otherwise the facts would have had to
move into the prompt; they were already there.

## Decision

**A summary rule's `captions` field decides every word drawn on its mosaic, and
its default is `none`.** `none` suppresses the per-tile strip AND the title
band, whatever `captionText` holds; `tiles` restores the strip; `all` is
byte-for-byte the behaviour every rule had before the field existed. The
decision lives in exactly one pure function, `mosaicTextPlan`, which reads an
ABSENT value as `none` — so a rule stored before the field, parsed by
`NcSummaryRuleSchema`, comes back `none` with nothing rewritten on disk.

**A field the browser will not open must be visibly dimmed, and that belongs to
the primitive.** `Select` and `Input` carry `disabled:opacity-50
disabled:cursor-not-allowed`; a surface that disables a block also says in words
what would re-enable it.

Rejected: *keep drawing text and add an opt-out.* The operator asked for
pictures, and a default that has to be turned off is a default that is on for
every rule already stored — the migration would have been the loud half.

Rejected: *coerce a `captions` value this build cannot render to `none`.* A hub
one version newer could grow a fourth mode; coercing it would rewrite a live
rule the next time the operator renamed it. The admin narrower refuses the rule
instead, exactly as `parseWindow` refuses an unknown window kind, and the tab
says it does not understand.

Rejected: *fix the language dropdown at its call site.* There are dozens of
`<Select disabled>` in this app and the one that gets forgotten is the one that
generates the next ticket.

## Consequences

- `captionText` still round-trips and is still stored while `captions` is not
  `all`; the editor disables the box and says why, so turning the words back on
  does not cost the operator what he wrote.
- The tile rectangles stay exported from `mosaicLayout`. A viewer that wants to
  say what a tile is reads those — the answer is DATA, and the picture stays a
  picture. Same split as the detection boxes this renderer already refuses.
- Every disabled control in the admin UI now dims. Anywhere that relied on a
  disabled field looking live was already lying.

## Enforcement

- `mosaic-renderer.spec.ts` asserts on PIXELS, not on the SVG strings: with
  `captions` absent the bottom strip of a solid tile is within 3 of its middle,
  and with `captions: 'tiles'` it is more than 10 darker. Restoring the old
  default makes five tests fail, which was verified by doing it.
- `summary-rule.spec.ts` parses a stored rule with no `captions` key through
  `NcSummaryRuleSchema` and asserts `none` — the soft migration, not described
  but executed.
- `ui-library/src/primitives/__tests__/disabled-affordance.test.tsx` requires a
  `disabled:opacity-*` and a `disabled:cursor-not-allowed` on both primitives,
  and requires that an ENABLED field carries no bare `opacity-*`.
- `NC_SUMMARY_TABS` already fails the spec when a form field has no tab, so the
  new control could not be added without a home.
