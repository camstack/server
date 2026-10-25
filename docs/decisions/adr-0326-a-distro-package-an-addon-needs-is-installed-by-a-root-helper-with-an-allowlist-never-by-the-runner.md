---
id: D326
title: "A distro package an addon needs is installed by a root helper with an allowlist, never by the runner"
status: accepted
date: 2026-08-31
supersedes: D297
applies-to:
  - packages/system/src/kernel/deps/manifest-system-deps.ts
  - packages/system/src/kernel/deps/system-package-broker.ts
  - packages/system/src/kernel/deps/system-package-allowlist.ts
  - packages/system/src/kernel/deps/system-package-client.ts
  - scripts/docker/camstack-pkgd.mjs
  - scripts/docker/pkg-allowlist.json
  - Dockerfile
---

## Context

[D297](adr-0297-a-host-binary-an-addon-needs-is-declared-in-the-manifest-not-installed-by-the-addon.md)
put `smbclient` on `camstack.addons[].systemDependencies` and had the
**addon-runner** exec `apt-get`. The declaration is still right. The executor
was not.

Live hub 2026-08-31: every spawn of `smb-storage` logged

```
system dependency install failed
error="Command failed: apt-get update
E: List directory /var/lib/apt/lists/partial is missing. - Acquire (13: Permission denied)"
```

The runner is uid 1001. So is hub-main. `docker-entrypoint.sh` is root, then
`exec gosu camstack:camstack node`. D297's consequence *"the container runs as
root, so apt-get works"* described the entrypoint, not the process that ran
apt. Cloudflare, Tailscale onboard, ffmpeg and portable Python never hit this:
they download a standalone binary into a uid-1001 `dataDir` via
`ctx.deps.ensureBinary`. `smbclient` is a distro package with shared libraries,
so that path does not exist.

Giving `apt` to the runner (or to hub-main Node) would let any forked addon
install an arbitrary package. Unraid `Privileged: false` and the template's
lack of `--user` are already correct — the container *can* apt; Node must not.

## Decision

**The addon still declares. A root helper, started before `gosu`, installs
allowlisted packages. The runner never execs apt.**

- `camstack-pkgd.mjs` is **baked in the image** (not the data-root closure).
  `applyServerUpdate` must not replace a root process.
- Socket `/run/camstack/pkgd.sock`, mode 0660, group `camstack`. One JSON
  request per connection. One install at a time (apt's lock).
- Allowlist is `scripts/docker/pkg-allowlist.json`, duplicated in
  `DISTRO_PACKAGE_ALLOWLIST`. CI (`check-pkg-allowlist.ts`) fails if they
  drift. Expanding the list is an image rebuild; installing a listed package
  is not. Unknown names are refused before a socket write.
- Brew stays in-process: the logged-in user owns Homebrew.
- If the helper is down, the runner **warns and the capability refuses** —
  same honest surface as D297. It does not try apt as 1001.
- Standalone binaries keep `ensureBinary`. Do not apt `cloudflared`.

A future operator prompt for packages off the allowlist is compatible; it is
not this record.

## Consequences

SMB works after **one image rebuild + container recreate** (the helper has to
exist). Subsequent allowlisted packages do not need a recreate.

No host/Unraid role change, no `Privileged`, no sudoers, no docker.sock.
