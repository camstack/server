---
id: D384
title: Never-ran must never look like ran — an attempt stamp is not a success stamp
status: accepted
date: 2026-09-07
supersedes:
applies-to:
  - packages/system/src/builtins/backup-orchestrator/**
  - packages/addon-remote-storage/src/providers/smb/**
---

## Context

The operator, 2026-09-07: *"the SMB backup is enabled, it says last run
tonight, but there is nothing there."*

Measured on the hub. `backup.listDestinations` reported, for `backups:smb`:
`enabled: true`, `cron: "0 3 * * *"`, `nextRunAt: 2026-09-08 03:00`, no error.
`backup.listArchives` reported `[]`. Both statements were true about different
things and together they were a lie. Four independent defects stacked:

1. **A dead cadence was advertised as live.** `cron` and `nextRunAt` came from
   `backup_destination_policies.cron`, a column seeded `0 3 * * *` for every
   new `backups` location and read by NOTHING since the schedules refactor
   (2026-07-28) removed the per-location tick and
   removed its migration. The sibling destination proved it: `backups:default`
   advertised a nightly 03:00 cadence while its only schedule was DISABLED,
   with `lastRunAt` frozen at 2026-07-28 05:01 (the last tick the retired
   scheduler ever ran) and `nextRunAt` at 2026-07-29 03:00 — six weeks in the
   past, and nobody noticed, because a next-run computed from a frozen
   last-run looks like a number rather than like a stopped clock.

2. **The attempt stamp was rendered as a success stamp.** The schedule tick
   writes `lastRunAt = now` BEFORE firing, on purpose: it is the dedupe anchor
   and the cron's "after" cursor. It was documented as *"ms-epoch of the last
   successful run"* and surfaced under that name. The `Unraid` schedule really
   did fire at 03:00:26 and really did deliver nothing.

3. **A run that delivered nothing reported success.** `runBackupBuild`
   swallows per-destination errors on purpose (one bad sink must not kill the
   others), so the queue saw a resolved executor and finished the run
   `succeeded` — with `completedDestinationIds: []` and
   `failedDestinationIds: ["backups:smb"]` sitting in the same object. And
   `backup.trigger` resolved with `entries: []` and no error, so the caller
   could not tell either.

4. **The reason existed only in RAM and in a log line.** The refusal
   (`smb-storage: location "backups:smb" missing config.share`) was logged at
   03:00 and recorded on an in-memory run. The hub restarted five times that
   morning; `docker logs` had rotated past 03:00 by 07:44. By the time anyone
   looked, no surface anywhere held the reason. Nothing about the destination
   said it had ever been tried.

Underneath all four, a fifth: the SMB provider's own post-transfer check.
`samba-client`'s `list(x)` runs `smbclient -c 'dir x'`, and smbclient's `dir`
argument is a wildcard MASK evaluated in the current directory — it does not
descend into a directory named by it. `statRemote` and `list` passed a bare
directory path, and `''` for the root, so an empty mask matched nothing.
Every SMB destination was write-only and then disowned: the bytes landed, the
`is it there?` check said no, the upload was refused, retention could not see
an archive and the manifest never grew. The unit suite was green throughout
because its fake client treated the argument as a directory — the fake
supplied the semantics production assumed and smbclient does not have.

## Decision

**An attempt is not a success, and a surface says which one it saw.**

- A schedule and a destination each carry `lastAttemptAt` (stamped whatever
  the outcome), `lastSuccessAt` (only when an archive landed) and `lastError`
  (verbatim, cleared by the next success). No field means both.
- **A destination's advertised cadence comes only from the enabled schedules
  that fan out to it.** A destination no enabled schedule targets shows no
  cron and no next run. `backup_destination_policies.cron` is written NULL,
  never read, and `upsertDestinationPolicy` no longer accepts a cadence.
- **A run that selected destinations and landed the archive at none of them is
  `failed`**, and the error names them. Partial delivery stays `succeeded` —
  `failedDestinationIds` already says the rest.
- **A per-destination failure is PERSISTED, not just logged.** An explanation
  that lives only in a rotating log and an in-memory run record is an
  explanation this hub does not have.
- **A path that drops work names what it dropped**: the empty-selection branch
  names the requested destinations, and a scheduler that cannot arm (no
  settings backend) says so once instead of ticking silently forever.
- **`smbclient dir` takes a mask**: every listing goes through `listMaskFor`
  (`'' → '*'`, `'a/b' → 'a/b/*'`), and the test fake models the mask, not a
  directory walk.

## Consequences

- `BackupDestinationInfo.lastRunAt` is gone, replaced by `lastAttemptAt` +
  `lastError`; `BackupSchedule.lastRunAt` likewise, plus `lastSuccessAt`. A UI
  reading the old name shows nothing rather than a lie, which is the point.
- `upsertDestinationPolicy` no longer takes `cron`. Cadence is edited on a
  schedule, in one place.
- The `cron` column stays in the table (writing NULL) rather than being
  dropped: the storage surface has no migration for a removed column, and a
  column nothing reads cannot lie again.
- Two SQLite columns are added to each of `backup_destination_policies`
  (`last_error`) and `backup_schedules` (`last_success_at`, `last_error`).
- Rows written before 2026-07-28 keep an honest `last_run_at`: under the
  retired scheduler that column already meant "attempted".

## Enforcement

Tests, all of which fail when the corresponding fix is removed (verified):

- `packages/system/src/builtins/backup-orchestrator/__tests__/a-run-that-delivered-nothing-is-not-a-success.spec.ts`
  — the queue's terminal state.
- `packages/system/src/builtins/backup-orchestrator/__tests__/a-destination-that-never-ran-does-not-look-like-it-ran.spec.ts`
  — drives the real addon against a storage cap that refuses one destination
  the way the live SMB provider did: the failure is persisted and readable
  through `listDestinations`, a later success clears it, and a destination no
  enabled schedule targets advertises no cadence.
- `packages/addon-remote-storage/src/providers/smb/__tests__/smb-provider.spec.ts`
  — the fake now models smbclient's mask semantics, so a root listing that
  sees nothing is a red test rather than a green one.

No guard script: the rule is about what a field MEANS, which a linter cannot
read. The tests are the enforcement.
