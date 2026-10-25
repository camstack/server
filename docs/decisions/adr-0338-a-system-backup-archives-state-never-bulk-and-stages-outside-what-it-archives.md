---
id: D338
title: A system backup archives state, never bulk — and stages outside what it archives
status: accepted
date: 2026-09-04
supersedes:
applies-to:
  - packages/system/src/builtins/system-backup/**
  - packages/system/src/builtins/backup-orchestrator/**
---

## Context

System backups on the hub grew to gigabytes (staging alone: 175M → 503M →
4.5G+). Four causes, each measured live on 2026-09-04:

1. **node_modules were archived.** D27 made the *image* addons
   node_modules-free, but `AddonInstaller` still materialises runtime deps
   under `addons/@camstack/<addon>/node_modules` (~196 MB across 23 addons on
   the hub), and the tar walk had no filter — 9,090 of the first 11,593
   entries of a live archive were node_modules paths.
2. **Operator media was archived.** `addons-data/recorder/exports` held
   8.4 GB of exported clips; the "recordings/media are excluded" docblock only
   covered the top-level dirs, not the same content nested under a listed
   location.
3. **The staging dir lived INSIDE `addons-data`** — one of the locations
   being archived. Before the Jul 28 tar filter, every archive nested all
   previous archives; after it, leaked files still accumulated inside the
   backup set's own tree, invisible.
4. **Staging was never cleaned.** `triggerBackup` deletes its archive in
   `finally`, but a crash mid-fanout leaks it forever, and a restore download
   is consumed by the boot hook without ever being deleted. Two schedules due
   one tick apart also built two multi-GB archives concurrently
   (`setInterval` reentrancy), doubling the staging peak.

## Decision

A system backup captures restore-worthy STATE only. `node_modules` is never
archived, anywhere in the tree — only built `dist` + `package.json` + assets
(deps are reinstalled from npm). Bulk media nested under a backed-up location
(`DEFAULT_BACKUP_EXCLUDES`, at minimum `addons-data/recorder/exports` and the
legacy `addons-data/backup-orchestrator/staging`) is excluded in the walk, the
manifest, the location stats and the tar filter alike — the four must agree.

The staging dir lives at `<nodeDataDir>/backup-staging`, OUTSIDE every
location in `DEFAULT_BACKUP_LOCATIONS`, so a backup cannot contain a backup by
construction. It is deliberately not `<nodeDataDir>/backups`: with
`CAMSTACK_BACKUP_ROOT` unset (Electron, plain docker without the env) the
default `backups` destination seeds at exactly that path, and transient build
files must never mix into an archive destination. Staging is swept on every
orchestrator init (sparing only an archive a pending-restore marker still
references), and archive builds are single-flighted so peak staging disk is
one archive.

## Consequences

- A restored `addons/` tree has no node_modules; boot-time
  `ensureRequiredPackages` / a redeploy reinstalls deps. Restore of an addon
  whose deps cannot be re-fetched is out of scope for a system backup.
- The Create Backup modal's per-location sizes now reflect what the tar will
  actually contain.
- The legacy staging dir's leaked gigabytes are NOT auto-deleted — the
  orchestrator warns with the footprint and the operator reclaims the space.
- Excluding a new bulk subtree means adding it to `DEFAULT_BACKUP_EXCLUDES`,
  never a second filter site.

## Enforcement

`packages/system/src/builtins/system-backup/__tests__/system-backup.service.spec.ts`
(exclusion round-trips through a real tar + manifest + stats) and
`packages/system/src/builtins/backup-orchestrator/__tests__/staging-paths.spec.ts`
(staging placement, boot sweep, pending-restore sparing). Both were verified
RED against the unfixed code.
