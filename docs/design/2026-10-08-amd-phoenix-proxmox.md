# AMD Phoenix (Ryzen 5/7 7640HS) on Proxmox: research and plan

Date: 2026-10-08 (updated 2026-10-10). Target box is live as agent `agent-b`
(CT201 on PVE `.63`): Ryzen 7640HS, Radeon 760M gfx1103, XDNA1 (`1022:1502`).
P0+P1 shipped in `@camstack/server@1.2.499` and verified on the box (VAAPI +
`onnx:webgpu` + `openvino:cpu`). **P2 NPU spike closed no-go** the same day:
XRT validate PASS; Linux VitisAI has no Phoenix target (see §5 P2).

---

## TL;DR / recommendation

| Engine | Verdict | Path |
|---|---|---|
| **CPU inference** | Live + measured | ORT CPU floor + opt-IN `openvino:cpu` (Zen4 VNNI). **`amd-phoenix/x86-cpu` measured** 2026-10-10: INT8 OV ≫ ONNX (e.g. `yolov9m-320-int8` 21 ms vs ONNX 67 ms). Prefer OV-CPU for live YOLO. |
| **HW decode (VAAPI)** | Live | `amd-*` image (D822): Mesa `radeonsi`, no `LIBVA_DRIVER_NAME` pin. Decoded as `vaapi` on the box. |
| **iGPU inference** | Live (OD + crop) | `onnx:webgpu` via ORT WebGPU EP + RADV. Catalog OK; child per model (D823). **Corrected 2026-10-13 (D845):** the 10-10 latencies (`yolov9m-320` 1076 ms) were a software path — the pool could not open the render node. On the GPU: `yolov9t-320` 13 ms, `s-320` 23 ms, `m-320` 52 ms, `m-640` 170 ms; K processes serialise on one queue. `docs/benchmarks/2026-10-13-phoenix-npu-and-igpu.md`. No ROCm. |
| **NPU (XDNA1)** | **No-go on Linux Phoenix** | Driver + `xrt-smi validate` PASS. Ryzen AI 1.8 Linux is STX/KRK only; VitisAI aborts on PHX fingerprint even with a real `4x4` xclbin. 2026-10-13: mlir-aie/IRON runs a kernel on it (no ONNX path); `iree-amd-aie` dormant, no wheels; Windows-VM passthrough feasible but has no CamStack node. No `vitisai:npu` device. XDNA2 present-only until wired. |
| **Proxmox** | Live | Unprivileged Ubuntu 24.04 LXC + Docker; `devN:` for dri/accel. Not a VM (AMD iGPU reset bug). |

Phasing:
- **P0 / P1:** shipped and live on `agent-b` (2026-10-10). Latency columns + public docs done. Leftovers = capacity ramp (optional), Alexa cutover, CI smoke (`docs/roadmap.md` AMD section). <!-- drift-ok: moved to the private planning repo -->
- **P2:** spike done → **no-go**. Re-check only when AMD lists Phoenix in the Linux Ryzen AI release.

---

## 1. iGPU inference on Linux for gfx1103 (760M/780M)

### ROCm
- gfx1103 is **not** an officially supported ROCm target on Linux.
  - Ryzen APUs with 780M (gfx1103) are listed as working only with the `HSA_OVERRIDE_GFX_VERSION=11.0.0` hack.
  - Official gfx1103 support has only shipped for Windows WSL (librocdxg).
  - ROCm 7.2 (Mar 2026) added RDNA4.
  - The ROCm 7.12 tech preview adds Ryzen AI 300/400-class APUs. Phoenix is still not on the list.
  - Sources: [insiderllm ROCm guide 2026](https://insiderllm.com/guides/rocm-not-detecting-gpu-amd-fix/), [Phoronix: librocdxg 1.2 / WSL Ryzen](https://www.phoronix.com/news/librocdxg-1.2-More-Ryzen-ROCm), [Phoronix: ROCm 7.2](https://www.phoronix.com/news/AMD-ROCm-7.2-Released), [Phoronix: ROCm 7.12 TP](https://www.phoronix.com/news/AMD-ROCm-7.12-Tech-Preview).
- TheRock nightlies build a `gfx110X-all` family that community users run on gfx1103 ([lemonade-sdk/llamacpp-rocm](https://github.com/lemonade-sdk/llamacpp-rocm), [Framework community ROCm experiments](https://community.frame.work/t/experiments-with-using-rocm-on-the-fw16-amd/62189?page=3)). That is a nightly, unsupported path.
- Container needs: `/dev/kfd` plus `/dev/dri/renderD128`, the `render`/`video` groups, a large BIOS UMA frame buffer (≥2-4 GB), and multi-GB ROCm userspace.

### ONNX Runtime EPs
- **ROCm EP was removed in ORT 1.23.** AMD now points users to MIGraphX or Vitis AI EP ([ORT 1.23.0 release notes](https://newreleases.io/project/pypi/onnxruntime/release/1.23.0)).
- `onnxruntime-migraphx` 1.27.1 wheels exist on PyPI (cp310-cp314, manylinux_2_34; verified via the PyPI JSON API today). They still need ROCm and MIGraphX libraries on the system ([AMD: Install MIGraphX for Radeon](https://rocm.docs.amd.com/projects/radeon-ryzen/en/docs-7.2.1/docs/install/installrad/native_linux/install-migraphx.html)). MIGraphX on gfx1103 is equally unofficial.
- **WebGPU EP**, the recommended route. ORT's native WebGPU EP runs on Dawn, which dispatches to Vulkan on Linux.
  - It ships as a **plugin EP**: `pip install onnxruntime onnxruntime-ep-webgpu`.
  - Registration API: `ort.register_execution_provider_library(...)`, then pick the devices with `ep_name == webgpu_ep.get_ep_name()`, then `sess_options.add_provider_for_devices(...)`.
  - Linux requirements: a Vulkan driver/loader and glibc ≥ 2.28 (the wheel is manylinux_2_28).
  - Graph capture works only with fully static shapes. Our yolov9 ONNX builds are static opset-13, so that fits.
  - Sources: [ORT WebGPU EP docs](https://onnxruntime.ai/docs/execution-providers/WebGPU-ExecutionProvider.html), [Vulkan docs: ONNX Runtime](https://docs.vulkan.org/tutorial/latest/ML_Inference/Third_Party_Libraries/02_onnx_runtime.html). Current PyPI state: `onnxruntime` 1.30.0, `onnxruntime-ep-webgpu` 0.4.0 (linux x86_64/aarch64, macOS, Windows).
- ORT has no native Vulkan EP.
- **OpenVINO** has no AMD GPU plugin. Its CPU plugin does run on any x86-64 CPU with AVX2, including AMD ([OpenVINO system requirements](https://docs.openvino.ai/system_requirements)), so the existing **int8 IR** builds could run on Zen4 VNNI. Today `runtime-capabilities.ts` withholds OpenVINO unless `gpu.type === 'intel'`.

### Other Vulkan options
- **ncnn Vulkan**: there are YOLO exports and `ncnn` PyPI wheels (1.0.20260526). It needs a new model format (param/bin), a new runtime in the pool and new HF builds. Too costly while WebGPU reuses the ONNX builds. ([Ultralytics NCNN](https://docs.ultralytics.com/integrations/ncnn), [Phoronix NCNN Vulkan AMD vs NVIDIA](https://www.phoronix.com/news/NCNN-Vulkan-More-NVIDIA-AMD))
- **IREE (Vulkan/SPIR-V)** and **TVM**: research-grade for this use. Skip.

### Realistic latency
I found **no published YOLOv9 numbers on 760M/780M** for any of these runtimes. Treat everything below as an estimate to be replaced by our Benchmark.
- On paper the 760M (8 CU RDNA3 at ~2.6 GHz, ~8.6 TFLOPS FP16 dual-issue, shared LPDDR5/DDR5) is in the same class as the Core Ultra 265K's iGPU. That iGPU runs yolov9s-640 at 15.2 ms under OpenVINO.
- WebGPU kernels are less tuned than OpenVINO's. My expectation is **yolov9s-640 at 20-40 ms** and **yolov9t-320 at 4-8 ms**.
- Any op without a WebGPU kernel falls back to CPU. Check node placement with verbose ORT logging.

## 2. XDNA NPU on Linux

- **Kernel**: `amdxdna` went into mainline in **Linux 6.14** and needs IOMMU SVA ([Phoronix: amdxdna to drm-misc-next](https://www.phoronix.com/news/AMDXDNA-DRM-Misc-Next), [amd/xdna-driver](https://github.com/amd/xdna-driver)).
  - The out-of-tree build needs ≥ 6.10, `CONFIG_AMD_IOMMU`, `CONFIG_DRM_ACCEL`.
  - Firmware is in linux-firmware at `amdnpu/1502_00/npu.sbin`, with a newer `npu_7.sbin` that the driver tries first ([Phoronix: NPU firmware upstream](https://www.phoronix.com/news/AMD-NPU-Firmware-Upstream), [kernel docs amdnpu](https://docs.kernel.org/7.1/_sources/accel/amdxdna/amdnpu.rst.txt)).
  - The device appears as `/dev/accel/accel0`.
  - On Linux, Phoenix *is detected*: `xrt-smi examine` reports "NPU Phoenix" on an 8600G ([Arch BBS thread](https://bbs.archlinux.org/viewtopic.php?id=304979)).
- **Ryzen AI Software 1.8 (latest)**:
  - The release as a whole supports PHX/HPT/STX/Krackan. But **PHX/HPT get "CNN INT8" only, with no BF16**, and the old PHX `1x4.xclbin` was retired in favour of `4x4.xclbin` ([relnotes](https://ryzenai.docs.amd.com/en/latest/relnotes.html)).
  - The **Linux** page says support starts **"with Strix Point"** (STX/KRK, NPU `1022:17f0`). It is NPU-only flow on Ubuntu 24.04 with Python 3.12.
  - The Linux install is XRT `202620.2.25.37` plus the `xrt_plugin...amdxdna` debs, **downloaded behind an AMD account** ([Ryzen AI Linux](https://ryzenai.docs.amd.com/en/latest/linux.html)).
  - 1.6 stated that "Model generation is not supported on Linux; models generated on Windows are compatible with Linux" (relnotes above). Earlier Linux 1.6.1 was "early access" ([1.6.1 Linux page](https://ryzenai.docs.amd.com/en/1.6.1/linux.html)).
- **EP**: ONNX Runtime Vitis AI EP. The models must be INT8 QDQ for PHX, quantized with AMD Quark. CNNs like YOLOv8 exist in AMD's model zoo. YOLOv9 / YOLO26 compatibility on PHX is unverified: attention/NMS-free heads and some ops can fall back to CPU.
- **Open alternatives**: [IREE amd-aie](https://github.com/nod-ai/iree-amd-aie) (early phase), mlir-aie/IRON kernels for Phoenix NPU1 ([HF: phoenix-npu1-iron-kernels](https://huggingface.co/mrtib/phoenix-npu1-iron-kernels)), [Phoronix: IREE/MLIR for Ryzen AI](https://www.phoronix.com/news/AMD-Ryzen-AI-LLVM-MLIR-Coding). None gives "load an ONNX detector and run it".
- **Container**: pass `/dev/accel/accel0`, raise `ulimit -l` (memlock) for XRT buffers, and install XRT plus the plugin userspace in the container. XRT cannot be redistributed in our image because of the AMD account-gated download. It would be a runtime-installed dep under `/data/deps`, like libedgetpu.
- **Verdict (spike closed 2026-10-10)**: driver works (`xrt-smi validate`
  PASS); Linux VitisAI has no Phoenix target — even a real WHQL `4x4` xclbin
  aborts on fingerprint. Value would also be low (~10 TOPS vs the live iGPU).
  **No CamStack NPU device.** Re-check only if AMD lists Phoenix on Linux.

## 3. Hardware decode (VAAPI)

- The 760M has VCN 4.0, which decodes H.264/HEVC/VP9/AV1 through Mesa's `radeonsi` VA-API driver. Any Mesa ≥ 23.x handles Phoenix. Ubuntu 24.04 noble ships Mesa 24.x/25.0 through noble-updates; confirm with `vainfo` on the box. Jellyfin documents AMD VAAPI as user-mode Mesa drivers plus `/dev/dri/renderD128` with the render group ([Jellyfin AMD HWA](https://jellyfin.org/docs/general/post-install/transcoding/hardware-acceleration/amd)).
- **Our ffmpeg** is the pinned jellyfin-ffmpeg **8.1.2-5 portable**. Its builder (`builder/scripts.d/50-vaapi`) builds libdrm and libva (as a lazy implib) with `-Ddriverdir=/usr/lib/x86_64-linux-gnu/dri`. It bundles **no VA drivers**, so the image must provide `radeonsi_drv_video.so` there. That file comes from Ubuntu's `mesa-va-drivers`.
- **node-av** (decoder-nodeav) uses FFmpeg built against libva 2.20 (Ubuntu 24.04+). Its docs list `mesa-va-drivers mesa-vulkan-drivers libva2 libva-drm2` as the host packages ([seydx/node-av](https://github.com/seydx/node-av)). So the same image fix serves both decoders.
- **Code state**: `packages/system/src/kernel/hwaccel/hwaccel-resolver.ts` already detects vendor `0x1002` and offers `vaapi` for AMD. `decode-hwaccel-rank.ts` already ranks vaapi high. **Two blockers in the image:**
  1. `Dockerfile:176 ENV LIBVA_DRIVER_NAME=iHD` forces the Intel driver. On AMD, VAAPI init fails and decode silently drops to software.
  2. `mesa-va-drivers` (and, for P1, `mesa-vulkan-drivers libvulkan1`) are not installed.

## 4. Proxmox

### Options
| Option | Verdict |
|---|---|
| **Unprivileged LXC + Docker CE inside** | **Recommended.** The GPU stays bound to the host `amdgpu`. `/dev/dri`, `/dev/accel` and `/dev/kfd` go into the CT via PVE `devN:` entries with `gid=` (PVE 8.1+, also in the UI under Resources → Add → Device Passthrough), so no hand-written idmap is needed. Our existing image and compose run unchanged. |
| Privileged LXC + Docker | A fallback if nested-Docker device access misbehaves. It is simpler but weaker isolation. |
| VM + iGPU passthrough | **Avoid.** Phoenix/780M-class iGPUs hit the AMD reset bug. vendor-reset reports "Unsupported reset method", and people end up with ROM files plus host hook scripts and host reboots ([PVE forum: 780M reset bug 8845HS](https://forum.proxmox.com/threads/reset-bug-on-780m-igpu-amd-8845hs-pro.169251/), [PVE forum: 8700G passthrough](https://forum.proxmox.com/threads/8700g-igpu-780m-passthrough.164429/)). A VM without the GPU is fine for a CPU-only demo but throws away P1/P2. |
| PVE 9.1 OCI-image LXC (run our image directly as an "application container") | It's interesting but new: limited env/entrypoint/update story, and device passthrough isn't documented for it ([linuxiac PVE 9.1](https://linuxiac.com/proxmox-ve-9-1-released-with-oci-based-lxc-deployment/)). Revisit later. |

Docker-in-LXC trap: the containerd.io 1.7.28-2 fix for CVE-2025-52881 broke Docker inside LXC with `open sysctl net.ipv4.ip_unprivileged_port_start ... permission denied` ([PVE forum thread](https://forum.proxmox.com/threads/cve-2025-52881-breaks-docker-lxc-containers.175827/), [ktz blog](https://blog.ktz.me/apparmors-awkward-aftermath-atop-proxmox-9)).
- Update `pve-container`/`lxc-pve` first.
- If it still happens, add `lxc.apparmor.profile: unconfined` plus `lxc.mount.entry: /dev/null sys/module/apparmor/parameters/enabled none bind 0 0`.

### Host kernel
- PVE 9.1 (Nov 2025, Debian 13.2) ships kernel **6.17** ([datazone PVE 9.1](https://datazone.de/en/aktuelles/proxmox-ve-9-1-release/)). PVE 9.0 shipped 6.14 with 6.17 opt-in ([PVE forum opt-in 6.17](https://forum.proxmox.com/threads/opt-in-linux-6-17-kernel-for-proxmox-ve-9-available-on-test-no-subscription.173920/)).
- Both are ≥ 6.14, so `amdgpu` and `amdxdna` are in-tree. Whether the PVE kernel config enables `CONFIG_DRM_ACCEL_AMDXDNA` is **unverified**. It is Ubuntu-derived and Ubuntu enables it. Check with `modinfo amdxdna`.
- **Use PVE 9.x (latest, kernel ≥ 6.17). Not PVE 8** (6.8 kernel, no amdxdna).

### Exact steps (P0 setup; the operator does this, then gives SSH)
**BIOS**
- Enable SVM and IOMMU (amdxdna needs IOMMU SVA).
- Set **UMA Frame Buffer Size to 4 GB** if the option exists. It matters for iGPU compute; Vulkan also uses GTT.
- Leave Secure Boot as you like; in-tree modules are signed.

**Host (PVE 9.x)**
```bash
apt update && apt full-upgrade -y          # latest pve-kernel (>=6.17) + pve-firmware
reboot
uname -r                                   # expect 6.17+
ls -l /dev/dri /dev/accel /dev/kfd         # renderD128, card*, accel0, kfd
lsmod | grep -E 'amdgpu|amdxdna'
dmesg | grep -iE 'amdxdna|amdgpu.*(VCN|firmware)'
ls /lib/firmware/amdnpu/1502_00/           # npu.sbin (and npu_7.sbin)
cat /sys/class/drm/renderD128/device/{vendor,device}   # 0x1002 0x15bf
apt install -y vainfo vulkan-tools mesa-va-drivers mesa-vulkan-drivers   # host-side sanity only
vainfo --display drm --device /dev/dri/renderD128     # H264/HEVC VLD entrypoints
```
Do **not** blacklist `amdgpu` or bind vfio. That is the VM path.

**Create the CT.** Ubuntu 24.04 template, unprivileged, 12 vCPU, 16 GB RAM, 64 GB rootfs plus a recordings mount point:
```bash
pveam update && pveam download local ubuntu-24.04-standard_24.04-2_amd64.tar.zst
pct create 200 local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst \
  --hostname camstack --unprivileged 1 --features nesting=1,keyctl=1 \
  --cores 12 --memory 16384 --swap 2048 --rootfs local-lvm:64 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp --onboot 1
pct start 200
RGID=$(pct exec 200 -- getent group render | cut -d: -f3)   # usually 993 on noble
VGID=$(pct exec 200 -- getent group video  | cut -d: -f3)
pct set 200 -dev0 /dev/dri/renderD128,gid=$RGID,mode=0660
pct set 200 -dev1 /dev/dri/card1,gid=$VGID,mode=0660        # use the actual card* name; optional
pct set 200 -dev2 /dev/accel/accel0,gid=$RGID,mode=0660     # P2 only, harmless now
# pct set 200 -dev3 /dev/kfd,gid=$RGID,mode=0660            # ONLY if the ROCm fallback is ever tried
# recordings on a bigger disk:  pct set 200 -mp0 /tank/camstack,mp=/srv/camstack
pct reboot 200
```

**Inside the CT**
```bash
apt update && apt install -y ca-certificates curl vainfo vulkan-tools mesa-va-drivers mesa-vulkan-drivers
curl -fsSL https://get.docker.com | sh
vainfo --display drm --device /dev/dri/renderD128      # must list radeonsi + VAProfileH264*/HEVC*
vulkaninfo --summary                                    # must list "AMD Radeon 760M (RADV PHOENIX)"
ls -l /dev/accel/accel0
```

**Compose.** Take the existing `docker-compose.mdx` and change it as follows:
- `devices: [/dev/dri:/dev/dri, /dev/accel:/dev/accel]`
- `group_add: ["<RGID>"]`
- drop `/dev/bus/usb` and `device_cgroup_rules` (no Coral in the CT)
- keep `network_mode: host`
- until P0 ships, add `environment: LIBVA_DRIVER_NAME=radeonsi` to override the image's `iHD`

**cloudflared** for the Alexa demo: run it as a second compose service or with apt in the same CT.

## 5. Plan for CamStack

### What exists today (code read)
- `platform-scorer.ts probeHardware`:
  - Apple → `apple`/`apple-ane`
  - Linux → NVIDIA via `nvidia-smi`, then Intel via renderD vendor `0x8086` (`intel-accelerators.ts`), then AMD via `0x1002` (`amd-accelerators.ts`), then Intel NPU (`intel-npu.ts`), then AMD XDNA present-only (`amd-npu.ts`).
  - `GpuInfo.type` includes `'amd'`. `NpuInfo.type` is `'apple-ane' | 'intel-npu' | 'amd-xdna'` (XDNA is present-only until P2).
- `hwaccel-resolver.ts` already detects `0x1002` → `vaapi`.
- `runtime-capabilities.ts` (shipped):
  - ONNX: `cpu` (+`cuda` NVIDIA, +`coreml`, +`webgpu` when `gpu.type==='amd'`)
  - OpenVINO: Intel iGPU/NPU, or AMD via `openvino:cpu` (int8 IRs on Zen4 VNNI)
- `inference_pool.py` + `webgpu_isolated.py` (D823): each WebGPU model is one
  child process (Dawn/Vulkan SIGSEGVs on a second in-process session).
  `requirements-webgpu.txt` proactively installed on AMD. OpenVINO / CoreML /
  classic ONNX stay in-process.
- Auto tune (`types/src/pipeline/auto-tune/`):
  - `HardwareClassId` includes `amd-phoenix`. `AcceleratorKind` includes
    `amd-igpu` / `amd-npu`. `acceleratorKindOf('onnx:webgpu')` → `amd-igpu`.
  - `DETECTOR_PERF` is mirrored from `docs/benchmarks/detector-latency.json`, with a spec holding the two equal.
- Models: yolov9 t/s/m at 320/640 ship static ONNX fp32, CoreML fp16, OpenVINO fp16 and int8 (`model-catalogs.ts`, `scripts/build-camstack-models.py`, HF `camstack/camstack-models`).
- Image: `ubuntu:24.04`, variant label `intel`, Intel apt repo, `intel-media-va-driver-non-free`, `ENV LIBVA_DRIVER_NAME=iHD`. ffmpeg is downloaded at runtime (jellyfin portable). Tag `ghcr.io/camstack/camstack:intel-latest`.

### P0: CPU + VAAPI decode on Proxmox (Alexa demo hub). ~4-5 dev days
1. **Image** — **done as two Dockerfile targets** (`intel` / `amd`), same npm
   closure, accel-prefixed tags (`intel-*`, `amd-*`). Decision revised 2026-10-09:
   a single image with both stacks left hundreds of MB of Intel GPU/NPU userspace
   on every AMD host and kept the footgun `LIBVA_DRIVER_NAME=iHD`. ROCm/XRT still
   never enter either image.
   - `amd` stage: `mesa-va-drivers mesa-vulkan-drivers libvulkan1`; no LIBVA pin
     (libva selects `radeonsi`).
   - `intel` stage: unchanged Intel GPU apt + NPU tarball + `LIBVA_DRIVER_NAME=iHD`.
   - Unraid stays on `intel-latest`; Proxmox / AMD APU hosts use `amd-latest`.
2. **Platform probe**
   - Add `amd-accelerators.ts`: renderD vendor `0x1002` → `gpu {type:'amd', name:'AMD Radeon 760M (gfx1103)'}`. Get the gfx target from a small PCI-device-id table (`15bf`/`15c8` Phoenix, `1900` Hawk Point, `150e` Strix…), or from `/sys/class/kfd/.../gfx_target_version` when `/dev/kfd` exists.
   - Add `amd-npu.ts`: `/sys/class/accel/accel*/device/{vendor,device}` = `0x1022` / `0x1502` (Phoenix) | `0x17f0` (Strix) → `npu {type:'amd-xdna', generation:'xdna1'|'xdna2'}`. Report it as *present* only. Do not offer it as a device until P2.
   - Unit tests with an injected fs, like the Intel classifiers.
3. **Hardware class**
   - Add `HardwareClassId 'amd-phoenix'`, regex `/Ryzen \d+ (7[0-9]40|8[0-9]40|8[0-9]45)[HSU]|Ryzen \d+ 8[0-9]00G/`, covering the 7040/8040 Phoenix and Hawk Point mobile parts and the 8000G desktop parts.
   - Fill its `x86-cpu` column by **measuring on the box with Benchmark**, then update `detector-latency.json` and `detector-performance.ts` together.
4. **Optional, cheap, possibly big win:** allow the **OpenVINO CPU** device on AMD x64 (relax `OPENVINO_DEF.supports` so CPU-only works without an Intel GPU, `devices: [CPU]`). That lets the existing int8 IRs use Zen4 AVX-512 VNNI. Benchmark ORT-CPU against OV-CPU on the box and keep whichever wins.
5. **Docs**
   - Public docs: new `installation/proxmox.mdx` with the section 4 steps, plus a `meta.json` entry.
   - Internal: `docs/architecture/inference-devices.md` gets the fleet row and the AMD probe. `ffmpeg.md` gets the per-vendor LIBVA note.
6. **Verify on the box**
   - `vainfo` in the container.
   - Decoder `reprobeHwaccel` → `vaapi`.
   - A 4K HEVC camera decodes with low CPU. Compare `top` with and without hwaccel.
   - The Alexa egress path works through cloudflared.

### P1: iGPU inference via ONNX Runtime WebGPU EP. ~6-9 dev days
1. **Python pool**
   - Add `requirements-webgpu.txt`: `onnxruntime>=1.23,<2` plus `onnxruntime-ep-webgpu`. Installed lazily like the other backends.
   - In `_load_model` (onnxruntime branch), when `device=="webgpu"`: `register_execution_provider_library`, then select the WebGPU `OrtEpDevice` for the AMD adapter, then `add_provider_for_devices`, with CPU fallback.
   - Log the active EP and the nodes that fell back to CPU. Extend `_resolve_onnx_providers` tests.
   - Watch for: graph-capture only with static shapes (fine here), fp16 shader support on RADV, and **first-run shader compile time** (bound it like the OV compile).
2. **Device key `onnx:webgpu`**
   - Offer it in `ONNX_DEF.devices` when `gpu.type==='amd'`. Possibly Intel as well later, but OpenVINO stays better there.
   - `AcceleratorKind 'amd-igpu'`, plus `acceleratorKindOf('onnx:webgpu')` → `amd-igpu` when `gpu.type==='amd'`.
   - Default `enabled` = opt-OUT like other iGPUs (D39; the Coral joined them in D912).
   - Make sure the share/least-loaded placement and the root-capability guard accept it. The format is `onnx`, which the guard already supports.
3. **Models**: no new format.
   - Optionally add **fp16 ONNX** builds (`OnnxExport` plus a fp16 conversion step in `build-camstack-models.py`, uploaded to HF) if fp32 is slow under WebGPU. Measure first.
   - Detail-plane models (face, plate, CLIP) are ONNX too, so they get the device for free if their ops are covered.
4. **Measure** the `amd-phoenix / amd-igpu` column (t/s/m × 320/640, single and concurrent) with Benchmark/capacity-ramp. Shares (D748/D750) then weigh it against CPU.
5. **Fallback (only if WebGPU underperforms or op coverage fails)**: a ROCm + `onnxruntime-migraphx` spike, as runtime-installed deps under `/data/deps/rocm` with `/dev/kfd` and `HSA_OVERRIDE_GFX_VERSION=11.0.0`.
   - Cost: 2-3 days for the spike, multi-GB deps, unofficial.
   - It would be a separate device key `migraphx:gpu`.

### P2: NPU (XDNA1) — CLOSED no-go (2026-10-10; four more avenues 2026-10-13)

2026-10-13 re-check, evidence table in
`docs/benchmarks/2026-10-13-phoenix-npu-and-igpu.md` §1: (a) `iree-amd-aie`
no-go — no wheels, dormant since 2026-06, source build out of budget;
(b) mlir-aie/IRON **runs** (`vector_scalar_add` PASS on `RyzenAI-npu1` via
XRT 2.27 + in-tree `amdxdna`, Peano wheels, `cmake ≥ 3.30`) but is a kernel
toolchain with no ONNX front-end; (c) no Ryzen AI release lists Phoenix on
Linux; (d) a Windows VM with the NPU (`66:00.1`, alone in IOMMU group 25)
passed through is feasible at the hypervisor but CamStack has no Windows
node. Lab toolchains stay in `/opt/npu-lab` on CT201 (snapshot
`pre-npu-igpu-20261013`). Original spike:

Spike run on CT201:

1. ~~XRT + amdxdna plugin~~ — open `amd/xdna-driver` XRT 2.27 + plugin
   (`SKIP_KMOD`; host already has `amdxdna`). Needs
   `lxc.prlimit.memlock: unlimited` or `xrt-smi` mmap EAGAIN. Ubuntu apt
   `libxrt` must not pollute `/usr/lib`.
2. ~~`xrt-smi examine` / `validate`~~ — **PASS**. RyzenAI-npu1, aie2, 6×5,
   fw 1.5.5.391; latency ~109 µs, throughput ~24k ops/s.
3. ~~`ryzen_ai-1.8.0.tgz`~~ — installed under `/opt/ryzen-ai-1.8.0`. Official
   `quicktest.py` exits on non-STX/KRK (`1022:17f0`; Phoenix is `1022:1502`).
4. Forced VitisAI sessions (`target=X1`, providers = VitisAI only):
   - Linux tree `phx/base.xclbin` is a **Git LFS pointer** (129 B) → silent CPU
     fallback ("xclbin header too small").
   - STX `unified-4x4.xclbin` → abort wrong fingerprint.
   - WHQL `4x4_3.5.0.0-2352.xclbin` (real `xclbin2`, 4.0 MB from
     `NPU_RAI_280_WHQL.zip`) → abort
     `Cannot find or create target with fingerprint=0x080002050018eec1`.
5. Windows `ryzen-ai-1.8.0.exe` MSI extracted: **no**
   `voe-4.0-win_amd64/xclbins/phoenix/4x4.xclbin` (quicktest still references
   it). Only `vaip_config.json` under that tree.

**Verdict: no-go.** Hardware and XRT validate work; Linux VOE/VitisAI has no
Phoenix target. Do **not** add `vitisai:npu`. Re-open the spike only when AMD
documents Phoenix on Linux Ryzen AI (or a CamStack Windows/NPU product exists).

### CI considerations
- No AMD hardware in CI. Classifiers, provider resolution and capability offers get unit tests with injected sysfs/`ort` fakes.
- The image build stays one job. Add a smoke check that `radeonsi_drv_video.so` and `libvulkan_radeon.so` exist in the image.
- Measured perf cells come from the physical box. Keep `measured:false` until then.
- Never dispatch the Checks workflow (operator-only).

### Risks
- Dropping `LIBVA_DRIVER_NAME=iHD` regresses the Intel hub, so verify there before shipping.
- Docker-in-LXC AppArmor/runc breakage (known fix above).
- WebGPU EP is young (plugin 0.4.0). Op coverage and perf on RADV are unknown, and so are the shader-compile stalls on first load.
- Shared memory bandwidth: iGPU inference and VAAPI decode compete with each other and with the CPU on one DDR5 bus.
- NPU: no supported Linux stack for Phoenix, and an account-gated, non-redistributable SDK.

### What needs the physical machine (operator first, then SSH)
1. BIOS: SVM, IOMMU, UMA frame buffer 4 GB.
2. PVE 9.x latest (kernel ≥ 6.17), `apt full-upgrade`, reboot.
3. Output of the host sanity commands in section 4: `uname -r`, `ls -l /dev/dri /dev/accel /dev/kfd`, `lsmod`, `dmesg`, `/lib/firmware/amdnpu`, `vainfo`.
4. CT 200 created as above with `dev0`/`dev2` (and `mp0` for recordings). Inside the CT: Docker CE, `vainfo`, `vulkan-tools`, `mesa-va-drivers`, `mesa-vulkan-drivers`.
5. SSH key access to **both** the PVE host (read-only checks, `pct`) and the CT.
6. For the Alexa demo: one camera on the LAN, and a Cloudflare tunnel token/hostname (operator-held).
7. ~~P2 Ryzen AI installer~~ — done; inference no-go (see §5 P2). Leave XRT
   userspace on the CT only if useful for `xrt-smi`; do not productize it.

Then on the box (leftovers): measure the **CPU** column (`openvino:cpu` /
`cpu`); public Proxmox docs; Alexa camera + tunnel. WebGPU Auto-tune column
is filled (below). No further NPU inference work on Linux.

### P1 catalog + multi-session + latency (2026-10-10)

Sweep on `agent-b` / `onnx:webgpu` (alone + `restartAddon` between models):
**32/32** catalog ONNX models ok. Full matrix + cold latencies:
`docs/benchmarks/2026-10-10-amd-webgpu-catalog.md`.

**Multi-model (D823):** same-process second WebGPU session still SIGSEGVs;
product fix is one OS child per model (`webgpu_isolated.py`, pipe IPC). OD +
face on WebGPU verified. CLIP stays unavailable (no onnx build).

**Auto-tune latency** (`amd-phoenix/amd-igpu`): warm median via
`scripts/bench-detector-latency-column.mjs` — see
`docs/benchmarks/detector-latency.json`. `yolov9m-640` omitted (sheds at 3 s).
