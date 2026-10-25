---
id: D874
title: A thermostat or air conditioner is an Alexa ThermostatController with the bounds the device reports
status: accepted
date: 2026-10-17
supersedes:
applies-to:
  - packages/addon-export-alexa/src/endpoints/adapters/climate.ts
  - packages/addon-export-alexa/src/endpoints/adapters/climate-model.ts
  - packages/addon-export-alexa/src/endpoints/validate-thermostat.ts
  - packages/addon-export-alexa/src/handlers/climate-controller.ts
  - packages/types/src/capabilities/climate-control.cap.ts
---

## Context

P3 of the Alexa adapter registry (D869). 19 Home Assistant thermostats
(`thermostat`) and 5 Gree air conditioners (`climate`) carry the
`climate-control` cap. Until now a thermostat was withheld with an info log and a
Gree AC could not even be selected in the Export table (`DeviceType.Climate` was
in neither the picker's kinds nor the generic device types). Two things made the
mapping more than a table row:

- The `climate-control` slice carried no setpoint bounds. The cap's own comment
  said min / max / step "are surfaced via `getOptions`", but the cap has no such
  method, so nothing could clamp a voice request.
- Two caps now answer the same directive key: `PowerController/TurnOn` on a
  switch AND on a thermostat, `ModeController/SetMode` on a cover AND on a
  thermostat's fan. The registry looked a directive up by key only, so a
  thermostat's TurnOn would have gone to `switch.setState` on a device with no
  switch.

## Decision

**Shape.** `climate-control` becomes `Alexa.ThermostatController` 3.1:
`targetSetpoint` (any device with a single-setpoint mode), `lowerSetpoint` +
`upperSetpoint` (a device with `heat_cool`), `thermostatMode` over HEAT, COOL,
AUTO (`auto`, else `heat_cool`), ECO (the device's `eco` preset) and OFF - only
the modes the slice's `availableModes` lists. With it: `Alexa.TemperatureSensor`
for `currentTemp`, `Alexa.PowerController` when the device can be turned off,
and two ModeControllers: `Climate.FanSpeed` (the device's own fan modes; `low`,
`medium`, `high` use the `Alexa.Value.*` assets, the rest Italian + English
text) and `Climate.Mode` (heat, cool, auto, dry, fan only, off - published only
when the device has `dry` or `fan_only`). Display category THERMOSTAT for
`thermostat`, AIR_CONDITIONER for `climate`. Discovery reads the climate slice;
an unreadable one falls back to HEAT / COOL / AUTO / OFF and the device's
`climate-dual-setpoint` feature.

**`dry` and `fan_only` are a ModeController, not `CUSTOM`.** Amazon's
`thermostatMode` has no value for them and a `CUSTOM` + `customName` mode is not
a documented way to carry device-specific operating modes, which we cannot
confirm without contacting Amazon. The ModeController is documented and
certifiable. While the device is in one of those modes `thermostatMode` is not
reported (a property that has no honest value is omitted, never guessed).

**Bounds travel in the slice.** `ClimateControlStatus` gains optional nullable
`minTemp`, `maxTemp`, `tempStep` (Celsius). Home Assistant fills them from
`min_temp`, `max_temp`, `target_temp_step`; a Gree AC from the protocol's
16-30 C in whole degrees. Absent means unknown and the handler falls back to
7-35 C / 0.5 (Home Assistant's own defaults) - never to "no limit".

**Directives** (one `handleClimateDirective`, synchronous - a thermostat command
is quick, so no DeferredResponse): `SetTargetTemperature` -> `setTarget` or
`setTargetRange` (with `heat_cool` first when it was not the mode),
`AdjustTargetTemperature` -> read + delta (a Fahrenheit delta is scaled, not
offset; a range shifts both ends), `SetThermostatMode` -> `setMode` / the eco
preset (leaving ECO clears the preset), `TurnOn` / `TurnOff` -> `setMode`
(TurnOn picks auto, heat_cool, cool, heat; TurnOn on a device already on changes
nothing), `Climate.Mode` / `Climate.FanSpeed` `SetMode` -> `setMode` /
`setFanMode`. A setpoint outside the bounds is
`TEMPERATURE_VALUE_OUT_OF_RANGE` with `validRange`; a value is snapped to the
step; other refusals use Amazon's own types (`UNSUPPORTED_THERMOSTAT_MODE`,
`DUAL_SETPOINTS_UNSUPPORTED`, `TRIPLE_SETPOINTS_UNSUPPORTED`,
`REQUESTED_SETPOINTS_TOO_CLOSE` with `minimumTemperatureDelta`,
`UNWILLING_TO_SET_VALUE` for a single setpoint while in range mode). A slice that
cannot be read is `ENDPOINT_UNREACHABLE`, never a guessed command. The Response
carries the state the command set, projected from the slice read before it.

**One key, several caps.** An `AdapterDirective` may declare `claims(ctx)`; the
router resolves a key through `resolveGenericDirective` - the first adapter, in
registry order, that claims the endpoint. The climate adapter sits before the
temperature and switch adapters, claims `PowerController` by the device's bound
caps (`climate-control` and no `switch`) and `ModeController/SetMode` by
instance; the cover claims `Blind.*`. A key nobody claims is `INVALID_DIRECTIVE`.

**Reports.** The current temperature is shaped like any temperature sensor
(0.5 C deadband, one report per 60 s); setpoints, mode, power and fan report on
every change (the reporter still dedupes against the last reported value).

**Validator.** `validate-thermostat.ts`: version 3.1, properties within the four
Amazon names, `thermostatMode` always declared, lower / upper together, at least
one setpoint, `supportedModes` non-empty, unique, within AUTO / COOL / HEAT /
ECO / OFF, `supportsScheduling` boolean. `THERMOSTAT` and `AIR_CONDITIONER` join
the display categories.

## Consequences

The 19 thermostats and 5 ACs become selectable and publishable; nothing is
published until the operator selects them (D869). A thermostat that also has a
`temperature-sensor` cap is one THERMOSTAT endpoint with one TemperatureSensor
(the climate adapter's declaration wins; both sources feed the same property).
Alexa keeps any bare-sensor endpoint it already holds for such a device until it
is removed. A device whose slice could not be read at discovery is published
without the fan / mode controllers; a re-sync after the slice is readable
changes the signature and adds them. The slice schema grew three optional
fields: a climate provider that omits them is still valid and simply gets the
default bounds. Scheduling (`ResumeSchedule`) and humidity are not exposed.

## Enforcement

`climate-adapter.spec.ts`: golden discovery JSON for a heat-only HA thermostat,
a heat/cool range thermostat and a Gree AC (each also run through the
validator), the slice -> property mapping, every directive -> cap action, the
out-of-range / dual / too-close / unsupported-mode / unreadable-state errors,
the shaped ChangeReports, and the directive resolution between caps. Removing
the bounds check, the PowerController claim or the temperature deadband turns
its spec red. `ha-climate-slice.spec.ts` pins the bounds the HA provider
publishes.
