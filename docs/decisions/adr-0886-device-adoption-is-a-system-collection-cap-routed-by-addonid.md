---
id: D886
title: device-adoption is a system collection cap routed by addonId
status: accepted
date: 2026-10-20
supersedes:
applies-to:
  - packages/types/src/capabilities/device-adoption.cap.ts
  - server/backend/src/api/trpc/cap-router-runtime.ts
  - packages/system/src/kernel/cap-router-builder.ts
---

## Context

Several integration addons each register a `device-adoption` provider (Home
Assistant, Dreame, Tuya, …). The cap was declared `mode: 'singleton'`, so
direct `deviceAdoption.*` tRPC calls resolved only the active/first provider.
Parallel adoption collided silently. The admin UI already routed through
`deviceManager.adoption*` with an explicit `addonId`; the gap was callers that
hit `deviceAdoption.*` directly.

## Decision

`device-adoption` is `scope: 'system', mode: 'collection'`. Route by explicit
top-level `{ addonId }` like `connection-test` and `broker`. When `addonId` is
omitted, the hub resolves the owning addon from `integrationId` (integrations
store) or from `camDeviceId` for `resync` (device registry) — never from the
first registered provider. Missing resolution is `BAD_REQUEST`, not another
provider's answer.

## Consequences

Every integration addon may register its provider in parallel. Callers that omit
both `addonId` and a resolvable `integrationId` / `camDeviceId` are refused.
`deviceManager.adoption*` is unchanged.

## Enforcement

`server/backend/src/__tests__/cap-routers/device-adoption-collection-routing.router.spec.ts`;
runtime `inferCollectionAddonPin` in `cap-router-runtime.ts`.
