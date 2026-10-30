---
id: D981
title: A notification target picks a broker and fetches its own options inside its form; there is no mass discovery
status: accepted
date: 2026-10-30
supersedes: D950 (the "broker picker inside the schema-driven config UI" rejection)
applies-to:
  - packages/types/src/interfaces/config-ui.ts
  - packages/ui-library/src/composites/config-broker-select-field.tsx
  - packages/ui-library/src/composites/config-discovered-select-field.tsx
  - packages/ui-library/src/contexts/broker-picker-slot.tsx
  - packages/addon-admin-ui/src/pages/system/NotificationTargets.tsx
  - packages/addon-provider-homeassistant/src/ha-notification-output.ts
  - packages/addon-import-alexa/src/speak/provider.ts
  - packages/addon-notifiers/src/adapters/**
---

## Context

D950 rejected a `broker-select` field and left the Alexa target with an
addon-fed select. The Targets page then grew a "Find devices" dialog that asked
every kind that declares `supportsDiscovery` for candidates at once. It did not
work out: a kind without a broker (Telegram, WhatsApp, Gotify, Zentik) has
nothing to search until its credentials are typed, so the mass call failed or
returned nothing for most kinds (a WhatsApp call even failed on a missing
`idInstance`), and the dialog's candidates were easy to add by mistake.

## Decision

Setting up a target works like adding an integration. A broker kind
(Home Assistant, Alexa) declares a `broker-select` field (`brokerKind`): the
form shows the existing brokers of that kind plus "Create new...". The target's
options are a `select` field with `discoverOptions: { kind, dependsOn }`: the
form calls `notificationOutput.discoverTargets` only once every `dependsOn`
field has a value, and shows a hint before that. Credential kinds depend on
their credential fields. Free text stays as a fallback with distinct loading,
empty and error lines; nothing is pre-selected. The stored value is the real
id; labels are friendly. Mass discovery (the dialog, its entry point and its
candidate comparison) is removed. The shared form names no kind.

## Consequences

A password field cannot be a discovered select (adapters redact secrets by
schema type), so Gotify keeps its text field. In an edit with a redacted secret
the fetch may fail and the form falls back to free text. Adding a kind with a
list to pick from is a schema declaration, not UI code.

## Enforcement

Specs: `config-form-discovered-fields.test.tsx` (no fetch until `dependsOn` is
filled, then the list; broker picker rendered), `ha-friendly-names.spec.ts`,
`ha-target-schema.spec.ts`, `discover-options-schema.spec.ts`,
`discover-without-credentials.spec.ts`, `NotificationTargets.spec.tsx` (no
"Find devices").
