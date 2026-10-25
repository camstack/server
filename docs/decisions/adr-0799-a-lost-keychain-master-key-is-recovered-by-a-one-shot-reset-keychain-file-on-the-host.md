---
id: D799
title: A lost keychain master key is recovered by a one-shot RESET_KEYCHAIN file on the host — it acts only on a locked keychain and clears the system-held markers
status: accepted (the cluster secret marker it clears no longer exists since D857; the rest stands)
date: 2026-10-09
supersedes:
applies-to:
  - packages/system/src/builtins/keychain/keychain-reset-trigger.ts
  - packages/system/src/builtins/keychain/keychain-service.ts
  - packages/system/src/builtins/keychain/keychain-store.ts
  - packages/system/src/builtins/keychain/keychain.addon.ts
  - packages/types/src/capabilities/keychain-admin.cap.ts
  - packages/addon-admin-ui/src/components/system/secrets/KeychainNoticeContent.tsx
---

## Context

D797 moved the session signing key into the keychain. A locked keychain
(`wrong-key`, `key-missing`, `key-file-unreadable`) therefore leaves no session
that verifies: every admin credential is a signing-key JWT and a `cst_` token
is never admin. `keychainAdmin.resetKeychain` existed but sat behind the very
login it was meant to rescue — a hub whose master key was truly lost could not
be administered at all (security hardening plan §2).

Reading the existing reset while fixing this found three more defects in it:

- it archived the values but DELETED the wrapped data keys, so the archive
  could never be opened even if the lost key turned up;
- it cleared no marker. The cluster secret's marker (`system-settings`
  `cluster.clusterSecret`) kept pointing at an archived value, so the gate
  read `unknown` and refused every agent forever;
- with a configured `keychain.keyFile` that was missing, it archived
  everything and then stayed locked — values gone for nothing.

Options weighed: the trigger file, and a host CLI that opens the database
offline. The CLI is a second writer of the keychain tables and awkward in
Docker (no `exec` into a stopped container). An environment flag was rejected
outright: it stays in a container template and re-arms on every boot (the
defect `RESET_ADMIN_PASSWORD` replaced).

## Decision

The operator recovers a lost master key by creating
`<dataDir>/.keychain/RESET_KEYCHAIN` on the host and restarting. At keychain
boot, right after the unlock:

- **locked for a key reason** → reset as actor `trigger-file`, then delete the
  file;
- **unlocked** → ignored, deleted, warned. A forgotten file never destroys a
  working store;
- **locked because the store cannot be read** → left armed; nothing could be
  reset yet;
- the file's content is not read and **no environment variable** arms it.

A reset — the file's or the page's — refuses BEFORE touching anything when the
configured primary source cannot give a key; otherwise it archives every value
(`keychain:secrets-orphaned-<ts>`) AND every wrapped data key
(`keychain:keys-orphaned-<ts>`), writes a new master key (default file; a
configured file is used as it is), creates a new data key, clears the
system-held markers (`SYSTEM_SECRET_SETTINGS_KEYS`), emits one `delete` event
per archived ref so every keeper reloads (local-auth then generates a new
signing key on `missing`), records the reset (`keychain:resets`) and audits it.
System → Secrets shows "the keychain was reset — re-enter secrets" with the
fields still to re-enter (never a value) until an admin dismisses it.

## Consequences

- Same trust boundary as the key: whoever can write the data directory can
  read the default master key already.
- Everyone signs in again after a reset (new signing key); the admin password
  is not in the keychain and still works.
- After a reset the cluster gate is OFF until the operator sets the cluster
  secret again — the alternative was a hub that refuses every agent forever.
  The notice says so.
- The page's own Reset takes the same path, so it now also keeps the old wraps
  and clears the markers.

## Enforcement

`packages/system/src/builtins/keychain/__tests__/keychain-reset-trigger.spec.ts`
— locked + file, unlocked + file, file removed after use, refused before
archiving, store-unavailable deferral, the archived wraps, the reset record and
re-entry list, and env variables that must not arm it.
`packages/addon-admin-ui/src/components/system/secrets/__tests__/reset-detail.spec.tsx`
and `packages/addon-admin-ui/src/pages/system/__tests__/secrets-page.spec.tsx`
— the notice (since 2026-10-08 a line in the page's single notice region).
