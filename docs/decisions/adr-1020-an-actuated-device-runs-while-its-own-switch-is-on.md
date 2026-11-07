---
id: D1020
title: An actuated device runs while its own switch is on; the default is derived, never written
status: accepted
date: 2026-11-07
supersedes:
applies-to:
  - packages/types/src/composition/actuator-running.ts
  - packages/types/src/composition/validate-composition.ts
  - packages/types/src/capabilities/timed-run.cap.ts
  - packages/system/src/builtins/composer/composer-plan.ts
  - packages/system/src/builtins/core-blocks/timed-run/**
  - packages/addon-admin-ui/src/components/device/customize/scalar/follow-switch.ts
---

## Context

D933 gave a device one running source: native, or one assigned field. A heater
composed on a plug had to be given that field by hand, and the usual choice was
a power threshold with a dwell (`power >= 50 W for 30 s`). A stove that cycles
its element reads as "stopped" for the dwell every time the plug draws less, and
the operator's own words were simpler: "switch on means the device is on".

Two different switches hide behind the word. The device's own switch is the
ACTUATOR: it turns the function on. A switch that only feeds power
(`power-source.switchOn`, an appliance on a plug) is the SUPPLY: a washer keeps
its supply on while it idles, so there the power reading is the only honest source.
A device-type table would have decided between them, and would have rotted with
every new type.

## Decision

A NEW composed device of a type that offers "running" (`RUNNING_CUSTOMIZE_DEVICE_TYPES`)
that has an actuator switch (its composed `switch.on` is one plain `from` of a
switch) and no supply relation counts as running while that switch is on:
`on` is true, `off` is false, unknown is `null` (D393), and `since` is the
switch's last change. This is derived from STRUCTURE by `actuatorSwitchDrivesRunning`
and applied at plan time by `withDefaultRunning`. It is never written into the
stored composition (D356): stored compositions are not rewritten, and a device
that already carries an authored running rule (the 5391 and 5392 stoves keep their
power dwell) keeps it until the operator moves the toggle.

The operator controls it in the Customize running row with one toggle, "Follow the
device's switch". ON stores nothing (the default applies, and a stored rule goes after
a confirmation). OFF stores an explicit opt-out: a disabled `running-state` feature
with no field. Picking another source replaces the opt-out. A disabled feature with
no field owes no required field in `planComposition`; any other disabled feature is
still checked.

Precedence is native running (not overridden), then an authored Customize field, then
the structural default, then `null`.

The quick-run duration of a timed-run device (D1010 area) is the same kind of fact:
per device, not a constant. It lives in the core-blocks device store, is edited through
the derived form of the timed-run `deviceConfig` (`getOptions`, `setSettings`), is bounded
by the type's maximum (refused, never clamped), and is published in the timed-run status
as `quickRun: { duration, unit }`, so the admin heater row, the timed-run control and the
viewer read the same value.

## Consequences

An existing native device (not a composed `new` one) is never given the default: it would
change behaviour silently. The toggle is offered only where the default applies. A viewer
shows its quick-run button from `quickRun` and hides it until the status carries one.

## Enforcement

`packages/types/src/composition/__tests__/actuator-running.spec.ts` (structure rules, opt-out,
authored wins), `packages/system/src/builtins/composer/__tests__/composer-actuator-running.spec.ts`
(the plan), `timed-run-service.spec.ts` (quickRun in status, over-max refused) and the admin-ui
`follow-switch` specs. Review only for the claim that a supply switch is never a running source.
