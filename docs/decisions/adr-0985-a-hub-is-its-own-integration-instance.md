---
id: D985
title: A hub is its own integration instance
status: accepted
date: 2026-10-31
supersedes:
applies-to:
  - packages/types/src/capabilities/integrations.cap.ts
  - packages/types/src/interfaces/integration-registry.ts
  - packages/system/src/builtins/device-manager/discovery-orchestrator.ts
  - packages/system/src/builtins/sqlite-storage/integration-registry.ts
  - server/backend/src/api/core/cap-providers.ts
  - packages/addon-admin-ui/src/components/integrations/integration-setup-seed.ts
---

## Context

A provider with a physical hub (a Reolink NVR or Home Hub, a UniFi console, a Bosch SHC, an Ecowitt gateway)
modelled the hub as a `DeviceType.Hub` device with its channels or sensors as children. The addon was
`instanceMode: unique`, so the hub device was the only place a second box could live, and everything the
hub owned (the socket, the reconnect backoff, the child sleep reconcile, the channel map) hung off a device
instead of off a connection. Velux and Enpal already did the opposite: one integration per box, the connection
and the keychain secret on the integration, devices stamped with `initialMeta.integrationId`.

Two framework gaps showed up while looking at the migration. `instanceMode: unique` was enforced only by the
picker, and was refused by the backend with an untyped `Error`. And a `setupIntegration` candidate (D977)
lost its `stableId` on the way into the new integration, so nothing remembered that the box had been set up and
a re-scan offered it again.

## Decision

Every physical hub is a standalone integration instance of its provider, named after the hub; there is no
Hub device for it. The provider's default (unconfigured) integration discovers hubs through the LAN engine
(D977) and offers each as a `setupIntegration` candidate whose connection is prefilled; picking one creates a
NEW integration. A hub integration's own discovery is scoped to that hub through `device-adoption`
(`integrationId`), and the channels it adopts are top-level devices stamped with that integration.

The integration remembers the candidate it was born from: `integrations.create` takes `originStableId`
(a typed field on the instance, not a key of `info`), and the central discovery path
(`discoverProviders`, one place) hides every candidate whose `stableId` already is an integration's origin.
A failed read of the integrations hides nothing. `instanceMode: unique` is refused by the backend on create
with a typed `CONFLICT`.

A provider migrates at boot, idempotently: each existing Hub device becomes an integration named after it
with its config (secrets moved through the keychain), its children keep their device ids and are re-stamped
with the integration id and un-parented, and the Hub device is retired by tombstone (D865).

## Consequences

Providers with a hub become `instanceMode: multiple`. A hub's reconnect and sleep reconcile belong to a
per-integration manager, not to a device, so a camera asks the manager (by integration id) for its API.
`Container` stays a Container. Velux keeps its Gateway device (D976); this decision is about providers whose
hub was a parent, and is applied per provider.

Rejected: a Hub device with children (the connection has no device identity, and the parent-child model leaks
into every consumer that walks children); one integration holding several hubs (a failing box then lives
inside another box's integration; ESPHome keeps exactly that by explicit exception, D978); a rename of
Container to Hub.

## Enforcement

`discovery-orchestrator.spec.ts` (an owned origin is hidden for engine and legacy providers, an unreadable
list hides nothing), `integration-registry*.spec.ts` (the typed field round-trips on both stores),
`integrations-create-instance-mode.spec.ts` (typed refusal, several instances of a `multiple` addon) and
`integration-setup-seed.spec.ts` (the seed carries the origin). The per-provider migrations carry their own
specs that mark a child field and assert it survived.
