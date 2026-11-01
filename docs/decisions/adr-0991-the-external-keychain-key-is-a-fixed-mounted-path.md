---
id: D991
title: The external keychain key is a fixed mounted path
status: accepted
date: 2026-11-01
supersedes:
applies-to:
  - packages/system/src/builtins/keychain/key-sources.ts
  - packages/system/src/builtins/keychain/keychain-service.ts
  - packages/system/src/kernel/config-schema.ts
  - packages/system/src/kernel/bootstrap-config.ts
---

## Context

D788 put the external master key behind `keychain.keyFile` and
`keychain.previousKeyFile` in `config.yaml`. `config.yaml` is being removed
(#342), and a key location is the one setting that must not live in a file a
UI or a backup of the data volume can reach. The alternatives were rejected:

- **Keep the config.yaml key.** It needs the file #342 deletes, and an
  operator must edit a file inside the data volume to say where the key
  outside it lives.
- **An environment variable carrying the path.** D783 / D797 keep secret
  material and its paths out of a node's environment, and it is one more knob.
- **A UI key upload.** It would write the key into the data volume, defeating
  the separation the external key exists for.

## Decision

The external key is a file at a FIXED path, no config, no env var:

- `/run/secrets/camstack-master-key` is the primary source when the file
  EXISTS at boot (the Docker / Compose secrets convention; Unraid and Proxmox
  bind-mount a file there). CamStack only reads it: never writes, never
  creates it.
- `/run/secrets/camstack-master-key.previous` is unlock-only, to rotate from
  one external key to another.
- Absent: unchanged — the desktop OS keychain when present, else
  `<dataDir>/.keychain/master.key`.

The two paths are constants in `key-sources.ts`; specs inject the directory.
Source kinds `config-file` / `previous-config-file` become `mounted-file` /
`previous-mounted-file`. A yaml that still carries `keychain.keyFile` /
`previousKeyFile` boots, with one `[Phase1] WARN` line telling the operator to
mount the file instead.

UI behaviour: rotating from Data → Secrets with the default file generates a
new key; with the mounted file it re-wraps when a new mounted key is pending
(default or previous key unlocked, a mounted key now present), otherwise it
refuses with the two paths. The recovery key download is unchanged; a restore
places it at the mounted path or the default path.

## Consequences

- A container that mounted a key through `keychain.keyFile` must mount it at
  the fixed path (mirror by hand in the Unraid template, Proxmox script and
  Compose example, D717).
- A mounted file that disappears makes the default file the primary on the
  next boot; if the data key was wrapped under the mounted key the keychain
  locks `key-missing` instead of starting empty.

## Enforcement

`key-sources` / `keychain-service` specs (mounted vs default primary, rotation
without writing to the secrets directory, the previous file unlocks) and the
`bootstrap-schema` spec (the retired keys warn once and do not fail boot).
