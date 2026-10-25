---
id: D800
title: System backups are encrypted, opt-in, to a backup PUBLIC key — the hub cannot decrypt its own archives, and the operator keeps the secret key
status: accepted
date: 2026-10-09
supersedes:
applies-to:
  - packages/system/src/builtins/system-backup/backup-encryption.ts
  - packages/system/src/builtins/system-backup/system-backup.service.ts
  - packages/system/src/builtins/backup-orchestrator/backup-orchestrator.addon.ts
  - packages/system/src/builtins/backup-orchestrator/encryption-key-store.ts
  - packages/system/src/builtins/backup-orchestrator/restore-archive.ts
  - packages/system/src/builtins/backup-orchestrator/manifest-store.ts
  - packages/types/src/capabilities/backup.cap.ts
  - packages/addon-admin-ui/src/components/backup/**
  - scripts/ops/backup-decrypt.mjs
---

## Context

A system backup carries the settings-database snapshot, `config.yaml`,
`addons-data` (library-owned secrets the keychain cannot hold: HAP pairing,
Matter fabric, tailscaled node state) and `tls`. It was a plain `.tar.gz`, and
it leaves the host (an SMB share, the default destination's disk). The
hardening plan (§4.1, risk 8) asked for encryption and left open WHICH key.

Three candidates:

1. **The keychain data key.** The hub decrypts its own archives, and a restore
   onto a fresh hub needs the old hub's master key — the hub that just died.
   A keychain reset (D799) would strand every backup.
2. **A separate symmetric backup key held by the hub.** Scheduled runs work,
   but the key that decrypts every archive sits in the hub's database — so in
   every copy of it, in the nightly appdata tar, in any snapshot of the
   volume. The archives on the share are exactly as safe as the hub.
3. **A key pair: the hub holds the PUBLIC key, the operator the secret one.**
   Scheduled runs encrypt unattended; nothing on the hub, in its database or
   in a copy of its volume can open an archive that already left.

## Decision

Option 3, opt-in from the Backup page. Setup generates an X25519 pair, keeps
the public key (`backup_encryption_keys`), returns the secret key ONCE with a
store-it-safely warning, and never stores it. Every run then encrypts the gzip
stream as it is written — `x25519-hkdf-aes256gcm-stream-v1`: an ephemeral
X25519 agreement, HKDF-SHA256 bound to the whole header, AES-256-GCM in 64 KiB
chunks with a counter + final-flag nonce (age's STREAM construction) — so no
plaintext archive touches staging and memory is one chunk whatever the size.
The file is `<id>.tar.gz.csbk`; the destination's clear index records the key
id and the archive outline (locations, sizes), not the file list.

Restore asks for the secret key for an encrypted archive only, refuses a
missing or wrong key before downloading, decrypts into the hub's private
staging (0600) and hands the unchanged boot-time restore a plain `.tar.gz`. An
archive made before encryption, or with it off, restores without a key.
Replacing the key retires the old public key (listed: older archives need it);
turning encryption off makes new archives plain. A setting the store cannot
read fails the run — never a plain archive by accident. `scripts/ops/backup-decrypt.mjs`
decrypts with no hub at all (key from a file or stdin, never argv or env).

The plan's recommendation to include the backup key in the keychain's
recovery download is NOT taken: the hub does not have the secret key to
include, which is the point.

## Consequences

- The operator owns the secret key. Lose it and the encrypted archives are
  unrecoverable by anyone; the UI says this at setup and cannot be dismissed
  without the operator confirming it is stored.
- The hub cannot verify an encrypted archive's contents after upload (it
  cannot read it); the end-to-end spec is what pins the round trip.
- The destination index still shows locations, sizes and dates — metadata,
  not content.
- The secret key travels once over the admin session at setup and at each
  restore (a mutation, never a URL); it is never logged (the input field is
  credential-named for the redactor) and never persisted.
- Encryption is destination-agnostic: the default destination, SMB and any
  other `backups` location receive the same ciphertext.

## Enforcement

`system-backup/__tests__/backup-encryption.spec.ts` (round trips, wrong key,
flipped / reordered / truncated / header-tampered input, bounded memory),
`system-backup/__tests__/encrypted-archive.spec.ts`,
`backup-orchestrator/__tests__/encrypted-backup-run.spec.ts` (through the real
addon: public key only, ciphertext uploaded, restore asks and refuses before
download, key replacement, disable, fail-closed setting read),
`server/backend/src/__tests__/encrypted-backup-restore.spec.ts` (hub-built
archive → `prepareRestoreArchive` → `applyPendingRestore`, and the offline
script agreeing byte for byte).
