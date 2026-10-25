---
id: D878
title: An LLM profile's API key and a TOTP seed live in the keychain, moved by their owner under a verified operator migration
status: accepted
date: 2026-10-18
supersedes:
applies-to:
  - packages/addon-ai/src/profile-store.ts
  - packages/addon-ai/src/provider.ts
  - packages/system/src/auth/totp-manager.ts
  - scripts/hub/migrate-raw-secrets.ts
  - scripts/check-keychain-backed-rows.ts
---

## Context

The 2026-10-18 storage census found two credentials still in plain text in SQLite
while every other one was in the keychain (D787): the `apiKey` of every LLM profile
(`ai:llm-profiles`) and the TOTP seed of every enrolled user (`user_totp.secret`).
A copy of the database - or of a backup of it - therefore carried API keys that bill
real money and the seeds that let anyone mint a user's second factor.

Also checked: `backup_encryption_keys` holds `key_id`, `public_key`, `created_at`
and `retired_at`. It is the backup PUBLIC key (D800); the secret key is shown once and
never stored. No raw key material sits in that table, so nothing moves.

## Decision

A secret that lives in a business row is stored in the keychain by the row's owner,
and the row keeps only the marker.

- **LLM profile.** Owner `ai`, ref `secret://ai/row/ai:llm-profiles/<profileId>/apiKey`.
  The row's `apiKey` is `{ "$secret": ref, "v": 1 }`. `ProfileStore` resolves it on
  read and puts it before writing the marker. A REDACTED/absent key on write keeps the
  stored one; an empty one removes it (and its keychain value). The admin form keeps
  its `password` field and the `__redacted__` wire contract: a stored key is shown as
  set, never revealed back, even while the keychain is locked.
- **TOTP.** Owner `system`, ref `secret://system/row/user_totp/<userId>/secret`. The
  `secret` column holds the marker as JSON text. `setup` puts the seed first, so a
  locked keychain refuses the setup before the previous enrolment is touched.
- **Locked is explicit, never open.** A profile whose key cannot be read is not
  dispatched: the call returns `unavailable` naming the keychain, and a save that
  carries no new key leaves the stored one untouched. `TotpManager.verify` and
  `confirm` THROW `TotpSecretUnavailableError` when the seed cannot be read - no code
  is accepted and the user does not read as "not enrolled" (`getStatus` needs no seed).
  Setup without a keychain door is refused, never stored inline.
- **Migration is the owner's, run by the operator, never at boot.** Each owner exposes
  `migrateRawSecrets({ apply })` (`llm.`, `userManagement.`; admin). Per row it puts
  the value, reads it back, compares, and only then rewrites the row with the marker;
  a row that fails stays raw. It reports counts only. `scripts/hub/migrate-raw-secrets.ts
  --server <host> [--apply]` calls both (dry run by default, exit 1 unless every row is a
  marker and every marker resolves). Until it runs, a pre-D878 row keeps working inline
  (an enrolled user still verifies; a profile still authenticates) - nothing migrates on
  its own, and a save through the normal path migrates only that row.
- **Both migrate methods are admin-only and idempotent; they carry no rate limiter.** A
  repeat run finds nothing raw and changes nothing.
- **A marker is honoured only for its own row.** The profile store accepts a marker only when
  it equals that profile's ref, and TOTP only when it equals that user's ref, so a forged row
  cannot reach another row's or another `system` secret. A malformed or empty TOTP column
  fails closed. TOTP setup / confirm / disable / migration are serialized per user, and the
  migration is a compare-and-set, so a concurrent setup is never overwritten. The client sees
  a generic message; the keychain reason is logged server-side.
- **One writer.** Only `profile-store.ts` and `totp-manager.ts` (plus the schema
  declaration) name these collections.

## Consequences

- A database copy no longer carries these two credentials; a backup still does not need
  the keychain (D800 encrypts the archive separately).
- The Secrets page counts both refs `in-use` while their row holds the marker (a row
  scope, read through `settingsStore.get`); deleting a user leaves the enrolment row
  (and so its seed) exactly as before - an orphaned user's row, not a keychain orphan.
- A hub whose keychain is locked can no longer call a keyed LLM profile or verify a
  second factor. That is the intended failure: it is loud and bounded to those two paths,
  and sessions are already refused in that state (D797).
- Still inline, tracked in the roadmap: notifier targets, broker connections, library
  files.

## Enforcement

`scripts/check-keychain-backed-rows.ts` (owner still writes a marker and puts the
value; no other source names the collections). Specs: `profile-store-keychain.spec.ts`,
`totp-manager.spec.ts`, `keychain-usage-backed-rows.spec.ts`, `migrate-raw-secrets.spec.ts`;
each was disarmed (resolution removed, plaintext write restored, error swallowed) and
failed.
