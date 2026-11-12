---
id: DNNN
title: A rule groups system events that arrive within a few seconds into one summary
status: proposed
date: 2026-11-12
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/**
  - packages/types/src/notification/group-within.ts
  - packages/types/src/capabilities/notification-rules.cap.ts
---

## Context

On 2026-11-12 the hub delivered a notification for every device that flipped,
two at a time, a couple of seconds apart: four offline notices where the
operator wanted two sentences, and the same again when they came back. The
evening state summary already knows how to say several of these in one
message, but it waits for a schedule. The addon-update batch already coalesces,
on a sliding 30 s window, and dropping that for a second timer would leave two
mechanisms that disagree about when a window ends.

A window that lives only in memory loses the deliveries if the process stops
inside it. A Zod `.default()` cannot be both 5 (a system rule) and 0 (a
detection rule), and the addon cap path does not run Zod defaults.

## Decision

Each rule has `groupWithinSec`. Absent means 5 seconds for a system-event rule
and 0 for every other kind; `0` sends each delivery as it does today. The
window is per (rule, target), opens on the first delivery and flushes at
first + N seconds. One delivery in it is sent unchanged, only late. Two or
more become one state-summary notification, and each held row is marked sent
and points at that one notification.

The rows are written to the outbox immediately with `payload.groupHold`. The
drain skips a row that still carries it. The summary and the fold of the held
rows are one write. A restart that finds that summary already written settles
the held rows into it and does not write a second one; otherwise it finishes
the original window. A stop flushes what is still open.
Both windows — this fixed one and the addon-update sliding one — are the same
`WindowCoalescer`.

## Consequences

A muted device is dropped at flush, not said in the summary. A digest-only
rule never enters the window: it already holds its events for the schedule.
The summary is enqueued directly, not re-evaluated, so it is not held again.
A single item does not change its title or body. Detection rules stay
immediate until an operator sets a window.

## Enforcement

`group-within-window.spec.ts` reconstructs the morning (eight deliveries, four
notifications), the single delayed delivery, the detection default, a restart
inside the window, and the addon-update coalescer's own spec stays green.
`groupWithinSecOf` is the only reader of the default.
