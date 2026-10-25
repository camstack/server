---
id: D822
title: Docker image accel variants are Dockerfile targets, not one universal image
status: accepted
date: 2026-10-09
applies-to:
  - Dockerfile
  - .github/workflows/release.yml
  - docs/architecture/deploying.md
---

## Context

The image baked the Intel GPU apt stack, the Intel NPU userspace tarball, and
`ENV LIBVA_DRIVER_NAME=iHD`. That pin breaks VAAPI on AMD (`radeonsi`). Putting
Mesa beside Intel in one image would fix the pin only if it were removed, and
would still ship hundreds of MB of Intel/NPU userspace to every AMD host. ROCm
and XRT must never enter the image either way. The release matrix already
tagged by accel (`intel-<version>`, `intel-latest`) and expected a second
target.

## Decision

One `Dockerfile`, one npm `fetch` stage, a shared `runtime-common`, and two
final stages: `intel` and `amd`. CI builds both (`docker build --target …`) and
publishes `ghcr.io/camstack/camstack:{intel,amd}-<version>` plus the matching
`-latest` tags. Unraid stays on `intel-*`. Proxmox / AMD APU hosts use `amd-*`.
Hub vs agent remains `CAMSTACK_ROLE` on either variant.

## Consequences

- Release wall time grows by a second matrix leg (shared BuildKit cache for
  `runtime-common` keeps the delta mostly the vendor apt layer).
- Template / compose / Proxmox install scripts must name the accel tag; a bare
  `:latest` stays forbidden.
- Intel hubs must not be switched to `amd-*` (no iHD / Level Zero / Intel NPU).

## Enforcement

Nothing automated beyond the release matrix. Review: a new vendor stack is a
new `--target` + matrix row, not packages piled onto `runtime-common`.
