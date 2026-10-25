---
title: System backups and their encryption
last-verified: 2026-10-15
applies-to:
  - packages/system/src/builtins/backup-orchestrator/backup-orchestrator.addon.ts
  - packages/system/src/builtins/system-backup/system-backup.service.ts
  - packages/system/src/builtins/system-backup/backup-encryption.ts
  - server/backend/src/pending-restore.ts
covers:
  - packages/system/src/builtins/system-backup/backup-encryption.ts
  - packages/system/src/builtins/backup-orchestrator/encryption-key-store.ts
  - packages/system/src/builtins/backup-orchestrator/restore-archive.ts
  - packages/system/src/builtins/backup-orchestrator/backup-databases.ts
  - packages/addon-admin-ui/src/components/backup/BackupEncryptionCard.tsx
  - packages/addon-admin-ui/src/components/backup/RestoreWizard.tsx
  - packages/addon-admin-ui/src/components/backup/backup-databases.ts
  - packages/addon-admin-ui/src/components/backup/BackupDatabasePicker.tsx
  - packages/addon-admin-ui/src/components/backup/BackupNowDialog.tsx
  - scripts/ops/backup-decrypt.mjs
---

# System backups and their encryption

A system backup is one archive of a node's state, built once and fanned out to
every `backups` storage location a schedule (or a manual run) targets.

## What an archive holds

`DEFAULT_BACKUP_LOCATIONS`: `config.yaml`, `addons`, `addons-data`, `tls`,
`auto-update.json`. The settings database enters only as its owner's verified
snapshot, never as a copy of its live files (D693). `addons-data` carries the
library-owned state the keychain cannot hold — HAP pairing, the Matter fabric,
tailscaled's node state. The keychain master key is NOT in any location
(`.keychain/` is outside them), so a plain archive carries keychain ciphertext
but not the key.

## Which databases, and how often (D852)

The engine owns several SQLite files (`storage-files.md`). An archive carries the
ones the run SELECTED, each as its owner's verified snapshot — one
`database-snapshot.writeSnapshot({ databaseId })` per file, taken one after the
other — and no other. A file that exists but was not selected is left out of the
tar AND the entry list (a live file is never carried anyway) and named in
`manifest.omittedDatabases`.

- **An unstated selection is `['settings']`** (D382): `createArchive`, a manual
  `backup.trigger` and a schedule with no `databases` all mean the minimum. A
  nightly archive therefore cannot grow when a second file appears.
- **Cadence.** Settings runs nightly. Events and history are statistical stores
  (losing a week costs chart gaps, never configuration), so they ride the seeded
  weekly schedule — `weekly-events-history`, `0 4 * * 0`, databases
  `events + history`, the destinations of the existing schedules, retention 4.
  **A run that does not select `settings` is a snapshots-only archive**: no
  data-root file walk at all, just the selected owner snapshots and the manifest
  (`manifest.locations` is empty), so the weekly costs the two databases and not
  a second copy of the nightly. The seed happens **once ever**: the
  `seed-markers` records row `weekly-events-history` is written after the schedule
  and ends the seed for good, so a weekly the operator deleted or disabled is
  never re-created (D728). Not seeded when any schedule already carries `events`,
  nor on a hub that backs up nowhere. A weekly seeded by an earlier build (with
  `settings` in its list) is found, marked and left as the operator has it.
- **Nothing to carry is not a run.** A scheduled run that asks for events or
  history while neither file exists is skipped (logged, no archive, no outcome
  stamped; the schedule tick's wiring is pinned by
  `a-weekly-with-nothing-to-carry-is-skipped.spec.ts`). A snapshots-only
  `createArchive` whose owner has none of the selected files refuses outright. An owner that cannot be
  asked never causes a skip.
- **Retention is per cadence.** `applyRetention` counts only archives whose
  `databases` (what the run ASKED for, recorded on the `manifests.json` entry)
  match the archive just written; an entry without the field is `['settings']`. An
  entry that lists ids this build does not know keeps the known ones and is
  classified by them; one that lists only unknown ids is its own class, so no
  nightly ever counts or prunes it.
  Seven nightlies must not evict the weekly archive that holds the ledgers, nor
  four weeklies the nightlies.
- **The list is the owner's, read per run.** `listDatabases` answers every open
  file, so a file created at runtime is selectable from its first archive.
- **Restore** is suffix-generic: every `<db>.backup-snapshot` an archive carries is
  promoted over its database. A database the archive does not carry keeps its
  current live file, sidecars included — so restoring a weekly (events + history
  only) touches those two files and never settings or any data-root file. After a mixed-age restore (nightly
  settings, weekly events) cross-file references may dangle; every reader already
  treats a missing track or media as absent.

## The admin UI (System → Data → Backup)

- **What to back up.** `BackupDatabasePicker` (`components/backup/`) is the one
  selection control: the schedule editor and the "Back up now" dialog both use
  it, and `backup-databases.ts` holds the labels ("Configuration & files",
  "Events & detections", "History (statistics)"), the default (`['settings']`)
  and the selection → payload mapping. A new schedule and a manual run default
  to settings; a row with no `databases` shows as settings; saving always writes
  the list, in the server's order.
- **What exists.** `backup.listAvailableDatabases` (admin) answers the owner's
  open files. A database not open yet is shown disabled ("created when this
  feature is enabled"), never hidden; one already selected stays enabled so it can be unticked. An owner that did
  not answer (`answered: false`) is unknown and nothing is disabled on it.
- **Schedules and archives** show their databases as filled badges
  (`BackupDatabaseBadges`); a selection without settings is labelled "Snapshots
  only". An archive row without `databases` (legacy) reads as settings. Any edit
  of a schedule that re-sends it (enable toggle, retention) must carry
  `databases`, or the schedule falls back to settings.
- **Restore.** The wizard lists the databases the archive carries. A
  snapshots-only archive says it does NOT touch configuration, addons, addon
  data or certificates, and is restored with no `locations` whitelist: the
  whitelist applies to the tar extraction, and such an archive has no file
  locations to choose.

## A run

`backup-orchestrator` (hub builtin, `backup` cap) runs one build at a time
(D342): `SystemBackupService.createArchive` tars + gzips into
`<dataDir>/backup-staging` (outside every location), then each destination
receives the same bytes through the `storage` cap's chunked upload, and its
`manifests.json` index gets an entry (retention by count). The orchestrator
never knows what a destination is — the default local destination and an SMB
share are both a `backups` location.

## Restore

The restore dialog (`backup.restore`) downloads the archive into staging and
writes `.pending-restore.json`; on the next boot the launcher
(`server/backend/src/pending-restore.ts`) extracts it before any runner starts
— the only restore there is.

## Encryption (D800)

Opt-in from the Backup page. The hub keeps a backup **public** key
(`backup_encryption_keys`); the operator keeps the **secret** key, shown once
at setup and never stored. Why a key pair and not the keychain's data key or a
symmetric key the hub holds: scheduled runs must encrypt with nobody present,
but nothing on the hub — its database, its volume, the nightly appdata tar —
may be able to open an archive that already left; and a restore onto a fresh
hub must not depend on the old hub's master key (or survive only until a
keychain reset, D799).

| Step | Where | What |
| --- | --- | --- |
| set up / replace | `backup.setupEncryption` | new X25519 pair; public key stored, previous one retired (kept listed); secret key returned ONCE |
| every run | `createArchive({ encryptTo })` | the gzip stream is encrypted as it is written — no plaintext archive in staging; file `<id>.tar.gz.csbk` |
| destination index | `manifests.json` | `encryption: { scheme, keyId }` and the outline (locations, sizes) — not the file list |
| restore | `backup.restore({ backupSecretKey })` | missing / wrong key refused before the download; decrypted into staging (0600); the launcher extracts the plain `.tar.gz` as before |
| turn off | `backup.disableEncryption` | new archives plain; existing ones keep needing their key |
| no hub | `scripts/ops/backup-decrypt.mjs` | decrypts an archive with the key from a file or stdin |

Format `x25519-hkdf-aes256gcm-stream-v1`: header (magic, version, chunk size,
recipient key id, ephemeral X25519 public key, salt), then AES-256-GCM chunks
of 64 KiB with an 11-byte counter + final-flag nonce; the payload key is
HKDF-SHA256 over the X25519 agreement with the whole header in its info, so a
changed header byte fails the first chunk. A flipped, reordered, dropped or
appended chunk, a cut at a chunk boundary, and the wrong key all fail loudly.
Memory is one chunk per stream, whatever the archive size (hub archives are
~1.3 GB).

Rules that hold it together:

- A setting the store cannot read fails the run (`encryption setting
  unreadable`): an operator who turned encryption on never gets a plain
  archive by accident. A node with no settings store at all cannot have
  encryption set up and builds plain archives.
- An archive made before encryption (no header) restores without a key.
- The header is the authority at restore; the index entry only lets a wrong or
  missing key be refused before gigabytes are downloaded.
- The secret key travels in `backupSecretKey` / `secretKey` — credential-named
  for the log redactor, mutations only (never in a URL), never persisted.
