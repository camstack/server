---
id: D829
title: Training provider entry forms use configSchema like notification targets; secrets stay keychain
status: accepted
date: 2026-10-12
supersedes:
applies-to:
  - packages/types/src/capabilities/training-provider.cap.ts
  - packages/addon-training/src/page/ProviderSection.tsx
  - packages/addon-training/src/providers/modal/**
---

## Context

Notification Targets drive their edit dialog from `kind.configSchema` +
`ConfigFormBuilder` (NC). Training Providers had hand-built fields and a
parallel `tokenSecretView` on `describe`, after D828 removed the settings
`editable-array`. That duplicated secret UI wiring instead of reusing the
schema path. NC itself stores secrets with D634 (`getTarget` plaintext +
`mergeSecrets`); Training already uses keychain (`secretStatePaths`, D787).

## Decision

**Entry forms for a training provider type are a `ConfigUISchema` on
`describeTypes` (`configSchema`), rendered with `ConfigFormBuilder` — same UI
mechanism as notification targets.** Lifecycle stays `createEntry` /
`updateEntry` / `deleteEntry` (D828). Password fields hydrate as keychain
`SecretFieldView` in `describe.formValues` (D789 / `KeychainOr`), never as
plaintext `getTarget`. Create seeds `''` so `KeychainOr` keeps a plain
`PasswordField`.

## Consequences

- A new Modal credential/default field is a schema field + `updateEntry`
  mapping, not a React row in `ProviderSection`.
- NC is not migrated to keychain here; Training must not copy D634.
- `globalSettingsSchema` still has no `entries` editable-array (D828).

## Enforcement

`modal-entry-schema.spec.ts`, `provider-section.spec.tsx` (ConfigFormBuilder /
secret field on edit; create eye plain; Save = create+update).
