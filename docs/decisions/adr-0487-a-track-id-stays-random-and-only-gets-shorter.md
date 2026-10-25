---
id: D487
title: A track id stays random and only gets shorter — the database cannot mint it
status: accepted
date: 2026-09-13
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/track-id.ts
---

## Context

The operator asked for an incremental track id: *"l'ID delle tracce è ancora
alfanumerico. Possiamo averlo incrementale?"* [the track ID is still alphanumeric. Can we have it incremental?] A UUID is 36 characters and it
appears in every media key, every `object-clip` vector row id, every URL and
every log line about a track.

Three things decided the answer, and two of them were already written down in
this repository.

**It cannot be a database auto-increment.** The tracker mints the id MID-FRAME
and uses it immediately — in the event, in the media key, as the vector's row
id — long before anything is persisted. There is no rowid to wait for, and no
await to spend there (D49: a one-shot never gates on a fallible read). This is
the difference from D474, where event ids became integers precisely because
SQLite allocates them at insert.

**A local counter was already tried and reverted.** `sort-tracker.ts` still
records what it did: *"A bare per-process counter (`track-${n++}`) reset to 1 on
every runner restart and collided across restarts AND devices — a post-reboot
track reused an old id and UPSERT-clobbered the old persisted row (wrong 'now'
dates, stale bestEventId thumbnails, cross-session media in the detail view)."*

**A durable counter is possible, and was designed.** The hub keeps one bookmark
per camera and hands each node a BLOCK of ids ahead of need; the bookmark
advances BEFORE they are used, so a crash leaves a gap and never a duplicate —
the exact inverse of the old counter. It was not built: agents hold no sqlite of
their own, so this is a cluster allocator plus a degrade path for when the hub
is unreachable, in service of a property nothing reads. Presented with that
cost, the operator chose the smaller thing: *"Lasciamo la generazione attuale
randomica ma su molte meno cifre."*

## Decision

A track id stays random, minted synchronously with no I/O and no shared state,
and shrinks from 36 characters to 10 over a 32-character alphabet
(`newTrackId`).

Ten is arithmetic, not taste. The space is 32^10 ≈ 1.13e15; the live table held
17 870 track rows under a 7-day window, so the population that must not collide
is ~20 000. Birthday gives p ≈ n²/2N ≈ 1.8e-7 per window, ~1e-5 per year at the
current fleet. A collision is not cosmetic — two tracks sharing an id UPSERT
over each other, which IS the old counter's failure — so the margin is three
orders of magnitude wider than "probably fine", and that is why it is 10
characters and not 6.

The alphabet is Crockford-style base32: the digits and letters minus `i`, `l`,
`o`, `u`. The first three are misread as `1`/`1`/`0` by a human copying an id
out of a log; `u` goes with them so the set is exactly 32 — which is what lets
five raw bits map to one character with no modulo bias. A `% 36` over a byte
would make the first 16 characters ~1.5× more likely and silently shrink the
space the arithmetic depends on.

## Consequences

- **No migration.** `trackId` is `string` in every public type (checked: 230
  files reference it, none as a number), nothing validates it as a UUID, and
  nothing orders or pages tracks by id. Existing UUID tracks stay valid and
  expire with retention — the operator's call. For about a week both shapes are
  visible side by side.
- **One prefix in this system IS parsed** — `occupancy-watcher` asks
  `trackId.startsWith('stationary:')`. A colon cannot occur in this alphabet, so
  a generated id can never be mistaken for a stationary one. Pinned by a test,
  because the next alphabet change is where that would break.
- **`pa-synth-` stays** on synthetic tracks. Nothing parses it either, but it is
  what tells an operator reading a log that a track has no detection behind it.
- **Shortening further is not a free knob.** The bound above is the whole reason
  for the length, and it is in the module next to the constant.

## Enforcement

`track-id.spec.ts` pins the length, the alphabet, the absence of ambiguous
characters, that no id can start with `stationary:`, that 20 000 draws do not
repeat, and that the alphabet is a power of two — the property that keeps the
draw unbiased and therefore keeps the collision arithmetic true.
