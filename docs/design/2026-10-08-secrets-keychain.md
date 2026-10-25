---
title: Secrets keychain — design and decisions (2026-10-08)
last-verified: 2026-10-08
covers:
  - scripts/ops/keychain-migrate-hub.mjs
---

# Secrets keychain — design and decisions (2026-10-08)

Status: **P1, P2 and the strict rule of P5 implemented** (D787, D788, D789);
**the env-carried secrets retired** (D797, §12).
P3 (in-product migration) was **dropped by the operator**; P4 is the one-off
operator script below. Architecture orientation:
[architecture/secrets-keychain.md](../architecture/secrets-keychain.md).

This record keeps the design as approved, with the operator's decisions applied
where they changed it. Where the two differ, the decisions win.

## 0. Why (the survey, 2026-10-08)

- Only mqtt-broker encrypted anything at rest (`enc:v1`), with its key file
  next to the ciphertext in every backup. Everything else — camera passwords,
  OIDC client secrets, Cloudflare / HA / Alexa / Wyze / notifier tokens — was
  plaintext JSON in `camstack.db`, plus `config.yaml` and library-owned files.
- Three secrets reached logs (cloudflared token on argv, Tailscale auth key in
  an error message, the magic-link login link) — fixed by D783 (P0).
- CamStack's system backups (which may go to S3 / SFTP) were the whole
  database, unencrypted.
- Admin forms received the stored plaintext on purpose (`hydrateSchema`).
- Agents keep no settings store: agent-placed addons read the hub's rows
  through `$hub-cap-fwd`, whose envelope carried no caller identity.

## 1. Threat model

**Protects against:** a copy of `camstack.db` (a stray `-wal`, a DB attached
to a support issue, the inert copy on an agent); CamStack's own backups (the
master key is not in `DEFAULT_BACKUP_LOCATIONS`); the nightly appdata tar —
**only** when the master key lives outside appdata; log leaks (central
redactor, nothing on argv); non-admin reads (D634 stays, and a blob holds a
marker anyway); the UI round-trip (a form, a HAR file, a screen share sees
"set"); accidental cross-addon reads (owner-checked — against bugs, not
malice).

**Does not protect against:** root on the host or a shell in the container; an
admin terminal session; a malicious addon (every runner is the same OS user,
can read the key file, and a runner's `childId` is self-declared); memory
dumps; library-owned files (v1); a secret typed into a non-secret field.

## 2. Key management (D788)

- **Hierarchy.** KEK (32 bytes, never in the database) wraps the DEK (32
  bytes, `keychain:keys`); the DEK encrypts values. Rotating the KEK re-wraps
  one row; no value is re-encrypted.
- **Sources — operator decision: configuration only, NO environment variable
  carries a key or a key path.** In order of primacy:
  1. `keychain.keyFile` in `config.yaml` (base64 or hex, 32 bytes), meant to
     be a read-only bind mount from outside appdata and outside the flash
     drive. `keychain` is a bootstrap-owned section: the settings store may
     not answer it.
  2. The desktop hub: the Electron main process keeps the KEK in the OS
     keychain (`safeStorage`, file `keychain-master.enc` in the app's user
     data) and hands the raw bytes to the hub over an inherited pipe
     (`--keychain-key-fd=3`), read once at boot and closed.
  3. `<dataDir>/.keychain/master.key` (0600 in a 0700 directory), generated on
     first boot — the fallback, flagged on the Secrets page because a
     whole-volume backup carries it next to the database.
  `keychain.previousKeyFile` is consulted only to unlock, so moving keys is:
  new file, old one as previous, restart, rotate, remove the previous entry.
  The design's `CAMSTACK_KEYCHAIN_KEY_FILE` / `CAMSTACK_KEYCHAIN_KEY` env
  sources were **removed** by the operator.
- **Fingerprint** `HMAC-SHA256(KEK, "camstack-keychain-v1")` is stored with
  the wrap; the page shows 16 hex chars.
- **Locked states** `key-missing`, `wrong-key`, `key-file-unreadable`,
  `store-unavailable`: `put` refuses, `resolve` answers `unavailable` per ref,
  never empty. A first boot generates keys only when nothing could be lost
  (no wrap AND no stored value).
- **Recovery key** download (audited, nagged until taken once), **rotation**
  (keeps the previous wrap until purged), **reset** for a lost key (archives
  the values into `keychain:secrets-orphaned-<ts>`, starts a new DEK).

## 3. Storage model (D787)

- **Ref** `secret://<owner>/<scope>/<fieldPath>`; scope `global`,
  `node/<id>` (perNode keys), `device/<id>`, `integration/<id>`,
  `row/<collection>/<id>`; array items by item id
  (`providers[authentik].clientSecret`), never by index.
- **Tables** `keychain:secrets` (ref, owner, scope, fieldPath, ciphertext,
  keyId, version, created/updated, updatedBy, coarse `lastReadAt`),
  `keychain:keys`, `keychain:audit` (writes, deletes, rotations, reveals,
  recovery downloads, orphan deletions, resets; 90 days / 20k rows; no
  per-read rows — operator decision Q5).
- **Envelope** `ck1.<keyId>.<iv>.<tag>.<ct>`, AES-256-GCM, AAD = ref.
- **Marker** `{"$secret": ref, "v": 1}`; the empty state is `null`, never `''`.

## 4. API

- `keychain` (internal): `put`, `resolve` (batched; `value` / `missing` /
  `unavailable` / `forbidden`), `delete`, `listMeta`, `getState`.
  `callerAddonId` is in no input schema.
- `keychain-admin` (admin): `status`, `listSecrets` (with usage), `listAudit`,
  `reveal` (**operator decision Q2: a generic, audited admin reveal** — the UI
  hides the value after 10 s), `deleteOrphans`, `rotateMasterKey`,
  `purgeRetiredKeys`, `downloadRecoveryKey`, `resetKeychain` (typed
  confirmation). The design's `migrationPlan` / `setMigrationMode` /
  `migrationReport` were **dropped** with P3.
- **Caller identity** (best-effort, against bugs): the parent stamps the
  connection's child id; the sibling short-circuit carries it to the serving
  child; an agent stamps its child and `$hub-cap-fwd` carries it, the hub
  dropping a stamp the sending agent does not host; a stamp overwrites the
  args, an unstamped wire call is stripped; only a hub in-process caller
  states its own id (`ctx.secrets`, `forOwner` for system doors).
- **Events** `EventCategory.KeychainChanged {ref, owner, version, change}` —
  never the value.

## 5. Schema integration

- Keychain-stored = `type: 'password'` or `secret: true`, not
  `storage: 'inline'`, not a JSON textarea; plus `secretStatePaths`
  (export-alexa, export-hap, cloudflare-tunnel, reolink). Never by name.
- **Save path** (every BaseAddon settings write): see the table in the
  architecture page. `''` never clears; `$secretClear` is the only clear;
  arrays by `itemIdKey`; put → blob → delete.
- **Strict (P5, operator decision):** a value the keychain cannot store is
  refused; plaintext never lands in a blob as a fallback. **No silent
  migration:** an addon's write-back of the same inline value keeps it inline;
  only an operator's write (or the one-off script, which is an operator
  client) moves it.
- **Doors:** device-manager `persistConfig` / `loadConfig` (declared
  `secretConfigPaths`, owner = the driver), `integrations.create` /
  `setSettings` / `getSettings` (the form's `secretKeys`, owner = the
  integration's addon; the form reads views), storage locations (the
  provider's declared keys, owner = storage-orchestrator).
- **Read:** markers resolve in one call before `resolveConfig`'s `typeof`
  check; unavailable → left out, reported, retried, never written back.
- **UI (D789, amends D780):** `hydrateSchema` emits the view for a marker,
  and for an inline value only in the addon's own forms
  (`inlineSecretsAsViews`). Camera-driver device forms get the view from the
  device-manager aggregate, which reads the stored blob raw (top-level
  marker keys only); a still-inline device secret keeps the driver's value.
  The secret control is one password input with an eye (reveal = audited
  `keychain-admin.reveal`; emptying a revealed or typed value = clear); a view
  sent as action input is resolved by its owner.

## 6. Migration — P3 DROPPED; P4 is a one-off operator script

Operator decision: **no migration code in the product.** No owner-run
migration, no modes, no plan/report, no rollback. The hub that holds plaintext
is migrated ONCE by `scripts/ops/keychain-migrate-hub.mjs`, which is not in
any package. It talks to the admin API with the operator's own token, never
prints a value, and every write goes through the product's ordinary OPERATOR
write paths (`addonSettings.updateGlobalSettings`,
`deviceManager.persistConfig`, `integrations.setSettings`).

### P4 procedure (run by the operator; never by an agent)

0. Preconditions: not between 04:00 and 05:30 (the appdata backup stops the
   hub); hub healthy; this release deployed (system force-published, server,
   the four addons with `secretStatePaths`, admin-ui).
1. **Decide the key source first.** For the live hub: create a 32-byte key
   file outside appdata and off the flash drive (e.g.
   `openssl rand -base64 32 > /mnt/user/system/camstack/keychain.key`,
   `chmod 600`), bind-mount it read-only into the container, and set
   `keychain.keyFile` in `config.yaml`. If the hub already booted with the
   default file, also set `keychain.previousKeyFile:
   /data/.keychain/master.key`, restart, open System → Secrets and Rotate.
   Check: state unlocked, source = key file, fingerprint shown. Download the
   recovery key into the password manager.
2. `node scripts/ops/keychain-migrate-hub.mjs plan` — the inline secrets by
   path (addon settings, device configs, integrations) and the stale
   `system-settings` rows. Compare with the survey inventory; anything
   missing is a bug — stop.
3. `node scripts/ops/keychain-migrate-hub.mjs backup` — a manual system
   backup (it is plaintext; it is deleted in step 7), recorded in
   `scratchpad/keychain-migration-state.json`.
4. `node scripts/ops/keychain-migrate-hub.mjs apply` — refuses without a
   verified backup or with a locked keychain. Moves every inline secret, then
   deletes the stale `auth.jwtSecret` / `auth.adminPassword` rows (operator
   decision Q3: those stay env / `config.yaml`).
5. One hub restart (not per-addon restarts).
6. `node scripts/ops/keychain-migrate-hub.mjs verify` — no inline secret left,
   keychain unlocked, stored values in use. Then the function smoke: cameras
   101 / 587 / 104 stream, HA broker connected, Cloudflare tunnel up, OIDC
   login, Loki shipping, Alexa token refresh, plus catalog catalog from the
   agent-placed model-studio. Then the discriminator (reading data proves
   nothing): pick ONE harmless credential whose failure is visible (e.g. the
   plus catalog API key on model-studio), Change it in its form to an invalid
   canary — only the keychain value changes, the blob's marker stays — and
   confirm the runtime now FAILS (catalog refused). Change it back and confirm
   it works. Repeat after `addons.restartAddon` (check the runner pid
   changed): a restart re-resolves.
7. **After the hub migration, delete only the most recent backups** that hold
   plaintext (operator decision Q6): `plaintext-backups` lists the pre-
   migration backups newest first; the operator picks, then
   `plaintext-backups --delete <destinationId>:<backupId> ... --confirm`.
   No secret is rotated for now (Q6).

mqtt-broker is left out of `apply` on purpose (it would store ciphertext): the
`mqtt` step of §12 decrypts its `enc:v1` values first.

## 7. UI

System → Secrets: key source, path, fingerprint, the shared-backup warning,
the pending-rotation and missing-recovery-copy notices; Download recovery key,
Rotate, Purge retired wraps, Reset (only when locked); the stored values with
owner, scope, field, updated, last read, usage and an audited Reveal; Delete
orphans (never `unknown`); the audit trail.

## 8. Logging

Central redactor in `LogManager`, the UDS child logger and the agent's
child-log forward: known values (registered by `ctx.secrets`, ≥ 8 chars) →
`‹secret:<ref hash>›`; URL credentials and credential CLI flags → `***`;
credential-named meta keys → `***` (a LOG heuristic only — storage is by
type).

## 9. Phases as shipped

| Phase | State |
| --- | --- |
| P0 hotfixes (D783) | shipped separately (argv/log fixes, schema declarations, redaction) |
| P1 core | shipped — caps, builtin, key sources, envelope, tables, audit, event, `ctx.secrets`, caller stamp, redactor |
| P2 schema integration | shipped — save path, marker, views, secret control, `secretStatePaths`, doors, Secrets page, D780 contract update |
| P3 in-product migration | **dropped** (operator) |
| P4 live run | the script above, run by the operator |
| P5 strict mode | shipped (refusal, no silent migration); archive encryption → roadmap |

## 10. Operator decisions (2026-10-08) — recorded

- No migration code in the product; one-off operator script (above).
- Storage keyed on schema TYPE, never names; name-only secrets fixed in the
  schemas (P0).
- Master key: config file / OS keychain / default file with a warning; **no
  env var** carries a key or a key path (correction to the design).
- Reveal: yes, generic, admin, audited, short-lived display.
- Audit: writes, deletes, rotations, reveals + coarse `lastReadAt`.
- JWT secret and admin bootstrap password stayed env / `config.yaml` in this
  record — **superseded by D797 (§12)**: the signing key moved into the
  keychain and the admin bootstrap became a fixed `admin` / `changeme`.
- Library-owned files out of v1 (roadmap).
- No rotation of exposed secrets now; delete only the most recent plaintext
  backups after the migration.

## 11. Follow-ups (not in this work)

- ~~Secrets still read from the environment~~ — done in D797 (§12), except
  the CLI's `CAMSTACK_TOKEN` (developer-side, handled separately).
- Notifier targets and LLM profiles (business collections) need their own
  door; JSON blobs holding secrets need splitting into fields; HA / Homematic
  / Dreame broker connections (`brokers[].connection.*`) are not in a form
  schema the save path reads; addon per-device stores (D4) have no operator
  adopt path; a device created before it registers persists its first config
  without its declared paths.
- ~~Encrypt CamStack system-backup archives with the DEK~~ — done by D800,
  with a separate backup key pair (public key on the hub, secret key with the
  operator), not the DEK; TOTP secrets into the keychain; library-owned files.

## 12. The env-carried secrets (D797, operator decisions 2026-10-08)

Operator rule: no secret travels through a server-side environment variable
(hub, agents, addons at runtime). Developer variables on the operator's Mac
(`HF_TOKEN` in `server/backend/.env` for the upload scripts, the CLI's <!-- drift-ok -->
`CAMSTACK_TOKEN`) are out of scope.

| Was | Now |
| --- | --- |
| `CAMSTACK_SECRET_KEY` + `.secret-key` — mqtt-broker's `enc:v1` codec | retired (no encryption, no env key); broker passwords are `password` fields in the keychain. Until migrated, an `enc:v1:` value is decrypted READ-ONLY with the existing `.secret-key` (no write); without it, an error naming the field — never "no password". The ops `mqtt` step moves the values into the keychain once. |
| `CAMSTACK_CLUSTER_SECRET` on the hub (also the Moleculer namespace) | OPTIONAL `password` field in System → Cluster (`system-config`), keychain owner `system`; empty = gate off, never generated. Not a namespace any more (TCP never checked it; UDP broadcast it in clear). |
| `CAMSTACK_CLUSTER_SECRET` on an agent / desktop agent | bootstrap credential in the agent's `agent.json` (0600), entered at first run (status page / desktop setup). |
| `CAMSTACK_JWT_SECRET` / `auth.jwtSecret` | keychain `secret://system/global/jwtSigningKey`, generated only on `missing`; locked keychain → sessions unavailable, loudly, no fallback; replaced only by `keychainAdmin.setSystemSecret`. |
| `CAMSTACK_ADMIN_USER` / `CAMSTACK_ADMIN_PASS` / `auth.admin*` | removed; a fresh hub seeds `admin` / `changeme` (first sign-in forces a change); an existing user is never overwritten (D728). |
| `HF_TOKEN` / `HUGGING_FACE_HUB_TOKEN` | removed from product code; downloads are anonymous; no code path needs auth, so no field. |

**Locked keychain at boot — chosen behaviour.** Session signing key: no
login and no bearer JWT verifies (`JwtSigningKeyUnavailableError`), error
logged, retried every 30 s. No admin call works meanwhile: API keys are
signing-key JWTs too and `cst_` scoped tokens authenticate as non-admin, so
System → Secrets (Reset, Rotate) is unreachable — recovery is the key file +
a restart. A truly lost key cannot be reset from the UI; since D799 the
operator creates the one-shot `<dataDir>/.keychain/RESET_KEYCHAIN` file on the
host and restarts. Cluster secret, when one is set: `$hub.registerNode` refused
with the retryable `CLUSTER_SECRET_UNAVAILABLE`. Neither ever falls back to
env or invents a value.

### Live-hub procedure for D797 (operator; never by an agent)

Prerequisites: the keychain is UNLOCKED (System → Secrets: ready) — the
signing-key change must never boot on a locked keychain; this release
deployed (system force-published, server, admin-ui, desktop agent,
mqtt-broker — which keeps reading its `enc:v1` values read-only, see step 5).

1. Collect the hub's current env values into a 0600 file on the host, e.g.
   `docker inspect camstack --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^CAMSTACK_(JWT_SECRET|CLUSTER_SECRET|SECRET_KEY)=' > /root/hub-secrets.env && chmod 600 /root/hub-secrets.env`
   (only the ones set). The first boot of this release generated a new
   signing key and logged everyone out once — expected. The operator signs in
   once (no pre-release token survives, and no `cst_` token is admin) and
   refreshes the token the script uses (`scripts/hub/hub.mjs login`).
2. `node scripts/ops/keychain-migrate-hub.mjs import-system --values-file /root/hub-secrets.env --config-yaml /mnt/user/appdata/camstack/config.yaml`
   — imports the session signing key (old tokens valid again) and the cluster
   secret (only if set; also from a plaintext `cluster.secret` settings row),
   and removes `auth.jwtSecret` / `auth.adminUsername` / `auth.adminPassword`
   from config.yaml.
3. Remove `CAMSTACK_JWT_SECRET`, `CAMSTACK_CLUSTER_SECRET`,
   `CAMSTACK_ADMIN_USER`, `CAMSTACK_ADMIN_PASS`, `CAMSTACK_SECRET_KEY`,
   `HF_TOKEN` from the hub's and every agent's container template.
4. Each agent: put the cluster secret (if the hub has one — Reveal it on
   System → Cluster) into its `agent.json` as `"secret"` (0600) — status page
   on port 4444, or the desktop Setup window on the Mac agent (blank keeps
   the current one). Restart the agent; it must show connected.
5. After the release, whenever convenient — nothing breaks in between, the
   addon reads the `enc:v1` values read-only meanwhile:
   `node scripts/ops/keychain-migrate-hub.mjs mqtt --mqtt-key-file <copy of /data/addons-data/mqtt-broker/.secret-key>`.
   Then restart mqtt-broker, check every broker connects, and only then delete
   the `.secret-key` on the hub and the local copy (deleting it earlier makes
   the leftover values an error).
6. `apply` (deletes the stale `auth.*` / `cluster.secret` rows), one hub
   restart, `verify` (also checks the signing key is stored and no `enc:v1`
   is left). Delete the values file.
7. Smoke: sign in (old viewer-app tokens work), an agent registers, every MQTT
   broker connects.

