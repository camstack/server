---
id: D1058
title: A switch that can only power-cycle is still a switch, and a forced restart uses its native cycle
status: accepted
date: 2026-11-17
supersedes:
applies-to:
  - packages/types/src/capabilities/switch.cap.ts
  - packages/system/src/builtins/core-blocks/power-source-service.ts
  - packages/system/src/builtins/core-blocks/power-source-devices.ts
  - packages/system/src/builtins/core-blocks/hero-layout-service.ts
  - packages/addon-provider-unifi/src/devices/unifi-feature-device.ts
  - packages/types/src/device/cap-vocabulary/resolve.ts
  - packages/system/src/kernel/moleculer/switch-toggle.ts
  - packages/addon-admin-ui/src/pages/build/flow/use-dynamic-choices.ts
  - packages/addon-export-hap/src/mappers/builders/generic/cap-service-table.ts
  - packages/addon-export-alexa/src/endpoints/adapters/switch.ts
  - packages/addon-export-google/src/device-gateway.ts
---

## Context

A UniFi PoE port seen only through the Integration API (an API key, no local account)
reports whether PoE is on but cannot switch it. The one thing it can do is
`POWER_CYCLE`. A camera on such a port could not be restarted from CamStack: a
`power-source` link needs a `switch` source, and the port had none.

A `power-cycle` button per port was retired (one control per port, no reboot
controls on infrastructure ports). Adding a new cap just to carry "cycle" would
make the port unlinkable as a power source, since the link compiles against
`switch`.

## Decision

- `switch` gains two optional methods: `getOptions` and `powerCycle`.
  `getOptions` answers `{ supportsSetState, supportsPowerCycle }`. The defaults
  (`SWITCH_DEFAULT_OPTIONS`: true / false) are the old contract, so a provider that
  writes no `getOptions`, or is not redeployed yet, is a plain on/off switch.
- `powerCycle` has no action and no button. Its tier is the same as `setState`
  (protected, viewer role): it actuates the same output.
- `supportsSetState: false` means the provider's `setState` refuses, and every
  surface that offers on/off withdraws it once the device ANSWERED so — one
  predicate, `switchRefusesSetState`. A provider without `getOptions`, or a read
  that failed or is pending, changes nothing (D315):
  - the device hero draws no on/off;
  - the automation action picker: `switch.on`, `switch.off` and `switch.toggle`
    carry `offeredWhen: { method: 'getOptions', field: 'supportsSetState' }`, a
    generic action gate in the cap vocabulary (`actionOfferedWith` withdraws an
    action whose gate read answered `false`, beside the dynamic-offer rule);
  - the default `switch.toggle` refuses as `not-settable`, logged with the device;
  - the HomeKit, Alexa and Google exporters publish no on/off accessory, endpoint
    or trait for that switch (a device with nothing else is not exportable).
- `power-source.forceRestart` asks the linked switch's options first. A switch
  that declares `supportsPowerCycle` is cycled in ONE call and never switched
  off or on. Any other switch keeps off / wait `offSeconds` / on. A provider
  without `getOptions` (`NOT_IMPLEMENTED`, or a hub that predates the method)
  is a plain switch; a read that FAILED refuses the restart as
  `switch-options-unreadable` rather than switching off blind. A failed
  native cycle is refused as `switch-call-failed`, like a failed off.
- UniFi: every PoE port is a `switch` device. With a local account it switches
  PoE and declares no native cycle, so its forced restart is unchanged. With
  only an API key it declares `supportsSetState: false, supportsPowerCycle: true`.

## Consequences

- A camera on an API-key-only PoE port can be force-restarted, and the port can
  be linked as its power source.
- Any vendor whose relay or port has a native cycle (a smart PDU outlet) can
  declare it the same way, with no change to `power-source`.
- The hero model (built in core-blocks `hero-layout-service`) reads the switch's
  `getOptions` for any device bound to `switch`; a read that fails draws the plain
  on/off switch, as before.
- A composed device's `switch` answers the default options whatever its source
  is: a composed switch forwarding to a port that only reports still offers
  on/off, and that on/off fails. Not handled yet.
