---
id: D728
title: The configured admin password seeds the first boot and never overwrites an existing one
status: accepted
date: 2026-10-06
supersedes:
applies-to:
  - packages/system/src/auth/user-manager.ts
  - packages/system/src/builtins/local-auth/admin-account-boot.ts
---

## Context

`UserManager.ensureAdminExists` ran on every boot of `local-auth`. When the
configured admin (`auth.adminUsername`, `CAMSTACK_ADMIN_USER`) already existed,
it compared the stored hash with the configured password (`auth.adminPassword`,
`CAMSTACK_ADMIN_PASS`, schema default `changeme`) and, when they differed,
re-hashed and wrote the configured one — the comment called config "the source
of truth". So a password the operator changed in the admin UI went back to the
configured one at the next restart:

- on a Mac hub, whose desktop app sets no admin password, every restart put the
  admin back on `changeme`;
- on a container without `CAMSTACK_ADMIN_PASS`, the same;
- on a container with it (the live hub), every restart put back the template's
  value, so a UI change lasted until the next update.

The first-login detour the admin UI already has (signing in with `changeme`
forces `/change-password`) made it worse rather than better: the operator was
made to choose a new password on every boot, and every boot discarded it. The
boot-time WARN about the default password read the CONFIG value, not the stored
one, so it fired forever on a hub whose admin had changed it and said nothing
useful either way.

## Decision

The configured admin credentials are a SEED. `ensureAdminExists` creates the
configured admin only when no admin account exists at all, and never writes the
password of an existing account. A configured username that does not match the
existing admin does not create a second admin.

Recovering a forgotten password is an explicit, one-shot request: an empty file
named `RESET_ADMIN_PASSWORD` in the node's data directory (`/data` in the
container). At boot `local-auth` resets the configured admin's password to the
configured one and DELETES the file. A file, not an environment flag, because a
flag stays set in a container template until someone remembers to remove it,
and while set it would revert the password on every boot — the defect itself.

While the admin still signs in with the default password, every boot logs a
WARN — decided by a bcrypt comparison against the stored hash, never by the
config value, and never logging the password. The admin UI's existing
first-login detour remains the place the operator is made to change it.

## Consequences

- Changing `CAMSTACK_ADMIN_PASS` (or `auth.adminPassword`) on an existing
  install does nothing. The Unraid template's description says so.
- An install whose `users` table is wiped (the destructive `declareCollection`
  rebuild) still comes back with the configured admin: an empty table is a
  first boot.
- If the trigger cannot be deleted, the hub logs an ERROR naming the path, since
  every restart would then reset the password again.

## Enforcement

`packages/system/src/auth/__tests__/admin-password-seed.spec.ts` boots a real
`UserManager` + `AuthManager` (bcrypt) twice over one users table, changes the
password between boots the way the UI does, and requires it to survive; it fails
against the previous `ensureAdminExists`. It also covers the one-shot trigger
and the hash-based default-password warning.
