# shm-ring → inference pool: zero-copy frames to the Python detector

**Status:** Design (not implemented)
**Date:** 2026-06-27
**Author:** session handoff
**Related:** `packages/shm-ring`, `packages/addon-pipeline/python/inference_pool.py`, <!-- drift-ok: deleted in D763 -->
`packages/addon-pipeline/src/detection-pipeline/engine/shared-inference-pool.ts`,
`packages/addon-pipeline/src/detection-pipeline/provider.ts`,
`packages/addon-pipeline/src/pipeline-runner/`

## Problem

Today a decoded camera frame already lives in **shared memory** (`@camstack/shm-ring`,
a POSIX `shm_open`+`mmap` ring written by the decoder), but the Python inference
pool never reads it. The detection path re-materialises the pixels and ships them
over the pool's stdio pipe every frame:

```
decoder ──shm-ring write──► FrameHandle
   │
   ▼ (runner reads frame by handle, gets raw RGB/BGR)
detection-pipeline provider
   │  raw → JPEG re-encode (sharp, ~3–5 ms)        ◄── waste
   ▼
shared-inference-pool (stdio pipe)
   │  MSG_INFER_JPEG: [hdr][~200 KB JPEG bytes]      ◄── waste (per-frame IPC copy)
   ▼
inference_pool.py
   │  JPEG decode (PIL)                              ◄── waste
   ▼  preprocess → predict → postprocess
```

Per frame the system pays a **raw→JPEG encode + a ~200 KB pipe transfer + a JPEG
decode** purely to move bytes the pool could read directly from the shared
segment. The synthetic benchmark's `simulatePipeline` numbers (hub 265K, yolov9t,
parallel=4) show the cost: full-pipeline ~96 fps (AUTO) vs cached/predict-bound
~134 fps — a chunk of that gap is preprocess + this transfer.

## Goal

Let the Python pool read the frame **directly from the shm-ring segment** by
handle, eliminating the re-encode, the pipe byte-copy, and the JPEG decode for the
same-node hot path. Target: close most of the simulate-vs-cached DPS gap in
production (not just the bench).

## Feasibility (verified)

- `packages/shm-ring/src/shm.cc` backs every ring with `shm_open(name, …)` + <!-- drift-ok: deleted in D763 -->
  `ftruncate` + `mmap(MAP_SHARED)` — a **named** POSIX segment at `/dev/shm/<name>`,
  mode 0600. Any process that knows the name can `mmap` it.
- The pool is a child process: `spawn(pythonPath, [scriptPath], { stdio:
  ['pipe','pipe','pipe'] })` (`shared-inference-pool.ts:197`). It runs as the same
  `camstack` user → can open `/dev/shm/<name>`.
- Python can map it with stdlib only: `multiprocessing.shared_memory.SharedMemory(
  name=…)` or `os.open('/dev/shm/'+name, O_RDWR)` + `mmap.mmap`. A zero-copy
  `numpy.frombuffer(view)` over the slot's pixel region feeds preprocess directly.
  No new native dependency.

The frame layout the reader needs is already public in `frame-ring.ts`
(`FrameHandle` = `{ shmId, slot, seq, width, height, format, byteLength,
slotCount, … }`) plus the header/metadata offsets (slotCount, slotByteLength,
per-slot seqlock `seq`, 32-byte metadata, then pixels).

## Design

### 1. New pool message: `MSG_INFER_SHM` (0x06) + `MSG_INFER_SHM_BATCH` (0x07)

Payload is the **handle, not the pixels** (~40 bytes):

```
[1B model_idx][2B name_len][name bytes][4B slot][4B seq]
[4B width][4B height][1B format][4B slotByteLength][4B slotCount]
```

`shared-inference-pool.ts` gains `inferShm(slot, handle)` /
`inferShmBatch(slot, handles)` that frame this instead of the JPEG bytes. The
existing JPEG/RAW/CACHED messages stay (push sources, cross-node, tests).

### 2. Python shm reader (`inference_pool.py`)

- **Memoised segment map**: `dict[name → (SharedMemory, np.ndarray header view)]`.
  Open once per segment name; reuse across frames. Re-open on `shmId` change
  (the writer tags `shmId` with a generation on resolution change → cache miss →
  remap).
- **Seqlock read** (mirror `frame-ring.ts` `readHandle`): read the slot's `seq`
  (Atomics-equivalent via `numpy`/`memoryview` load), verify it equals the
  handle's `seq` and is even (committed); read pixels; re-read `seq` and confirm
  unchanged. On mismatch the slot was recycled mid-read → **one retry, then drop**
  (telemetry counter; a dropped detection frame is acceptable — it's the newest
  that matters).
- **Zero-copy preprocess**: `np.frombuffer(slot_pixels, dtype=uint8).reshape(
  H, W, channels)` per `format` (rgb/bgr/gray/yuv420 — the pool already has the
  per-format preprocess). For `THROUGHPUT`/concurrent predict, copy the (small,
  letterboxed) preprocessed tensor — NOT the full frame — so the predict thread
  owns stable memory while the ring slot may recycle.

### 3. JS wiring (provider + runner)

- The runner already holds live `FrameHandle`s (`frame-handle-poller.ts`).
- When a step runs on the **same node** as the writer and the engine is the
  Python pool, the provider routes `frame.handle` → `inferShm` instead of
  `raw→JPEG → MSG_INFER_JPEG`. A small capability flag on the engine
  (`supportsShmInput`) gates it; everything else (push sources without a handle,
  cross-node forwards) keeps the byte path.

### 4. Constraints / non-goals

- **Same-node only.** `/dev/shm` is per-host. The hub→agent forward
  (`agent-child-forward`) still ships bytes; each node's pool reads only its own
  decoder's ring. (The agent's decoder→agent-pool path benefits identically on
  the agent.)
- **No change to the seqlock contract.** Reader is strictly read-only; the writer
  stays the single producer.
- **Lifecycle:** on model reload / pool restart the segment maps are dropped and
  re-opened lazily; a stale handle simply fails validation → drop.

## Phasing

1. **P1 — `MSG_INFER_SHM` single-frame** + python reader + a unit test that writes
   a known frame into a ring and asserts the pool's detections match the JPEG
   path. Wire `runSyntheticBench` to drive it (new `path: 'shm'`) so we measure
   before/after on the same harness.
2. **P2 — batch (`MSG_INFER_SHM_BATCH`)** for the window accumulator.
3. **P3 — live path**: provider routes same-node Python steps through
   `inferShm`; benchmark production fps vs the byte path; roll out behind the
   `supportsShmInput` flag.

## Expected payoff

Removes raw→JPEG encode (~3–5 ms/frame) + ~200 KB/frame pipe copy + JPEG decode
from the hot path. The bench harness (`runSyntheticBench`, now node-pinnable)
measures it directly: compare `path: 'pipeline'` (today) vs `path: 'shm'` per
device on the hub 265K and the N100 agent.

## Risks

- **Torn reads** under high writer churn → mitigated by seqlock + retry + drop;
  worst case is an occasional dropped frame (already the ring's latest-wins
  semantics).
- **Segment-name plumbing**: the handle must carry the exact `shm_open` name; keep
  the naming in one place (`frame-ring.ts`) and pass it verbatim.
- **Format coverage**: ensure every decoder output format the ring carries has a
  python preprocess branch; fall back to the byte path for any unsupported format.
