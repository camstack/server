---
id: DNNN
title: A timed run is on by default only for stoves and fountains
status: accepted
date: 2026-11-09
supersedes:
applies-to:
  - packages/types/src/capabilities/timed-run.cap.ts
  - packages/types/src/capabilities/capability-definition.ts
  - packages/system/src/builtins/device-manager/device-bindings-store.ts
---

## Context

A timed run (D993) turns a device on and switches it off at a deadline. It
shipped for heaters and pet fountains, the two types that are left running on
purpose. The device row now shows that run (Run while idle, Stop and the time
left while armed), and the same control is useful on any device that already
has a `switch` cap: a light, a fan, a siren, a plain switch.

Turning the wrapper on for every switch by default would put a Run button on
devices the operator never asked to time, and the hub would publish a timed-run
slice for each of them. The first attempt — one `defaultActive: true` for the
whole cap — cannot say "bindable everywhere, on by itself only here".

## Decision

`defaultActiveTypes` on a wrapper capability is the list of device types that
wrapper auto-binds for when `defaultActive` is true. It lives only in the
`*.cap.ts` (D4). Omit it and every type in `deviceTypes` stays active by
default.

`timed-run` declares `deviceTypes` as every `switch` device type plus
`PetFountain`, so Customize can turn it on for any of them, and
`defaultActiveTypes` as `Heater` and `PetFountain` only. A device whose wrapper
is off has no binding, so the row draws no control. The per-device switch is
the existing wrapper activation (`setWrapperActive`); nothing new is stored
(D62). A generic switch uses the heater's bound: actuator `switch`, minutes,
180 at most, a 30 minute one-tap run.

## Consequences

A new wrapper that should be opt-in for some of its types and on for others
names those types in `defaultActiveTypes`. A type listed in `deviceTypes` but
not there can still be activated per device. The boot publish of timed-run
follows the bindings, so a switch that has not opted in is not published.

## Enforcement

`defaultWrapperAppliesToType` is the only reader of `defaultActiveTypes`.
`bindings-store.spec.ts` asserts a heater and a fountain bind on their own and
a switch does not until `setWrapperActive`. `timed-run-service.spec.ts` refuses
a generic switch above 180 minutes.
