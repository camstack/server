---
id: D1012
title: A broker is referenced by id and owns nothing of its users
status: accepted
superseded-in-part-by: D1013
date: 2026-11-05
supersedes: D950 (the integrationId foreign key on a broker), D1007 (the registry id as a broker key)
applies-to:
  - packages/types/src/addon/instance-link.ts
  - packages/types/src/addon/instance-in-use.ts
  - packages/types/src/migrations/broker-links-to-connections.ts
  - packages/addon-import-alexa/src/**
  - packages/addon-matter-broker/src/**
  - packages/addon-provider-homeassistant/src/**
  - scripts/check-integration-instances-declared.ts
---

## Context

An addon that is both a broker (an account or connection) and an integration (the devices it
imports) kept the link as an `integrationId` field on the broker record, plus an in-memory
`integrationId -> brokerId` map, a `linkIntegration` call and a reconcile that deleted a broker
when its integration vanished. The registry id `int_NNNN` also doubled as a broker key, so
`integrations.create` wrote an empty broker row under it. The owner of the connection held a
pointer to its users, and removing either side left the other dangling.

## Decision

A broker is referenced by id and owns nothing of its users. The broker (connection and sign-in) is
the only holder of connection settings and secrets and is edited only on the Brokers page. A
device-import integration stores a `connections` record, keyed by its registry id, holding
`brokerId` plus only its own link fields. That record is declared through the generic primitive
`declareBrokerLinkKind` (`BrokerLinkBody`), its form is built by `buildBrokerLinkInstances` (a
`broker-select` plus the link fields, with a hook for sections that depend on the chosen broker),
and `resolveBrokerId` / `brokerLinkUserFinder` answer "who uses broker X". Removing a broker that
is still referenced is refused with a `BrokerInUseError` naming the users. The role `both` is
removed: an addon with both declares the connection as a broker and the integration as `devices`.

## Consequences

The broker record no longer carries `integrationId`; it is retired and only the migration
`broker-links-to-connections` reads it (write the connection, read it back, clear the field;
stray `int_*` rows are counted and logged, never deleted). A broker rewrite that ran before that
migration would drop the link, so the migration runs before the first load. Notifier targets,
calendar sources and exporters can reuse the primitive; none is migrated yet.

## Enforcement

`scripts/check-integration-instances-declared.ts` rule 4: an addon that provides `broker`, a device
marker and `integration-instances` must declare its integration kind through `declareBrokerLinkKind`,
with no password or secret link field. Specs mark a field on the broker and watch the migration keep it.
