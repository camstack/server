---
id: D863
title: Settings texts and user-facing errors are translated by the hub from catalogs; the English text always travels beside the key
status: accepted
date: 2026-10-17
supersedes:
applies-to:
  - packages/types/src/i18n/translation.ts
  - packages/types/src/i18n/camstack-error.ts
  - packages/system/src/i18n/**
  - server/backend/src/i18n/request-lang.ts
  - server/backend/src/api/trpc/cap-route-error-formatter.ts
  - server/backend/src/api/trpc/localized-schema-paths.ts
  - server/backend/src/api/trpc/trpc.middleware.ts
  - scripts/i18n/**
---

## Context

The admin UI and the viewer are translated on the client, but everything the
HUB composes was English only: the labels and descriptions of every addon's
settings schema (`ConfigUISchema`) and the `message` of every error that reaches
a person. The operator's decision: schema texts are translated gradually, ALL
error messages get translated texts, and later the hub serves every catalog
through a `translations` capability.

Two shapes were rejected. Replacing `label` with a key would break every
consumer that predates it (old viewers, the MCP tools, an addon compiled against
an older framework) and leave a blank where a key is missing. Translating on the
client would need every client to ship every addon's catalog.

## Decision

Translation happens on the hub, at the two points where the hub already turns
data into a response, and **the English text always travels beside the key**.

- **Catalogs** are flat `key -> text` JSON, one per (namespace, language),
  validated with zod; a broken file is logged and ignored. Namespace `server`
  (error texts and core schema labels) lives in `packages/system/src/i18n/`;
  an addon package ships `i18n/<lang>.json` and its namespace is the package's
  short name (`@camstack/addon-provider-reolink` -> `provider-reolink`; a
  package may host several addons).
- **Schema fields** carry an optional `labelKey` / `descriptionKey` (sections:
  `titleKey` / `descriptionKey`) of the form `"<namespace>:<key>"` next to the
  mandatory English `label` / `description` / `title`. The tRPC middleware
  substitutes the catalog text when the request language has the key, on the
  methods listed in `localized-schema-paths.ts` only; otherwise the English text
  stays. Option labels (`{ value, label }`) follow the same rule.
- **Errors** carry a stable code: `userError(code, params, englishFallback)`
  (`CamstackError`, an `Error` whose `message` is the English text) or
  `trpcUserError(trpcCode, code, params, english)`. The tRPC error formatter
  replaces the response `message` with `server:<code>` in the request language
  and keeps `{ code, params }` in `data.i18n`. A legacy error, an unknown code
  and English pass through unchanged, so `message` is always a string and no old
  client notices.
- **Request language** is resolved once per request (`resolveRequestLang`): the
  user's profile language when one exists (none does yet), else the app's
  `lang` (`x-camstack-lang` header, `lang` query or connection param), else
  `Accept-Language`, else `en`. It is on the tRPC context as `ctx.lang`.

## Consequences

- A new settings field is still valid with English only; migration is
  additive and can run addon by addon (`scripts/i18n/add-label-keys.ts`).
- A schema served from a method NOT in `LOCALIZED_SCHEMA_PATHS` stays English:
  a new cap method that returns a schema must be added there.
- A code thrown in a forked runner reaches the hub: the local channel's error
  frame carries `i18n: {code, params}` (`socket-channel.ts`) and the rehydrated
  `PeerAnsweredError` exposes it. The Moleculer (cross-node) path does not carry
  it yet, so an error from an agent node arrives in English.
- Clients send their language: the SDK's `SystemConfig.getLanguage` becomes the
  `x-camstack-lang` header (HTTP) and `lang` connection param (WS); the admin UI
  passes its i18n language, the viewer must pass its own.
- Code-bearing error messages must not be parsed by callers; the code is the
  contract, the text is for people.

## Enforcement

`scripts/i18n/__tests__/catalog-parity.spec.ts`: `en.json` / `it.json` key and
`{placeholder}` parity per namespace, every `ns:key` reference in source exists,
every `userError` code exists in the `server` catalog.
`scripts/i18n/census-server-i18n.ts` reports what is still untranslated.
Behaviour specs: `server/backend/src/api/trpc/__tests__/i18n-output.spec.ts`,
`server/backend/src/i18n/__tests__/request-lang.spec.ts`.
