---
id: D879
title: A credential in a persisted row is a keychain marker or a census row, and ctx.records will make it automatic
status: accepted
date: 2026-10-18
supersedes:
applies-to:
  - scripts/check-no-raw-secrets-in-collections.ts
  - scripts/__tests__/check-no-raw-secrets-in-collections.spec.ts
---

## Context

D783 / D797 make a config field declared `password` / `secret: true` keychain-backed, and
`scripts/check-secret-fields-declared.ts` scans config SCHEMAS for credential-named string
fields. A secret an addon writes into storage of its own - a `declareCollection` table, a
`ctx.settings` store, a hub-main builtin table, hidden addon state - is no config field, so it
is invisible to both and sat in SQLite in plain text (and in every database snapshot inside a
backup). D878 found two (LLM profile key, TOTP seed) by hand. This census looked for the rest.

**Why the old guard missed them.** It (1) reads Zod `z.string()` chains and config-UI literals
only, (2) only under `addon-*` and `system/builtins`, and (3) treats `.meta({ secret: true })` as
proof of protection - but that meta only means "the CONFIG path stores a marker". The same
schema reused as a row shape, a `config: Record<string, unknown>` blob whose secret keys are
named by an adapter descriptor, or an array of `brokers` rows that no form field declares, are
all "declared" and all plaintext. A guard that finds secrets by field name cannot see a blob
whose keys are dynamic.

## Decision

1. **The census below is the work list of the `ctx.records` migration.** Nothing is moved with
   per-owner code: secret handling becomes a feature of the record kind (design section), and
   each owner is fixed when it migrates to records (phases 2-4 of the records plan).
2. **One guard for every persisted row shape**, `scripts/check-no-raw-secrets-in-collections.ts`.
   A credential-named field (the `check-secret-fields-declared` name heuristic, used only to FIND
   candidates) of a Zod row schema, interface member, column spec or store-write literal in a file
   that owns a collection - and of row types such a file refers to - must be typed as a keychain
   marker, or be pinned in `ALLOWLIST` with a reason (hash, public key, request shape, count). Two
   rules cover what no name shows: `broker-rows` (a package persisting `brokers` rows must name
   `brokers[` in `secretStatePaths`) and `hidden-state` (a credential-named `this.state('...')`
   key must be in `secretStatePaths`).
3. **`RAW_UNTIL_RECORDS` is the temporary section**: every census row still raw today, with its
   phase and a text probe proving it is still raw. The guard is green with it and red for any NEW
   raw secret; a row whose probe disappears (it was fixed) fails as stale, so the list only
   shrinks. It is not a place to park new findings.

### Census (2026-10-18)

> Amended by [D880](adr-0880-core-block-passwords-and-waste-source-credentials-are-keychain-backed-and-a-read-only-scan-finds-what-no-code-writes.md): the census MISSED core-block settings (`password` fields, raw in two copies) and waste `sources[].argsJson` (latent). Both are now keychain-backed and need no `RAW_UNTIL_RECORDS` row. Rows no code writes (orphans) are found by the live scan, not by this guard.

Raw, plaintext today - moved by the records migration (phase is a proposal):

| Owner | Where | Field | Now | Phase |
| --- | --- | --- | --- | --- |
| `notifiers` | `notifiers:notification-targets` (`config` blob) | every `password` field of the kind (bot tokens, webhook secrets, SMTP / Pushover / ntfy / Gotify credentials) and editable-array row passwords (webhook headers) | raw; redacted on read only (D634) | 2 |
| `provider-homeassistant` | addon-settings `brokers[]` | `auth.accessToken`, `auth.supervisorToken` | raw | 3 |
| `provider-homematic` | addon-settings `brokers[]` | `connection.password` | raw | 3 |
| `matter-broker` | addon-settings `brokers[]` | `connection.threadDataset`, `connection.wifiPassword` | raw | 3 |
| `import-alexa` | addon-settings `brokers[]` | `connection.cookie`, `.refreshToken`, `.macDms` | raw | 3 |
| `google-services` | addon-settings `brokers[]` (+ legacy top-level) | `clientSecret` | raw | 3 |
| `snapshot` | addon state | `snapshotLinkSecret` (HMAC key of signed links) | raw | 4 |
| `pipeline-analytics` | addon state | `ncActionSecret`, `ncArtifactSecret` (HMAC keys of action / artifact links) | raw | 4 |
| `homeassistant-export` | addon state | `haExportMediaSecret` (HMAC key of media links) | raw | 4 |

Already protected, so nothing to do:

| Owner | Where | Field | Now |
| --- | --- | --- | --- |
| `ai` | `ai:llm-profiles` | `apiKey` | keychain marker (D878) |
| `system` | `user_totp` | `secret` | keychain marker (D878) |
| `system` | `users` | `passwordHash` | hashed (bcrypt) |
| `system` | `api_keys`, `scoped_tokens`, `admin_tokens` | `tokenHash` | hashed (SHA-256); the token shows once |
| `system` | `login_sessions` | `refreshHash`, `previousRefreshHash` | hashed |
| hub backend | `share_view_tokens` | `tokenHash` | hashed |
| `mqtt-broker` | addon-settings `brokers[]` | `password` | keychain (schema `password` item field); `embeddedClients[].passwordHash` hashed |
| `auth-webauthn` | `user_passkeys` | `credentialId`, public key | public values |
| `system` | `device_credentials`, `backup_encryption_keys` | public keys, fingerprints | public (D800: the backup secret key is never stored) |
| `system` | integrations, `storage_locations.config`, device configs | declared password fields | keychain markers (D787, D870) |
| `stream-broker` | per-device `rtspTokens` | restream tokens | keychain marker (D870) |
| `homeassistant` | HA notify targets (`config`: `service`, `brokerId`) | none | no credential in the row |
| `system` | device CA key | PEM | keychain (`DEVICE_CA_KEY_REF`) |

Outside collections (not this guard): mesh / TLS CA key files (owner-only, 0600), HAP pairing store,
Matter fabric, tailscaled state, the Alexa import session file - the roadmap's "library-owned
files" item.

## Design: secrets in `ctx.records`

A record kind declares its row shape as a Zod schema; a field marked `.meta({ secret: true })`
is keychain-backed with no further code, exactly like the config-schema path.

- **Declaration.** Only the schema says what is secret (never a field name). A field of a
  nested object or an array of objects is addressed like `secretStatePaths`
  (`headers[name].value`): array rows are matched by a declared id key, so a reorder keeps refs.
  A `z.record` of free keys (a notifier `config`) cannot be declared field by field - such a kind
  declares its secret keys per variant (a discriminated union by `kind`), which is also what lets
  the descriptor's `password` fields and the Zod schema be ONE source.
- **Write.** The store puts each non-empty secret into the keychain FIRST, under
  `secret://<owner>/row/<collection>/<rowId>/<fieldPath>`, then writes the row holding the
  marker `{ "$secret": ref, "v": 1 }`. A locked keychain refuses the write; plaintext is never
  stored. An absent / REDACTED value on update keeps the stored one; an empty string removes it
  (and its keychain value); a row delete removes its refs.
- **Marker bound to the row.** A marker is honoured only when its ref equals the ref the store
  would build for that row and field. A forged row cannot make a record read another row's, or
  another owner's, secret (the D878 rule, now enforced once, in the store).
- **Read.** The owner reads resolved values in one batched `resolve`. A value the keychain
  cannot serve is reported as `locked` for that row - the field is left unset and the call that
  needs it fails explicitly (fail closed where the secret gates access), never read as empty.
  The wire / list view shows `__redacted__` for a set secret; it is never revealed back.
- **UI.** A secret field renders as the library `password` field (the schema `secret` meta is
  what the derived form reads); the admin form round-trips the redacted token.
- **Migration on adopt.** Adopting a collection into records runs a verified move per row: put,
  read back, compare, then rewrite the row with the marker; a row that fails stays raw and is
  counted. Dry run first, counts only, operator-run, no boot-time purge (D878). Once a kind
  adopts, its `RAW_UNTIL_RECORDS` rows are deleted in the same change (the probe fails otherwise).

## Consequences

- Today nothing changes at runtime; the nine raw rows stay raw until their phase.
- A new raw secret in a collection, a broker row or hidden state now fails the guard.
- The guard cannot see a blob with dynamic keys; the notifier row is therefore a census row,
  not a finding, and so would be the next such kind - a reviewer must register it.

## Enforcement

`scripts/check-no-raw-secrets-in-collections.ts` (wired into `.github/workflows/checks.yml`),
spec `scripts/__tests__/check-no-raw-secrets-in-collections.spec.ts`: a raw `token` planted in a
fake collection, an unregistered `brokers` writer and an unregistered hidden-state key each fail;
removing an allowlist entry or letting a census probe go stale fails the real-tree test.
