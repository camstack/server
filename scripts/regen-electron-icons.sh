#!/usr/bin/env bash
# regen-electron-icons.sh
#
# Re-rasterise the SVG sources in `packages/desktop/assets/`
# into the .png + .icns files electron-builder packages. Run this
# whenever icon.svg changes.
#
# Tools (all macOS-native or installed via Homebrew):
#   - rsvg-convert  (`brew install librsvg`)  — SVG → PNG
#   - sips          (built-in)                  — PNG resize
#   - iconutil      (built-in)                  — iconset → .icns

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

regen_one() {
  local pkg_dir="$1"
  local assets="$pkg_dir/assets"
  local svg="$assets/icon.svg"
  if [ ! -f "$svg" ]; then
    echo "skip: $svg not found"
    return
  fi
  echo "── $pkg_dir ──"

  # 1. Master 1024x1024 PNG (electron-builder picks this up for Linux).
  rsvg-convert -w 1024 -h 1024 "$svg" -o "$assets/icon.png"

  # 2. iconset for .icns (macOS) — needs the standard sizes.
  local iconset="$assets/icon.iconset"
  rm -rf "$iconset"
  mkdir -p "$iconset"
  for size in 16 32 64 128 256 512 1024; do
    rsvg-convert -w "$size" -h "$size" "$svg" -o "$iconset/icon_${size}x${size}.png"
  done
  # Retina pairs — same image at 2x dimensions, named to match
  # iconutil's expectations.
  cp "$iconset/icon_32x32.png"     "$iconset/icon_16x16@2x.png"
  cp "$iconset/icon_64x64.png"     "$iconset/icon_32x32@2x.png"
  cp "$iconset/icon_256x256.png"   "$iconset/icon_128x128@2x.png"
  cp "$iconset/icon_512x512.png"   "$iconset/icon_256x256@2x.png"
  cp "$iconset/icon_1024x1024.png" "$iconset/icon_512x512@2x.png"
  rm -f "$iconset/icon_64x64.png"  # not a real iconset slot — only used as 32@2x
  iconutil -c icns "$iconset" -o "$assets/icon.icns"
  rm -rf "$iconset"

  echo "  ✓ icon.png  (1024×1024)"
  echo "  ✓ icon.icns (multi-resolution)"
}

regen_one "$ROOT/packages/desktop"

echo
echo "Done. Note: icon.ico (Windows) is not regenerated — when we add"
echo "Windows builds back, use \`magick convert\` or an online SVG→ICO"
echo "service. Bundles ship without .ico today (Windows target disabled)."
