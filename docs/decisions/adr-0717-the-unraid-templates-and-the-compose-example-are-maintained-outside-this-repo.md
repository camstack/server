---
id: D717
title: The Unraid templates and the Compose example are maintained outside this repo, by hand, with no guard
status: accepted
date: 2026-10-06
supersedes:
  - D22
  - D23
  - D714
applies-to:
  - AGENTS.md
---

## Context

[D22](adr-0022.md) generated `unraid/**` from the image contract,
[D23](adr-0023.md) generated `docker-compose.yml` from the same spec, and
`scripts/check-deployment-templates.ts` refused drift on every commit. The <!-- drift-ok -->
distribution copy lived in the public `camstack/unraid-templates`, so every
template existed twice. The second copy is the one that rotted: it sat at the
`1.2.19` stamp while the tree reached `1.2.456`, with the generator and its
guard green throughout. [D714](adr-0714-the-release-pushes-the-unraid-templates-to-the-public-distribution-repo.md)
answered that with a release job that pushed the copy, needing a PAT secret.

The generator, guard, pre-commit block, publish-train regeneration and release
job were a lot of machinery for files that change only when the container
contract changes. The server is now stable, the contract rarely moves, and the
operator wants one source.

## Decision

The Unraid templates live only in `github.com/camstack/unraid-templates`, the
Proxmox install script in `github.com/camstack/proxmox`, and the Docker Compose
example only in the public docs (`camstack/docs`). This repo carries none of
them, nor a generator, nor a guard. A change to the container contract — an
environment variable the code reads, a port it binds, a volume, a device — is
mirrored by hand in those places in the same piece of work.

## Consequences

- One copy of each template, in the repository users actually install from.
- Nothing checks the mirror. A new environment variable that is not added to
  the templates is invisible until a user misses it.
- The publish train no longer regenerates templates, and the release no longer
  needs `UNRAID_TEMPLATES_TOKEN`.

## Enforcement

Nothing, review only: a rule in `AGENTS.md` names the obligation. The cost of a
miss is a missing setting in a new install, which is why the rule asks for the
mirror in the same change rather than later.
