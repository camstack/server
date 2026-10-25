---
id: D714
title: The release pushes the Unraid templates to the public distribution repo
status: superseded
superseded-by: D717
date: 2026-10-06
supersedes:
applies-to:
---

## Context

[D22](adr-0022.md) generates `unraid/` from the image contract and distributes it
from the public `camstack/unraid-templates`, with the copy between the two repos
left as a deliberate manual step: "it will be forgotten. That is accepted rather
than automated … If it becomes a real problem, automate it then."

It became one. On 2026-10-06 the public templates still carried the
`1.2.19` stamp from 2026-07-28 while the tree had reached `1.2.456`. Every new
Unraid install in between got `--shm-size=2g` (a flag the image no longer
needs), a frame-ring variable nothing reads, no `/backups` mapping although the
image declares it a `VOLUME`, and no `--pids-limit=8192` — the flag whose absence
had been measured refusing thread creation on this hub. The generator and its
guard were green throughout; the hop they cannot see is the one that rotted.

## Decision

The `sync-unraid-templates` job in `release.yml` copies `unraid/` into
`camstack/unraid-templates` on every tag release, after the release is
published, on the self-hosted `agent-a` runner only. It first re-runs
`deployment-templates.ts --check`, so a stale tree is refused rather than
shipped. It authenticates with the `UNRAID_TEMPLATES_TOKEN` secret (a
fine-grained PAT with Contents read/write on that one repository), and it never
fails the release: a missing secret, a refused clone or a refused push each end
the job with a `::warning` that names what to fix.

## Consequences

- A cross-repo token now exists in this repository's secrets, scoped to the
  public templates repo only. Its blast radius is a public repo whose content is
  generated here and recoverable from any commit — the trade D22 refused is
  smaller than the drift it allowed.
- Until the secret is added, every release logs the warning and the manual copy
  in `docs/architecture/unraid.md` is still the path.
- A template change still reaches new installs only (D22). Pushing faster does
  not change what an installed container sees.

## Enforcement

The job itself: it refuses a stale tree (`--check`) and warns, by name, when it
could not push. Nothing checks that the warning is read.
