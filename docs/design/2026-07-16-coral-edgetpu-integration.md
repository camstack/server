# Coral Edge TPU integration — USB on the hub (Unraid .9), PCIe/M.2 since 2026-10-21

Status (2026-07-16): **passthrough OK · runtime OK · python backend committed & bench-validated on-device · executor TS wiring PENDING.**

The Coral USB Edge TPU attached to the Unraid hub (<hub-ip>, container `CamStack`) is now a working full-integer tflite inference device. Validated end-to-end through the real `inference_pool.py`: **SSD MobileNet V2 (COCO, 300×300) at ~11.7 ms predict / ~15 ms E2E per frame (~85 fps)**, correct person/tie detection on `grace_hopper`.

> ⚠️ `/dev/accel0` on the host is the reference NVR's Intel-NPU/PCIe accel context. The CamStack container's own `/dev/accel` mapping is the operator's Intel NPU (OpenVINO) — left untouched. The Coral is a **USB** device, wired via `/dev/bus/usb`.

## 1. USB passthrough (DONE)

Detection (host `lsusb`): pre-init the Coral is `1a6e:089a Global Unichip`; after libedgetpu loads firmware it re-enumerates to `18d1:9302 Google` **with a new USB minor** (observed 189:131 → 189:132). A fixed `--device` therefore does NOT survive init — you must pass the whole bus + allow the major.

Applied to the container (Unraid-native, sourced from the operator's own template):

- **Template** `/boot/config/plugins/dockerMan/templates-user/my-camstack.xml` (backup `*.bak-pre-coral-*`):
  - `<Config … Type="Path" Target="/dev/bus/usb">/dev/bus/usb</Config>` → `-v /dev/bus/usb:/dev/bus/usb` (bind dir so re-enumerated nodes appear live).
  - `<ExtraParams>--shm-size=2g --device-cgroup-rule='c 189:* rmw'</ExtraParams>` → authorize any USB minor (major 189).
  - Also corrected `<Repository>` to the running image `ghcr.io/camstack/camstack-server:intel-1.1.62` and added the 3 runtime-injected env vars (`CAMSTACK_HUB_PUBLIC_URL`, `CAMSTACK_MOLECULER_EVENT_FANOUT`, `CAMSTACK_SHM_RING_BUDGET_MB`) so a template rebuild is faithful.
- **Recreate**: `rebuild_container CamStack` (Unraid) → `docker start CamStack`. `xmlToCommand` output was dry-run reviewed before executing; `/dev/dri` + `/dev/accel` come from the operator's own template lines.
- A faithful `docker inspect`-based alternative is staged at `/mnt/user/appdata/camstack/edgetpu-recreate/recreate.sh` (+ `camstack.env`).

Verified: `/dev/bus/usb/002/004` visible in-container; delegate load re-enumerates the device and the `c 189:* rmw` rule admits the new minor.

## 2. Runtime (DONE, persistent under /data)

Container is Ubuntu 24.04 / Python 3.12 / x86_64; shared venv at `/data/deps/python`.

**Working combo** (installed by `/data/deps/edgetpu-install.sh`, persistent on the `/data` bind mount, re-run after any venv rebuild):
- Interpreter: **`ai-edge-litert==2.1.6`** (numpy-2 native — must NOT downgrade the shared venv numpy; OpenVINO needs numpy<2.4, hub runs 2.3.5).
- Delegate: **feranick `libedgetpu` 16.0 rebuilt against TF 2.17.1** (std/throttled), `→ /data/deps/edgetpu/lib/libedgetpu.so.1`.

Dead-ends ruled out empirically:
- **Stock Coral libedgetpu** (`packages.cloud.google.com`, 16.0/grouper): delegate loads + reprograms firmware but `invoke()` fails `EdgeTpuDelegateForCustomOp failed to invoke` — built against old TFLite; the delegate's TF version must match the interpreter.
- **feranick tflite-runtime cp312**: compiled against numpy 1.x → `numpy.core.multiarray failed to import` under numpy 2.x. Rejected in favour of ai-edge-litert.
- **pycoral**: official wheels cap at Python 3.9.

## 3. Python backend (DONE — committed & bench-validated)

`packages/addon-pipeline/python/`:
- `inference_pool.py`: new `edgetpu` runtime — `_init_runtime` (load delegate once, shared lock), `_load_model` (LiteRT `Interpreter` + delegate, capture in/out tensor indices + input dtype, positional-keyed predict closure under a lock), `_preprocess` (uint8/int8 NHWC, **no /255 normalize**; honours `preprocessMode` letterbox|resize).
- `postprocessors/ssd.py` (+ registered `"ssd"` in `__init__.py`): decodes the `TFLite_Detection_PostProcess` 4-tensor output (boxes/classes/scores/count) → yolo-shaped detections with original-frame pixel bboxes; embeds the Coral COCO-90 label map (skips `n/a`); handles resize + letterbox coord inversion.
- `requirements-edgetpu.txt`: `ai-edge-litert==2.1.6` + libedgetpu host-prereq note.

Validated by driving the real pool wire protocol on-device (config `runtime=edgetpu, postprocessor=ssd` → `infer_jpeg` → response): `person 0.72` + `tie 0.77`, `predictMs≈11.7`, `preprocessMs≈1.4`, E2E ~15 ms.

## 4. Remaining — executor TS wiring (NOT done this session)

Broad cross-package cascade (`@camstack/types`, `@camstack/system`, `@camstack/addon-pipeline`); deferred to avoid a partial build on top of the concurrent shm-removal work. Precise insertion points:

1. `packages/types/src/inference/runtime-capabilities.ts` — add `'edgetpu'` to `RuntimeId`; add `EDGETPU_DEF` (supports = Coral present; devices = `[usb]`; defaultDevice `usb`) + register in `RUNTIMES` + score in `scoreRuntimes`.
2. `packages/types/src/interfaces/platform.ts` — add a Coral hardware field (e.g. extend `NpuInfo.type` with `'coral-edgetpu'` or a new `coral` field).
3. `packages/system/src/builtins/platform-probe/platform-scorer.ts` (`probeHardware`, Linux branch) — new `classifyCoralAccelerators` (mirror `intel-accelerators.ts`): scan `/dev/bus/usb` for `1a6e:089a`/`18d1:9302` and/or a loadable `libedgetpu.so.1`. Also `runtime-packages.ts` — Coral branch → `requirements-edgetpu.txt`.
4. `packages/addon-pipeline/src/detection-pipeline/engine/engine-factory.ts` — `PoolRuntime` union += `'edgetpu'`; `BACKEND_TO_POOL_RUNTIME.edgetpu='edgetpu'`; `RUNTIME_TO_FORMAT.edgetpu='tflite'`; `defaultConcurrency.edgetpu=1`; `defaultBatchMode.edgetpu='none'`; device derivation.
5. `packages/addon-pipeline/src/detection-pipeline/engine/shared-inference-pool.ts` — `PoolRuntime` union += `'edgetpu'`.
6. `packages/addon-pipeline/src/detection-pipeline/runtimes.ts` — `RUNTIME_DETAIL.edgetpu` (`pythonRequirements: ['requirements.txt','requirements-edgetpu.txt']`, tuning) + `RUNTIME_FORMAT.edgetpu='tflite'`.
7. `index.ts` `ALL_RUNTIME_IDS`; `auto-pick.ts` `PREFERENCE`; `provider.ts` `toRuntimeId` + `resolvedEngineBackend`; `engine-provisioner.ts` `ModelFormat` += `'tflite'`.
8. `packages/types/src/capabilities/pipeline-executor.cap.ts` — `EngineProvisioningSchema.runtimeId` enum += `'edgetpu'`; then `npm run codegen` + regenerate `generated/` proxies + `ui-library/generated/system-hooks.ts`.
9. **Model catalog** `registry/model-catalogs.ts` — add `tflite:` format entries for SSD MobileNet V2 (`ssd_mobilenet_v2_coco_quant_postprocess_edgetpu.tflite`) and EfficientDet-Lite0/1 from the Coral model zoo. **Postprocessor routing**: the object-detection step is hardcoded `postprocessor:'yolo'`; a tflite/SSD model needs `postprocessor:'ssd'`. Either add a per-model postprocessor override to the catalog+`serializeModelConfig`, or add a dedicated SSD detection step. Update the Gate-B/format tests that currently assert no model ships a tflite build.

COCO→macro-class mapping (person / car|truck|bus|motorcycle→vehicle / cat|dog|bird|horse…→animal) already happens downstream in TS on the yolo-shaped detection output, so `ssd.py` emitting COCO class names is sufficient.

## 5. PCIe / M.2 Coral (2026-10-21)

The probe and the executor address PCIe Corals beside USB ones (code: the
"Coral units" section of `docs/architecture/detection-execution.md`).

- **Detection**: one unit per `/sys/class/apex/apex_N` whose `/dev/apex_N`
  opens read/write. A PCI function `1ac1:089a` with no apex unit is reported
  `driver-missing`; an apex unit whose node is not in the container or not
  openable is `device-not-accessible`. Neither is ever reported as "no Coral".
- **Keys → delegate device**: `edgetpu:pci` → `pci:0`, `edgetpu:pci:1` →
  `pci:1`; USB is explicit too, `edgetpu:usb` → `usb:0`, `edgetpu:usb:1` →
  `usb:1`. A node with both buses lists both, USB first.
- **Host prerequisites (not code)**: the gasket/apex kernel driver loaded on
  the host, `/dev/apex_N` passed into the container (`--device /dev/apex_0`
  …) and readable/writable by the CamStack user (the `apex` group or a udev
  rule), plus the same libedgetpu delegate as USB. On an LXC host (Proxmox) the
  container entry is `devN: /dev/apex_N,gid=993,mode=0660` — a container
  contract change mirrored by hand in the Proxmox install script (D717).
- **libusb, even for PCIe**: the feranick std delegate links `libusb-1.0.so.0`
  whatever the bus. On the AMD image (which lacked it) `load_delegate(…,
  {'device': 'pci:0'})` failed with `libusb-1.0.so.0: cannot open shared
  object file` (agent-b, 2026-10-21). The AMD image now installs
  `libusb-1.0-0`; the installer also drops a copy beside the delegate, and the
  pool preloads that copy RTLD_GLOBAL (`preload_libusb`) — no
  `LD_LIBRARY_PATH`.
- **Installer in the repo**: `packages/addon-pipeline/python/edgetpu-install.sh`
  (it ships with the addon). It replaces the hand-kept
  `/data/deps/edgetpu-install.sh` and installs ai-edge-litert 2.1.6, the
  feranick std delegate (TF 2.17.1, Ubuntu 24.04 build) and libusb into
  `/data/deps/edgetpu/lib`.
- **Enablement**: since D912 (superseding D39) every unit, USB or PCIe, is
  enabled by default like any accelerator; a stored `enabled:false` wins.

### Validated live on agent-b (2026-10-22)

Two PCIe units, CT201 (unprivileged LXC, Docker inside, `amd-latest`),
server 1.2.608. What it actually took, beyond the code:

- **The entrypoint chown.** The image running there is v1.2.509; no Docker
  release up to v1.2.583 carries `/dev/apex_*` in the entrypoint's chown loop
  (the Dockerfile has it since 70bf3360e). The CT's compose bind-mounts
  `/opt/camstack/docker-entrypoint.sh` over `/usr/local/bin/docker-entrypoint.sh`
  (added 2026-10-13 for `/dev/dri/renderD*`), and that host copy had to gain
  `/dev/apex_*` in its loop. `group_add` cannot replace it: `gosu` drops
  supplementary groups. Once an image newer than v1.2.583 is pulled, DROP the
  mount — it shadows every later entrypoint fix.
- **libusb** beside the delegate (`/data/deps/edgetpu/lib`), even for PCIe.
- **Enable** both keys through `setAgentInferenceDevices` (full map). Log
  proof: `EdgeTPU: delegate bound to device 'pci:0'` / `'pci:1'`.
- **Latency** (warm step p50, 1 cold + 5 warm, harness
  `bench-detector-latency-column.mjs`): SSD MobileNet V2 14–16 ms,
  bird-classifier 9–10 ms, YuNet 22–29 ms, YOLOX-tiny plate ~61 ms; the same
  three non-SSD models on `openvino:cpu` of that Zen4 node: 10 / 14 / 22.7 ms.
  Full table: `docs/benchmarks/2026-10-22-coral-pcie-amd-phoenix.md`.

## Operational quick-reference

```sh
# Re-install runtime after a venv rebuild:
docker exec CamStack sh /data/addons/@camstack/addon-pipeline/python/edgetpu-install.sh
# Standalone on-device bench (SSD MobileNet V2):
docker exec CamStack /data/deps/python/bin/python /data/deps/edgetpu/bench.py
# Full-pool E2E test (spawns real inference_pool.py):
docker exec CamStack sh -c 'cd /data/deps/edgetpu-pool && /data/deps/python/bin/python test_edgetpu_pool.py'
```
