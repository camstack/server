---
id: D630
title: An arm is refused by openings; armed around only by name — Arm anyway, a per-mode non-blocking list, and every transition announced
status: accepted
date: 2026-09-24
supersedes: D137 (the second-press bypass; refusal on open contacts and the two-phase exclusions stand)
applies-to:
  - packages/addon-post-analysis/src/notification-center/alarm/**
  - packages/addon-post-analysis/src/notification-center/index.ts
  - packages/addon-post-analysis/src/notification-center/rule-engine.ts
  - packages/addon-post-analysis/src/pipeline-analytics/services/event-kinds.ts
  - packages/types/src/catalogs/device-state-vocabulary.ts
  - packages/types/src/capabilities/notification-rules.cap.ts
  - packages/addon-post-analysis/src/notification-center/nc-actions.ts
  - packages/addon-post-analysis/src/notification-center/action-token.ts
  - packages/addon-post-analysis/src/notification-center/action-buttons.ts
  - packages/addon-post-analysis/src/pipeline-analytics/index.ts
  - packages/addon-post-analysis/src/pipeline-analytics/services/sensor-transition-gate.ts
---

## Context

[D137](adr-0137.md) shipped the first refusal: an open contact blocks the arm,
and a second press inside 60 s arms around it. Two places make that bypass
silent instead of an act the operator can see:

- the viewer's `useCapMutator` swallows the rejection in an empty `catch`;
- the admin hero card fires `void cap.arm({ mode })` and ignores the rejected
  promise.

So the second tap arms around an open window that nobody read about — the
confirmation D137 wanted turned into exactly the un-noticed bypass it was
built to replace. Fixing both call sites to stop swallowing is necessary but
not sufficient: a bypass with no confirmation UI still needs a device list to
confirm, and D137's list is a coincidence of implementation (`decideArm` was
handed whatever was open 60 s ago), not a record of what the operator agreed
to arm around.

At the same time, three narrower defects surfaced from the same D137 code:

- `DEVICE_STATE_READERS` names a lock cap that does not exist
  (`{ cap: 'lock', field: 'locked' }`); every lock in the fleet collapsed to
  `undefined` and a lock gate never matched.
- D137's candidate derivation required `sensorKinds: ['contact']`, so a rule
  scoping a cover or a lock covered nothing — the refusal only ever knew about
  contacts, even though the operator's mental model ("is anything open")
  includes windows and doors that are covers, and doors that are locks.
- The panel's `announceArm` switch already gates the refusal **in code**, not
  only in an operator's mental model: `announceArmRefused` computes
  `targetIds` as `settings.announceArm ? settings.announceTargets : []`
  (`notification-center/index.ts:~3767`) — the exact check `armAnnouncement`
  applies to the armed/arming sentence (`~4062`). An install whose switch is
  off, or was never turned on, gets no refusal notification at all: the one
  notification an operator most needs ("I could not arm, and here is why")
  was silently withheld by a switch named for the opposite case. Every OTHER
  transition (disarmed, pending, triggered, re-armed) has no announcement
  builder at all today — `scheduleAlarmTransition` falls back to `null` for
  any kind but `alarm-armed`/`alarm-arming` — so "every transition
  announced" is new behaviour, not a relaxation of an existing switch.

## Decision

**1. The second press is removed.** The bypass becomes an explicit **Arm
anyway**, bound to ONE refusal:
- it is an action button on that refusal's notification (an HMAC grant bound
  to that one refusal). The same call is reachable through the `nc.*` bridge
  (`nc.armAlarmAnyway`), but the bridge's WRITES — arm, Arm anyway, disarm —
  are **admin-only**, in the envelope and again in the handler:
  `addons.custom` is system-scoped and knows nothing of the per-device grants
  `alarm-panel.arm`/`disarm` check. A non-admin arms and disarms through the
  device-scoped cap, exactly as before, and gets past a refusal with the
  notification's Arm anyway button. `nc.getAlarmStatus` is admin-only too
  until the viewer work scopes it to the caller's devices — it names every
  covered device and whether it is open;
- it carries only the refusal's id — the panel's in-RAM refusal record holds
  the mode and the exact blocking ids at refusal time, never re-derived from
  whatever happens to be open when the button is pressed;
- it is one-shot, and it expires when the panel changes state (armed,
  disarmed, or fired) or after `ARM_ANYWAY_TTL_MS` (5 min) — a confirmation
  that outlives the sentence it confirmed is not one;
- pressing it re-checks. A device that opened since the refusal produces a
  NEW refusal notification; it is never silently folded into the old
  confirmation. That refusal names EVERY device that blocks now — the new
  blocker, the confirmed ones still open, and the confirmed ones the re-read
  reads UNKNOWN (D49) — so its own Arm anyway can arm around all of them, and
  never arms live a device the operator was shown open;
- when the openings cannot be read at all, the arm goes ahead without the
  check and an `alarm-check-failed` notification says so — announced only
  AFTER the arm has landed, with the state the panel is really in. An Arm
  anyway overtaken by a disarm while its re-read was in flight arms nothing
  and announces nothing.

**2. A per-mode `nonBlocking` list is allowed, and D62 still holds.** D62
forbids a second list of what a mode *covers*. This list does not cover
anything — coverage stays derived from the enabled rules gated on
`armed_<mode>` (D137/D62's "rules are the zones"), and disabling a rule still
removes the device from coverage. `nonBlocking` only says: "this ALREADY
covered device may be open when the panel arms." A device on neither list, if
open, still refuses. It is **one entry per mode** — a second entry naming a
mode already present is rejected rather than merged or appended, so there is
never an ambiguous "which list wins" question at read time. The settings
**patch** field carries no default: a patch that omits `nonBlocking` leaves
the stored per-mode lists exactly as they were — `nonBlocking` is set-if-
present, not reset-if-absent, matching how every other optional settings
field on this panel already patches.

**3. An opening is any state that is not fully secure.** The addon owns this
table in one place (`alarm-openings.ts`), read from the raw runtime slice —
never the collapsed `deviceState` word, which cannot distinguish "not an
opening" (a camera) from "an opening that could not be read":

| Device | Secure | Open |
|---|---|---|
| Contact (`entryOpen`) | `false` | `true` |
| Cover (`state`) | `closed` | `open`, `opening`, `closing`, `stopped` |
| Lock (`lock-control.state`) | `locked` | `unlocked`, `unlocking`, `locking`, `jammed` |

Two cases are worth writing out, because "open" here means "not yet secure",
not "in motion toward open":

- **Cover, `stopped`.** A cover stopped part-way is an opening; the position
  is not needed to know that — `stopped` is never `closed`.
- **Cover `closing`, lock `locking`.** Both are "not yet secure" at the
  instant the arm is decided, even though both are moving toward secure. If
  they finish before the operator's next press, the reconcile tick has
  already read them as closed/locked by then, so that next press finds
  nothing open on that device and simply succeeds. There is no race to
  resolve — the arm decision is a snapshot at press time, never a wait for a
  device mid-transition.

This also fixed the lock reader: `DEVICE_STATE_READERS` named `{ cap: 'lock',
field: 'locked' }`, a cap that does not exist. The real cap is `lock-control`
with a string `state` (`lock-control.cap.ts:26-40`), so every lock read
`undefined` and a lock gate never matched. Replaced with
`{ cap: 'lock-control', field: 'state' }`.

**4. Every transition goes to `announceTargets`.** The recipients are the
panel's own, and rules may add more. The `announceArm` switch is dropped —
in the code it replaces, it gated the armed/arming sentence AND the refusal
(Context, above), and every other transition had no announcement builder at
all. An install whose switch was off — including one that has therefore never
seen a refusal notification — starts receiving announcements for every
transition, and that is the operator's explicit decision, made once, by the
plan that shipped this record.

**5. `armed_X` also matches `pending` and `triggered` whose target is X.**
Only for the panel the Notification Center owns, because it is the only
device whose target mode is knowable from its own state machine. A rule
gated on `armed_away` keeps matching through `away`'s entry delay and through
a siren that has not yet resolved — today it silently stops matching the
instant the panel leaves the settled `armed_away` word, which is the state
most rules actually care about (`arming` still lets people leave; `pending`
and `triggered` are exactly when a rule ought to still be live).

This is why `NcDeviceStateLookup` now answers a LIST of words: one device may
truthfully be in two (`triggered` and `armed_away`), and the `deviceState`
gate matches when ANY of them is among the rule's states. A normal device
answers one word.

The alias works only while the panel lives on the node that evaluates the
rules — the post-processing node, today the hub. Rules are evaluated only
there, and only there is the panel's target knowable; if post-processing
moves off the panel's node, the alias fails CLOSED (the panel answers
`pending`/`triggered` alone, and a rule gated on `armed_X` stops matching
during them) — never open.

**6. A sensor linked to no camera now reaches the notification rules.** Its
event is built with the sensor as its own device (`deviceId` and
`sourceDeviceId` both the sensor's id), so a device-event rule can finally
fire on it. It writes **no** timeline row, because there is no camera to own
one — this is evaluation without persistence, not a new kind of durable
record. A sensor whose linked cameras have ALL opted out of tracked events
(`producesTrackedEvents: false`) takes the same sensor-level route: no camera
row is written for it either, so without this route its change reached no
rule. That event carries `linkedCameraIds` — every linked camera — so a rule
scoped to one of those cameras still matches it.

**7. A rule that belongs to the alarm fires on the opening edge only.** A
sensor state change reaches the rule engine as one `device-event` subject per
linked camera, for EVERY transition — so a rule gated on `armed_<mode>` would
otherwise fire when a covered window CLOSES too, sounding the siren on the
person shutting it. A rule "belongs to the alarm" when its `deviceState` gate names ANY
device's `armed_*` word — CamStack's panel or any other, e.g. an HA-mirrored
alarm panel — or when an ENABLED `onTrigger` sequence has an
`alarm-panel.trigger` step. It ignores which device, which mode, whether the
rule is enabled and what it is scoped to: this is **not** the coverage
predicate `alarmCoveredDevices` uses for the arm check, only the answer to
"should this rule refuse a closing edge"; there is no
separate operator-facing condition for this — both rule editors already prune
condition keys to the catalog on save, so an unsurfaced key would be silently
dropped on the first edit, and nobody has asked for "notify me when a window
closes while armed". Such a rule is evaluated only on the OPENING edge, read
off the event's own slice (`alarm-opening-edge.ts`): a contact opens
(`entryOpen` `false → true`), a lock leaves `locked` (`unlocking`/
`unlocked`), a cover leaves `closed` (`opening`/`open`). It never fires on
the matching closing edge, and `stopped`/`jammed` count as neither edge — a
cover stopping half-way after already opening, or a lock fault, is not a
fresh entry. A rule that does NOT belong to the alarm (a window-chime rule,
say) is unaffected and keeps firing on every edge, exactly as today.

The edge is STATELESS — one change is N rows, one per linked camera, and a
"previous reading" tracker would call the first an edge and the rest steady —
and it reuses the open/secure table of Decision 3 (`alarmOpeningFromSensorEvent`)
rather than a second one; it only adds the direction of a word that table calls
open. A sensor linked to no camera (Decision 6) is built through the same
subject builder and is filtered the same way. A trigger step counts only in an
ENABLED sequence. Residual, accepted: a four-word cover travelling
`closed → opening → open` gives two opening rows, so an alarm rule fires on
both (the rule's cooldown bounds it); a stateless reader cannot tell `open`
after `opening` from `open` after `closed`, and a two-word cover (`closed`/
`open` only) must fire on `open`. A refused edge is not silent: the intake's
`rule did not match` debug line names `failed: sensorEdge` and the edge, tagged
with the `deviceId`. The edge gate runs AFTER the `deviceState` gate, so a
closing on a disarmed panel reports `deviceState` — the gate that really
stopped it.

**8. A cover is now an eventful sensor kind.** `cover` was in neither the
event taxonomy nor `CAP_TO_KIND`, so a cover produced no `SensorEvent` and
could never reach a rule — including the opening-edge rule above, which needs
a cover's own state changes to see it open at all. `cover` is now
`CAP_TO_KIND.cover`, mapped in the taxonomy's control group. Being eventful is
necessary but not sufficient: what actually reaches the sink is gated by the
post-analysis **sensor transition gate**, and for a cover that gate fires on a
**change of the `state` word** — `opening`, `open`, `closing`, `closed`,
`stopped` — never on a position tick within the same word and never on a
same-state republish. A **lock** (`lock-control`) is gated the same way on its
`state` word, with `locked` at rest — it used to pass through as "arrival is
the event". And a provider's **placeholder** slice (`lastChangedAt === 0`,
written by a constructor before it has read the device: an HA lock's
`unlocked`, an HA cover's `closed`, a binary sensor's `entryOpen: false`) is
dropped by the gate for every cap (`cold-slice`, counted in its drop summary)
and remembers nothing; the opening table (Decision 3) reads such a slice as
UNKNOWN. Without both, a provider respawned while the panel was armed could
fire the siren: the placeholder `unlocked` was an unlock, and a placeholder
`closed` followed by the real `open` was an opening that could lift an
exclusion. **Consequence:** a cover linked to a camera now writes
one sensor-event row (and, where `producesTrackedEvents` is on, a marker
track) per state-word TRANSITION on that camera's timeline — not per position
update. This is a known, accepted side effect: Decision 7's opening-edge-only
rule is what keeps the ALARM itself from re-firing on every one of those
rows; the timeline rows are not filtered and are a visible, permanent
consequence of making covers eventful at all. (The Phase-1/Phase-2 install
ordering this depends on is recorded under Consequences, below.)

**9. The lock-control reader fix (Decision 3) also widens what `armed_X` can
gate on.** Adjacent to this record's own scope, not a separate decision:
`lock-control.state` is now readable by every consumer of
`DEVICE_STATE_READERS`, not only the alarm opening table — a `deviceState`
rule gated on a lock's word now matches for the first time on any install
with a lock-control device.

## Consequences

- **`alarmPanel.arm` failing is now a normal, expected outcome**, not an edge
  case — every caller (admin UI, viewer, a notification action button, a rule
  sequence) must render the refusal rather than swallow it. This record
  exists because two of those four callers did not.
- **The refusal is stateful, in RAM only.** A refusal that survived a restart
  would let a respawned panel arm around devices nobody re-read since the
  crash; losing a live refusal on restart costs the operator one more tap,
  which is the cheaper failure.
- **An install whose `announceArm` was off starts getting every transition
  announced.** `announceArm` is kept, `optional`, parsed and never read, for
  one release so an older admin's settings patch still round-trips; it is
  removed after that release.
- **A rule gated on `armed_*` no longer fires on a covered device's closing
  edge** (Decision 7). No rule audited at the time of this record relies on
  that firing; a rule that is NOT alarm-gated is untouched and keeps firing
  on every edge.
- **A cover linked to a camera writes timeline rows it did not before** (see
  Decision 8) — one per state-word TRANSITION, gated by the sensor transition
  gate, never per position tick or same-state republish. An operator auditing
  a camera's timeline after this record now sees cover state changes
  interleaved with detections; this is accepted, not filtered.
- **The Phase-1/Phase-2 install order leaves a short window** where the new
  types are live but the transition-gated addon (Decision 8) is not yet
  deployed. Phase 1 installs `@camstack/server` on the hub; Phase 2's
  `camstack deploy packages/addon-post-analysis` follows immediately after,
  back-to-back. In that window the OLD addon build runs against the NEW
  types, so a cover state change may pass through whatever ungated behaviour
  the old addon already had for it rather than the gate Decision 8 describes.
  The window exists only because the two steps are separate commands; it is
  not meant to be observed on a well-run rollout.
- **A device with no opening meaning (a camera, a switch) is never an
  opening**, and `alarmOpeningFrom` returns `not-opening` for it — never treated as
  an unreadable opening. Distinguishing "not applicable" from "unreadable"
  is what makes the D49 fail-open rule enforceable here: an unreadable
  opening logs and does not block (D49); a non-opening is not part of the
  question at all.
- **`nonBlocking` is a new persisted list**, capped at 200 device ids per
  mode, one entry per mode, restored through a guard that filters to known
  modes rather than a cast — consistent with the "no casts" global
  constraint. Patching settings without naming `nonBlocking` is a no-op on
  the stored lists — never a silent clear.

## Enforcement

- `packages/addon-post-analysis/src/notification-center/alarm/__tests__/alarm-openings.spec.ts`
  — the full D630 table (Decision 3), including the two cases written out
  above (`stopped`, `closing`/`locking`), that a camera or a switch is
  `not-opening`, and that a placeholder slice is UNKNOWN (Decision 8).
- `packages/addon-post-analysis/src/pipeline-analytics/__tests__/sensor-transition-gate.spec.ts`
  — the cover and lock word gates and the `cold-slice` drop (Decision 8).
- `packages/addon-post-analysis/src/notification-center/alarm/__tests__/alarm-arm-guard.spec.ts`
  — `decideArm`'s blocking/excluded split for `nonBlocking`, `acknowledged`,
  and the no-bypass-on-repeat-press case (Decisions 1, 2).
- `packages/addon-post-analysis/src/notification-center/alarm/__tests__/alarm-arm-refusal.spec.ts`
  — the refusal lifecycle on the real device: unknown/superseded, stale on
  any panel state change, expired past `ARM_ANYWAY_TTL_MS`, a new blocker
  producing a new refusal, one-shot use, and that a restart drops the refusal
  (never persisted) (Decision 1).
- `packages/addon-post-analysis/src/notification-center/alarm/__tests__/alarm-gate-words.spec.ts`
  and `packages/addon-post-analysis/src/notification-center/__tests__/rule-engine-device-state.spec.ts`
  (the repo's existing `deviceState` gate spec) — `pending` and `triggered`
  answering as their target mode, and `arming` not answering as one
  (Decision 5).
- `packages/addon-post-analysis/src/notification-center/alarm/__tests__/alarm-opening-edge.spec.ts`
  and `packages/addon-post-analysis/src/notification-center/__tests__/rule-engine-alarm-edge.spec.ts`
  — the opening-edge table and that an alarm-gated rule fails on `closing`/
  `neither` while a non-alarm rule still fires on every edge (Decision 7).
  Disarms performed and reverted: `ruleBelongsToAlarm` returning `false`
  turns the closing-window, trigger-step, alias and unlinked-sensor cases
  red; dropping `neither` from the refused edges turns the jammed-lock and
  stopped-cover cases red.
- `packages/types/src/catalogs/__tests__/device-state-vocabulary.spec.ts` —
  the lock reader against the real `lock-control.state` slice (Decision 3).
- `packages/types/src/capabilities/__tests__/notification-rules-alarm.spec.ts`
  — the alarm kind list in lifecycle order, and that `cover` maps to
  `CAP_TO_KIND.cover` (Decision 8).
- Disarm check performed and reverted during implementation: restoring the
  old `{ cap: 'lock', field: 'locked' }` reader turns
  `device-state-vocabulary.spec.ts`'s lock case red.
- `docs/reference/*` regenerates this record into `docs/decisions/index.md`
  on commit; nothing here is hand-maintained past this file.
