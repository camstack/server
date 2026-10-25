# Public-docs draft: hardware accelerators on Proxmox (LXC + Docker), Coral PCIe validated

Status: DRAFT for the public docs (`camstack/docs`, D717/D822). The device
lines also belong in the Proxmox install script (`camstack/proxmox`), which is
mirrored by hand. Plain Docker: `2026-10-21-public-draft-accelerators-docker.md`.

Proxmox differs from plain Docker in one way that matters: there are TWO
hops. The driver runs on the **PVE host**, the device node is passed into the
**LXC container** with a `devN:` entry, and the CamStack compose inside the CT
passes it on to the **Docker container**.

Validated on `agent-b` (2026-10-21): PVE 9.2.2, kernel `7.0.2-6-pve`,
Secure Boot off, two PCIe Corals (`1ac1:089a`), unprivileged CT running
Docker CE and the `amd-latest` image.

## 1. Host driver (PVE host shell)

```sh
# no-subscription repository (skip if you have a subscription)
echo "deb http://download.proxmox.com/debian/pve trixie pve-no-subscription" \
  > /etc/apt/sources.list.d/pve-no-subscription.list
apt-get update
apt-get install --no-install-recommends proxmox-headers-$(uname -r) dkms git build-essential

git clone https://github.com/feranick/gasket-driver.git /usr/src/gasket-1.0
cp /usr/src/gasket-1.0/debian/gasket-dkms.dkms /usr/src/gasket-1.0/dkms.conf
sed -i 's/^PACKAGE_VERSION=.*/PACKAGE_VERSION=1.0/' /usr/src/gasket-1.0/dkms.conf
dkms add -m gasket -v 1.0
dkms build -m gasket -v 1.0
dkms install -m gasket -v 1.0

groupadd -f apex
echo 'SUBSYSTEM=="apex", MODE="0660", GROUP="apex"' > /etc/udev/rules.d/65-apex.rules
reboot              # a clean boot; a live modprobe was not used on the validated box
ls -l /dev/apex_*   # /dev/apex_0, /dev/apex_1
```

Match the suite in the repository line to your PVE release (`trixie` for PVE
9, `bookworm` for PVE 8). With **Secure Boot on**, enrol the DKMS key before
the reboot: `mokutil --import /var/lib/dkms/mok.pub`, then accept it in the
MOK screen at boot.

## 2. Pass the devices into the CT (PVE host shell)

`gid` is the group id INSIDE the CT that should own the node (993 on the
validated CT); `mode=0660` keeps it private to that group.

```sh
CT=201
pct set $CT -dev0 /dev/dri/renderD128,gid=993,mode=0660   # AMD/Intel iGPU   (uncomment what you have)
pct set $CT -dev1 /dev/accel/accel0,gid=993,mode=0660     # Intel NPU / AMD XDNA
pct set $CT -dev2 /dev/kfd,gid=993,mode=0660              # AMD ROCm (optional)
pct set $CT -dev3 /dev/apex_0,gid=993,mode=0660           # Coral PCIe unit 1
pct set $CT -dev4 /dev/apex_1,gid=993,mode=0660           # Coral PCIe unit 2
pct reboot $CT
```

A Coral USB in an LXC needs the USB bus instead (`lxc.cgroup2.devices.allow:
c 189:* rwm` plus a bind mount of `/dev/bus/usb` in `/etc/pve/lxc/<CT>.conf`).
NVIDIA in an LXC needs the host driver, the same driver version in the CT and
the NVIDIA Container Toolkit; Hailo is not supported by CamStack today.

## 3. Compose inside the CT

```yaml
services:
  camstack:
    image: ghcr.io/camstack/camstack:amd-latest   # intel-latest on Intel
    network_mode: host
    volumes:
      - /opt/camstack/data:/data
    devices:
      # iGPU (VAAPI decode, WebGPU / OpenVINO GPU)
      # - /dev/dri:/dev/dri
      # Intel NPU / AMD XDNA
      # - /dev/accel:/dev/accel
      # AMD ROCm (optional)
      # - /dev/kfd:/dev/kfd
      # Coral PCIe / M.2 — one line per unit passed in step 2
      # - /dev/apex_0:/dev/apex_0
      # - /dev/apex_1:/dev/apex_1
```

The entrypoint makes every passed node openable by the `camstack` user, so no
`group_add` is needed for CamStack itself — for `/dev/apex_*` only from the
first Docker release after v1.2.583. The validated CT ran v1.2.509 with a
host-mounted entrypoint (`- /opt/camstack/docker-entrypoint.sh:/usr/local/bin/docker-entrypoint.sh:ro`,
added earlier for `/dev/dri/renderD*`); that copy had to gain `/dev/apex_*`
in its device chown loop before the Corals opened. With a current image, do
not mount an entrypoint at all; if you carry one from an older install,
remove the mount when you pull a newer image.

## 4. Coral runtime, then enable it

```sh
docker exec -u root camstack sh /data/addons/@camstack/addon-pipeline/python/edgetpu-install.sh
```

Then, per node, enable `Coral Edge TPU (PCIe)` and `(PCIe 2)` (device keys
`edgetpu:pci`, `edgetpu:pci:1`) under Pipeline → the node → Inference
devices. A Coral is never enabled on its own (it runs the smaller SSD model
family).

Proof it is in use: the node log shows `EdgeTPU: delegate bound to device
'pci:0'` (and `'pci:1'`) when the first model loads on it. Measured on the
validated box (Ryzen 5 7640HS, warm per-step latency): SSD MobileNet V2
14–16 ms, bird classifier 9–10 ms, YuNet 22–29 ms, YOLOX-tiny plate ~61 ms;
the Zen4 CPU on OpenVINO is as fast or faster per request, so the Coral's
gain there is CPU headroom.

If the Coral is missing there, the node log names the reason:
`Coral Edge TPU present but unusable` — `driver-missing` (step 1 not done or
not booted) or `device-not-accessible` (step 2 or 3 missing).
