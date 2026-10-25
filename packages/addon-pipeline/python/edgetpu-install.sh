#!/bin/sh
# Coral Edge TPU runtime installer — USB and PCIe/M.2.
#
# Installs, persistently under the data volume (default /data/deps):
#   - the LiteRT interpreter (ai-edge-litert) into the shared Python venv;
#   - feranick's libedgetpu "std" delegate rebuilt against TF 2.17.1 — the
#     delegate's TF version MUST match ai-edge-litert 2.1.6 (stock Coral
#     libedgetpu 16.0/grouper fails at invoke);
#   - libusb-1.0.so.0 beside the delegate: the std delegate links libusb even
#     for a PCIe Coral, and an image without it cannot load the delegate at all.
#     The inference pool preloads this copy, so no LD_LIBRARY_PATH is needed.
#
# PCIe needs the host gasket/apex driver: this script installs userspace only.
# A PCIe/M.2 Coral additionally needs the gasket + apex kernel modules loaded
# ON THE HOST (they create /sys/class/apex/apex_N and /dev/apex_N), and each
# /dev/apex_N passed into the container, readable and writable by the CamStack
# user. Until then the probe reports the Coral as `driver-missing` or
# `device-not-accessible`, never as absent.
#
# A USB Coral needs /dev/bus/usb passed through plus the cgroup rule
# `c 189:* rmw` (it re-enumerates its USB minor after firmware load).
#
# Usage (inside the container, as root):
#   sh <addon>/python/edgetpu-install.sh
# Re-run after a venv rebuild. Idempotent.
#
# Overrides: CAMSTACK_DEPS_DIR (default /data/deps),
#            CAMSTACK_PYTHON   (default $CAMSTACK_DEPS_DIR/python/bin/python).
set -eu

DEPS_DIR="${CAMSTACK_DEPS_DIR:-/data/deps}"
PYTHON="${CAMSTACK_PYTHON:-$DEPS_DIR/python/bin/python}"
LIB_DIR="$DEPS_DIR/edgetpu/lib"

LITERT_VERSION="2.1.6"
EDGETPU_TAG="16.0TF2.17.1-1"
EDGETPU_VERSION="16.0tf2.17.1-1"
EDGETPU_DISTRO="ubuntu24.04"
LIBUSB_VERSION="1.0.27-1"

log() { echo "[edgetpu-install] $*"; }
die() { echo "[edgetpu-install] ERROR: $*" >&2; exit 1; }

case "$(uname -m)" in
  x86_64 | amd64)
    DEB_ARCH="amd64"
    UBUNTU_POOL="http://archive.ubuntu.com/ubuntu/pool/main"
    ;;
  aarch64 | arm64)
    DEB_ARCH="arm64"
    UBUNTU_POOL="http://ports.ubuntu.com/ubuntu-ports/pool/main"
    ;;
  *) die "unsupported architecture $(uname -m)" ;;
esac

command -v dpkg-deb > /dev/null 2>&1 || die "dpkg-deb not found (needs a Debian/Ubuntu container)"
command -v curl > /dev/null 2>&1 || die "curl not found"
[ -x "$PYTHON" ] || die "python not found at $PYTHON (set CAMSTACK_PYTHON)"

EDGETPU_DEB="libedgetpu1-std_${EDGETPU_VERSION}.${EDGETPU_DISTRO}_${DEB_ARCH}.deb"
EDGETPU_URL="https://github.com/feranick/libedgetpu/releases/download/${EDGETPU_TAG}/${EDGETPU_DEB}"
LIBUSB_DEB="libusb-1.0-0_${LIBUSB_VERSION}_${DEB_ARCH}.deb"
LIBUSB_URL="${UBUNTU_POOL}/libu/libusb-1.0/${LIBUSB_DEB}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT TERM

# Extract one shared object out of a .deb into $LIB_DIR under its soname.
#   $1 = deb URL, $2 = file-name glob inside the deb, $3 = soname to install as
install_lib_from_deb() {
  name="$(basename "$1")"
  log "fetching $name"
  curl -fsSL -o "$WORK/$name" "$1" || die "download failed: $1"
  mkdir -p "$WORK/x-$name"
  dpkg-deb -x "$WORK/$name" "$WORK/x-$name"
  src="$(find "$WORK/x-$name" -name "$2" \( -type f -o -type l \) | sort | head -n 1)"
  [ -n "$src" ] || die "$2 not found inside $name"
  cp -L "$src" "$LIB_DIR/$3.tmp"
  mv "$LIB_DIR/$3.tmp" "$LIB_DIR/$3"
  log "installed $LIB_DIR/$3"
}

mkdir -p "$LIB_DIR"
install_lib_from_deb "$EDGETPU_URL" "libedgetpu.so.1*" "libedgetpu.so.1"
install_lib_from_deb "$LIBUSB_URL" "libusb-1.0.so.0*" "libusb-1.0.so.0"

log "installing ai-edge-litert==$LITERT_VERSION into $PYTHON"
"$PYTHON" -m pip install --no-cache-dir "ai-edge-litert==$LITERT_VERSION"
"$PYTHON" -c "from ai_edge_litert.interpreter import load_delegate" \
  || die "ai-edge-litert import failed"

apex_nodes="$(find /dev -maxdepth 1 -name 'apex_*' 2> /dev/null | sort | tr '\n' ' ')"
if [ -n "$apex_nodes" ]; then
  log "PCIe Coral device nodes visible: $apex_nodes"
elif [ -d /sys/class/apex ] || grep -qil '0x1ac1' /sys/bus/pci/devices/*/vendor 2> /dev/null; then
  log "a PCIe Coral is present but no /dev/apex_N is visible here — pass it into the container"
fi
log "done — delegate at $LIB_DIR/libedgetpu.so.1 (CAMSTACK_EDGETPU_LIB overrides the path)"
