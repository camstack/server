---
id: D698
title: A state-summary rule may send one notification per SECTION, and a restart never moves an open state's "since"
status: accepted
date: 2026-10-01
supersedes:
applies-to:
  - packages/types/src/capabilities/notification-rules.cap.ts
  - packages/types/src/notification/system-event-summary.ts
  - packages/types/src/notification/template-vars.ts
  - packages/addon-post-analysis/src/notification-center/boot-window-rows.ts
  - packages/addon-post-analysis/src/notification-center/liveness-ledger.ts
  - packages/addon-post-analysis/src/notification-center/state-summary/system-state-ledger.ts
  - packages/addon-post-analysis/src/notification-center/state-summary/state-summary.ts
  - packages/addon-post-analysis/src/notification-center/state-summary/state-summary-delivery.ts
  - packages/addon-post-analysis/src/notification-center/state-summary/state-summary-service.ts
  - packages/addon-post-analysis/src/notification-center/state-summary/state-summary-test.ts
  - packages/addon-post-analysis/src/notification-center/nc-actions.ts
  - packages/addon-admin-ui/src/pages/system/NotificationSystemEventDelivery.tsx
  - packages/addon-admin-ui/src/pages/system/notification-system-event-delivery.ts
  - packages/addon-admin-ui/src/pages/system/notification-rule-test.ts
---

Amends [D647](adr-0647-a-system-rule-may-send-a-scheduled-state-summary-instead-of-an-event.md)
(it does not supersede it: every D647 rule keeps its meaning).

## Context

Three things went wrong with the D647 state summary, all reported by the
operator on 2026-10-01:

1. **One message for everything.** The operator wants ONE NOTIFICATION PER
   CATEGORY (device state, batteries, consumables, ...): a low battery and an
   addon update are acted on by different people at different moments, and one
   combined push mixes them.
2. **"Offline since" moved to the restart.** Five sensors offline since 10:36
   read "offline (since 19:43)" — 19:43 being the hub's restart after a server
   update — one of them in the first preview after the restart, all five an
   hour later. The cause was the boot window of the durable ledgers. Every
   provider re-announces its devices at boot, and the notification centre hears
   those events BEFORE its back-fill loads the liveness ledger (and later still
   the system-state ledger). On an empty mirror `DurableLedger.observe` seeds a
   row stamped "now" and persists it write-behind; `load()` then replaces the
   mirror with what the store returned. Whether the seed's write landed before
   the load's read decided what RAM held, and the store held "now" either way,
   so the next load (a runner respawn) read 19:43 for all five. The first fix
   handled only the seeds; review found the CLOSE half (a stream back online at
   boot, a `server-updated`) was lost the same way for a row only the store
   held — reported open indefinitely.
3. **TEST on a summary rule sent nothing.** `nc.testRule` injected one
   synthetic event; a summary rule sends nothing per event, so the test was
   dropped, silently.

Rejected: a per-section flag on each SECTION (a rule-level choice is what the
operator asked for, and a per-section matrix doubles the editor); deriving the
split from the template (a body is words, not a delivery decision); fixing the
boot window inside `DurableLedger` (three drift-guarded copies; the merge rule —
what counts as "the same fact" — is the owner's, not the primitive's).

## Decision

**Split.** The summary arm of `systemEventDelivery` carries an optional
`split: 'rule' | 'section'`; absent is `'rule'`, the D647 message.
`systemEventSummarySplitOf` is the one reader. With `'section'`, every section
that has something to say at window close — items, or an UNAVAILABLE read worded
exactly as the combined text words it — is its own outbox row with record id
`state-summary:<ruleId>:<windowEndMs>:<sectionId>`, title
`{{rule}} — {{summarySection}}` and body the section's lines. A read section
with nothing open sends nothing. On a split row only that section's variable is
filled; a body that names neither `{{summaryText}}` nor the row's own section
variable gets `{{summaryText}}` appended.

**Test.** Testing a summary rule builds the summary now (mute bypassed) and
enqueues it, split as the rule is, under the TEST record id
`state-summary-test:<ruleId>:<nowMs>` (`:<sectionId>` per section), with the
`synthetic` origin so it is marked `[TEST]`; it touches no stamp. Nothing to
report is answered (`droppedBy: 'nothing-to-report'`, every section's read).

**Boot window.** Before a ledger's boot load has answered and been SETTLED, an
observation that would create a row is provisional — staged in RAM, never
persisted — and a close is applied to what RAM holds AND deferred, keyed, to be
replayed against the loaded rows. The settle replays the closes first, then
merges each provisional row with the stored one by the owner's rule (liveness:
same state keeps the stored row; system state: same kind keeps the stored
`since` and takes the fresh params). A different or absent stored fact is
written with the observation's time. A load that fails leaves the window open
and writes nothing provisional. A restart never resets "since" for a state that
was already open.

## Consequences

- A window replayed after a crash sends each section once (outbox dedup per
  record id; the stamp is last). Changing the split while a window is being
  retried can send that window in both shapes — an edge, not guarded.
- A state that changed while the hub was down is stamped with the boot
  observation's time: a lower bound. Making that "unknown" would need a column.
- A provisional seed is not durable until the load settles; a crash inside the
  boot window loses it (one silent re-seed next boot — the ledger's stated
  cost).
- An older hub strips `split` at save and sends one message; the admin preview
  names such a hub, the phone's hint says the option needs an updated hub.
- The phone mirrors `split` and the test answer; its mirror-parity spec needs
  the published `@camstack/types` that carries this record.

## Enforcement

Tests, each disarmed (removing the gate turns it red):
`liveness-boot-window.spec.ts` (seeds, the settle log, the answer/settle gap),
`state-summary/__tests__/system-state-boot-window.spec.ts` (seeds, closes, the
merge, the replayed-close INFO line with its `deviceId` tag, the settle's count
of rows closed, the failed load's pending closes),
`state-summary/__tests__/state-summary-split.spec.ts`,
`__tests__/state-summary-split-center.spec.ts` (through the real centre, crash
replay per section), `__tests__/state-summary-test-rule.spec.ts` (a TEST
delivers, is marked, and leaves the next real window owed),
`__tests__/template-var-parity.spec.ts` (a section row fills only declared
variables), `scripts/check-nc-text-catalog.ts` (EN/IT keys), the admin
`notification-summary-split.spec.tsx`, and the viewer's `summary-split.spec.ts`
and `nc-rule-mirror-parity.spec.ts`. Preview row `section` is
`NcStateSummarySectionIdSchema` (D698 LOW-6; disarm in
`system-event-summary.spec.ts`). No guard script.
