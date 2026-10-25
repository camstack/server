---
id: D297
title: "A host binary an addon needs is DECLARED in the manifest; the runner satisfies it before caps register"
status: accepted
date: 2026-08-30
supersedes:
applies-to:
  - packages/types/src/interfaces/addon.ts
  - packages/system/src/kernel/deps/manifest-system-deps.ts
  - packages/system/src/kernel/moleculer/addon-runner.ts
---

## Context

The SMB storage provider drives `smbclient` — Samba's own tool — rather than a
JavaScript SMB implementation. That choice is the operator's, taken from his
`the reference plugin` plugin, which has run this exact route against this
exact NAS in production; every pure-JS SMB client on npm is a fork of the
abandoned `@marsaud/smb2` (last publish 2022-06-12), untested on Node 24, with
no upstream.

`smbclient` is on the Unraid host at `/usr/bin/smbclient` and **absent from the
CamStack container** (`which smbclient` → nothing; `mount.cifs` likewise). So
the binary has to arrive somehow. The first plan was a Dockerfile line, which
means an image rebuild and a container recreate — a materially heavier ship
chain than `camstack deploy`, for one addon's dependency.

The operator's own plugin does it differently: `installDependencies()`
(`~/Documents/Git/`the reference plugin`:243`, called from its
startup path at `:230`) runs `apt-get install -y smbclient` on Linux,
`brew install samba` plus an empty `/opt/homebrew/etc/smb.conf` on macOS, logs
"not supported yet" otherwise, and wraps the whole thing in a try/catch that
logs rather than throws.

That works, and it raises the question this record answers. CamStack already
has a mechanism for "this addon needs something installed, satisfy it before it
initialises": `camstack.addons[].python.requirements` →
`installManifestPythonDeps`, called from `addon-runner.ts` immediately before
`addon.initialize()`. A binary is the same question with a different package
manager. `CLAUDE.md` forbids a second mechanism where one exists.

## Decision

**Extend the framework. A host binary is declared, not installed by the addon.**

`AddonDeclaration.systemDependencies` is an array of
`{ binary, packages: { apt?, apk?, dnf?, brew? }, reason? }`. The declaration
names WHAT is needed and the package name each manager knows it by — a
translation table, because Debian calls it `smbclient` and Homebrew calls it
`samba`. HOW to install belongs to `installManifestSystemDeps`, so the next
addon that needs `rclone` or `mediainfo` does not re-answer it.

Same declaration site as `python`, same position in the lifecycle (before
`onInitialize`, so a capability never advertises itself while the binary it
wraps is missing), same idempotence contract.

It is deliberately NOT a shell command in the manifest. `"install": "apt-get
install -y smbclient"` would be a per-addon script the framework runs blind:
unportable, unverifiable, and the second mechanism under a different name.

Four properties, each of which is a test:

1. **Cheap on the common path.** The binary is probed first; the manager runs
   only when it is genuinely absent. Runners respawn routinely and a network
   round-trip on every boot is a cost the Python mechanism does not impose.
   (His plugin installs unconditionally; this does not.)
2. **Every boot, not once.** The install lands inside the container and is lost
   on every image update. Expected. "Already installed" is a success.
3. **Honest, not fatal.** A failure warns and returns; the addon still loads.
   Aborting here would take the runner's SIBLINGS down — `smb-storage` shares
   `execution.group: "remote-storage"` with SFTP, S3 and WebDAV.
4. **Exit 0 is not the claim.** The binary resolving is. The step re-probes
   after installing and reports a package that exited 0 without producing the
   binary.

**The other half is not optional: a capability whose binary is missing must
REFUSE, loudly.** `SmbBinaryUnavailableError` is raised by every SMB provider
method, and `list()` in particular throws rather than returning `[]` — an empty
listing would be read by a retention sweep as "nothing to keep", and an
unreachable location that reads as empty walks straight past D293's delete
guard (D296, lock 3).

## Consequences

**Ship chain.** No Dockerfile change, no image rebuild, no container recreate.
The mechanism is `packages/system` + `packages/types`, so it is a publish
train; the SMB provider itself is `camstack deploy
packages/addon-remote-storage`.

**The container runs as root** (`docker exec CamStack id` → uid 0), so
`apt-get` works. An unprivileged deployment gets the warn path and a provider
that refuses — which is the honest outcome, not a silent one.

**A new trust surface.** The framework now runs a package manager on the host
on an addon's say-so. It is bounded to a name from a fixed per-manager map,
executed via `execFile` with an argument vector (never a shell), and only for
an addon the operator installed. It is nonetheless a real increase in what
installing an addon means, and should be weighed before the second addon uses
it.

**Not addressed: the macOS `smb.conf` quirk.** Homebrew's `samba` needs
`/opt/homebrew/etc/smb.conf` to exist before `smbclient` will run. That is a
condition for RUNNING the binary, checked on every call, not for installing it
— so it does not belong in an install mechanism, and it is not implemented
here. The macOS desktop build therefore installs `samba` and may still fail at
first use, with the mapped SMB error rather than a crash. Closing it is one
small piece of work in the provider's readiness path.

## Enforcement

`packages/system/src/kernel/deps/__tests__/manifest-system-deps.spec.ts` —
eight cases, one per property above plus the two "declines and says so"
branches. Disarming any single implementing line turns at least one red.

Nothing checks that a capability whose binary is missing refuses; that is
per-provider and is asserted for SMB in `smb-provider.spec.ts`. A second addon
using this mechanism should carry the same three assertions (refuses, does not
return empty, recovers without a restart).

## Related

- D296 — the storage-access constraint, and why "unreachable" must never read
  as "empty".
- D29 — `execution.group` co-location; why an install failure must not be fatal
  to the runner.
- `docs/design/2026-08-30-smb-storage-provider.md` §Stage-2 and §8, superseded
  by the choice of `smbclient` over a JS client.
