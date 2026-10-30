#!/usr/bin/env bash
# Install CamStack into a Proxmox VE LXC (Ubuntu 24.04 + Docker CE + amd image).
# Run on the PVE HOST (needs `pct`), not inside a container.
#
#   ROLE=hub  VMID=200 bash install-camstack-proxmox.sh
#   ROLE=agent VMID=201 CAMSTACK_HUB_ADDRESS=192.168.1.9 \
#     CAMSTACK_NODE_ID=amd-proxmox bash install-camstack-proxmox.sh
#
# Hub and agent on the same machine = two CTs (host networking collides otherwise).
#
# Accelerators present on the host are passed into the CT and enabled in the
# generated compose: /dev/dri, /dev/accel, /dev/apex_* (Coral PCIe/M.2) and a
# Coral USB. PASS_ACCEL=none skips all of it; PASS_KFD=1 adds /dev/kfd (ROCm).
#
# Opt-in, separate host step (never run by an install):
#   bash install-camstack-proxmox.sh --install-coral-pcie-driver
#   (curl … | bash -s -- --install-coral-pcie-driver)
set -euo pipefail

PCT=$(command -v pct || true)
if [ -z "$PCT" ]; then
  echo "pct not found. Run this on the Proxmox host."
  echo "Docs: https://camstack.io/docs/installation/proxmox"
  exit 1
fi

ROLE="${ROLE:-hub}"
case "$ROLE" in
  hub|agent) ;;
  *) echo "ROLE must be hub or agent (got: $ROLE)"; exit 1 ;;
esac

if [ "$ROLE" = "hub" ]; then
  VMID="${VMID:-200}"
  HOSTNAME="${HOSTNAME_CT:-camstack}"
  COMPOSE_NAME="hub.yml"
else
  VMID="${VMID:-201}"
  HOSTNAME="${HOSTNAME_CT:-camstack-agent}"
  COMPOSE_NAME="agent.yml"
fi

CORES="${CORES:-8}"
MEMORY_MB="${MEMORY_MB:-8192}"
SWAP_MB="${SWAP_MB:-2048}"
DISK_GB="${DISK_GB:-64}"
BRIDGE="${BRIDGE:-vmbr0}"
IMAGE_TAG="${IMAGE_TAG:-ghcr.io/camstack/camstack:amd-latest}"
# Optional: host directory for recordings, bound at /opt/camstack/recordings
# in the CT (same path Docker maps to CAMSTACK_MEDIA_ROOT). Prefer attaching
# a real HD later with setup-camstack-recordings-volume.sh if unknown now.
RECORDINGS_HOST_PATH="${RECORDINGS_HOST_PATH:-}"
FORCE="${FORCE:-}"
# auto = pass every accelerator node the host has; none = pass nothing.
PASS_ACCEL="${PASS_ACCEL:-auto}"
case "$PASS_ACCEL" in
  auto|none) ;;
  *) echo "PASS_ACCEL must be auto or none (got: $PASS_ACCEL)"; exit 1 ;;
esac
# /dev/kfd (AMD ROCm compute) only on request: the image has no ROCm runtime.
