---
id: D697
title: An alarm mode inherits every delay it does not set, read when the delay is used; a non-blocking switch writes one membership, never a list
status: accepted
date: 2026-10-01
supersedes:
applies-to:
  - packages/types/src/capabilities/notification-rules.cap.ts
  - packages/addon-post-analysis/src/notification-center/alarm/alarm-panel-device.ts
  - packages/addon-post-analysis/src/notification-center/alarm/alarm-state-machine.ts
---

## Context

This record amends two earlier ones without superseding them: the single
global value per delay that the alarm panel carried into D630 (exit, entry,
siren duration — one number each, for every arm mode), and the non-blocking
picker of D636 (item 7). Both rules they state otherwise stand.

**One value per delay, for every mode.** `home` waited the same exit delay as
`away`, although nobody leaves the house when arming `home`. The code said so
itself: the `DEFAULT_DELAYS` doc comment in the state machine reads "the shared
value is applied to every mode until per-mode delays are asked for". The
operator asked (2026-10-01): every delay can be set per arm mode, and a mode
that sets nothing behaves exactly as today. The panel also cached the delays in
a private field, refreshed at boot and after a settings write — a copy of a
value that now has to be chosen per mode at the moment it is used.

**The non-blocking picker wrote whole lists and showed no state.** Every change
in the mode card sent the mode's ENTIRE `nonBlocking` list, computed from the
editor's snapshot. Two editors (the admin UI and the viewer, or two tabs) each
undid the other's last change, and the deleted-device prune (D633) writes whole
lists too. The picker also showed no current state, so the operator could not
see which window was open — or whether a listed device was even read by the arm
check — without arming and reading the refusal.

Considered and rejected:

- **A per-mode copy of all three values.** Every install would have to be
  migrated (three numbers per mode written on first boot), and each copy drifts
  from the global value the moment the operator edits that one: a changed
  default would no longer reach a mode that never meant to differ.
- **A whole-list `modeDelays` patch.** The same fault as the whole-list
  `nonBlocking`: two editors changing two different modes (or two fields of one
  mode) each send the list they hold and the later one erases the earlier.
- **A sensor-state field on `live`.** `getAlarmConfig` is polled every 2–15 s,
  and the household set of openings comes from `listDeviceIdsByCaps`, a
  whole-fleet bindings pass. Paying that on every poll to draw a table that is
  open on one screen is the wrong place for the cost; the client already holds
  the set (60 s staleness, D636) and can ask for the states of exactly the ids
  it draws.

## Decision

**A mode's delay is its own value if it sets one, else the global value** —
`resolveModeDelays` (`notification/alarm-settings.ts` in `@camstack/types`) is
the only implementation, used by the engine and by both clients. **A delay is
read at the transition that schedules its instant, from the mode that
transition is about:** the exit delay at arm, from the mode being armed; the
entry delay AND the siren duration at the trigger, from the armed mode. The
siren duration is read at the trigger, not when `triggered` begins, because the
trigger is the transition that fixes `clearAt` (`firesAt + duration`). **An
instant already scheduled never moves** when a delay is edited. **An operator's
switch writes ONE membership** (`nonBlockingEdit`: one device, one mode, on or
off), never a list, and the panel computes and writes every list change —
whole-list `nonBlocking`, `nonBlockingEdit`, `modeDelays` edits — from the list
it holds, before its first `await`, so no concurrent writer can erase it.

## Consequences

- **`modeDelays` means two things, by position.** In the settings it is the
  stored OVERRIDES (one entry per mode, a missing field inherits); in a patch
  it is per-field EDITS (a number sets the override, `null` removes it so the
  mode inherits again, an absent field is left alone). Both doc comments say
  so, a test pins it, and the `nonBlocking` / `nonBlockingEdit` pair makes the
  same split by name. Neither patch key has a default — the D630 partial-update
  discipline holds.
- **Stored blobs parse unchanged.** A blob without `modeDelays` reads as `[]`:
  every mode inherits, identical behaviour, nothing migrated. The persisted read
  (`alarm/alarm-mode-delays.ts`) drops an entry whose mode is not an arm mode, a
  field outside its bounds (that field inherits), and a second entry for one
  mode — each said once at boot.
- **An older host strips both new patch keys and answers success.** The clients
  check the answer with `alarmPatchLanded` and say "the hub did not apply this
  change" instead of showing it as saved.
- **A refused edit writes nothing.** A `modeDelays` edit or `nonBlockingEdit`
  naming a mode the panel does not offer, or a `nonBlockingEdit` that would
  overfill a list, is refused in words before anything is written, and logged
  (D391).
- **The table reads states through `getAlarmSensors` (admin cap method, and its
  `nc.*` bridge twin for the viewer),** classified on the hub by
  `alarm/alarm-sensors.ts` through the same `alarmOpeningFrom` classifier as the
  arm check, so the table and the arm check cannot disagree about open, closed
  or unknown. Pending and failed never render as "closed" (D315).
- **The table's coverage column equals the arm check.** `alarmCoveredDevices`
  reads only the ids an enabled rule of the mode NAMES. A device covered only by
  an all-devices rule is never read by the arm check and never blocks that mode,
  and the table says exactly that instead of showing it as covered. The admin's
  older `coveredBy` helper has the opposite reading and is not used for it.
- **The non-blocking picker on the mode card is removed;** the table's switch
  replaces it. A whole-list `nonBlocking` patch stays accepted for older clients
  and for the prune.
- **Operator answers (2026-10-02).** Two choices adopted provisionally from the
  pre-flight review were ruled on; Q1 stands, Q2 changed:
  - *Q1 — filters (confirmed 2026-10-02):* the shared device picker (and the
    table) has Zone and Location multi-select FILTERS beside the Type filter; the
    Zone filter applies only once the zones read answered (D315); Reset clears
    search, Type, Zone and Location and leaves Group by alone.
  - *Q2 — uncovered sensors are not rows (changed 2026-10-02):* the table lists
    only sensors the mode's rules cover, in the arm-check sense of the coverage
    bullet above. This **replaces** the earlier provisional reading (an enabled,
    muted switch on every uncovered row). Choices made with it:
    - **A device covered only by an all-devices rule is NOT covered** for this
      purpose — the arm check never reads it and it never blocks the mode — so its
      row is hidden, exactly like a device no rule names.
    - **A sensor on the mode's non-blocking list that no rule covers is shown
      anyway** (`listedUncovered`): D49 forbids carrying an invisible stored
      entry. It is muted and labelled "Not checked by any rule of this mode —
      listed as non-blocking; switch it on to remove the entry"; its switch
      removes the entry.
    - A removed device that is still listed stays a row as before (D49).
    - When no row remains the card says "No sensor is covered by a rule of this
      mode" — never an empty table, and never while the household scan has not
      answered (`alarmSensorTableState`; pending is not "none", D315).
    - Rows hidden for being uncovered are not counted in "N rows hidden by
      filters". The filtering lives in the byte-shared `alarmSensorRows`, so the
      admin and the viewer behave identically.

- **Layout (operator, 2026-10-02, after the live check).** The modes are tabs,
  one shown at a time; the per-mode paragraphs are gone (badges with tooltips);
  the sensor list is the shared `DeviceList`, one table sorted by name, never
  grouped by zone or room — this replaces the Zone/Location grouping of Q1 (the
  Zone and Location filters stay in the shared device PICKER; the alarm list
  keeps the Type filter and a search that matches the zone and location).

## Enforcement

- Tests: the `alarm-settings` spec (inheritance, per-field edits, idempotent
  membership edits, `alarmPatchLanded`) and the extended
  `notification-rules-alarm` schema spec; the persisted-read spec of
  `alarm/alarm-mode-delays.ts`; the panel tests that arm and trigger under
  per-mode values and the concurrency tests in which a membership edit races a
  whole-list write; the `alarm/alarm-sensors.ts` classifier spec and the
  `getAlarmSensors` cap and bridge specs.
- A per-mode delay edit writes back, untouched, a persisted entry whose mode this
  release does not know (a later release wrote it); a duplicate or out-of-bounds
  entry is discarded and logged once per entry (`alarm per-mode delay discarded
  on write`). The boot line already announced the drop.
- The device-selection pair guard (`scripts/check-device-selection-in-sync.ts`)
  keeps the shared table model and picker model byte-identical in the admin UI
  and the viewer.
- The Q2 row filter is pinned in both copies of the model spec (uncovered hidden,
  all-devices-only hidden, listed-uncovered shown and flagged, removed kept,
  pending is not none) and in the admin page and viewer mount specs.
- Beyond those tests, "read at use, never cached" is review only: a new site
  that schedules an instant from a cached delay would not be caught.
