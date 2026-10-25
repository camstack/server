---
id: D489
title: A summary is a group that MOVES TOGETHER, and one camera may hold several at once
status: superseded
superseded-by:
  - D680
date: 2026-09-13
supersedes:
applies-to:
---

## Context

The first cut of summaries was "one open summary per camera": `summaries_open_device`
was a UNIQUE index, so any track born on a camera with an open summary was absorbed
into it. That is a timeslice, not a group. Two people arriving at the gate while a
car sat in the drive produced one summary saying all three were together, and nothing
in the record could ever separate them again.

The operator rejected the two obvious cheap proxies. Zones were the first suggestion
and the answer was blunt — *"Le cose che camminano insieme sono un gruppo cosa
centrano le zones"* [things that walk together are a group, what do zones have to do with it]: standing in the same named area is not walking together. A pure
time overlap is the same mistake with a coarser boundary.

What remains is the only evidence the pipeline actually has at birth: where the
subject IS, in the frame, relative to the subjects already grouped.

## Decision

Membership is decided by **proximity at birth**. A new track joins the open group on
its camera whose NEAREST member is closest to it, provided that distance is under
`togetherFraction` of the frame diagonal (`DEFAULT_TOGETHER_FRACTION = 0.15`); if no
group qualifies, it opens a new one. A camera therefore holds as many open summaries
as it has distinct groups, and `summaries_open_device` is **not unique**.

Evidence must be present for the rule to apply: a frame whose dimensions are unknown
yields a `null` distance, never a `0` that would read as "touching". With no usable
position the birth falls back to the previous behaviour (`openOrAbsorb`) rather than
guessing — an unknown position must not silently found a new group.

Class priority inside a group is person > animal > vehicle, ties broken by the
earliest track; synthetic (`pa-synth-`) and package events are never members at all —
they are separate events by construction.

## Consequences

- Two groups on one camera are now normal, and every reader of open summaries must
  handle a list. `listOpen(deviceId?)` returns them oldest-first; `openNew` and
  `absorbInto` are separate operations, and `openOrAbsorb` merely composes them.
- The UNIQUE index had to be dropped on the live hub by hand. We are pre-release, so
  there is no migration in the repo and none will be written — `declareCollection` is
  additive and can never change an index's uniqueness on its own.
- `togetherFraction` is a constant. Making it per-camera is the obvious next step and
  is deliberately NOT done yet: one cluster-wide number that is wrong everywhere is
  easier to correct than a per-camera number nobody tuned.
- Splitting is still missing. A group that separates mid-session stays one summary
  until it seals; the proximity rule makes sealing-on-divergence possible but does not
  implement it.

## Enforcement

`summary-join.spec.ts` pins the chooser, including the null-distance path and the
"closest group wins, not the first" case. `summary-open-list.spec.ts` pins that two
groups can be open on one camera at once — it fails against the unique index.
Review only for the live index drop, which is a one-off.
