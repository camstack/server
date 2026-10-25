---
id: D828
title: Training provider entries are edited via updateEntry, not a settings array
status: accepted
date: 2026-10-12
applies-to:
  - packages/types/src/capabilities/training-provider.cap.ts
  - packages/addon-training/src/page/ProviderSection.tsx
  - packages/addon-training/src/providers/modal/**
---

## Context

The Training → Providers tab listed entries correctly and deleted them via
`deleteEntry`, but Edit mounted `AddonGlobalSettingsForm` on the whole Modal
addon. That form's `globalSettingsSchema` was an `editable-array` of every
entry — a second Add/Delete/Edit surface that spliced the settings blob
instead of running the entry lifecycle (`createEntry` / `deleteEntry`,
gateway close, keychain paths). Operators saw a Delete that did not mean
"remove this provider entry".

Rejected:

- **Keep the array and teach the UI to call deleteEntry on row remove.** Two
  authorities on the same rows drift; Addons → settings would still edit
  entries beside Training → Providers.
- **Add a parallel `patchSettings` only for one entry.** Cap methods already
  own entry identity; inventing a settings-shaped patch duplicates Zod and
  the keychain contract.

## Decision

**One Providers form edits one entry.** Save on create runs `createEntry` then
`updateEntry`; Save on edit runs only `updateEntry`. Delete lives only on the
Providers table and always calls `deleteEntry`. Provider addons expose no
`entries` editable-array in `globalSettingsSchema`; entry secrets stay on
`secretStatePaths` (`entries[id].tokenSecret`).

## Consequences

- A new input field on credentials/defaults is declared on the type's
  `configSchema` (D829) and mapped through `updateEntry` (and a server
  publish), not an Addons settings form field.
- Addons → Modal settings is a blurb pointing at Training → Providers.
- Entry form UI is `ConfigFormBuilder` on that schema; secrets remain
  keychain-backed (`secretStatePaths`), not D634 plaintext (D829).

## Enforcement

`provider-section.spec.tsx` (no settings-form / Entries array in the dialog;
Save = create+update; Delete = deleteEntry) and
`modal-settings-schema.spec.ts` (no editable-array `entries`).
