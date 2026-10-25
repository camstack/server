---
id: D202
title: Batch capability is a hardware fact, not a setting
status: accepted
date: 2026-08-20
supersedes:
applies-to:
  - packages/addon-pipeline/python/inference_pool.py
---

## Context

On 2026-08-20 the hub — pinned by the operator to its Intel NPU — stopped
loading a model without failing. It repeated `Loading step variant
plate-ocr/cct-s-v2-global` with a climbing `poolIndex` and never once reached
`Step variant loaded`, while `agent-a` loaded the same artefact in 205 ms.
The pool stderr underneath named it exactly:

```
[w0] OpenVINO: operator-pinned device NPU
[w0] OpenVINO: compile on NPU failed
[w0] Got negative shape dim bound: '-1'
[w0] L0 pfnCreate2 result: ZE_RESULT_ERROR_INVALID_ARGUMENT
```

The `-1` was the ONNX export's dynamic `batch` axis. The Level-Zero compiler
refuses a dynamic dimension outright, and a pool load failure is a RETRY, not an
error any caller sees — so the node looked busy rather than broken.

The first fix was to pin batch to 1 in **that model's conversion script**. It
worked and it does not generalise, for a reason the fleet makes obvious: the
SAME artefact is downloaded to a CPU node, an iGPU node, an NPU node and a
CoreML node. An export cannot know which target it will meet. Worse, pinning at
export is actively wrong for CoreML, where the flexible `RangeDim` batch axis is
the very thing the stacked single-dispatch ANE path reads. And a third
production of dynamic-batch graphs has no conversion script at all to patch: the
model-studio convert path runs `ov.convert_model`, which preserves whatever the
ONNX declared, for any model an operator brings.

Under AUTO the same defect is quieter and just as real: the NPU candidate loses
every dynamic-batch model to the GPU fallback, silently, forever.

## Decision

**Whether a compiled graph may keep a dynamic batch axis is derived at the point
of load from the `(engine, device)` pair, by one function, and is never
configurable — not per model, not in the catalog, not by an operator.**
`_static_batch_required(runtime, device)` in `inference_pool.py` is that
function: `openvino` + `NPU` is the only pair that refuses a dynamic shape;
OpenVINO CPU/GPU, ONNX Runtime, CoreML and EdgeTPU all keep it. When the pair
refuses, `_pin_batch_for_device` RESHAPES the graph to a static batch of 1
before `compile_model` sees it — per compile candidate, so the AUTO ladder pins
for its NPU attempt and hands the untouched source to GPU and CPU — and logs the
derivation either way.

This is **compile shape**. It is not the pool's runtime request grouping
(`batch_mode` / `max_batch_size`, and the CoreML stacked-tensor path gated on
the export's own `RangeDim`), which remains an internal optimisation and remains
operator-tunable per node.

## Consequences

- A conversion script must no longer decide batch for a target. The static pin
  left in `build-plate-ocr-model.py` is now redundant belt-and-braces, kept only
  because it costs nothing and makes that model's three formats agree; the
  dynamic exports in `build-camstack-models.py` and `build-auraface-model.py`
  stay dynamic on purpose.
- The catalog declares nothing about batch, and must not start. The fact is
  readable from the graph at load; a catalog field would be a second authority
  that can disagree with the first, which this repo has shipped twice (D62).
- A dynamic axis that is NOT the batch (a dynamic H/W) still cannot be compiled
  on the NPU — there is no value we are entitled to invent for a spatial dim.
  The loader says so in one line and lets the compile fail, rather than failing
  in silence.
- Reshaping costs one `core.read_model` on the NPU path when the load would
  otherwise have compiled straight from the IR path. It is paid once per model
  load, against a compile measured in seconds.

## Enforcement

`packages/addon-pipeline/python/test_inference_pool_static_batch.py`. It pins
the pure derivation, reshapes a real dynamic-batch graph through real OpenVINO,
and — the test that matters — drives `_load_model` itself with a recording core
to assert the object handed to `compile_model` for an NPU target was static.
Delete the call at the compile site and that last test goes red while the helper
tests stay green.

Those tests had never been runnable in CI: nx only collects workspace packages,
and the pool suite is Python. `scripts/test-python-pool.sh` now runs it and is
wired into `.github/workflows/ci.yml`.
