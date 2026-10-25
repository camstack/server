---
id: D933
title: A device reports whether it is running, natively or from one assigned field
status: accepted
date: 2026-10-24
supersedes:
applies-to:
  - packages/types/src/capabilities/running-state.cap.ts
  - packages/types/src/running-state/**
  - packages/types/src/expression/builtins.ts
  - packages/system/src/builtins/device-manager/running-flip.ts
  - packages/addon-admin-ui/src/components/device/customize/scalar/ScalarOverrideCard.tsx
  - packages/ui-library/src/composites/running-badge.tsx
---

## Context

A washing machine, a dishwasher, a dryer and a robot are either doing their job
or they are not, and that fact is what an automation wants ("when it finishes")
and what the device row should show on the icon the device already has.
Several integrations already know it — Home Connect `OperationState`, a
vacuum's cleaning lifecycle, a mower's activity — and many others do not: the
only signal is a switch, a binary sensor, or a power meter whose heater cycles
off for a minute in the middle of a program.

Two shapes were rejected. A second field on each appliance cap (`dishwasher`,
`vacuum-control`, `lawn-mower-control`) leaves every other device type unable
to say it, and the icon badge would have to know each cap. A poll in the
admin UI, or a cache of the assigned sensor beside the device, is the copy
D224 forbids: the fact belongs to the owner, and the owner of an assignment
is the composer, the same place a battery percentage and a consumable level
are derived.

Naming it `activity` collided with the vocabulary label already used for a
vacuum's lifecycle and a mower's activity. The cap is `running-state`.

## Decision

`running-state` is one device-native cap on every device type. Its slice is
`{ running: boolean | null, since: number | null, source: 'native' | 'assigned', phase: string | null, lastFetchedAt: number }`.
`running: null` is unknown and is never stored as `false` (D393). `since` is
the epoch ms the current boolean began; it is null while `running` is null.
`source` names the one authority (D62). `phase` is the native program or
lifecycle word when the integration has one, otherwise null.

An integration that already reports an operation state writes this slice
itself, in the same publish as its own cap, with `source: 'native'`:

- Home Connect operation state (dishwasher, and any washer or dryer that
  shares that state): `Run` and `Aborting` are running; `Pause` is not
  running and keeps the phase `Pause`; `Inactive`, `Ready`, `DelayedStart`,
  `ActionRequired`, `Finished` and `Error` are not running; an unparsed
  state is null.
- A vacuum lifecycle (`cleaning`, `returning`, `drying` are running;
  `paused` is not, phase `paused`). A state the provider has not observed
  is null, even where the vacuum cap itself collapses that to `idle`.
- A mower (`mowing` is running; `paused` is not). Unobserved is null.
- A media player (`playing` is running). Unobserved is null.

The mapping function lives next to the provider's own decode (D12, D13).

An operator assignment, on the device's Customize page, replaces that
authority only when it is saved. It is one composition feature on
`running-state`, evaluated by the composer, and it claims the fields so the
merged slice is what every reader sees. One source field:

- a switch: on means running;
- any other boolean (a binary sensor, a contact, motion): on means running,
  unless the operator inverts it;
- a power reading in watts: running after it has stayed at or above a
  threshold for a start delay, and idle only after it has stayed below that
  threshold for a stop delay.

The defaults are 5 W, 30 s and 180 s. 5 W sits above the standby of a modern
appliance (typically under 2 W) and below a drain pump, so a quiet phase
still counts and a lit panel does not. 30 s is longer than a display waking
and shorter than a real program step. 180 s covers a dishwasher heater
pausing for one to two minutes without holding "running" for long after a
real end. The operator can change all three; they are named constants.

The delay is the expression builtin `dwell(active, onForMs, offForMs)`. It
returns null until the first delay elapses (unknown, not idle), holds the
previous boolean through a gap shorter than the delay, and asks the composer
for one deadline at the instant the delay will elapse — a timer, not a poll.
`latchedAt(value)` stamps `since` at the evaluation where the boolean
changes. An instant source (switch, binary) copies the source's own
`lastChangedAt` instead, so a machine that has already been on for an hour
does not read as "just started".

History records `running` as a boolean, so device history shows running
time. `lastFetchedAt` is volatile.

The flip event is emitted once, from the hub mirror's public slice — the
merge a claim already substituted for the native — and only when that
boolean changes. Restored state is seeded into the detector and does not
emit. `null` is not an edge: becoming unknown does not finish a cycle, and
becoming known-idle does not start one. `true` after anything else emits
`running.started`; `false` after `true` emits `running.finished`. The bus
may drop either (D8); the slice remains the durable fact. The composer does
not emit a second copy, and a native provider does not either.

Home Assistant and HomeKit do not export the cap. The HA binary projector
skips a null and leaves the previous on/off in place, which would show a
machine as running after its state became unknown. HomeKit's boolean
sensors coerce a missing reading to the false characteristic. Both wait
until a null can be published as unavailable.

## Consequences

- A new integration that knows an operation state writes `running-state` in
  its own publish. It does not emit the flip; the mirror does.
- An assignment is the only writer of those fields while the claim is held.
  Removing it hands them back to the native provider.
- `dwell` and `latchedAt` are stateful builtins. A field that uses them is
  recomputed when its deadline fires, with no interval.
- The icon badge is absent while `running` is null. Idle is drawn; unknown
  is not drawn as idle.
- Automations phrase `running.started` and `running.finished`. A dropped
  event is recovered by reading the slice, not by replaying.

## Enforcement

Specs on the pure mappers (each operation state, including unknown → null),
on `dwell` (a heating gap shorter than the stop delay stays running; the
first delay stays null), on the flip detector (seeded restore emits nothing;
null is not an edge), and on the badge (running, idle, unknown). The
vocabulary guard refuses the cap without its phrases. Nothing mechanical
checks that a provider called the mapper.
