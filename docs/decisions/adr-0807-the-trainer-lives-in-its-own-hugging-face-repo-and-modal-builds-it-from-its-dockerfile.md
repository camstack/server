---
id: D807
title: The trainer lives in its own Hugging Face repo, pinned by commit, and Modal builds its image from the trainer's Dockerfile — no registry image yet
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - hf/camstack-trainer/Dockerfile
  - packages/addon-training/src/orchestrator/trainer-source.ts
  - packages/addon-training/src/providers/modal/dockerfile.ts
  - packages/addon-training/src/providers/modal/modal-sdk-gateway.ts
  - scripts/check-trainer-vendor.ts
---

## Context

The trainer imports Ultralytics (AGPL-3.0), so it must never run inside
CamStack (D661/D703) and its Corresponding Source must be public. The operator
asked for it to live on Hugging Face rather than in a GitHub repo. The plan
assumed a GHCR image Modal would pull; the A0 spike read the pinned `modal`
JS SDK (0.11.0) and found `images.fromRegistry(base).dockerfileCommands([...])`
— Modal can build the image itself, with no build context.

Rejected:

- **`source/trainer/` inside `camstack/camstack-models`.** That repo is a
  multi-GB LFS mirror under a collection licence; `pip install git+…` would
  clone it, and every model upload would move the trainer's revision pins.
- **A GHCR image built by a GitHub Actions workflow now.** It adds a registry,
  a workflow the operator must run, and a second artefact to keep in step with
  the source, for a provider that does not need it. A registry image becomes
  worth it with a provider that cannot build (RunPod, Phase C).

## Decision

**The trainer's source is the Hugging Face repo `camstack/camstack-trainer`
(AGPL-3.0), tracked in this repository as `hf/camstack-trainer/` and edited
only here. A job runs it at ONE commit sha (`TRAINER_SOURCE`, recorded on the
job and in `result.json`). The Modal provider fetches the trainer's
`Dockerfile` at that commit and builds the image as `fromRegistry(FROM)` plus
one `dockerfileCommands` entry per line, substituting the revision itself; a
Dockerfile instruction that needs a build context (COPY, ADD, multi-stage) is
refused, not approximated.**

- Every pip version in the image is pinned; the trainer is installed with
  `pip install "camstack-train[...] @ git+https://huggingface.co/camstack/camstack-trainer@<sha>"`
  (verified to resolve on 2026-10-08).
- The evaluation harness and the pipeline's postprocessors are vendored into
  the trainer byte-identical; `scripts/check-trainer-vendor.ts` fails on drift.
- The `modal` SDK is imported in exactly one file
  (`modal-sdk-gateway.ts`) behind a gateway interface; the provider and its
  contract tests run against a recorded fake.

## Consequences

- Publishing a trainer change is: edit `hf/camstack-trainer/`, upload it to the
  HF repo, put the new commit sha in `trainer-source.ts`, redeploy
  addon-training.
- Modal caches built layers, so the first job on an account pays the image
  build (several GB) and later jobs do not — the exact first-build time is
  unmeasured until a real run.
- Whether CoreML conversion of YOLOv9 works on Linux is unproven until a real
  run; the trainer drops the format with a recorded reason and Model Studio's
  `ensureEngineFormats` converts the ONNX on the Mac instead.

## Enforcement

`modal-provider.spec.ts` (the real Dockerfile parses; the revision is
substituted; context instructions are refused), `scripts/check-trainer-vendor.ts`,
and the trainer's own pytest suite (`hf/camstack-trainer/tests`).
