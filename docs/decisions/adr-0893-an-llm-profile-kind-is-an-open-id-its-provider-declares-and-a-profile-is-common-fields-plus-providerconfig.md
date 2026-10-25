---
id: D893
title: An LLM profile kind is an open id its provider declares, and a profile is common fields plus providerConfig
status: accepted
date: 2026-10-21
supersedes:
applies-to:
  - packages/types/src/capabilities/llm.cap.ts
  - packages/addon-ai/src/kinds/**
  - packages/addon-ai/src/profile-migration.ts
  - packages/addon-admin-ui/src/pages/system/AiProfileEditor.tsx
---

## Context

`llm.cap.ts` declared the profile kinds as a closed `z.enum` (openai,
openai-compatible, anthropic, google, managed-local, apple-foundation), and the
profile row flattened every provider's fields beside the common ones
(`baseUrl`, `apiKey`, `extraHeaders`, `runtime`, `appleFoundation`). A new
provider therefore needed a framework change (a cap edit, codegen, a
`@camstack/system` + `@camstack/server` publish and an update of every node)
before it could ship one row; and the admin editor carried a hand-written
branch per kind (`kind === 'managed-local'`, `kind === 'apple-foundation'`), a
kind-keyed icon table and a hard-coded top-k list. `llm.listModels` took a
SAVED profile only and answered `string[]`, so the operator could not check a
key or a base URL before saving, and an error looked like an empty list.

Kept as an alternative and rejected: a discriminated union of per-kind
provider schemas in the cap. It types `providerConfig` exactly, but it is the
same closed list in another form — every new provider is still a cap change.

## Decision

A kind is an open, validated id (`LLM_PROFILE_KIND_PATTERN`) declared only by
the provider's `listProfileKinds` descriptor, which also carries everything the
editor draws: `connectionSchema` / `advancedSchema` (ConfigUISchema over
`providerConfig`), `features` (vision / tools / streaming defaults), whether
vision is operator-editable, `modelCatalog` (`fetch` | `static` | `none`, with
`staticModels`), the common `profileFields` its wire carries, and
`providerWidgets` by generic widget id where a field cannot be a schema field.
A profile is common fields plus `providerConfig: Record<string, unknown>`,
validated by the owning provider on `upsertProfile`. The kind's one `password`
field is the secret: the store keeps it in the row's existing keychain slot
(`apiKey`, a marker on the record's own ref), never in `providerConfig`, and the
wire shows it as the redaction marker. `llm.listModels({ addonId, kind,
profileId?, connection? })` is an admin MUTATION (a draft may carry a key; a
query's input travels in a URL) that answers models or a typed failure
(`auth` | `network` | `unsupported` | `invalid`), and resolves a key the draft
leaves untouched from the stored profile of the same kind server-side. The UI
has no branch on a kind id.

## Consequences

- A third-party provider ships a kind with no framework change; the editor
  renders it from its descriptor.
- A consumer that needs a provider fact reads `providerConfig` defensively
  (`addon-post-analysis` reads `providerConfig.baseUrl` for its locality
  check) — the cap no longer types it.
- A kind holds at most ONE secret field (the row has one keychain slot);
  `secretFieldOfDescriptor` throws on two.
- `listModels` with a stored key and an edited base URL sends that key to the
  new URL: admin only, and the price of verifying an edit before saving.
- Stored flat rows are rewritten once at boot (`migrateLegacyRows`,
  idempotent, keychain untouched) and read correctly before that.

## Enforcement

`packages/addon-ai/src/__tests__/profile-migration.spec.ts` (marked fixture,
same keychain ref before and after), `list-models.spec.ts` and
`list-models-provider.spec.ts` (draft vs saved key, never echoed),
`AiProfiles.spec.tsx` (a fake provider's open kind renders and saves with no UI
change), `scripts/method-tier-baseline.json` (`llm.listModels` is admin).
Nothing mechanically forbids a new `kind ===` branch in the admin UI — review.
