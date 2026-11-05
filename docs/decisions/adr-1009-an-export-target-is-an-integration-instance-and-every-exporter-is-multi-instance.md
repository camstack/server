---
id: D1009
title: An export target is an integration instance, and every exporter is multi-instance
status: accepted
date: 2026-11-05
supersedes: the "an exporter keeps its configuration in addon-level settings" part of D986 for the four exporters
applies-to:
  - packages/addon-provider-homeassistant/src/ha-export/target-instances.ts
  - packages/addon-export-alexa/src/skill-runtime.ts
  - packages/addon-export-alexa/src/skill-records.ts
  - packages/addon-export-google/src/export-records.ts
  - packages/addon-export-hap/src/hap-instance-kinds.ts
  - packages/addon-admin-ui/src/components/instances/InstancesTable.tsx
---

## Context

The four exporters (Home Assistant, Alexa, Google Home, HomeKit) each stored their
configuration in a different way. The Home Assistant export kept one `ha-export-links` row per
broker, Google kept `linkedAccounts` in addon-level settings, and HomeKit kept `bridgeName`,
`fixedPin` and `interfaceName` in addon-level settings. Alexa had a `skills` record but its
actions (account link, ingress token, broker credential) lived on an addon-level settings page.
Each of the four could serve only one target per hub. An operator who wanted a second Home
Assistant, a second HomeKit bridge or a second Alexa skill had no way to add one, and the admin
UI needed a vendor-specific page per exporter.

D1007 made every device integration a typed instance record served by `integration-instances`.
The exporters are the same shape with the direction reversed: a configured target that devices
are sent TO.

## Decision

- **An export target is an `integration-instances` record** (`role: 'services'`, so it never
  appears on the Integrations page). The `device-export` cap keeps status and per-device
  exposure, keyed by the SAME instance id. Nothing new is added to `device-export.cap.ts`.
- **Every exporter is `instanceMode: 'multiple'`.**
  - Existing instances keep their id: Alexa and HomeKit use the addon id, Google uses
    `export-google`, and Home Assistant targets use minted ids (`hae_001…`).
  - New instances always get minted ids.
- **A Home Assistant target references its connection by `connectionId`** (the
  provider-homeassistant instance id). Several targets may share one Home Assistant
  connection. A missing connection means "target not configured", never "unexpose the
  devices".
- **An Alexa skill is one `SkillRuntime` per instance.** A request is routed to its skill by
  path, then by the ingress header, then to the legacy `export-alexa` instance, so the
  `/directive` and OAuth routes already linked in the Alexa console keep answering. A new skill
  enforces its ingress token by default.
- **A HomeKit bridge is one `hap-bridges` record.** Its identity (username, uuid, setup code)
  is never rewritten by a migration, so no controller is unpaired. The setup code is read-only
  in the form. Its only change is a Regenerate action, which warns that it unpairs every
  controller. `interfaceName` is a node-scope setting, and `clipRetentionDays` is a fleet
  default (`deviceDefaultsSchema`).
- **An exporter's actions live in its instance form** (`addon-action-button` fields): Alexa
  link, unlink and resync, reveal and regenerate the ingress token, and rotate the broker
  credential. No exporter declares a `globalSettingsSchema`.
- **The data moved through D987 migrations, one per owner** (homeassistant-export 6/7,
  export-google 4/5, export-hap 6/7/8, export-alexa 7/8). After them, no runtime code reads the
  old shape.

## Consequences

- The admin UI renders every exporter with the generic `InstancesTable`. There is no vendor
  page; pairing QR codes and OAuth URLs sit in the edit dialog's setup block.
- Adding a second target of any exporter is the table's Add button. Removing one tombstones
  only its own exposure and ledgers.
- State that is not configuration, such as a skill's signing key or the exported-endpoint
  signatures, lives in a per-instance state record, never in a form.
- A new exporter must provide `integration-instances` alongside `device-export`. Exposing a
  `device-export` without instances is a bug.

## Enforcement

- Not yet guarded: `scripts/check-integration-instances-declared.ts` checks only addons that
  bring devices. Extending it to every `device-export` provider is the follow-up that makes the
  last consequence a guard.
- `scripts/check-migrations-well-formed.ts` covers the migrations listed above, and their specs
  run on real SQLite (move, read-back, rerun no-op).
