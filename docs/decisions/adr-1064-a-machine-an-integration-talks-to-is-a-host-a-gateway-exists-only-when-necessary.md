---
id: D1064
title: A machine an integration talks to is a Host; a Gateway exists only when necessary
status: accepted
date: 2026-11-18
supersedes:
applies-to:
  - packages/addon-provider-unraid/src/unraid-discovery.ts
  - packages/addon-provider-unraid/src/unraid-legacy-gateway.ts
  - packages/addon-provider-unifi/src/unifi-discovery.ts
  - packages/addon-provider-unifi/src/unifi-legacy-gateway.ts
  - packages/addon-provider-unifi/src/devices/unifi-infra-device.ts
  - packages/types/src/capabilities/reboot.cap.ts
---

## Context

When the hub device was removed (D985, the #259 pattern), UniFi and Unraid kept a
`DeviceType.Gateway` per integration standing for the controller or the server. The same
machine was then offered twice: once as that Gateway (the admin link, the online state) and
once as the workload Host that D1056 made it (CPU, RAM, temperature, disk). An Unraid server
was a Gateway beside itself; a UniFi console was a Gateway beside its own infra device. The
Gateway carried no capability the Host could not carry, and the operator saw two devices for
one box.

## Decision

A machine an integration talks to is a Host: one `DeviceType.Workload` device with role
`host`, carrying its workload data, its admin link and its identifiers, plus `reboot` when the
machine can restart. A Gateway exists only when necessary: a physical box that bridges a radio
or serial protocol (D976), or an account-only integration whose account has no machine to stand
for (VeSync, Wyze). Unraid adopts one Host per server (WebGUI link, identifiers, array capacity
as its disk, no reboot). UniFi adopts each console as a Host that also serves `reboot` through
`restartDevice`; switches and APs stay as they were. A LAN scan proposes the machine as a
`Workload` candidate marked `setupIntegration`. This amends D1056 (the Host is the integration's
own machine) and D985 for UniFi and Unraid.

## Consequences

The Gateway device classes, the Gateway discovery candidates and `adoptGateway` are removed from
both addons. Everything the Gateway did lands elsewhere: the admin link and the identifiers on
the Host, the connection state on the Host's online state and on the integration page, the
removal cascade unchanged (it is generic over the integration's top-level devices). A Gateway
row an older version persisted is retired on restore through the kernel's device removal, which
writes the tombstone (D865) — never by its absence from a list. The `reboot` capability now
lists `Workload` in its `deviceTypes`, so a Host binds it only when its provider serves it; that
is a capability change and ships with the server. A UniFi controller with no console in its
infra list (a self-hosted Network application) has no Host; its admin link stays on every infra
device. The Unraid client reads no uptime and no RAM, so those stay unknown (D393).

## Enforcement

Specs only: `unraid-host-not-gateway.spec.ts` and `unifi-host-not-gateway.spec.ts` (no Gateway
candidate, no Gateway class, the LAN candidate is a Workload, legacy rows retired through the
removal path), the console reboot spec in the UniFi `integration-gateway.spec.ts`, and
`reboot.cap.spec.ts` in `@camstack/types`. Nothing stops a new provider from adding a Gateway
for a machine it talks to; review only.
