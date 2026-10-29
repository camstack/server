---
id: D964
title: A remote is a Customize extension over a generic template collection, binds roles to Actions, and takes precedence at dispatch
status: accepted
date: 2026-10-28
supersedes:
applies-to:
  - packages/types/src/capabilities/template.cap.ts
  - packages/types/src/capabilities/remote.cap.ts
  - packages/types/src/remote/**
  - packages/types/src/interfaces/device-call-redirect.ts
  - packages/system/src/builtins/core-blocks/remote-*.ts
  - packages/system/src/builtins/core-blocks/templates-service.ts
  - packages/system/src/kernel/device-call-redirect.ts
  - packages/system/src/kernel/transport/device-call-redirect.ts
---

## Context

An infrared appliance modelled as its own device with a code map would make a
television a different thing from the media player the rest of the product
already knows, and an exporter or an automation would have to know which kind it
was talking to (D963).

## Decision

1. **Templates are a generic collection.** `template` (system, collection)
   stores `{ id, kind, name, payload }`; a kind registers only a payload schema.
   The one kind today is `remote` (a button grid whose buttons are named roles,
   vocabulary exported from `@camstack/types`). `delete` refuses with a typed
   `in-use` result naming the devices that still use the template.
2. **A remote is a Customize extension (D944) offered on media-player devices.**
   Its config lives in the device settings store (D865):
   `{ layoutTemplateId, bindings: { [role]: { action } }, customButtons, power }`.
   A binding action is the Actions-step shape (`AutomationCapStepSchema`); an IR
   binding is `ir-transmitter.send` on a transmitter device with the pulse train.
   The config also names a default transmitter; a binding carries its own device,
   so one command may use another. The
   SmartIR parser is the one in `@camstack/types/ir`; the admin UI parses and
   saves the bindings, the server never receives a code file. A repeat count is never stored: `sendCommand`
   takes `repeat` (int >= 1, default 1) per call.
3. **Precedence is at dispatch.** A media-player command (`play`, `pause`,
   `stop`, `next`, `previous`, `setMute`, `selectSource`) on a device with the
   remote extension runs the binding when its role is bound, else the native
   cap. The decision lives in a device-call redirect installed in the
   capability registry (Proxy over every registry resolution) and consulted by
   the three by-name transport entries, so it holds for every caller. A bound
   command that fails fails the call; the native cap never silently replaces it.
4. **State is reported from the running source when one exists, else assumed.**
   The `running-state` cap is read first, then a native media-player reading;
   `getStatus` is redirected only when no native media-player provider exists
   for the device. The assumed state (power, and mute when the device does not
   report it) moves after a `sent` result and is persisted per device; a toggle
   power code is sent only when the current state differs from the requested one.

## Consequences

The registry gains one hook beside the claimed-status overlay. A new
name-resolving entry that skips the hook would bypass precedence for its
callers; the guard names it.

## Enforcement

`scripts/check-claimed-get-status.ts` (second rule: every name-resolving entry
asks the device-call redirect), the specs beside each entry, and
`remote-service.spec.ts` for the toggle and repeat rules.
