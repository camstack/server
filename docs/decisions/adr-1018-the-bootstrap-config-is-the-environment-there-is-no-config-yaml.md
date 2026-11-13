---
id: D1018
title: The bootstrap config is the environment; there is no config.yaml
status: accepted
date: 2026-11-07
supersedes:
applies-to:
  - packages/system/src/kernel/bootstrap-config.ts
  - packages/system/src/kernel/config-schema.ts
  - server/backend/src/main.ts
  - Dockerfile
---

## Context

The bootstrap schema had shrunk, release after release, to three keys:
`server.port`, `server.host` and `server.dataPath`, each already settable from
`CAMSTACK_PORT`, `CAMSTACK_HOST` and `CAMSTACK_DATA`. Everything else a yaml
could carry (auth, tls, keychain file locations, addon sets) had moved to the
keychain, the settings store or the admin UI, and was stripped when read. Agents
already run in production with no file at all. What remained was a second
source for three values, a `/config` volume that held nothing else, a
`CONFIG_PATH` variable, and a settings page that told the operator to edit a
file the container cannot easily reach.

## Decision

The bootstrap config is built-in defaults plus the environment, and nothing
else. `loadBootstrapConfig` takes no path and reads no file. The Settings
server section shows port, host and data path read-only and says they are set
by `CAMSTACK_PORT`, `CAMSTACK_HOST` and `CAMSTACK_DATA`. Backups no longer
archive `config.yaml`, and a restore skips that entry when an older archive
carries it.

A leftover `config.yaml` is not read. The one-release reader
(`legacy-config-yaml.ts`) applied a differing port, host or data path when the
environment variable was unset, so an update would not move a node silently.
Transition reader removed 2026-11-12: that module, its spec and the `js-yaml`
dependency of `@camstack/server/system` are gone. A node that still kept a
non-default value only in the file must set `CAMSTACK_PORT`, `CAMSTACK_HOST` or
`CAMSTACK_DATA`. A restore of an older archive still skips the `config.yaml`
entry (`RETIRED_CONFIG_FILE` in `pending-restore.ts`), so the file is not
written back.

## Consequences

The container contract changes (D717, D822): the image no longer sets
`CONFIG_PATH`, no longer declares `/config` as a `VOLUME`, and the entrypoint no
longer creates or chowns it. The generated compose and install rules of the CLI
(`setup-compose.ts`, `setup-install-rules.ts`) no longer map or mention
`/config`. The Unraid templates, the Proxmox script and the Compose example live
outside this repository and are aligned by hand: drop the `/config` mapping, and
set `CAMSTACK_PORT` / `CAMSTACK_HOST` / `CAMSTACK_DATA` where a non-default is
wanted. The external keychain master key is unaffected: it is the fixed path
`/run/secrets/camstack-master-key` (D991). A node with a non-default value in a
leftover file keeps working for one release, then must have set the variable.

## Enforcement

`boot-config-one-loader.spec.ts` (one loader; a leftover `config.yaml` does not
change the port), `pending-restore-sqlite.spec.ts` (an old archive's
`config.yaml` is not restored) and `mcp-setup.spec.ts` (no `/config` in
generated compose). `scripts/check-no-config-yaml.ts` refuses any runtime file
that names `config.yaml`, `config.yml` or `CONFIG_PATH`; the only exception is
`pending-restore.ts`, which skips the entry in an older archive.
