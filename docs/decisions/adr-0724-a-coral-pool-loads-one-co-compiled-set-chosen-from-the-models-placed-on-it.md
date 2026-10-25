---
id: D724
title: A Coral pool loads ONE co-compiled set, chosen from the models placed on it
status: accepted
date: 2026-10-06
supersedes:
applies-to:
  - packages/addon-pipeline/src/detection-pipeline/registry/edgetpu-cocompiled-sets.ts
  - packages/addon-pipeline/src/detection-pipeline/engine/coral-cocompiled-set.ts
  - packages/addon-pipeline/src/detection-pipeline/engine/engine-factory.ts
  - packages/addon-pipeline/src/detection-pipeline/engine/pipeline-model-manager.ts
  - scripts/build-edgetpu-sets.py
---

> Extends [D710](adr-0710-a-coral-build-of-a-survivor-is-a-format-of-that-model-admitted-by-what-it-costs-the-shared-edge-tpu-context.md).

## Context

D710 admits a Coral build by what it costs the one ~6.9 MiB parameter cache of
a Coral. Every build it admitted (bird, then YuNet and YOLOX) was compiled
ALONE, and a separately compiled file carries its own random cache token: on
one Coral, every alternation between two of them flushes the cache and
re-streams the incoming model over USB. The root SSD alone is 6.39 MiB, so a
plate detection on the root's Coral would have re-streamed both models on every
switch — on a camera whose root runs at frame rate. The first answer, "keep
every enrichment step off the Coral with `jumpDeviceKey`", throws the Coral's
headroom away and leaves a second Coral with nothing to do.

`edgetpu_compiler` given several models at once allocates the cache between
them in command-line order under ONE token; loaded on one Coral (separate
interpreters, as the pool does) they never evict each other, and whatever a
member could not keep is streamed on each of ITS invokes instead. Measured
(compiler 14.1, `-s`, MiB on chip / streamed per invoke):

| Set (compile order) | members |
| --- | --- |
| SSD + YOLOX + bird | SSD 6.39 / 0 · YOLOX 0.08 / 5.41 · bird 0 / 4.54 |
| SSD + YuNet | SSD **3.34 / 2.93** · YuNet 0.00 / 0.20 |
| SSD + YuNet + YOLOX | SSD **3.34 / 2.93** · YuNet 0.00 / 0.20 · YOLOX 0 / 5.49 |
| YuNet + YOLOX + bird | YuNet 0.11 / 0 · YOLOX 3.23 / 2.27 · bird 0 / 4.54 |
| YOLOX + bird | YOLOX 5.55 / 0 · bird 0.92 / 2.80 |

YuNet's 640 activations take ~3.6 MiB of the same on-chip memory, so any set
holding it shrinks everybody's cache; with the root in it the ROOT streams on
every frame. Streaming latency is estimated, not measured (no Coral on the
build host): ~3–4 ms per MiB on USB 3, ~30–35 ms on USB 2.

## Decision

A Coral pool (`edgetpu:usb`, `edgetpu:usb:1`, …) loads at most ONE
co-compiled set, chosen from the models PLACED on it, and every other model it
runs from that model's own `formats.tflite`.

- **The set is a pool-level artifact, not a model.** Each member is the same
  int8 graph as its catalog entry's `formats.tflite` (same `modelId`, labels,
  licence — D710); `EDGETPU_COCOMPILED_SETS` names member files hosted under
  `edgetpuSets/<set>/`, built by `scripts/build-edgetpu-sets.py` from pinned
  CPU graphs. A pool loads a member by swapping only the entry's `tflite` URL
  (`withSetBuild`), for both the download and the pool config.
- **Placement is what the pool is asked to run**: the union of the enabled
  video steps of the dispatches it served (`placedModelsOf`). A Coral-elected
  camera's first dispatch already carries the root and every subtree that stays
  on the Coral; a step jumped in by `jumpDeviceKey` joins with its first
  dispatch. The union only grows, for the pool's lifetime.
- **Selection** (`selectCoCompiledSet`): a set that reserves the cache for the
  root is eligible only on a pool running the root, a rootless one only on a
  pool that is not; a set must stand for at least two placed models; most
  placed models covered wins, then fewest idle members.
- **Published sets are only those whose cost is acceptable**:
  `root-plate-bird`, `face-plate-bird`, `plate-bird`. Root + YuNet is not a
  set: `build-edgetpu-sets.py` refuses any set whose root member streams.
- **A change of set** reloads the pool's resident models from the new files,
  queued behind the pool's other loads, new slot before old
  (`reloadChangedPaths`). It is logged once per change, tagged with the camera
  whose dispatch moved it; a placement no set covers is a WARN naming the
  models that will swap, with the `jumpDeviceKey` hint.

Rejected:

- **Compiling on the node.** `edgetpu_compiler` is x86-64 Linux only and its
  apt repository answers 403; the hub could run Google's bundle, an arm64 or
  macOS agent could not, and a compile per placement change is a minute of
  latency and a moving cache layout nobody measured. Pre-built sets are
  reproducible (`build-edgetpu-sets.py`), measured before they ship, and few:
  the useful combinations are three.
- **An operator-picked set per device.** A second knob that disagrees with the
  placement it describes (the D62 shape); the placement already says it.
- **A new `-edgetpu` model id per combination.** D710 forbids sibling ids.

## Consequences

- One Coral: root + plate (+ bird) share `root-plate-bird`; the root keeps its
  whole cache. Face detection must keep jumping (`jumpDeviceKey`) — or it
  swaps with the root at 1 Hz per person track, and says so in the WARN.
- Two Corals: the root Coral stays root-only by jumping face, plate and bird to
  `edgetpu:usb:1`, which then loads `face-plate-bird` (or `plate-bird`).
  Nothing of this was run on a Coral: the first deploy is the hardware check.
- Adding a model to a set, or a new set, is a recompile of every member of
  that set and a registry edit; the script refuses a registry that disagrees
  with it.
- A set switch while dispatches are in flight replaces pool indices; a
  dispatch holding the old index sees one failed inference, at a placement
  change only.

## Enforcement

- `engine/__tests__/coral-cocompiled-set.spec.ts`: selection rules against the
  published sets, the planner, the config path, the reload order.
- `__tests__/coral-pool-loads-its-cocompiled-set.spec.ts`: the provider's real
  dispatch path downloads and loads set files, moves the root onto the set,
  WARNs on root + face with `tags.deviceId`.
- `__tests__/edgetpu-cocompiled-sets.spec.ts`: every member is a catalog model
  with a tflite build; basenames unique; a root set has the root first and
  streaming nothing.
- `scripts/build-edgetpu-sets.py` refuses to build when its set list and the
  TypeScript registry disagree, or when a root member would stream.
