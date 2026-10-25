---
id: D436
title: The crowd guard says HOW crowded it was, and how far the nearest competitor stood
status: accepted
date: 2026-09-10
---

> **Superseded by [D683](adr-0683-identity-is-decided-late-tracklets-split-when-in-doubt-a-deferred-linker-fuses-them-and-a-still-subject-belongs-to-the-registry.md)
> (2026-09-29).** The crowd guard's online reacquisition is gone: L1 ends a
> tracklet on any association doubt (`swap` / `rival` / `competitor`)
> instead of asking a binary "is anyone else nearby" question, and a
> deferred linker judges a later join once every competitor for the window
> is already known.

## Context

Ten hours of production tracks on this hub split 510 times. The single largest
reason was `crowd-guard`: **191 of them**, and their geometry says the pair was
not ambiguous at all — median `centroidDist / reach` of **0.55**, with 81 of the
191 already overlapping (IoU > 0).

The reason is in the gate itself. `isUnambiguousReach` asks two questions and
neither one has a distance in it:

- is there any other LIVE or resurrectable track of the same association group,
  anywhere;
- is there any other DETECTION of the same group in this frame, anywhere.

Either one answering yes turns a reacquisition into a `crowd-guard` refusal. On
a 3840 px frame, a second person at the far corner of a room refuses a
re-association whose two boxes are already touching.

## Decision

**Measure before narrowing.** The gate's decision is unchanged. What changes is
that the record it emits now carries `competitorCount` and
`nearestCompetitorPx`, so the question "how many of those 191 had a competitor
actually near the spawn?" is answered from production data instead of from a
guess.

Both fields are **optional and absent** when another gate declined — absence
means "this gate did not ask", which is a different claim from "there was
nobody" (D393, D400).

A live track and the detection it is about to be updated from are ONE subject:
they are de-duplicated on IoU > 0 before counting, or one person standing in
the room would be reported as a crowd of two and the number would be worthless.

## Why not narrow the gate now

Because the guard is real. It exists because a live track once claimed a
**second car 452 px away**. Adding a distance term trades fewer fragments for
more wrong merges, and a wrong merge is the worse defect: a fragment loses
continuity, a merge invents it. The threshold must come from the distribution
of `nearestCompetitorPx` on real refusals, which this record is what produces.
