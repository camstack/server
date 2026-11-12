---
id: D1013
title: One instance model — every configured thing is a record kind served by integration-instances; function caps are runtime-only
status: accepted
date: 2026-11-05
supersedes: D996 (the "not on Integrations" clause and body `enabled` as a second switch; "the instance id IS the registry id"), D1007 (the registry as a second on/off switch), D1009 (the `role 'services'` exemption from the one list), D1012 (the broker-specific `declareBrokerLinkKind` / `BrokerInUseError`, "edited only on the Brokers page"), D950 (a broker dialog and picker of its own; sign-in declared on `broker.listProviders`), D978 (superseded by D1011 for add-device; its board list stays)
applies-to:
  - packages/types/src/capabilities/integration-instances.cap.ts
  - packages/types/src/capabilities/broker.cap.ts
  - packages/types/src/addon/**
  - server/backend/src/core/addon/integration-instances-provider.ts
  - packages/addon-admin-ui/src/components/instances/**
  - packages/addon-*/src/**
---

## Context

The 2026-11-05 audit: storage is about 85% on records, the API and the UI are not. A broker has a
second CRUD on the `broker` cap because the instances provider is one per addon; a parallel
Brokers table was being built next to the instances list; five switches, ten tests and six ad-hoc
id references (`mqttBrokerId`, `smtpInstanceId`, `connectionId`, the mailbox id, the picker
targets, the calendar-id arrays on the account) had grown. D996, D1007, D1009, D1012 and D950
contradict each other on the switch, the id scheme and the sign-in surface.

Tried first: a broker-only link primitive and a second table. It reproduced the divergence one
level down.

## Decision

Every configured thing (an account, a connection, a relay, a mailbox, an export target, a
calendar, a notifier target) is an instance: one typed record of a kind the owning addon
declares, served ONLY through `integration-instances`.

1. An instance is a record kind on `integration-instances`. There is ONE provider per addon;
   `describe().kinds[]` lists every kind and each kind names its `functionCap`. No other cap
   carries add / remove / list / get / settings / `listProviders` for a configured thing.
2. Resolution is by (addon, section). A section is a function cap; a caller keeps the kinds whose
   `functionCap` is that section. An instance belongs to exactly one kind. The instance id is
   opaque and immutable. A NEW instance gets an opaque id; an id that already exists is KEPT as it
   is (an adopted device provider keeps its registry id, a provider that mints its own id from the
   addon id keeps that), because devices and links carry it. Nothing renames a live id.
3. One switch: `setInstanceEnabled`. The registry `enabled` is a projection of it; there is no
   body field, target flag or calendar flag.
4. One test: `testInstance`, with `canTest` per kind.
5. One link primitive: `linkField({ cap, kind? })` in a kind declared with `declareLinkKind`,
   drawn by `instance-select`, REQUIRED id. The owner of the target refuses `deleteInstance` while
   it is linked (`InstanceInUseError` naming the users). The link lives on the CONSUMER.
6. One list: `InstancesTable` plus `InstanceEditorDialog`, with slots per kind. Sign-in and
   connect come from `describe().kinds[].signIn` / `connectPath`.
7. Function caps are runtime-only: `broker` (publish, subscribe, unsubscribe, getState,
   getBrokerConfig, getStatus), `notification-output` (send), `smtp-provider`, `llm` and `storage`
   carry no CRUD.

## Consequences

The `broker` cap loses eleven methods and `BrokerInfo`; callers list the instances of the owning
addon instead. A dual addon (a broker and the integrations that use it) composes two record kinds
into one provider with `composeInstanceKinds`. The ad-hoc ids are migrated by their CONSUMER, under
D987. A cap change force-publishes `@camstack/system`, and the removal commits atomically with
the UI that used it. Until steps 3 to 8 of the epic land, the superseded clauses stay in force for
the families not yet moved.

What an operator can do now: add, edit, test, switch off and delete every broker kind from the
Connectivity page (Alexa, Matter, Home Assistant, Google, MQTT, the inbound mailboxes), test an
MQTT broker or a mailbox port before saving it, create an ONBOARD MQTT broker (a CamStack `aedes`
server on this hub, with an auto-allocated or typed port and optional anonymous access) and delete
it to stop its server. Removing a broker something still uses is refused, naming the users; a
registry that cannot be read refuses too, and so does an MQTT Discovery addon that is installed but
not answering yet (booting or switched off: not-yet-known, D315). Only an addon the registry and the
roster both answer is not installed means no users. The old single embedded MQTT broker (flat
`embedded*` settings) is migrated to an onboard broker record under the same id, so it is listed,
tested, switched off and deleted like every other broker. An MQTT broker reports connected,
auth-failed, unreachable or TLS error from its probe, and an unreachable one is not offered.
Pickers offer only brokers that can carry traffic (on, configured, not failing) and keep an
already chosen one visible with its state. What no longer exists is the `broker.list`, `add`,
`remove`, `test*`, `getSettingsSchema` and `signIn` calls themselves: a script that used them
reads and writes `integration-instances` instead, pinned to the owning addon.

## Enforcement

`scripts/check-broker-cap-is-bus-only.ts` (the broker cap is exactly the bus; no `BrokerInfo`; no
`listProviders` or out-of-kind `signIn`) and `scripts/check-instances-kinds-declared.ts` (every
kind names a declared function cap) cover step 1. Planned with the later steps:
`check-instance-refs-use-link-primitive` (step 2, with a consumer-keyed shrink-only baseline),
then `check-one-row-switch`, `check-one-test-method`, `check-no-settings-fallback-for-kinds`,
`check-collection-crud-is-instances`, `check-one-instances-list` and
`check-no-addon-level-settings`. Already in force: `check-collection-cap-pin` and
`check-integration-instances-declared`.

**Kinds are required (H1).** `describe().kinds` is never empty and every instance carries its `kind`
(one of `kinds[].id`); a provider with one kind has the kind stamped for it. The type says so, and
`scripts/check-instances-kinds-declared.ts` refuses a provider that declares none.

**Migration notes (review 3).** A legacy embedded broker that was STOPPED but had been configured is migrated as a switched-off onboard record (`enabled: false`, same id, port and password through the keychain), then its flat keys are dropped; nothing is lost silently. The Home Assistant `broker-links-to-connections` step is `tolerate`: a link that does not read back stays on the broker, uncleared, and the engine logs the failure, so one unreadable link never blocks every HA integration.

**A user's own rows (planning#440 blocker 1).** A per-user notification target is an `integration-instances` record of the `notifiers` addon, owned through `config.ownerUserId`. The cap methods that read or write rows are `caller: 'scoped'`: open to any session, with the server-derived caller (the same stamp as `caller: 'required'`, the client value is discarded) handed to the provider. The door is default-deny: an admin passes as before; a non-admin passes only on a call pinned to one addon (`addonId`, never the fan-out union) whose `describe()` says `userScoped: true` (`admitsUserCaller`, asked of the provider, so it also holds for a forked addon). The provider then filters list, get, update, switch, delete and test to the caller's own rows, stamps the owner on create, and refuses a draft test for a non-admin. An admin keeps the operator-wide view. The admin UI reaches targets only through this door. The five `nc.*MyTarget*` delegates were removed on 2026-11-12: viewer 1.0.698 writes a user's own targets through `integrationInstances` (addonId `notifiers`), and nothing in this repo calls the delegates. `nc.listTargetKinds` (the add form's catalogue) stays. Records keep their ids: no migration was needed, they were already per-kind instance records.

**`integrations.delete` is kept as the hub-owned fallback.** The delete door is `integration-instances.deleteInstance`. When the addon is installed but not running there is no provider to route to, so the admin-ui (`IntegrationDetail.tsx`) calls `deleteInstance` when `processState === 'running'` and otherwise `integrations.delete`, which does a hub-side delete plus cascade while the addon is down.

**The Google accounts are one store (planning#480).** The last split of the census (I8): the OAuth session no longer lives in the addon's `oauthAccounts` durable state beside the `brokers` records. The refresh token (a secret field, keychain-backed), the email, the scopes and `needsReauth` are fields of the account's record; the access token is memory only. The OAuth callback writes the record, sign-out patches the token away, and calendar, Gmail and the refresh read the record. The move is the D987 sequence `google-services/2026-11-10-oauth-accounts-to-records` (procedure: each entry joins or becomes its record, read back; a failed entry is logged by id and reason and blocks only the drop) then `google-services/2026-11-10-release-oauth-accounts-secrets` (procedure: a second read, the state's keychain values released) and `google-services/2026-11-10-drop-oauth-accounts-state` (a pure plan: the emptied key deleted); nothing reads the old state afterwards. `check-no-settings-fallback-for-kinds` gained the rule `credential-state`: a package that registers a record kind does not keep a credential in `this.state(...)` outside a migration. google-services stays on the D1014 pending list (`defineAddonMigrations`).
