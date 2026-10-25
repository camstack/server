---
id: D642
title: A consumable is judged at each rule's own threshold, a vacuum tank notifies on the provider's verdict, and consumables survive a restart
status: accepted
date: 2026-09-26
supersedes:
applies-to:
  - packages/types/src/capabilities/consumables.cap.ts
  - packages/types/src/capabilities/notification-rules.cap.ts
  - packages/types/src/notification/system-event-filters.ts
  - packages/types/src/notification/system-event-families.ts
  - packages/types/src/notification/template-vars.ts
  - packages/addon-post-analysis/src/notification-center/alerts/device-alerts.ts
  - packages/addon-post-analysis/src/notification-center/alerts/consumable-subject.ts
  - packages/addon-post-analysis/src/notification-center/alerts/supply-band.ts
  - packages/addon-post-analysis/src/notification-center/rule-engine.ts
  - packages/addon-post-analysis/src/notification-center/event-intake.ts
  - packages/addon-admin-ui/src/pages/system/notification-system-events.ts
  - packages/addon-admin-ui/src/pages/system/notification-system-event-field.tsx
  - packages/addon-admin-ui/src/pages/system/hub-rule-schema-probe.ts
  - packages/addon-admin-ui/src/components/notifications/template-field.helpers.ts
  - packages/addon-post-analysis/src/notification-center/rule-store.ts
  - packages/addon-post-analysis/src/durable/durable-ledger.ts
  - scripts/check-nc-system-filter-scope.ts
  - scripts/check-nc-mirrors-in-sync.ts
---

## Context

The Dreame audit of 2026-09-26
(planning repo: superpowers/specs/2026-09-26-dreame-consumables-audit.md) in the main <!-- drift-ok: the audit lives in the main checkout, not in this tree -->
checkout) found three framework gaps behind the vacuum 4385 and the mower 503.

- **One cluster-wide consumable threshold** (15 %, `consumableLowPercent` in the
  post-analysis settings) judged every item on the hub. A vacuum sensor with a
  30 h life at 15 % is about 4.5 h of cleaning from empty; a main brush at 15 %
  is about 45 h away. The mower worked around the single number with a
  hard-coded `replace` at 10 %, which the hub honours whatever the threshold
  says. The operator decided: "default 15 %, but configurable on the rule". A
  rule at 25 must be told about an item at 20 %, and a rule at 10 must not.
- **Tanks never reached the notification centre.** A `vacuum-control` tank that
  reported `low` (clean water, detergent) or `full` (dust bin) showed on the
  panel and nowhere else. The operator: tanks notify like consumables.
- **`consumables` was `durability: 'session'`.** The mower's three CMS counters
  can be read only while it charges, so after an addon restart with the mower
  idle, `503.consumables` was `{ items: [] }`. The panel was empty and no alert
  could fire, while the mower's own code believed the reading was
  "kernel-persisted across restarts".

The first idea was to put the threshold on the event: carry the item's level,
and let each rule compare it with its own number. That does not work, because
the band is an EPISODE, not a comparison. With one episode per item, a rule at
10 is never told when the item later falls from 20 % to 8 %. The episode opened
at 25 and has nothing left to raise, and its hysteresis belongs to one
threshold only.

## Decision

1. **The consumable threshold is a field of the rule.** It is
   `systemEvent.consumableLowPercent`: an integer from 1 to 95 (`NC_CONSUMABLE_LOW_PERCENT_MAX`: above it the +5 recovery passes 100 % and an episode could never clear), absent meaning
   `NC_CONSUMABLE_LOW_PERCENT_DEFAULT` (15). It is scoped by
   `systemEventFilterApplies` to `device-consumable-low` and `-normal` only, and
   allowed only in the device-events family (`NC_SYSTEM_EVENT_FAMILY_FILTERS`).
   The cluster setting is removed.
2. **The hub keeps one episode per (threshold, device, item).**
   `consumableThresholdCensus` reads the RAM rule mirror and returns every
   distinct threshold that a system-event rule carrying a consumable kind asks
   for. Disabled rules count, so their raise waits PENDING (D636). With no such
   rule, the default is used. Each threshold has its own subject,
   `consumable@<threshold>:<deviceId>:<key>`, with its own hysteresis (+5), its
   own pending raise and its own reminder. The event carries the threshold it
   was judged at, and **a rule hears only the episode judged at its own
   threshold**. This is the occupancy rule's per-count keying, applied one
   family over. Two rules with the same number share an episode.
3. **The thresholds come from a mirror, and a read that has not answered
   changes nothing (D49).** Until the rule mirror has loaded, the census is
   `null`: readings are kept, nothing is judged and no row is touched. A
   threshold that a rule gains is judged on the next tick from the item's last
   reading. A threshold that no rule asks for any more has its episodes retired
   only when **two consecutive censuses** agree. Retirement is silent (nothing
   recovered), and a line tagged with the device id is logged for each row.
   A pre-D642 row (`consumable:<id>:<key>`) is carried over to the
   default-threshold episode instead of being announced again.
4. **A vacuum's tanks are three device-events kinds**: `device-tank-low`,
   `device-tank-full` and `device-tank-normal`, with subject
   `tank:<deviceId>:<tank>`. They are raised from the `vacuum-control` slice
   that already arrives on `device.state-changed`. **The verdict is the
   provider's float switch** (`status`). The hub has no tank threshold: a tank
   that reports only a `level` is not judged, and an unknown status changes
   nothing. Tanks use the same episode machinery as consumables: a silent
   healthy seed, the pending raise and hourly cadence, and the reminder. The
   body names the tank per variant (`system.device-tank-<band>.body.<tank>`),
   because params are frozen before the reader's language is known.
5. **`consumables` is `durability: 'restored'`**, with `lastChangedAt` and
   `lastFetchedAt` volatile. A restored item is the previous observation, which
   is what the panel and the band should see after a restart.
6. **Kinds the installed viewers cannot parse are not served.** The viewer
   parses `getTemplateCatalog` as a whole, with a strict system-event-kind enum,
   so one `device-tank-low` in `{{deviceName}}` would empty every placeholder
   picker on every phone. The served catalog (`servedTemplateVars`) therefore
   drops `NC_TEMPLATE_HELD_BACK_SYSTEM_EVENT_KINDS` from every descriptor. The
   in-process catalog keeps them, and so does the admin: it is built from the
   workspace, so it restores the held-back kinds from its own build
   (`restoreHeldBackKinds`). A tank-only rule is offered `{{tank}}` and
   `{{deviceName}}` there (review M3).
7. **A tank change counts only once it has held for `NC_TANK_HOLD_MS`** (60 s).
   It is confirmed by a later slice write or by the reload tick. There is no
   timer of its own, the hold is per tank and bounded, and it is dropped with
   the device. A float switch that sloshes between `ok` and `full` restarts its
   hold on every flip back and says nothing (review M2).
8. **A threshold is at most `NC_CONSUMABLE_LOW_PERCENT_MAX` (95).** 95 plus the
   +5 recovery hysteresis is 100; above that, an episode could never clear, even
   for a part just replaced (review M1).
9. **The thresholds are an answer only after a load that READ the store.**
   `DurableLedger.hasAnswered()` becomes true on the first successful load.
   `NcRuleStore.isLoaded()` waits for it. A cold boot whose rule read failed
   used to count as loaded with no rules, so the census judged at the default
   and retired every 25 % / 10 % episode two ticks later. Those episodes then
   re-raised under a new `since` when the store came back (review I1).
   `isLoaded()` also gates the clip-retention plan and the deleted-device
   prune, and a failed read now leaves both on their safe side.

## Consequences

- A rule whose threshold changes hears the item at its new threshold within
  one reload tick, provided the item has reported since the process started.
  A reading is held in RAM, and a restart waits for the next slice write.
- A new rule that shares a threshold with an existing rule does not get a raise
  for an episode that is already open and was already heard. It hears the next
  reminder. This was already true of the single cluster threshold.
- The admin's settings section "Battery & offline alerts" no longer offers a
  consumable threshold. A stored value is stripped on read and nothing reads it.
- **Ship note: the viewer lags.** A phone on an older build:
  (a) drops a whole rule that carries a tank kind from its list, because the
  per-rule parse fails. It cannot edit such a rule, so it cannot corrupt it.
  (b) **strips `consumableLowPercent` when it saves a device-events rule**,
  because conditions are re-sent whole. The rule then falls back to 15 %.
  Author thresholds and tank rules on the admin UI until the viewer OTA carries
  both.
- The mower's hard-coded `replace` at 10 % still reads as low at every
  threshold. Removing it is the Dreame addon's part (Workstream A).
- **Release order: `@camstack/server` first, and a wrong order is SILENT, not a
  crash** (corrected in review I2). The notification centre and the admin are
  self-contained bundles (`externals: 'self-contained'`, which inlines
  `@camstack/types`), so they load and look current on an older closure. The
  failure is in the hub's generated router, which validates rule input with the
  closure's schemas: it STRIPS `consumableLowPercent`, so a rule saves "fine"
  and judges at 15 %, and it REFUSES the tank kinds. `durability: 'restored'`
  is also closure-side: until the new server is installed on a node, the slice
  there stays session-only.
  **Made visible:** the admin's device-events editor probes the hub with
  `previewTemplate`. The probe is pure, has `view` access, and puts a tank kind
  in its context, which an old router refuses with BAD_REQUEST
  (`hub-rule-schema-probe.ts`). On an old router the editor warns that the
  server predates thresholds and tanks. A probe that failed any other way says
  "could not check" (D315).

## Enforcement

- Types: `system-event-families.spec.ts` covers the threshold scoped to the
  consumable pair, the hub refusing it outside device-events, and tanks being
  device events. `template-vars.spec.ts` checks that the served catalog names
  no held-back kind and that a tank rule is still offered `{{tank}}` in
  process.
- Engine: `system-event-consumable-threshold.spec.ts`.
- Ledger: `device-alerts-consumable-thresholds.spec.ts` (25 heard at 20 % and
  10 not, hysteresis per threshold, a null census, second-read retirement,
  legacy carry-over, device-id tags) and `device-alerts-tanks.spec.ts`. Each
  gate was removed once and its spec went red.
- Through the real centre: `consumable-threshold-center.spec.ts`.
- Durability: `device-state-mirror-durability.spec.ts` runs the production
  policy round trip.
- Admin: `notification-consumable-threshold.spec.ts`,
  `notification-system-event-field.spec.tsx` (threshold field, 1–95, and the
  old-hub warning), and `template-field.helpers.spec.ts`
  (`restoreHeldBackKinds`).
- Rule store: `rule-store-load-failure-direction.spec.ts` (a failed cold load
  is not an answer).
- Guards: `scripts/check-nc-system-filter-scope.ts` now probes the threshold as
  a fifth filter. Its probe subject carries the default judgement, which is not
  an identity. `scripts/check-nc-mirrors-in-sync.ts` compares the viewer's
  system-event-kind enum. The allowance is read from
  `NC_TEMPLATE_HELD_BACK_SYSTEM_EVENT_KINDS` and expires when the viewer
  mirrors a kind. It also checks the served `systemEventKinds` enum, and has a
  self-expiring `aheadOfViewer: ['consumableLowPercent']` on the condition keys.
