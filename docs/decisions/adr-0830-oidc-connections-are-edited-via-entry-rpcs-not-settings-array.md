---
id: D830
title: OIDC connections are edited via entry RPCs, not a settings array
status: accepted
date: 2026-10-12
applies-to:
  - packages/types/src/capabilities/oidc-connections.cap.ts
  - packages/addon-auth/src/oidc/**
  - packages/addon-admin-ui/src/pages/system/OidcSettingsConnections.tsx
  - packages/addon-admin-ui/src/pages/system/Authentication.tsx
---

## Context

Identity → Authentication → OpenID Connect Settings used an `editable-array`
of IdPs in `globalSettingsSchema`. That is the same second-authority trap as
Training Providers before D828: Add/Delete/Edit spliced the settings blob
instead of a typed entry lifecycle, and the FormBuilder array UI does not match
the DataTable + single-item dialog pattern used elsewhere.

Rejected:

- **A separate Connections IntegrationHub panel** (`?section=connections`).
  The operator already looks under Settings; a second section duplicates
  navigation without clarifying ownership.
- **Keep the array and restyle editable-array as a table.** The form still
  owns create/delete via settings patch; secrets and runtime rebuild stay
  coupled to a generic field type.

## Decision

**OIDC IdPs are `oidc-connections` entries.** Settings (same section) renders a
DataTable + `ItemFormDialog`; Save on create runs `createConnection` then
`updateConnection`; edit runs `updateConnection`; Delete on the table runs
`deleteConnection`. `globalSettingsSchema` has no `providers` editable-array.
The operator-chosen `id` slug stays the URL id and is immutable after create.
`clientSecret` stays on `secretStatePaths` (`providers[id].clientSecret`).

## Consequences

- A new connection field is declared on the connection form schema and mapped
  through `updateConnection`, not an Addons settings array field.
- `rebuildInstances` runs on `onConfigChanged` and after every entry mutate so
  login buttons update without a runner restart.
- Requires a server publish (new cap routers) plus deploy of `addon-auth` and
  `addon-admin-ui`.

## Enforcement

`oidc-connections.spec.ts` (no editable-array in schema; CRUD helpers),
`oidc-settings-connections.spec.tsx` (table + dialog; create then update),
`integration-hub.spec.tsx` (`settingsContent` replaces NodeAddonsSettingsPanel).
