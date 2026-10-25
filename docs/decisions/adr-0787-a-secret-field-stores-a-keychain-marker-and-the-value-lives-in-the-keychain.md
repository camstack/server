---
id: D787
title: A secret field stores a keychain marker; the value lives in the keychain, addressed by owner, scope and item id
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/types/src/keychain/**
  - packages/types/src/addon/secret-paths.ts
  - packages/types/src/addon/secret-settings-view.ts
  - packages/types/src/addon/secret-aware-context.ts
  - packages/types/src/addon/base-addon.ts
  - packages/types/src/capabilities/keychain.cap.ts
  - packages/types/src/capabilities/keychain-admin.cap.ts
  - packages/system/src/builtins/keychain/**
  - packages/system/src/kernel/transport/cap-route-resolver.ts
  - packages/system/src/kernel/transport/hub-cap-forward.ts
  - packages/system/src/kernel/transport/local-child-client.ts
  - packages/system/src/logging/log-redactor.ts
---

## Context

Every credential CamStack holds — camera passwords, OIDC client secrets, the
Cloudflare and Tailscale tokens, the Alexa broker credential, notifier tokens —
was plaintext JSON in `camstack.db`. Only the MQTT broker encrypted anything,
and its key file sat next to the ciphertext in every backup. CamStack's own
system backups (which may go to S3 or SFTP) carried the whole database, and
admin forms received the stored plaintext on purpose (`hydrateSchema`) because
a masked form written back had clobbered the cloudflare token (D780 restored
the plaintext round-trip for the OIDC secret).

The first design (2026-10-08) also migrated existing values automatically,
inside each owner, with `dry-run` / `apply` / `rollback` modes. The operator
refused shipping migration machinery: the one hub that holds plaintext is
migrated once by an operator script, and the product only ever writes the new
shape.

## Decision

A field is keychain-stored because its schema TYPE says so (`type: 'password'`
or `secret: true`, D783; `storage: 'inline'` opts out; a JSON blob holding a
secret stays inline), or because the addon declares it in
`secretStatePaths`. Its settings blob holds a marker
`{"$secret":"secret://<owner>/<scope>/<fieldPath>","v":1}` and never the
value. The ref is deterministic: owner addon, scope (`global`,
`node/<id>`, `device/<id>`, `integration/<id>`, `row/<collection>/<id>`) and
field path, with array items addressed by their id field, never by index.

The save path (`transformSecretWrite`, wrapped around every settings write of a
`BaseAddon`) keeps on `''`, `null`, a marker, a UI view or a redaction token —
`''` NEVER clears; sets on a non-empty string (keychain `put` first, then the
marker); clears only on `{"$secretClear":true}` (the ref is deleted after the
blob write). A value the keychain cannot store is REFUSED, never written as
plaintext. Nothing migrates an existing plaintext value on its own.

The keychain owner-checks every call against the CALLER the transport stamped
(`callerAddonId`): a stamp overwrites the args, an unstamped wire call has its
claim stripped, and only a hub in-process caller states its own identity.

## Consequences

- A copy of `camstack.db`, a stray `-wal` or a CamStack backup holds
  ciphertext (AES-256-GCM under a data key, AAD = the ref) and wrapped key
  material — never a value — as long as the master key is not in the same
  archive (D788).
- An addon that reads its store RAW (`ctx.settings.readAddonStore`) sees
  markers. The runtime config (`this.config`, `state()`) is resolved;
  `resolveConfig` substitutes markers before its `typeof` check so a marker can
  never fall through to the default `''`.
- A locked keychain resolves `unavailable` per ref. The addon runs without the
  value (`unresolvedSecrets`), never with an invented empty one, and writes
  nothing back; it retries with backoff and re-resolves on `keychain.changed`.
- Business collections (notifier targets, LLM profiles), the device and
  integration stores, and JSON blobs that hold secrets need their own door;
  until one lands they stay inline.
- The caller stamp is identity against bugs and misrouting, not against a
  malicious addon: every runner is the same OS user and can read the key file.

## Enforcement

- Specs: the save-path contract (`secret-settings-view.spec.ts`), the
  BaseAddon canaries (`base-addon-keychain.spec.ts`: a keychain-only change
  reaches the runtime, a restart re-resolves, a wrong key is unavailable, `''`
  never clears, strict refusal), the service
  (`keychain-service.spec.ts`: AAD, owner rule, locked states, rotation,
  orphans) and the caller stamp (`caller-stamp.spec.ts`).
- The type-keyed declaration is guarded by `check-secret-fields-declared`
  (D783).
