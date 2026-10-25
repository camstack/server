---
id: D788
title: The keychain master key comes from config.yaml, the OS keychain or the data-dir fallback — never an environment variable
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/system/src/builtins/keychain/key-sources.ts
  - packages/system/src/builtins/keychain/platform-key-source.ts
  - packages/system/src/kernel/config-schema.ts
  - packages/system/src/kernel/system-settings-policy.ts
  - packages/desktop/src/keychain-platform-key.ts
  - packages/desktop/src/process-manager.ts
  - server/backend/src/boot/platform-keychain-key.ts
---

## Context

The keychain encrypts values under a data key wrapped by a master key (KEK).
Where the KEK lives decides what a stolen backup is worth. The first design
offered `CAMSTACK_KEYCHAIN_KEY_FILE` and `CAMSTACK_KEYCHAIN_KEY` as
environment variables. The operator refused both: an environment is inherited
by every runner the hub forks, readable from `/proc/<pid>/environ`, shown by
`docker inspect`, and stored in the Unraid template on the flash drive — which
is itself backed up. D783 already bans secrets from the environment.

## Decision

The KEK is loaded, in this order of primacy, from:

1. `keychain.keyFile` in `config.yaml` — a file of 32 random bytes (base64 or
   hex), meant to live OFF the data volume (a read-only bind mount);
2. the desktop app's OS keychain (Electron `safeStorage`), handed to the hub
   over an inherited pipe (`--keychain-key-fd=3`) because `safeStorage`
   exists only in the Electron main process;
3. `<dataDir>/.keychain/master.key` (0600 in a 0700 directory), generated on
   first boot — the fallback, which the Secrets page flags because a
   whole-volume backup carries it next to the database.

`keychain` is a bootstrap-owned section: no env var maps to it and the
settings store may not answer it. `keychain.previousKeyFile` is consulted only
to UNLOCK, so moving to a new key is: new file, old one as previous, restart,
`rotateMasterKey`. The KEK fingerprint (`HMAC(KEK, label)`) is stored with the
wrapped data key; a mismatch is `wrong-key`, a missing key `key-missing`, an
unreadable file `key-file-unreadable` — each locks the keychain, none starts an
empty one.

## Consequences

- The default file is NOT in `DEFAULT_BACKUP_LOCATIONS`, so CamStack's own
  backups never carry it. The nightly Unraid appdata tar does, which is why
  the live hub should configure `keychain.keyFile` outside appdata.
- A key file that does not exist yet is the operator's to create: the hub
  generates only the default file, and only when there is nothing to lose (no
  wrapped data key and no stored value).
- `CAMSTACK_JWT_SECRET` and the admin bootstrap password are unchanged by this
  record (Q3): they stay env / `config.yaml` until the operator decides.

## Enforcement

- `keychain-service.spec.ts`: default-file permissions, the backup-location
  exclusion, wrong-key / key-missing / unreadable states, the previous-key
  rotation, the recovery key.
- `platform-keychain-key.spec.ts` and `keychain-platform-key.test.ts`: the pipe
  hand-off and the OS-keychain store.
- Review only for "no env var": nothing scans for a new `CAMSTACK_KEYCHAIN_*`.
