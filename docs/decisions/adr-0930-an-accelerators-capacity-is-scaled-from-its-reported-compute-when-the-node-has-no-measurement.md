---
id: D930
title: An accelerator's capacity is scaled from its reported compute when the node has no measurement
status: accepted
date: 2026-10-24
supersedes:
applies-to:
  - packages/types/src/pipeline/auto-tune/accelerator-compute.ts
  - packages/types/src/pipeline/auto-tune/recommend.ts
  - packages/addon-pipeline/python/accelerator_facts.py
  - packages/system/src/builtins/platform-probe/accelerator-facts-probe.ts
---

## Context

Auto tune classified a node by its CPU string and then read one column of the
measured latency table. Anything that was not a Core Ultra, an N100-shaped
N-series part, a Phoenix APU or an Apple chip was `unknown`, and the
recommender left it alone. The N-series column is the N100 (24 execution
units, 750 MHz). An N305 (32 EU, 1250 MHz) matched the same string and was
told it was an N100. An i5-12500 (UHD 770), an i7-1260P (Iris Xe, 96 EU), an
older UHD and a Ryzen 5000/6000 APU that is not Phoenix all landed on
`unknown`.

The alternative that was rejected is more CPU-name rows. The names do not
say how much compute the GPU has, and the next chip we have not typed would
be `unknown` again. Measuring every chip before it can be recommended was
also rejected: a node benchmark already beats the table (D791, D913), but a
machine that has not been benchmarked yet still needs a default.

`1000/p50` matched the cameras an N100 iGPU held at 10 fps and under-stated
them at 5 fps. Aggregate throughput there was about 1.4× the serial ceiling
(LATENCY, two InferRequests). The extra throughput becomes extra sessions
only when the frame interval is wide enough to hide the queue. It does not
add a camera at 10 fps.

## Decision

An accelerator's capacity comes from reported compute when the node has no
measurement of its own.

The probe (OpenVINO enumeration in the inference worker, and the WebGPU
adapter for AMD) reports, per device, the full device name, GPU execution
units, `DEVICE_GOPS` for int8 and fp16, architecture, NPU name and TOPS, and
for WebGPU the vendor, architecture, device and compute-unit count when the
device answers. A query that fails is null, never 0.

Latency for a device with that compute is the nearest measured column of the
same accelerator kind, scaled by the compute ratio. GOPS is used when the
reference column carries GOPS of that precision; otherwise execution units ×
clock (Intel) or compute units (AMD). The ratio is clamped to
`ESTIMATE_COMPUTE_RATIO_MIN` (0.5) and `ESTIMATE_COMPUTE_RATIO_MAX` (2): peak
compute and detector latency do not move together, the N100-to-N305 public
ratio is about 2.2×, and a wider guess without a measurement on that device
is not justified. Every scaled cell is `measured: false` and names
`estimatedFrom`. The plan's source is `estimated`.

A measured class other than the N-series spread is the measurement and is
not scaled. `intel-n-series` is the N100 column; N200 and N305 scale by the
compute they report. `unknown` remains only when the device reports neither
compute nor a known class.

Precedence is unchanged in order: a node benchmark (D791) or the automatic
measurement (D913) beats the estimate, and the estimate beats nothing.

Capacity counts sessions as `⌊fps × factor × (1 − headroom) / camera fps⌋`.
`factor` is 1 at 10 fps and above (the rate where serial `1000/p50` matched
what held). Below that, `intel-igpu` uses 1.4, the aggregate-over-serial
ratio measured on the N100. Every other kind stays 1 until it is measured
the same way.

## Consequences

- A chip we have not named gets a default, labelled estimated, and a
  benchmark on that node replaces it.
- The clamp hides real gaps larger than 2×. That is the point: those chips
  need a measurement, not a braver guess.
- The reference compute is the vendor specification of the measured machine
  (N100 24 EU × 750 MHz, Core Ultra 7 265K 64 EU × 2000 MHz, Phoenix 780M
  12 CU). None of those columns carry a probed `DEVICE_GOPS` yet, so GOPS
  wins only after a reference is given a GOPS figure. A wrong execution-unit
  count for the 265K moves which column an unnamed Intel iGPU is nearest to.
  It does not change the Core Ultra column.
- The 1.4× factor is a step, not a curve. A camera at 7 fps gets the full
  uplift. A later measurement can replace the step.

## Enforcement

`capacity-estimate.spec.ts` (N305 above the N100 column, UHD 770 and Iris Xe
estimated from an intel-igpu column, Core Ultra unchanged, an AMD APU
without a Phoenix name estimated from amd-igpu, null or zero GOPS with no
fallback stays unknown, the ratio clamp, GOPS preferred over EU×clock when
the reference has GOPS, a node benchmark beats the estimate, the 5 fps
intel-igpu uplift). `test_accelerator_facts.py` (a failed property is null,
never 0). Remove the clamp or the uplift and the matching spec fails.
