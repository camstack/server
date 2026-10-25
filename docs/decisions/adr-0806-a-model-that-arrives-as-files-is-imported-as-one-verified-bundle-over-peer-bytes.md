---
id: D806
title: A model that arrives from another addon as files is imported as ONE verified bundle over peer bytes, into the flat modelsDir, with revisions
status: accepted
date: 2026-10-08
supersedes:
applies-to:
  - packages/types/src/capabilities/custom-model-registry.cap.ts
  - packages/addon-model-studio/src/bundle/bundle-import.ts
  - packages/addon-model-studio/src/bundle/bundle-tar.ts
---

## Context

A trained detector is an ONNX file, two OpenVINO IR pairs (FP16 and INT8) and
a Core ML package — a directory. Model Studio's upload path takes one
`.onnx`/`.tflite` at a time, and its custom actions are a poor contract
between addons (their input schemas go stale after a redeploy). A path on the
hub's disk handed from one addon to another would make the receiver trust a
location the sender controls, and the files come from a container we did not
run on this machine.

Rejected:

- **A path handed across addons.** Same host today, but it lets the sender
  name any file the receiver can read, and it is not how bytes cross addons
  (D613).
- **One call per file.** A half-registered model (the ONNX in, the IR not) is
  worse than none, and a peer-bytes ticket lives seconds.
- **Placing files under `<modelsDir>/<modelId>/`.** Every download path
  resolves `<modelsDir>/<basename of the url>`; a subdirectory would be a
  second layout the nodes do not read.

## Decision

**`custom-model-registry.importModelBundle` takes the catalog rows (every
format URL already `camstack-local://<modelId>/<file>`), the declared list of
files with their sha256, and ONE tar behind a peer-bytes ticket. The tar is
taken bounded by its declared size and checked against its sha256; only
declared, path-safe regular files are unpacked, each against its own sha256;
only then are the files moved into the flat modelsDir, a `.revision` record
written per format, the rows upserted under the operator's name, the hub marked
available and — when asked — engine formats ensured and the model distributed.
An id another source registered with other files is refused, never
overwritten; the same import twice is a no-op.**

## Consequences

- Refusals are named (`transfer-failed`, `checksum-mismatch`,
  `bundle-mismatch`, `invalid-entry`, `id-taken`) and leave modelsDir and the
  registry untouched.
- Every format carries a `revision` (its weight file's sha256), so a later
  retrain that reuses an id is detected as stale on every node (D743/D744).
- The tar reader is our own allowlist reader (ustar, PAX path, GNU long name):
  a link, a device or an unlisted file refuses the whole bundle.

## Enforcement

`addon-model-studio/src/__tests__/bundle-import.test.ts` and
`bundle-tar.test.ts`.
