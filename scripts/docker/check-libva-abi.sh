#!/bin/sh
# Refuse a VA driver that needs a newer VA-API than the libva installed beside it.
#
#   check-libva-abi.sh <path/to/*_drv_video.so>
#
# Run by the image build (Dockerfile `intel` and `amd` stages) and by hand in a
# running container. Measured 2026-10-23 (intel-1.2.509): Intel's iHD 25.2.4
# exports only `__vaDriverInit_1_22`, Ubuntu's libva 2.20 looks for `_1_20`,
# so `vaInitialize` failed on every node and every decode ran in software —
# while the image built green. libva 2.N speaks VA-API 1.N.
#
# With a render node present (a running container with /dev/dri passed) it
# also runs `vainfo` against it; at build time there is no /dev/dri and that
# half is skipped. CAMSTACK_LIBVA_ABI_SKIP_DEVICE=1 skips it explicitly.
set -eu

driver="${1:-}"
if [ -z "$driver" ] || [ ! -f "$driver" ]; then
  echo "[libva-abi] FATAL: VA driver '$driver' not found" >&2
  exit 1
fi

needs=$(grep -aoE '__vaDriverInit_1_[0-9]+' "$driver" | sed 's/.*_1_//' | sort -n | tail -n 1 || true)
if [ -z "$needs" ]; then
  echo "[libva-abi] FATAL: $driver exports no __vaDriverInit_1_* symbol" >&2
  exit 1
fi

libva_version=$(dpkg-query -W -f='${Version}' libva2 2>/dev/null || true)
have=$(printf '%s' "$libva_version" | sed -n 's/^\([0-9]*\)\.\([0-9]*\).*/\2/p')
if [ -z "$have" ]; then
  echo "[libva-abi] FATAL: cannot read the libva2 version (dpkg-query said '$libva_version')" >&2
  exit 1
fi

if [ "$have" -lt "$needs" ]; then
  echo "[libva-abi] FATAL: $(basename "$driver") needs VA-API >= 1.$needs, libva2 $libva_version provides 1.$have — vaInitialize would fail and every decode would run in software. Install libva from the same repository as the driver." >&2
  exit 1
fi
echo "[libva-abi] ok: $(basename "$driver") needs VA-API 1.$needs, libva2 $libva_version provides VA-API 1.$have"

render_node="${CAMSTACK_LIBVA_RENDER_NODE:-/dev/dri/renderD128}"
if [ "${CAMSTACK_LIBVA_ABI_SKIP_DEVICE:-0}" = "1" ] || [ ! -e "$render_node" ]; then
  echo "[libva-abi] no render node at $render_node — vaInitialize not exercised"
  exit 0
fi
if ! command -v vainfo >/dev/null 2>&1; then
  echo "[libva-abi] vainfo not installed — vaInitialize not exercised"
  exit 0
fi
if ! vainfo --display drm --device "$render_node" >/dev/null 2>&1; then
  echo "[libva-abi] FATAL: vainfo cannot initialise $render_node:" >&2
  vainfo --display drm --device "$render_node" 2>&1 | tail -n 5 >&2 || true
  exit 1
fi
echo "[libva-abi] ok: vaInitialize succeeded on $render_node"
