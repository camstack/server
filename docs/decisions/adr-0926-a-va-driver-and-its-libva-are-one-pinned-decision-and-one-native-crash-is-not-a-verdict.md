---
id: D926
title: A VA driver and its libva are one pinned decision, and one native compiler crash is not a verdict
status: accepted
date: 2026-10-23
applies-to:
  - scripts/docker/check-libva-abi.sh
  - packages/system/src/kernel/hwaccel/vaapi-init-probe.ts
  - packages/addon-pipeline/python/openvino_compile_probe.py
  - packages/addon-pipeline/python/coreml_load_probe.py
  - packages/addon-pipeline/src/session-decode/session-hwaccel.ts
---

## Context

A production measurement on 2026-10-23 found two hardware verdicts that were
wrong for good, each from a single bad read.

**VAAPI.** The `intel` image (`intel-1.2.509`, the hub and agent-a; the
v1.2.619 image comes from the same Dockerfile) installed Intel's iHD 25.2.4,
which exports only `__vaDriverInit_1_22`. libva 2.N looks for VA-API 1.N, and
the container had Ubuntu noble's libva 2.20: the driver package does not depend
on `libva2`, so apt never moved it. `vaInitialize` failed on every node, and
the hwaccel resolver kept offering `qsv, vaapi` because it judged hardware by
PCI vendor ids alone. Result: 722 `hwaccel 'vaapi' failed` lines a day, every
frame decoded in software, an N100 at load 13.9 — and an image that had built
green. Mesa's `radeonsi` in the `amd` image comes from Ubuntu with Ubuntu's
libva and matches (1.20 / 2.20).

**OpenVINO.** D910 compiles a GPU/NPU model in a child first and caches a
`crashed` verdict when the child dies by a signal. One SIGSEGV during an
overloaded moment wrote `crashed` to `.ov-cache/*.GPU.ovprobe.json`, and every
later request for that model was refused `native-load-crashed`, with no way
back short of deleting the file. On the hub GPU that plausibly blocked every
FP16 model.

## Decision

The VA driver and the libva that loads it are installed from the **same
repository, at pinned versions that move together** (`LIBVA_VERSION`,
`VAINFO_VERSION`, `IHD_VERSION` in the `intel` stage), and the image build
**fails** when the driver's newest `__vaDriverInit_1_N` is newer than the
installed libva (`scripts/docker/check-libva-abi.sh`, run in both final
stages). At boot the kernel hwaccel resolver asks `vainfo` once per process;
when libva cannot initialise the driver it logs one ERROR naming the gap and
withholds `vaapi` and `qsv` instead of offering a backend that cannot open.

A native compiler crash caches a refusal only when a **second crash at least a
cool-off (10 min) after the first agrees** (D49). One crash is `suspect`: the
load is refused, later loads are refused without probing until the cool-off
ends, then probed again; an `ok` in between resets the count. Each crash is
recorded with its time, the host load average and the child's detail.

Rejected: rebuilding the Intel stack on Ubuntu's own `intel-media-va-driver`
(older, and drops the newer GPUs the Intel repo exists for); a third-party PPA
for libva (a third source to keep in step); un-caching OpenVINO crashes
entirely (one crashing model would re-probe on every load forever).

## Consequences

- Upgrading the iHD driver means upgrading libva in the same edit; the build
  check refuses a pair that does not load, with the versions in the message.
- A node whose libva cannot load its driver decodes in software on purpose and
  says so once, instead of failing per session. A bare host with no `vainfo`
  is unaffected.
- The session decode worker receives the resolver's offer on `start` and
  tries only those backends; an unresolved offer keeps its platform order.
- A model that truly crashes the compiler costs one extra child crash, ten
  minutes later. A suspect model is unavailable on that device for the
  cool-off.
- No cap method clears a verdict; deleting the `.ovprobe.json` /
  `.probe.json` file does. The CoreML probe follows the same two-crash rule
  (the primitives live in `coreml_load_probe.py`).

## Enforcement

- `scripts/__tests__/check-libva-abi.spec.ts` runs the build check against a
  driver exporting `_1_22` with libva 2.20 (refused) and 2.22 (accepted).
- `packages/system/src/kernel/hwaccel/__tests__/vaapi-init-probe.spec.ts` pins
  the verdict text, the withheld backends and the single ERROR.
- `packages/addon-pipeline/python/test_openvino_compile_probe.py`
  (`CrashNeedsASecondAgreeingReadTest`): one crash retried after the cool-off,
  two crashes cached, a success resets.
