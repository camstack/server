---
id: D320
title: "A walk that ANSWERS A QUESTION is bounded, single-flighted and never on a timer — and a read that cannot be complete refuses"
status: accepted
date: 2026-08-31
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/media-relocate-engine.ts
  - packages/addon-admin-ui/src/components/recordings/migration/StorageMigrationSection.tsx
  - packages/system/src/kernel/settings-door-view.ts
---

## Context

Two defects, one family: a component that confidently returns something false,
or asks a question so expensive that everything else in the cluster waits for
it. Both were measured on the live hub on 2026-08-31 and are diagnosed in full
in `docs/design/2026-08-31-settings-store-saturation.md`.

**The census.** ONE query shape was **88.7 % of the `hub/sqlite-settings`
engine's wall clock** — 19 110 s of 21 540 s — and top-1 in **359 of 359**
consecutive 60 s profiler windows over six hours. It is
`MediaRelocateEngine.pageRows`, reached from `StorageMigrationSection` →
`refetchInterval: 10_000` → `storageMigration.residue` →
`countRelocatableMedia` → `countSelected(mode, target, () => false)`. One
answer walks the 1.26 M-row `media` collection twice plus `retrain-frames`
once — ~12 600 store round trips at `PAGE_SIZE = 200`.

The walk had **no stop signal** and **no single flight**, and that is what
turned an expensive read into an outage. A ten-second timer did not REPLACE the
previous census; it added one that would never retire. Inferred from two
measured rates: ~480–530 walks in flight, ~1 800 outstanding store requests,
and a **~16 s standing FIFO queue in front of every store call in the
cluster** — a `settingsStore.get` of 71 bytes cost the same 15 s as a 3 893-byte
`query`, because the payload was never the cost. Restarting the runner took a
store read from ~15 s to 0.19–1.09 s. Nothing else cleared them: not the
browser tab, not the aborted HTTP request, not a UI change.

**What was already tried, and why it was not enough.** Five real round-trip
reductions shipped over 2026-08-29/30/31 (`getAllBindings` 1 + 1019 → 2,
`projectChildren`, the OSD catalog, the event-media seal, `footprintByDevice`).
Every one was worth doing and every one was **dividing by a ~15 s constant
nobody had asked about**. Optimising callers cannot fix a saturated single
queue while the thing saturating it is still running.

**The partial answer.** `settings-store query truncated by a defensive row cap`
fired **138 times in two hours**, always `collection: addon-device-settings`,
`rowCap: 2000`, `requestedLimit: null`. That is `loadPrefixed` issuing ONE
`query` with no `limit`; `queryDeclared` resolves an absent limit to
`SETTINGS_QUERY_DEFAULT_ROW_CAP` and cuts there. On a ~1 019-device fleet an
addon with more than two stored keys per device puts its `<addonId>:` range
past the cap, so `readDeviceStoreBatch` handed back a map **shape-identical to
a complete one** in which every device past the cap has `config: {}` — exactly
what a device with no stored settings looks like. The engine warned; the door
did not notice; no caller could.

The tests could not see it either, and that is the part worth remembering: the
fake door in `device-store-batch.spec.ts` returned every matching row. A fake
with no row cap cannot observe a defect that IS the row cap.

## Decision

**A walk exists to DO work, not to answer a question.** A pass may walk a whole
collection: it must touch every row, an operator started it, and its stop
signal is that operator's cancel. A question about a collection gets one of
three shapes, in order of preference: an indexed aggregate the store answers;
a bounded walk; or `null`, meaning *"I could not answer"*. Three rules ride
with it:

1. **A census is single-flighted on the QUESTION and bounded.** At most one in
   flight per `(mode, target)`; a concurrent caller joins the walk already
   running, and the flight is released when it settles — a single flight, not
   a cache. It carries a budget in ROWS and in TIME (read through an injected
   `now`), past which it returns `null` and **stops reading** — the budget is a
   stop signal, not a filter applied to rows already fetched. It also exposes
   an explicit `cancelCensuses`, because the runaway's defining property was
   that nothing outside the process could retire it.

2. **No timer starts a whole-collection read.** An expensive census is
   operator-driven: a Refresh affordance, the time the number was taken, and a
   disabled control while one is in flight so a second press cannot start a
   second walk. `staleTime: Infinity` and `refetchOnWindowFocus: false` close
   the other two ways React Query re-runs a query on its own. What may stay on
   a timer is a bounded read — one job record, one registry lookup.

3. **A read that cannot be complete refuses; it never returns the part it
   got.** A scoped read pages with an EXPLICIT `limit` and a keyset cursor
   until a short page, and throws if it cannot (an unpageable prefix, or a walk
   past its page budget). Never `OFFSET` — page two at `offset: N` starts N
   rows past a set that may have lost its first N (D295 rule 1). A caller that
   asked for a scope and was given 2 000 of it must be told, and the only
   telling that cannot be ignored is not returning.

`null` is the answer, not the absence of one (D295): it is listed, worded as
"amount unknown", and never rendered as zero — the same failure D312 fixed one
layer down, where a dropped predicate answered `0` and a gate read it as "safe
to cut over".

## Consequences

**The media lane's residue on this fleet now answers "unknown".** 1.26 M rows
is past any budget a UI read may hold, so the operator sees "amount unknown —
the archive could not be read" instead of a number. That is a real loss of
information and it is the honest reading: the number it used to print cost the
cluster its store. The drain affordance survives, because a `null` residue is
still listed.

**The only thing that makes the question cheap is R3, and R3 is not done.**
Sealing `locationId` turns the `move` residue into `COUNT(*) WHERE locationId
<> ?` against an index that already exists. The seal is a 464 902-row write
pass, is deliberately STOPPED, and must be re-planned with the operator under
D58/D54 — not smuggled in behind a performance fix. Until it lands, this ADR is
what stands between that walk and the cluster.

**A paged scope read costs more round trips than one unbounded query** — two
instead of one at ~1 000 rows per page for the live fleet. That is the price of
knowing the answer is whole, and it is the same trade D295 made for the archive.

## Enforcement

Tests, each confirmed RED by deleting the line it guards:

- `packages/addon-post-analysis/src/pipeline-analytics/__tests__/media-relocate-census.spec.ts`
  — asserts SHAPE, never wall clock: store round trips issued, whether a second
  concurrent caller reaches the store, whether the answer is `null`. The
  deadline is driven by an injected `now`.
- `packages/addon-admin-ui/src/components/recordings/migration/__tests__/storage-migration-residue-poll.spec.tsx`
  — asserts the OPTIONS the query is given (no `refetchInterval`,
  `refetchOnWindowFocus: false`) and what the operator can press. A test that
  checked the rendered rows would pass against the polling version; the rows
  were never wrong.
- `packages/system/src/builtins/sqlite-storage/__tests__/device-store-batch.spec.ts`
  — the fake door now applies `resolveRowBound` and returns an unordered result
  when no `orderBy` is asked for, so the paging and the ordering are both armed.
  One test pins the defect's own log signature: no query is issued without an
  explicit `limit`.

There is **no guard script** for "a timer must not drive a collection walk".
Sibling `refetchInterval` call sites in the Admin UI have not been audited to
completion and this rule is review-only for them today — which is worth knowing
when trusting it.
