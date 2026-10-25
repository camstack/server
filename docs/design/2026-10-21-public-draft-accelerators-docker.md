# Public-docs draft: hardware accelerators with plain Docker (Coral USB / PCIe included)

Status: DRAFT for the public docs (`camstack/docs`, D717/D822) — port it there;
this repo does not publish it. Companion drafts:
`2026-10-21-public-draft-accelerators-proxmox.md` (Proxmox LXC) and
`2026-10-21-public-draft-accelerators-desktop.md` (the desktop app).

## What you need

Two things, always: the **host driver** for the device, and the **device node
passed into the container**. The image already carries every userspace
library it needs (Mesa VA/Vulkan on `amd`, the Intel media/NPU stack on
`intel`, `libusb-1.0-0` on both). The container entrypoint makes every passed
accelerator node openable by the `camstack` user, so `group_add` is only
needed by tooling that runs as root in the container.

**Coral PCIe and older images.** The entrypoint chowns `/dev/apex_*` only from
the first Docker release after v1.2.583. On an older image `/dev/apex_N` is
passed in but not openable (`reason: device-not-accessible`), and `group_add`
does not help (the server drops supplementary groups when it switches to the
`camstack` user). Pull a newer image; if that is not possible yet, mount a
copy of the image's `/usr/local/bin/docker-entrypoint.sh` whose device chown
loop includes `/dev/apex_*`, and remove that mount once you update — a mounted
entrypoint hides every later fix to it.

Measured on a Ryzen 5 7640HS with two PCIe Corals (warm per-step latency,
including pre/post-processing):

| Model | Coral PCIe | Same box, OpenVINO CPU |
| --- | --- | --- |
| SSD MobileNet V2 (COCO) | 14–16 ms | — |
| Bird classifier | 9–10 ms | 10 ms |
| YuNet face detection | 22–29 ms | 14 ms |
| YOLOX-tiny plate detection | ~61 ms | 23 ms |

On a modern x86 CPU the Coral does not beat OpenVINO per request — it takes
the work off the CPU. It pays off most on weak CPUs and on busy nodes.

| Device | Host driver | Container |
| --- | --- | --- |
| Intel iGPU | `i915`/`xe` (in-kernel) | `/dev/dri` |
| Intel NPU (Core Ultra) | `intel_vpu` (in-kernel, 6.8+) | `/dev/accel` |
| AMD iGPU/GPU | `amdgpu` (in-kernel) | `/dev/dri` (+ `/dev/kfd` for ROCm) |
| AMD XDNA NPU | `amdxdna` | `/dev/accel` — detected, no runtime yet |
| NVIDIA | the NVIDIA driver + NVIDIA Container Toolkit | `gpus: all` |
| Coral USB | none (libusb) | `/dev/bus/usb` + cgroup rule `c 189:* rmw` |
| Coral PCIe / M.2 | `gasket` + `apex` (DKMS, see below) | `/dev/apex_0`, `/dev/apex_1`, … |
| Hailo | — | not supported by CamStack today |

## Compose — uncomment what you have

```yaml
services:
  camstack:
    image: ghcr.io/camstack/camstack:intel-latest   # or amd-latest
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./data:/data
    # devices:
      # Intel iGPU (VAAPI/QSV decode, OpenVINO GPU) — needs group render/video
      # - /dev/dri:/dev/dri
      # Intel NPU (OpenVINO NPU, Core Ultra) — node /dev/accel/accel0
      # - /dev/accel:/dev/accel
      # AMD iGPU/GPU (VAAPI decode, ONNX WebGPU) — needs group render/video
      # - /dev/dri:/dev/dri
      # AMD ROCm compute (optional) — needs group render
      # - /dev/kfd:/dev/kfd
      # AMD XDNA NPU (detected only, no inference runtime yet)
      # - /dev/accel:/dev/accel
      # Coral USB Edge TPU — the whole bus: the Coral re-enumerates after firmware load
      # - /dev/bus/usb:/dev/bus/usb
      # Coral PCIe / M.2 Edge TPU — one line per unit; host gasket/apex driver required
      # - /dev/apex_0:/dev/apex_0
      # - /dev/apex_1:/dev/apex_1
    # device_cgroup_rules:
      # Coral USB: allow any USB minor (major 189) after re-enumeration
      # - 'c 189:* rmw'
    # group_add:
      # Intel / AMD GPU nodes
      # - render
      # - video
      # Coral PCIe nodes, when the host gives them an `apex` group
      # - apex
    # NVIDIA (CUDA) — needs the NVIDIA Container Toolkit on the host
    # gpus: all
```

## Coral PCIe / M.2 on a Debian/Ubuntu host

The in-tree `gasket` driver is gone from current kernels; use the maintained
fork and DKMS.

```sh
apt-get install --no-install-recommends linux-headers-$(uname -r) dkms git build-essential
git clone https://github.com/feranick/gasket-driver.git /usr/src/gasket-1.0
cp /usr/src/gasket-1.0/debian/gasket-dkms.dkms /usr/src/gasket-1.0/dkms.conf
sed -i 's/^PACKAGE_VERSION=.*/PACKAGE_VERSION=1.0/' /usr/src/gasket-1.0/dkms.conf
dkms add -m gasket -v 1.0
dkms build -m gasket -v 1.0
dkms install -m gasket -v 1.0
groupadd -f apex
echo 'SUBSYSTEM=="apex", MODE="0660", GROUP="apex"' > /etc/udev/rules.d/65-apex.rules
reboot                       # load on a clean boot; a live modprobe was not reliable
ls -l /dev/apex_*            # expect crw-rw---- root apex
```

With **Secure Boot on**, DKMS signs the module with its MOK key: run
`mokutil --import /var/lib/dkms/mok.pub`, set a one-time password, and accept
the enrolment in the blue MOK screen on the next boot — otherwise the module
does not load.

## Coral runtime (both buses)

The Edge TPU delegate is not in the image. Install it once, from inside the
container; it lands under `/data/deps` and survives image updates:

```sh
docker exec -u root camstack sh /data/addons/@camstack/addon-pipeline/python/edgetpu-install.sh
```

It installs `ai-edge-litert` 2.1.6, the libedgetpu "std" delegate built for
TF 2.17.1, and a `libusb-1.0.so.0` beside it (the delegate needs libusb even
for PCIe).

## Turn it on

A Coral is never used until you enable it, per node (it runs a different,
smaller model family): Pipeline → the node → Inference devices → enable
`Coral Edge TPU (PCIe)` / `(PCIe 2)` / `Coral Edge TPU` (USB).

If the node shows no Coral, the platform probe says why in the node log:
`Coral Edge TPU present but unusable` with `reason: driver-missing` (the PCI
card is there, the host driver is not) or `reason: device-not-accessible`
(the driver is loaded but `/dev/apex_N` is not passed in, or not openable).

## Unraid template — uncomment what you have

For `camstack/unraid-templates` (mirrored by hand, D717). Each block is one
`<Config>`; leave out what the box does not have.

```xml
<!-- Intel / AMD iGPU (VAAPI decode, OpenVINO GPU / WebGPU) -->
<!-- <Config Name="GPU" Target="/dev/dri" Default="/dev/dri" Mode="" Description="Intel/AMD iGPU" Type="Device" Display="advanced" Required="false" Mask="false">/dev/dri</Config> -->
<!-- Intel NPU / AMD XDNA -->
<!-- <Config Name="NPU" Target="/dev/accel" Default="/dev/accel" Mode="" Description="Intel NPU" Type="Device" Display="advanced" Required="false" Mask="false">/dev/accel</Config> -->
<!-- Coral USB: bind the whole bus + ExtraParams --device-cgroup-rule='c 189:* rmw' -->
<!-- <Config Name="Coral USB" Target="/dev/bus/usb" Default="/dev/bus/usb" Mode="rw" Description="Coral USB Edge TPU" Type="Path" Display="advanced" Required="false" Mask="false">/dev/bus/usb</Config> -->
<!-- Coral PCIe / M.2: one per unit; needs the gasket/apex driver plugin on the Unraid host -->
<!-- <Config Name="Coral PCIe 1" Target="/dev/apex_0" Default="/dev/apex_0" Mode="" Description="Coral PCIe Edge TPU" Type="Device" Display="advanced" Required="false" Mask="false">/dev/apex_0</Config> -->
<!-- <Config Name="Coral PCIe 2" Target="/dev/apex_1" Default="/dev/apex_1" Mode="" Description="Coral PCIe Edge TPU" Type="Device" Display="advanced" Required="false" Mask="false">/dev/apex_1</Config> -->
<!-- NVIDIA: ExtraParams --runtime=nvidia, plus NVIDIA_VISIBLE_DEVICES=all -->
```
