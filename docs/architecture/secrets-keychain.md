---
title: Secrets and the keychain
last-verified: 2026-10-18
applies-to:
  - packages/system/src/builtins/keychain/keychain-service.ts
  - packages/system/src/builtins/keychain/key-sources.ts
  - packages/system/src/builtins/keychain/keychain-reset-trigger.ts
  - packages/types/src/addon/secret-settings-view.ts
  - packages/types/src/addon/base-addon.ts
  - packages/system/src/kernel/transport/cap-route-resolver.ts
  - packages/system/src/logging/log-redactor.ts
covers:
  - packages/system/src/builtins/keychain/**
  - packages/types/src/keychain/**
  - packages/types/src/addon/secret-*.ts
  - packages/types/src/capabilities/keychain.cap.ts
  - packages/types/src/capabilities/keychain-admin.cap.ts
  - packages/system/src/builtins/device-manager/device-config-secrets.ts
  - server/backend/src/api/core/integration-secrets.ts
  - packages/ui-library/src/composites/config-secret-field.tsx
  - packages/addon-admin-ui/src/pages/system/Secrets.tsx
  - packages/addon-admin-ui/src/components/system/secrets/**
  - packages/system/src/auth/jwt-signing-key.ts
  - packages/system/src/builtins/local-auth/jwt-signing-key-keeper.ts
  - packages/system/src/builtins/keychain/system-held-secrets.ts
  - packages/system/src/builtins/device-manager/removal-cleanup.ts
  - packages/addon-ai/src/profile-store.ts
  - packages/system/src/auth/totp-manager.ts
  - scripts/hub/migrate-raw-secrets.ts
  - scripts/hub/scan-raw-secrets.ts
  - packages/system/src/builtins/core-blocks/block-settings-store.ts
  - packages/addon-waste-collections/src/waste-secrets.ts
  - scripts/check-no-raw-secrets-in-collections.ts
---

# Secrets and the keychain

Every password, token and key CamStack holds lives in ONE place: the hub's
keychain, encrypted. A settings blob, a device config, an integration's
settings and a storage location hold a **marker** where the value used to be:

```json
{ "$secret": "secret://<owner>/<scope>/<fieldPath>", "v": 1 }
```

The decisions: [D783](../decisions/adr-0783-secrets-are-declared-by-schema-type-and-never-travel-on-argv-env-or-logs.md)
(declared by type; never on argv, env or logs),
[D787](../decisions/adr-0787-a-secret-field-stores-a-keychain-marker-and-the-value-lives-in-the-keychain.md)
(the marker/ref contract, the save path, the caller stamp),
[D788](../decisions/adr-0788-the-keychain-master-key-location-is-configuration-never-an-environment-variable.md)
(where the master key comes from),
[D789](../decisions/adr-0789-the-admin-settings-form-round-trips-the-keychain-marker-not-the-stored-value.md)
(the admin form sees "set", never the value),
[D878](../decisions/adr-0878-an-llm-profile-api-key-and-a-totp-seed-live-in-the-keychain-moved-by-their-owner-under-a-verified-operator-migration.md)
(an LLM profile's key and a TOTP seed),
[D879](../decisions/adr-0879-a-credential-in-a-persisted-row-is-a-keychain-marker-or-a-census-row-and-records-will-make-it-automatic.md)
(the census of every credential still raw in a row, the guard over all collection writes, and how `ctx.records` will make the marker automatic),
[D880](../decisions/adr-0880-core-block-passwords-and-waste-source-credentials-are-keychain-backed-and-a-read-only-scan-finds-what-no-code-writes.md)
(core-block passwords, waste-source credentials, and the live shape scan). The full design, with what it
protects against and what it does not, is
[design/2026-10-08-secrets-keychain.md](../design/2026-10-08-secrets-keychain.md).

> **Caller stamp (D881).** The keychain owner check reads `callerAddonId`. The tRPC mount used to let a
> session supply that key itself (`.loose()` input); the mount now strips it for the keychain,
> device-history and records. The stamp comes only from the transport or a hub in-process caller.

## What is a secret

A field is a secret because its schema says so — `type: 'password'`,
`secret: true` on any field, `.meta({ secret: true })` on a Zod device-config
field — never because of its key name. `storage: 'inline'` opts a field out (a
masked non-secret). A JSON textarea that HOLDS a secret stays inline: the
keychain stores strings. Hidden state an addon writes itself is declared in
`secretStatePaths`.

## Where it lives

- **`keychain`** — a hub-only, in-process builtin in the infrastructure boot
  pass, right after the settings door. Tables `keychain:secrets` (ciphertext,
  one row per ref), `keychain:keys` (the wrapped data key) and
  `keychain:audit` (writes, deletes, rotations, reveals, recovery downloads;
  90 days / 20k rows). Reads are not audited per row: a coarse `lastReadAt`
  (at most hourly) is all.
- **Envelope.** AES-256-GCM under a data key (DEK); the DEK is wrapped by the
  master key (KEK). `ck1.<keyId>.<iv>.<tag>.<ct>`, AAD = the ref, so a
  ciphertext copied onto another ref does not decrypt. Rotating the KEK
  re-wraps one row.
- **Master key** ([D788](../decisions/adr-0788-the-keychain-master-key-location-is-configuration-never-an-environment-variable.md)):
  `keychain.keyFile` in `config.yaml` → the desktop app's OS keychain →
  `<dataDir>/.keychain/master.key`. No env var. The default file is not in
  CamStack's backups, but it IS in a whole-volume tar next to the database —
  the Secrets page says so.
- **Locked is never empty.** `key-missing`, `wrong-key`,
  `key-file-unreadable`: every ref resolves `unavailable`, `put` refuses, and
  the hub still boots.

## A lost master key (D799)

A locked keychain leaves no admin session (the signing key is in it, below),
so the way back in is a one-shot file on the host:
`<dataDir>/.keychain/RESET_KEYCHAIN` (`/data/.keychain/RESET_KEYCHAIN` in the
container), then a restart. Checked once at keychain boot, right after the
unlock (`keychain-reset-trigger.ts`):

| Keychain at boot | What happens |
| --- | --- |
| locked: `wrong-key` / `key-missing` / `key-file-unreadable` | reset (actor `trigger-file`), file deleted, an error-level banner names the fields to re-enter |
| unlocked | ignored, file deleted, warning — a working store is never reset |
| locked: `store-unavailable` | left armed for a boot that can reach the store |
| a configured `keychain.keyFile` that is missing / unreadable | refused BEFORE anything is archived, file deleted |

Nothing in the environment arms it, and its content is not read. A reset (this
file's, or the Secrets page's own) archives every value into
`keychain:secrets-orphaned-<ts>` AND every wrapped data key into
`keychain:keys-orphaned-<ts>` (so a key that turns up later still opens the
archive), writes a new master key (the default file; a configured file is used
as it is), starts a new data key, clears the system-held markers (none remain
since D857 removed the cluster secret; the list is empty), emits a `delete` per archived ref so every keeper
reloads (local-auth then generates a new signing key: everyone signs in again),
and writes a `keychain:resets` row. System → Secrets shows "Keychain was
reset: N fields to re-enter" as a notice line whose details list the fields
still unset (owner, scope, field; `keychain-admin.resetReport`) until an admin
dismisses it (`acknowledgeReset`).

## The hub's own secrets (D797)

Owner `system` — values no addon owns, read by hub code in process:

| Ref | What | Where its marker lives | Loaded by |
| --- | --- | --- | --- |
| `secret://system/global/jwtSigningKey` | the session signing key | none — process-held, always "in use" | `local-auth` (`JwtSigningKeyKeeper`) into the process slot every `AuthManager` reads |

There is **no cluster secret** (D857): agents are identified by their mesh certificate and
paired from the hub, so nothing of that kind is stored. An older hub may have left
`secret://system/global/clusterSecret` in the keychain and `cluster.clusterSecret` in
`system-settings`; no code reads, writes or recognises them. The entry reads as an
orphan on System -> Secrets (delete it there); the settings row can be deleted through the
settings store. The mesh CA key (`secret://system/global/meshCaKey`) is process-held like the
signing key.

Failure is closed and loud: a locked keychain makes sessions unavailable
(`JwtSigningKeyUnavailableError`; no admin call works meanwhile — every
token is a JWT signed with that key too, so the recovery is the key
file + a restart — or, for a key that is truly lost, the `RESET_KEYCHAIN` file
above — not System → Secrets) — never an
env fallback, never a fresh signing key (which would log everyone out). The
signing key is generated only when the keychain answers `missing`, and
replaced only by `keychainAdmin.setSystemSecret` (audited). An AGENT's `agent.json` (0600)
holds its private mesh key and the leaf the hub signed, never a shared secret (D857).
No secret reaches any node through its environment (D783, D797).

## Who may read what

`keychain` (internal) is owner-checked: a caller reads only the refs it owns —
its own addon id, or the runner hosting it (a grouped runner is stamped with
its group). The caller is the TRANSPORT's stamp (`callerAddonId`), see
[transport.md](transport.md#who-is-calling-the-caller-stamp): it overwrites
whatever the args claim, an unstamped wire call is stripped, and only a hub
in-process caller states its own identity. `ctx.secrets` is the handle; hub
system builtins (device-manager, the integration provider) act for the owner
through `forOwner`. This is identity against bugs and misrouting, not against
a malicious addon.

`keychain-admin` (System → Secrets) is admin-only: status, the list (with
usage: `in-use` / `orphan` / `unknown` — an unreadable owner blob is never
called an orphan), the audit, an audited reveal, orphan deletion, rotation,
the recovery key and, when the key is lost, reset.

The page (`pages/system/Secrets.tsx`, parts in `components/system/secrets/`)
has three parts, and two rules came from an operator report (2026-10-08):

- **One notice region.** Every condition is one line in a single
  `aria-label="Keychain notices"` region, ordered: locked, reset re-enter
  list, key shares the backup, no recovery copy, rotation pending, orphans
  (`keychain-notices.ts`); explanations sit behind each line's Details, and
  past two lines only the first shows until expanded. Separate banners per
  condition stacked and overlapped on a phone.
- **A reveal never renders in the table.** It opens `RevealDialog`
  (monospace, wrapping, scrolling in the dialog body, copy, hides after
  `SECRET_REVEAL_MS`, says the reveal is audited). Inline, a PEM re-flowed
  every column.
- The status card (state, key source + path, short fingerprint, recovery
  copy, Rotate / Download), then `?view=values` — the library `DataTable`
  with a usage filter and a confirmed "Delete N orphans" — and `?view=audit`,
  paged 25 at a time over the last 500 entries. `unknown` usage reads
  "Unavailable" and is never offered for deletion.

## Hidden per-device credentials (D870)

`secretStatePaths` also name credentials in the PER-DEVICE store. The stream-broker keeps
a camera's restream tokens as the device setting `rtspTokens` (JSON text of
`{ camStreamId: token }`); the row holds a keychain marker under `secret://stream-broker/device/<id>/rtspTokens`
and a locked keychain refuses the write, never storing plaintext. The one-shot migration
carries the old tokens over with the admin-only `keychainAdmin.importSecret` (restricted to
`secret://stream-broker/device/<id>/rtspTokens`, never overwrites a stored value, audited as the
operator; marked for removal with the script). A keychain that is locked when the broker starts
blocks only the token WRITES of the affected cameras (alert + log, recovery without restart);
streams keep being served. Until the
migration's drop, the Secrets usage check also reads the old per-addon blobs, so do not delete
"orphans" before `--verify` passes.

## A removed device takes its secrets with it (D864)

A device-scoped value (`secret://<driver>/device/<id>/<field>`) belongs to the
DRIVER that declared it, so deleting the device used to leave it behind. Every
delete ends in `deviceManager.removeDevice`, whose clean-up now includes a
`keychain-secrets` step: `ctx.secrets.deleteDeviceScope(deviceId)` ->
`keychain.deleteDeviceScope`, which removes every value scoped `device/<id>`
whatever its owner (audited as `delete`, announced on `keychain.changed`, works
while locked because it never reads a value). It is the only owner-spanning
delete, and only the caller `device-manager` is allowed. A failure is logged with
`tags: { deviceId }` and retried a bounded number of times in memory (no boot
sweep). A secret the retry lost reads `orphan` on System -> Secrets, whose
"Delete N orphans" is the manual clean-up. Other addons' device-scoped values are
removed by the same call; they never need their own hook.

## Secrets in business rows (D878)

Two credentials live in a row of their owner's own table, not in a settings blob, and
follow the same rule: the value is in the keychain, the row holds the marker.

| Row | Owner | Ref | Marker stored as |
| --- | --- | --- | --- |
| `ai:llm-profiles` `apiKey` | `ai` | `secret://ai/row/ai:llm-profiles/<profileId>/apiKey` | JSON object in the row blob |
| `user_totp` `secret` | `system` | `secret://system/row/user_totp/<userId>/secret` | JSON text in the column |

Reads resolve through the keychain. A key or seed the keychain cannot serve is never
treated as absent: a profile call returns `unavailable` naming the keychain (and a save
without a new key keeps the stored one), and TOTP `verify`/`confirm` throw, so no code is
accepted. `backup_encryption_keys` holds public keys only (D800) and stays as it is.

A row written before D878 keeps working inline until the operator runs the migration:

```bash
npx tsx scripts/hub/migrate-raw-secrets.ts --server <host>           # dry run
npx tsx scripts/hub/migrate-raw-secrets.ts --server <host> --apply
```

It calls `llm.migrateRawSecrets`, `userManagement.migrateRawSecrets`,
`coreBlocks.migrateRawSecrets` and the waste-collections `migrateSources` action (D880, below);
each owner puts the value, reads it back, and only then rewrites the row. Counts only,
idempotent, exit 1 unless every row is a marker and every marker resolves. There is no
boot-time move.
`scripts/check-keychain-backed-rows.ts` keeps the writers to the owner files.

## Block passwords and waste credentials (D880)

Two credentials no static guard could see (nothing names them in code) are keychain-backed by
their owner's schema, with ONE copy each:

| What | Owner / ref | Where the marker lives |
| --- | --- | --- |
| a core block's `password` / `secret: true` settings field | `core-block-<id>`, `secret://core-block-<id>/global/<field>` | the block addon's `addon-settings` row `core-block-<id>.<field>` |
| a waste source's `password`, `api_key`, `token`, `authorization` argument | `waste-collections`, `secret://waste-collections/global/sources[<id>].args.<key>` | `sources[].args.<key>` in the addon settings |

- **Blocks.** The block's `settingsSchema` is embedded in its generated wrapper, so the running
  script reads resolved values; core-blocks writes for the block through `forOwner`. The old
  `core-blocks:settings` blob is legacy (migration input only). A block delete removes its rows
  and keychain values.
- **Waste.** `args` is typed by the catalog; the credential keys are named in `waste-secrets.ts`
  and a catalog-walking spec keeps the list complete. The list view shows the redaction token.
- **Finding what no code writes.** `scripts/hub/scan-raw-secrets.ts --server <host>` is a
  read-only walk of every table that reports table, row id and field path of any credential-named
  field holding a raw string - never a value - including orphan rows (a legacy broker row that
  outlived its migration). It is a step of the records adoption dry run: clean before a
  collection is adopted, clean after its migration. A table over `--max-rows` is listed as NOT checked.

```bash
npx tsx scripts/hub/scan-raw-secrets.ts --server <host>              # exit 1 if anything is raw
npx tsx scripts/hub/migrate-raw-secrets.ts --server <host> --apply   # blocks + waste included
```

## The save path

Every settings write of a `BaseAddon` goes through `transformSecretWrite`
(the context's `settings` is wrapped, so `updateGlobalSettings`, `state()` and
direct `writeAddonStore` calls all qualify). Per secret path:

| Incoming | Result |
| --- | --- |
| a non-empty string | `put` first, then the marker |
| the marker, the UI view, `''`, `null`, `***` | KEEP — `''` never clears |
| `{ "$secretClear": true }` | marker → `null`, ref deleted after the write |
| the same plaintext an inline blob holds, written back by the addon | KEEP inline — nothing migrates on its own |
| the same, sent by the OPERATOR (settings dispatch, admin API) | stored in the keychain |

Array rows are matched by their id (`itemIdKey`, default `id`): a reorder keeps
refs, a removed row's refs are deleted, a duplicated row's secret is "not set".
A value that cannot be stored is **refused** — never written as plaintext.
Code that means "forget this token" calls `clearSecrets`.

Because addon reads answer values (D798, below), a write-back carries values
where the blob holds markers. Before `transformSecretWrite`, every position
where the stored blob holds one of the addon's OWN markers — declared secret or
not — is handled by `restoreUnchangedSecrets` (`secret-write-back.ts`):

| Incoming at a stored marker | Result |
| --- | --- |
| the value the marker resolves to | the marker — no `put`, no new version |
| `''`, `null`, `***` | the marker (KEEP) |
| another non-empty string | `put` under the SAME ref, then the marker |
| a new value while the ref is `unavailable` / `forbidden`, from the ADDON | **refused** (`SecretOverwriteRefusedError`) — the addon cannot see what it would replace |
| the same, from the OPERATOR | `put` (a deliberate change) |

An undeclared key that holds an own marker joins the secret tree for that write
(`widenTreeWithStoredMarkers`), so CLEAR and KEEP work on it too. After the
transform, keys equal to the stored value are dropped; a write that changes
neither the blob nor the keychain is not written and is not a config change —
`updateGlobalSettings` then skips `onConfigChanged`, `AddonUpdated` and the
auto-restart. Another owner's marker in the blob (device-manager keeps each
driver's) is never resolved, widened or taken over.

Doors for the stores that are not an addon's own blob: device-manager
`persistConfig` / `loadConfig` (the device's declared `secretConfigPaths`,
owned by the driver), `integrations.setSettings` / `getSettings` (the form's
`secretKeys`, owned by the integration's addon; the admin form reads views),
storage locations (the provider's declared keys, owned by storage-orchestrator).

## The read path

**Addon-facing reads resolve (D798).** `BaseAddon` wraps `ctx.settings`, and
every read on it — `readAddonStore`, `readAddonStoreResult`,
`readAddonStoreKeyResult`, `readDeviceStore`, `readDeviceStoreBatch` — plus
`resolveGlobalStore()`, `readStoredGlobalKey()`, `state()` and `this.config`
answers keychain VALUES, resolved through the addon's own `ctx.secrets` (one
batched, cached, owner-checked call per read; only the addon's own refs). A
value that cannot be resolved stays a MARKER on these raw-shaped reads —
"stored, unavailable", never `''` and never absent, so it cannot read as
"nothing stored, mint one" — and is logged once per ref. The marker-bearing
blob is reachable only through `BaseAddon`'s private `rawSettings()`: the form
hydrate (markers → views), `resolveConfig` (tracks unresolved refs for retry)
and the save path. An override that hydrates its form from a resolved read
through `super.getGlobalSettings(overlay)` keeps the marker for every member it
carries unchanged. `scripts/check-no-raw-secret-read.ts` fails CI on addon code
that reaches the raw view (the `initialize(context)` parameter's `settings`,
the private members). This replaced three per-addon fixes in one evening —
Wyze, ONVIF, Reolink — each an addon reading its config raw and meeting a
marker where its secret was.

`resolveConfig` resolves every marker in ONE keychain call **before** its
`typeof` check (a marker left in place would fall through to the default
`''`). An unresolvable value is left out and reported
(`unresolvedSecrets`), retried with backoff, and never written back.
`keychain.changed` (ref, owner, version — never the value) drops the cached
copy and re-resolves; a 15-minute revalidation covers a dropped event. A form
reads the VIEW (`hydrateSchema`) and draws it as one password input with an
eye: untouched it is empty behind a masked placeholder and sends the view back;
the eye reveals through the audited `keychain-admin.reveal`; typing sends the
new value; emptying a value the operator revealed or typed sends
`{ "$secretClear": true }`. A keychain marker is a view everywhere; a
pre-keychain inline value is a view only in the addon's own settings forms
(`inlineSecretsAsViews`, passed by `BaseAddon`). A camera driver hydrates its
device form from the config `loadConfig` resolved for it, so the device-manager
aggregate (`device-form-secrets.ts`) replaces every field whose key holds a
stored marker with the marker's view, and its save route drops a view from the
driver's patch (KEEP) and turns a clear into `''` for the driver plus a clear at
the door. A device secret still inline (not migrated) keeps the driver's
plaintext, whose eye only toggles visibility. Top-level keys only: a nested or
per-row device secret keeps the driver's hydration.

## Logs

The central redactor runs in `LogManager` (every sink), in each forked
runner's UDS logger (it alone knows the values that runner resolved) and on
an agent before a child's line is forwarded: known values →
`‹secret:<hash>›`, URL credentials and credential CLI flags → `***`,
credential-named meta keys → `***`.

## Not covered (yet)

Library-owned files (HAP pairing, Matter fabric, tailscaled state, the
Alexa-import session). Rows and blobs still holding a raw credential (notifier
targets, `brokers[]` connections, three link-signing keys) are the census of D879:
they move when their owner migrates to `ctx.records`, where a `.meta({ secret: true })`
field of the record schema is keychain-backed automatically, and
`scripts/check-no-raw-secrets-in-collections.ts` blocks any NEW raw secret meanwhile.
(LLM profiles and TOTP seeds moved in D878; core-block passwords and waste-source credentials in D880.) The copies of
all of these that LEAVE the host in a system backup are covered by backup
encryption ([backups.md](backups.md), D800) — deliberately NOT with the
keychain's data key: a restore onto a fresh hub must not need the old hub's
master key, and the hub must not be able to decrypt its own archives.
