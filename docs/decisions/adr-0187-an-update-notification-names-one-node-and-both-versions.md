---
id: D187
title: An update notification names ONE node, and an update names both versions
status: accepted
date: 2026-08-19
supersedes:
applies-to:
  - server/backend/src/core/update-availability-emitter.ts
  - server/backend/src/core/updates/restart-marker.ts
  - packages/node-root/src/root-update-service.ts
  - packages/addon-post-analysis/src/notification-center/event-intake.ts
---

## Context

Both update notifications an operator receives were reported useless on
2026-08-19, from a phone, and the hub's own logs carried the evidence for each.

**"Server aggiornato" named no version.** The line was
`Restart completed {kind=framework-update nodeId=hub packageName=@camstack/server
toVersion=1.2.138 requestedBy="server-update: @camstack/server@1.2.138"}` — the
`.restart-pending` marker had the version the hub went TO and nothing about the
one it left, because the reason STRING was the only channel between
`RootUpdateService.applyServerUpdate` and the restart seam, and a string spells
one version. The Notification Center then required BOTH versions for its
sentence and fell back to `system.server-updated.body.plain`, so it printed
neither: _"@camstack/server sul nodo hub è stato aggiornato"_. The version it
had was thrown away on the way out.

The fact cannot be recovered later: the starter swaps the single `current/`
copy in place, so the process that emits `system.restart-completed` IS the new
version and the old one is gone from disk.

**"Aggiornamenti addon disponibili" arrived three times, identical.** One 6-hourly
sweep of a three-node cluster (hub, MacMiniAgent.localdomain, agent-a)
produced three pushes at 19:31:03, 19:31:06 and 19:31:07, each listing the union
of all three nodes' packages — 45 rows — and naming no node in the title. The
cause was in `UpdateAvailabilityEmitter.emitList`: a change in ANY scope emitted
the entire `held` map for that target, so each node's sweep re-announced every
other node's list. The three differed by one line and read as duplicates.

A test had passed over the first bug for months, in the shape this repo has been
burned by twice: `system-event-intake.spec.ts` fed a fixture carrying
`fromVersion` — the field production never wrote.

## Decision

An update notification is **per node, and complete**:

1. **One `update.available` event covers exactly one node.** `emitList` filters
   `held` by scope, stamps `nodeId` on every row (the hub's included) and sets
   `nodeId`/`nodeIds` to that scope. A node whose list did not change stays
   silent.
2. **The Notification Center names the node once** — in the title
   (`system.addon-update-available.title.onNode`) when every row shares one, and
   per line otherwise. It never renders a list nobody owns.
3. **The version a node is LEAVING travels with the restart**, as a
   `RootRestartUpdate` handed to the restart seam beside the reason string, and
   is written into the marker by one shared builder
   (`core/updates/restart-marker.ts`) for the hub and the agent alike.
4. **A sentence never drops a fact it has.** Known target and unknown source
   renders `system.server-updated.body.toOnly`; the version-less body is for the
   case where nothing is known.
5. **A restart is an update only when a version says so.** The plain node
   restart travels under the same `server-update:` prefix
   (`RootUpdateService.restartNode`), and both the marker builder and the intake
   now require a version before calling it a framework update.

## Consequences

A cluster sweep can send up to one addon-availability notification per node. That
is deliberate and matches every other node-scoped system notification
(`node-online`, `node-offline`, `addon-crash-loop`): the operator narrows these
by _where_. The rejected alternative was one aggregated cluster push per sweep —
it needs a sweep-scoped barrier that does not exist, because each scope publishes
independently and an AGENT publishes its own `target: 'server'` availability from
its own process, so the hub cannot know when the cluster is done looking.

Keeping the union and merely adding the node list to the text was also rejected:
it would still send one push per scope change, each claiming 45 packages, and
"which of these do I have to act on, and where" would still be unanswerable.

The durable dedup state (`<dataDir>/update-availability/<scope>.json`) now holds
a `nodeId` on the hub's own rows. Keys are unchanged (`<target>:<scope>:<pkg>`),
so no re-announcement follows the upgrade.

`update.available` lists are now version-arrow lines (`pkg 1.2.3 → 1.2.4`) like
the completed-update list, instead of `pkg 1.2.4 (current 1.2.3)` — a frozen
param is delivered verbatim, and an English word in an Italian notification is a
translation the catalog cannot make.

## Enforcement

Tests, at each seam: `update-availability-emitter.spec.ts` (one node per event,
every row labelled, a quiet node stays quiet), `restart-marker.spec.ts` (both
versions; a plain restart is not an update), `root-update-service.spec.ts` (the
engine hands the seam the version it is leaving) and `system-event-intake.spec.ts`
(the three rendered sentences, in Italian). The text-catalog guard
(`scripts/check-nc-text-catalog.ts`, in CI) keeps the new keys at parity across
locales.
