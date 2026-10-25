---
id: D905
title: A notification rule that cannot work is announced once, from readings that answered
status: accepted
date: 2026-10-22
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/rule-health.ts
  - packages/addon-post-analysis/src/notification-center/event-intake.ts
  - packages/system/src/builtins/alerts/alerts.addon.ts
  - packages/types/src/notification/system-event-families.ts
---

## Context

On 2026-10-22 camera 108 lost power for 2 h 15 m and its `stream-offline` matched
no rule. The rule existed: since the records adoption of 2026-10-18 its row
carried `groupingSec: 0`, the schema refused it, and every 30 s load skipped it
with a count and no name. The same morning a robot rule stopped because its
device was re-created under a new id; the deleted-device prune kept the last id
and switched the rule off, which only the rule's own banner said. A rule that
silently stopped working is the one failure no other rule can report.

## Decision

The notification centre judges every rule on the reload tick, on the
evaluating node, after the deleted-device / deleted-target prune. A rule is
broken when the last SUCCESSFUL load skipped its row (`unparseable`), or when
the prune ledger holds a `kept` / `kept-disabled` record for it and the rule
still names that device (`device-deleted`) or target (`target-deleted`). The
prune writes such a record only after two answered directory reads and
`getDevice === null` agree (D49), so a registry that did not answer can never
break a rule. A reading that is not available keeps the previous verdict: it
neither raises nor clears.

The centre emits `notification.rule-broken` (rule id, name, reason codes,
offending ids) once per rule per distinct set of reasons, and
`notification.rule-repaired` once when a broken rule loads and names nothing
deleted. The alert centre shows one in-app card per rule (`nc-rule-broken:<id>`)
and closes it on repair, so it is visible with no rule at all; the centre's own
intake maps them to the system kinds `rule-broken` / `rule-repaired`, a new
kind group `rule-health` in the `system` family that every rule editor offers.
No rule is created for the operator.

A kind GROUP in the `system` family, not a fourth family: a family is a rule
kind with its own editor and filter set (D637), and these two kinds carry no
filter at all — they would have been a family with nothing to configure.

## Consequences

- The verdicts are in RAM: a restart announces a still-broken rule once more.
- Timelapse and summary rules are not judged yet.
- The kinds are held back from the served template catalog until the viewer
  OTA that mirrors them is installed (`NC_TEMPLATE_HELD_BACK_SYSTEM_EVENT_KINDS`).

## Enforcement

`rule-health.spec.ts` (each reason once, an unanswered read raises and clears
nothing, repair once), `rule-health-center.spec.ts` (through the real centre's
reload tick), `alerts.addon.spec.ts` (the in-app card and its close), and
`system-event-intake.spec.ts` (the kinds and the sentence per reason).
