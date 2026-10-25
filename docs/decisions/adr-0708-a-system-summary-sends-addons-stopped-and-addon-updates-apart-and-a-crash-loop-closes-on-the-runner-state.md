---
id: D708
title: A system summary sends addons stopped and addon updates apart, lists updates per node, and a crash loop closes when the runner state says it is running
status: accepted
date: 2026-10-06
supersedes:
applies-to:
  - packages/types/src/notification/system-event-families.ts
  - packages/types/src/capabilities/notification-rules.cap.ts
  - packages/types/src/notification/template-vars.ts
  - packages/types/src/notification/system-event-summary.ts
  - packages/addon-post-analysis/src/notification-center/state-summary/state-model.ts
  - packages/addon-post-analysis/src/notification-center/state-summary/state-sources.ts
  - packages/addon-post-analysis/src/notification-center/state-summary/state-summary.ts
  - packages/addon-post-analysis/src/notification-center/state-summary/state-summary-delivery.ts
  - packages/addon-post-analysis/src/notification-center/state-summary/state-summary-service.ts
  - packages/addon-post-analysis/src/notification-center/state-summary/system-state-ledger.ts
  - packages/addon-post-analysis/src/notification-center/state-summary/runner-recovery.ts
  - packages/addon-post-analysis/src/notification-center/system-event-tap-url.ts
  - packages/addon-post-analysis/src/notification-center/dispatcher.ts
---

Amends [D637](adr-0637-a-system-rule-answers-one-family.md) (the kind groups) and
[D698](adr-0698-a-state-summary-may-send-one-notification-per-section-and-a-restart-never-moves-since.md)
(the per-section split). Neither is superseded: every rule keeps its meaning.

## Context

The operator turned the D698 split on for device events and asked for the same
on the SYSTEM summary (2026-10-06). Five things stood in the way:

1. **One group mixed two jobs.** The `addons` group held `addon-crash-loop` and
   the two update kinds. A section IS a kind group (`state-model.ts`), so a
   crashed runner and an addon that is behind arrived in one push, titled
   "Addons" — read and acted on by different people at different moments.
2. **Updates were one flat list.** A line ended "on agent-1"; with three nodes
   behind, the operator had to read every line to know what to apply where.
3. **Every section row carried the rule's FIRST kind.** On a rule that started
   with `addon-update-available`, the nodes row, the server-updates row and the
   addon-updates row all tapped through to `/system/addons`, and `{{eventKind}}`
   on history named the wrong kind.
4. **History read ": 17".** `historySystemEvent` rendered the title from the
   row's frozen params alone; `{{rule}}` is a row-level variable the dispatcher
   adds, so the phone said "Stato: 17" and history said ": 17".
5. **A crash loop never ended.** The 12:00 summary of 2026-10-06 still listed
   "hub — core-block-01b86c71… stopped after repeated crashes (since 4 Oct)"
   for a core block that had been running for two days. The row closed only on
   `addon.started` (or a node liveness edge, or a server update), and a core
   block runner is not a registry addon: re-enabled, updated or respawned, it
   never emits one.

Rejected: decoupling sections from kind groups (a second table that can drift
from the one both editors draw — "the rule selected a battery kind" and "the
summary has a battery section" must stay one fact); renaming `addons` to a new
id for the crash loop (every stored preview/history row naming `addons` would
then name nothing — splitting OFF the updates keeps `addons` meaning "a runner
is down", which is what an operator acts on); a per-event close for core blocks
(events are telemetry, D8 — a dropped `started` would leave the row open again).

## Decision

**Groups.** The system family's groups are `nodes` (offline, online as the
closing edge, cannot infer), `addons` (`addon-crash-loop` only), the new
`addon-updates` (`addon-update-available`, `addon-updated`), `updates` (server
and container), and `backups-exports` (no summary section, unchanged).
`NcStateSummarySectionIdSchema` gains `addon-updates`; its variable is
`{{summaryAddonUpdates}}`. Sections stay DERIVED from the rule's kinds, so a
rule saved with the old kinds reports `addons` and `addon-updates` with no
migration. Section names: "Nodes with problems" / "Nodi con problemi",
"Addons stopped" / "Addon fermati", "Addon updates" / "Aggiornamenti addon",
"Server updates" / "Aggiornamenti server" — titled `{{summarySection}}:
{{summaryCount}}` on a split row. A group with nothing open sends nothing; one
that could not be read sends its "unavailable" sentence (D698, unchanged).

**Per node.** The two update sections are worded ONE HEADING PER NODE
(`summary.node.heading`, the node directory's name), the hub first, then by
name; the lines under a heading do not name the node
(`summary.line.update.onNode` is gone). The same blocks appear in the combined
message.

**Kind and tap.** A section row carries the rule's first selected kind OF THAT
SECTION (`sectionKindOf`). Its tap is the section's page
(`SUMMARY_SECTION_PATHS`): nodes and server updates → `/system/cluster`, addon
updates → `/system/addons`, unscoped because the row spans nodes. A section not
in that map taps through its kind like any row (crash loops have no action).

**History.** History renders the title with the dispatcher's recipe
(`renderRowTitle`: authored template, catalog key, frozen words) and the same
variable map (`buildTemplateVars`), so it reads what the phone read.

**Crash-loop recovery.** Once per summary (and preview) the service asks the
runner's OWNER whether each open crash-looped runner is running —
`core-blocks.list` for a `core-block-<id>` runner, `nodes.getNodeAddons` for
the rest (every addon the trip named reported `running`). Only a positive
answer closes the row; a read that fails, or does not name the runner, changes
nothing and is logged (D49).

## Consequences

- The editors show one more system group. The phone draws it from the
  published `@camstack/types`; until its pin moves it shows the old three, and
  after it moves it needs the label key
  `v2.nc.rules.editor.systemGroups.addon-updates` (it falls back to the shared
  English label meanwhile).
- A custom body that named `{{summaryAddons}}` for its update lines now gets
  only the crash loops there; the updates are in `{{summaryAddonUpdates}}`, and
  on a split rule the addon-updates row appends `{{summaryText}}` as D698 says.
- A preview can close a crash-loop row: it corrects the ledger's memory and
  sends nothing. A runner that crashes again later opens a NEW row with a new
  "since".
- A group runner whose trip named no addons is closed only by its events — the
  runner id is not an addon `getNodeAddons` can answer for.
- History's body is still rendered from the catalog key with the full variable
  map; the AI sentence and the TEST marker are not re-rendered there.

## Enforcement

Tests, each disarmed: `state-summary/__tests__/state-summary-system-sections.spec.ts`
(fan-out, EN/IT titles, per-node bodies and order, the row's kind — disarm:
send the rule's first kind — the tap — disarm: drop `SUMMARY_SECTION_PATHS` —
empty and unreadable groups, a rule with the pre-D708 kinds);
`__tests__/state-summary-crash-loop-recovery.spec.ts` (crash loop on day 1,
block running on day 2 → not listed, closed; a failed read changes nothing —
disarm: skip `reconcileCrashLoops`); `__tests__/state-summary-split-center.spec.ts`
(history title through the real centre — disarm: render from the frozen params);
`system-event-summary.spec.ts` (the enum, the groups, `templateCarriesSummary`);
`scripts/check-notification-tap-targets.ts` (the three section taps name
declared admin routes); `scripts/check-nc-text-catalog.ts` (EN/IT parity).
