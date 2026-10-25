---
id: D869
title: The Alexa export maps caps through one adapter registry, publishes covers first, and shapes and reconciles its reports
status: accepted
date: 2026-10-17
supersedes:
applies-to:
  - packages/addon-export-alexa/src/endpoints/adapters/**
  - packages/addon-export-alexa/src/endpoints/generic-device.ts
  - packages/addon-export-alexa/src/endpoints/validate-instanced.ts
  - packages/addon-export-alexa/src/handlers/cover-controller.ts
  - packages/addon-export-alexa/src/handlers/deferred-response.ts
  - packages/addon-export-alexa/src/state-reports/**
---

## Context

D775 published generic devices through a hand-written row table. One cap cost
five edits in five files: the `ROWS` entry in `generic-device.ts`, the slice
mapping in `generic-state.ts`, the ChangeReport map in `state-change-map.ts`, a
branch in `directive-router.ts`, and a line in `validate-endpoint.ts`. It
drifted. `RangeController` was whitelisted and handled by nobody; the validator
had no rule for `instance`, `configuration`, `semantics` or `capabilityResources`
names; `thermostat` was in `GENERIC_DEVICE_TYPES` with no `climate-control` row,
so 19 Home Assistant thermostats logged "not published" at warn, which read as
a configuration error. Nothing recovered a dropped `DeviceStateChanged` (events
are telemetry, D8/D11), so a blind that stopped at 40 % stayed "moving" in the
Alexa app. And nothing limited the report rate: a sensor twitching 0.1 degrees
or a blind streaming its position became a stream of ChangeReports to Amazon.

## Decision

**One adapter per CamStack cap** (`endpoints/adapters/<cap>.ts`), collected in
ONE registry (`adapters/index.ts`). An adapter declares, from the device's
features, role and (when it asks) a slice read at discovery: the Alexa
capabilities and display category (`describe`), the Alexa properties of a cap
slice (`properties`), its directive handlers (`directives`, each with
`needsReachableDevice`), and its report shaping (`shaping`). Discovery,
ReportState, ChangeReport, the reconcile, the directive router (access level
and reachability gate included) and the validator iterate the registry; none of
them names a cap. A new cap is one adapter file plus one line in the registry.
Lock, contact, motion, presence, temperature, humidity and switch (+brightness)
were ported with byte-identical discovery output
(`generic-golden.spec.ts` compares against the JSON captured before the port).
Camera endpoints keep their own builder.

**Thermostat.** Withheld in P0 with an info log (never the "no cap Alexa has an interface for" warning) until the climate adapter existed; P3 (D874) published it and the skip path is gone.

**State reconcile.** Every 15 minutes `StateReconciler` reads the slice of every
cap behind every exposed generic endpoint and `StateChangeReporter.reconcile`
pushes a ChangeReport only where it differs from the last REPORTED value. A
read that fails, or a cap the device lacks, changes nothing (D49). The first
look at a property records a baseline instead of pushing it (Alexa's copy is
unknown and a restart must not re-announce every device); a value still waiting
in the shaper is left to its own event.

**Rate shaping** (per property, declared by the adapter): temperature deadband
0.5 C and humidity 2 points, both with at most one report per 60 s per property
(the newest value wins, sent when the minute ends); position and brightness
deadband 1 with a 1 s debounce, so an actuator in motion reports its FINAL
value; and a global cap of 4 concurrent gateway pushes
(`ConcurrencyLimiter`), queueing rather than dropping.

**DeferredResponse.** A slow directive (a blind takes tens of seconds) runs
through `runWithDeferral`: command, then a 3 s synchronous poll, then
`Alexa/DeferredResponse` with `estimatedDeferralInSeconds` 30 and an
asynchronous `Alexa/Response` through the Event Gateway (with the directive's
`correlationToken`) when the actuator reports the target, or an asynchronous
`ErrorResponse` after 120 s. A read that fails while waiting is a poll lost,
never an arrival.

**Covers (P1).** The cover KIND is the device role (`cover-blind`,
`-shutter`, `-awning`, `-curtain`, `-garage`, `-gate`, `-door`, `-window`),
filled by `mapCover` from the Home Assistant `device_class` and by the
Homematic provider (`blind` entity -> blind, `cover` entity -> shutter). No role
reads as a blind. A positionable cover is an `Alexa.RangeController` instance
`Blind.Position`, 0-100 %, the localized `Alexa.Setting.Opening` asset, unit
`Alexa.Unit.Percent`, semantics Open = 100, Close = 0, Raise / Lower = +/-10
through `AdjustRangeValue`, states Closed = 0 and Open = 1-100; one that only
opens and closes is an `Alexa.ModeController` instance `Blind.State`
(`State.Open` / `State.Closed`, assets `Alexa.Value.Open` / `Alexa.Value.Close`)
with the same semantics. A device with tilt gets a second RangeController
`Blind.Tilt` without semantics (names `Inclinazione` / `Tilt`). Display category
INTERIOR_BLIND for blind and curtain, EXTERIOR_BLIND for shutter and awning,
OTHER for a window. Garage, gate and door covers are selectable in the Export
table but withheld (info log) until the confirmation-gated phase (P5).
Positionable = the `cover-positionable` feature OR a numeric `position` in the
slice read at discovery (the Homematic children do not carry the feature).

**Validator.** `validate-instanced.ts` encodes Amazon's rules for the instanced
fields: friendly names are global assets (`Alexa.Setting.*`, `Alexa.Value.*`,
`Alexa.DeviceName.*`) or locale-tagged texts, `supportedRange` has numeric
min < max and precision > 0, `unitOfMeasure` is `Alexa.Unit.*`, properties are
exactly `rangeValue` / `mode`, `ordered` is boolean and each mode is named, and
`semantics` use documented actions and states, map an action once, and keep
every value inside the declared range or modes.

**Operator decisions (2026-10-17).** The account is Italian: assets are
localized by Amazon and free text carries Italian. Nothing is hidden by default;
the user selects in the Export table, which stays the only filter. Tilt is
exposed when the device has it. Garage and gate may open AND close by voice
(later phase). No buttons or events. Media players are in (later phase).

**Phases.** P0 (this record: registry, reconcile, shaping, DeferredResponse)
and P1 (covers) are done. Recommended order for the rest: **P2** fan and the
simple switch-likes (valve, siren as its own category) - cheap, they exercise
the registry once more; **P3 climate** (`Alexa.ThermostatController` with
`targetSetpoint`, `thermostatMode` and the temperature sensor, which also lifts
the thermostat skip); **P4** media players (`Alexa.PlaybackController`,
`Alexa.Speaker`, `Alexa.InputController`); **P5** garage, gate and door covers
with the same Range / Mode shape behind a confirmation (Alexa's own voice PIN)
and security-panel-style gating; **P6** lights beyond brightness (colour and
colour temperature controllers); **P7** whatever sensors Alexa gains an interface for (D775 still holds: no smoke, CO or leak as a motion or contact sensor). Climate goes next because 19 devices are waiting
on it and it is the only item with a user-visible regression today.

## Consequences

An Alexa feature is declared once, so the five-file drift cannot recur; the
price is that the registry order is meaningful (the first adapter with a
category decides the display category) and a property that belongs to an
instanced interface must carry its `instance` through ReportState,
ChangeReport and the reconcile - the dedupe key is `endpoint|interface|instance`.
Reports on an endpoint whose signature lacks the interface are still dropped by
the gateway (D76), which also covers a cover whose position appears only after
it was published as a Mode endpoint; a re-sync fixes the shape.
The first reconcile pass is a baseline, so an event dropped before the first
event of a boot is not healed until the property changes once. Thermostats that
also expose a temperature sensor stop being published as bare sensors; Alexa
keeps the endpoints it already holds. A cover that never reaches its target
costs a 120 s background poll and then an ErrorResponse.

## Enforcement

`generic-golden.spec.ts` (byte-identical output for the ported adapters),
`cover-adapter.spec.ts`, `report-shaping.spec.ts` (deadband, minimum interval,
coalescing, reconcile pushes only a difference, a failed read changes nothing),
`deferred-response.spec.ts`, `validate-instanced.spec.ts` and
`thermostat-skip.spec.ts`. Removing a deadband or the reconcile's difference
check turns its spec red. The runtime validator withholds any endpoint that
breaks a rule, with a warn naming the rule.
