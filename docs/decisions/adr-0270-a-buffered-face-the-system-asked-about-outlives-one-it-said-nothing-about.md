---
id: D270
title: A buffered face the system asked a question about outlives one it said nothing about
status: proposed
date: 2026-08-28
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/store/face-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/face-settings.ts
---

## Context

2026-08-25. `FaceStore.pruneCapOverflow` held each camera's UNASSIGNED face
buffer to `bufferMaxPerDevice` (default 50) newest rows. Enrolled (`assigned`)
rows were exempt — an assignment is a curation act — but a row carrying a
`suggestedIdentityId` was exempt from nothing. The recognizer had offered the
operator an identity for that face and the buffer deleted the question before
anyone answered it.

Measured on the live hub: **15 of 24 cameras sat at exactly 50**, so the cap was
binding on most of the fleet, not a theoretical ceiling. On camera 108 (59 faces
in 25 h) a suggestion survived roughly **one day**. Anything not reviewed inside
that window was gone permanently. The operator reviews in BATCHES — 173
suggestions by hand in one sitting on 2026-08-25 — so a window measured in days
is the wrong unit entirely.

It ran that way for weeks and produced **not one log line**. The prune logged an
aggregate `deleted` count with no `deviceId`, so "why did camera 108 forget the
person it asked me about" could not be put to the logs at all. This is the same
shape as the 3-hour media blackout: a branch that drops work silently reads as
"never happened".

Two things were tried on paper first and rejected:

- **Exempt suggested rows outright.** Nothing clears `suggestedIdentityId` when
  the operator REJECTS a suggestion — rejection is simply not acting on it, and
  only `setSuggestion(id, null)` (an explicit rescore) or enrolment clears the
  column. So an unbounded exemption is a leak by construction: a camera that
  suggests constantly grows without limit at 10.8 KB of JSON embedding per row.
- **An age ceiling on suggested rows.** Forbidden here. A face row carries a
  `trackId`, so it is TRACK-OWNED and clockless (D61); a second clock over it is
  the exact defect that aged crops out from under tracks still inside their own
  retention window.

Separately, `bufferMaxPerDevice` is offered on the settings form and
`holdBufferCaps` passed `FACE_DEFAULTS.bufferMaxPerDevice` — the constant, not
the store. An operator override decided nothing. That is the D62 shape: a knob
that writes a store nobody reads.

## Decision

The unassigned face buffer is bounded in **two disjoint per-camera capacity
tiers**, both ranked newest-first and both skipping enrolled rows entirely:
`maxPerDevice` rows the recognizer said nothing about, and
`deriveSuggestedBufferCap(maxPerDevice)` rows carrying a `suggestedIdentityId`.
A suggested row neither consumes an ordinary slot nor is ranked against rows
that were never suggested.

The suggested tier is **DERIVED, never a second knob** — `4 ×
bufferMaxPerDevice`, so raising the operator's knob raises it too and setting it
to `0` turns the whole buffer off rather than leaving an orphan tier. Two
independent numbers over one buffer could contradict each other, which is
exactly how the suggestion BAND broke (D222).

Evicting a suggested row is a `warn`, one line per camera, carrying
`tags: { deviceId }`.

And the cap in force is the **operator's**: `holdBufferCaps` reads the global
settings store and falls back to the schema default only when that read fails.

## Consequences

**What it costs.** The worst case per camera goes from 50 rows to 250 (50 + 200).
Across 24 cameras at 10.8 KB/row that is ~65 MB if every buffered face on every
camera carried a suggestion. It never does — the live table is 372 rows / 4.0 MB
— but the number is stated rather than left unbounded. Anything that sweeps this
collection (`pruneCapOverflow` itself, `listAllRecentFaces`) now pages over a
table whose ceiling is 5× larger; both already page at `FACE_SWEEP_PAGE`, and
this is the reason that paging must never be removed.

**The loss when the bound is hit** is the OLDEST unanswered suggestion on that
camera. That is the least-bad row to lose: the review surface lists newest-first,
so it is the one the operator has had longest to answer and has not. It is not a
free loss and it is logged as such.

**Why 4.** At the shipped default it turns 50 rows into 200 suggested slots. On
the busiest measured camera (~59 faces/25 h, of which the suggestion band takes
a minority) that is a review window of roughly a week and a half rather than a
day — long enough to survive between batches, which is the cadence that actually
exists.

**What now has to be true elsewhere.** Nothing may clear `suggestedIdentityId`
as a side effect of an unrelated write: the column is now load-bearing for
retention, not only for display. `setSuggestion(id, null)` correctly returns a
row to the ordinary tier — the question was withdrawn, so it earns no
protection.

**Activating a dormant knob.** Reading the operator's `bufferMaxPerDevice` makes
a previously-inert stored value live. A stored value BELOW 50 would delete rows
on the next sweep. The suggested tier protects the rows that carry a question,
the effective caps are logged on every prune that deletes, and the fallback is
the same constant the sweep used unconditionally before — so a settings outage
can never make the bound stricter than it has ever been.

## Enforcement

Tests, in `packages/addon-post-analysis/src/pipeline-analytics/__tests__/face-store.spec.ts`
and `.../__tests__/face-settings.spec.ts`:

- a suggested row survives an eviction pass that removes an unsuggested row of
  the SAME age, and does not consume an ordinary slot;
- the suggested tier BOUNDS — oldest-first within itself, per device;
- evicting a suggested row logs with `tags: { deviceId }` and the numeric id;
- `deriveSuggestedBufferCap` is total over the domain: an integer, never below
  the ordinary cap, `0` exactly at `0`, and never `Infinity` for a non-finite or
  negative input;
- the cap in force comes from the settings store, not from `FACE_DEFAULTS`.

Each was disarmed (implementing line reverted) and confirmed RED before being
restored. No guard script: the rule is "a durable row the system asked a
question about is not evicted like one it did not", which no regex can see.
