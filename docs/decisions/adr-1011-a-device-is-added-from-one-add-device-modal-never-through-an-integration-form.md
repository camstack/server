---
id: D1011
title: A device is added from one Add device modal, never through an integration's settings form
status: accepted
date: 2026-11-05
supersedes:
applies-to:
  - packages/addon-admin-ui/src/components/integrations/AddDeviceModal.tsx
  - packages/addon-admin-ui/src/components/integrations/NetworkCandidatesPanel.tsx
  - packages/addon-admin-ui/src/components/integrations/network-candidates.ts
  - packages/addon-provider-esphome/src/config.ts
  - scripts/check-no-devices-in-integration-form.ts
---

## Context

The integration page had three separate ways to add a device: the Adopt devices
modal (D886), the per-integration Scan network modal (D977) and the manual form,
and the passive-discovery proposals (D994) lived on yet another banner. ESPHome
added a fourth: its integration settings form carried an editable `boards` list
and an `importKeys` action, so a board was "added" by editing settings.

That form wrote through the integration record with no integration id on the
call. With more than one ESPHome integration `targetIntegration(undefined)`
throws, and a board found by mDNS could not be offered at all: the only way in
was typing its host into the list. An encrypted board's key was asked for every
board, with no word on where to find it.

## Decision

An integration page has ONE Add device button and ONE modal. Its tabs are
"Found on the network" (the adoption provider's candidates, a scan scoped to the
integration and the passive proposals, deduped to one row per device) and
"Enter parameters" (the provider's manual creation form), the second one drawn
only when the provider declares a creation type and a form. A candidate that
needs parameters (`needsParams` on the discovery candidate) opens the
provider's creation form prefilled before it is adopted. No new capability: the
modal composes `device-adoption`, `device-provider` and the discovery proposals,
and the hub passes `integrationId` through `createDevice` and
`adoptDiscoveredDevice` to the provider.

A device is never added through an integration's settings form. The form of an
integration holds connection settings; `buildIntegrationFormSchema` /
`instanceFormSchema` contain no `editable-array` of devices and no `import…`
action. Board records are written only by the adopt and manual flows.

## Consequences

The generic cross-integration network scan stays under Integrations. Existing
saved boards need no migration: the record shape and its keychain secrets are
unchanged, only the form stopped exposing them. `@camstack/types` and
`@camstack/server-framework` change (an additive optional field and parameter),
so the system closure needs a force-publish. A `device-adoption` integration
still lists its candidates through the adopt job surface (children, granularity
filters); only the device-provider path uses the merged list.

## Enforcement

`scripts/check-no-devices-in-integration-form.ts` (empty baseline, wired in
`checks.yml`) refuses an `editable-array` or an `import…` action inside an
integration form builder. The modal composition is pinned by
`add-device-modal.spec.tsx` and `network-candidates.spec.ts`.
