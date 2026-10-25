#!/usr/bin/env bash
# Convert assets/icon.svg into platform-specific app icons used by
# electron-builder + the tray.
#
# Outputs:
#   assets/icon.icns           (macOS app icon — bundled DMG/ZIP)
#   assets/icon.ico            (Windows app icon — NSIS installer)
#   assets/icon.png            (Linux app icon — AppImage/deb)
#   assets/tray-icon-template.png       (macOS menu-bar — light/dark adaptive)
#   assets/tray-icon-template@2x.png    (Retina version of above)
#
# Requirements:
#   - rsvg-convert (or `brew install librsvg`)
#   - iconutil (built into macOS) — required for .icns
#   - node — packs the .ico (scripts/png-to-ico.mjs)
#
# Usage:
#   bash packages/desktop/scripts/build-icons.sh
set -euo pipefail

cd "$(dirname "$0")/.."

ASSETS=assets
SVG="$ASSETS/icon.svg"
TRAY_SVG="$ASSETS/tray-icon-template.svg"

if [[ ! -f "$SVG" ]]; then
  echo "Master icon $SVG missing. Aborting." >&2
  exit 1
fi

command -v rsvg-convert >/dev/null 2>&1 || { echo "rsvg-convert required (brew install librsvg)"; exit 2; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---- PNG (linux) ----------------------------------------------------------
rsvg-convert -w 512 -h 512 "$SVG" -o "$ASSETS/icon.png"

# ---- ICNS (macOS) ---------------------------------------------------------
ICONSET="$TMP/icon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 64 128 256 512 1024; do
  rsvg-convert -w $size  -h $size  "$SVG" -o "$ICONSET/icon_${size}x${size}.png"
  if [[ $size -le 512 ]]; then
    rsvg-convert -w $((size*2)) -h $((size*2)) "$SVG" -o "$ICONSET/icon_${size}x${size}@2x.png"
  fi
done
if command -v iconutil >/dev/null 2>&1; then
  iconutil -c icns "$ICONSET" -o "$ASSETS/icon.icns"
else
  echo "iconutil missing (macOS-only) — skipping .icns" >&2
fi

# ---- ICO (Windows) --------------------------------------------------------
# Packed by png-to-ico.mjs (PNG-compressed entries, Vista+): no ImageMagick, so
# the icon the Windows build points at is always generated, on any host.
ICO_PNGS=()
for size in 16 32 48 64 128 256; do
  rsvg-convert -w $size -h $size "$SVG" -o "$TMP/icon-$size.png"
  ICO_PNGS+=("$TMP/icon-$size.png")
done
node scripts/png-to-ico.mjs "$ASSETS/icon.ico" "${ICO_PNGS[@]}"

# ---- Tray icons (macOS template) -----------------------------------------
if [[ -f "$TRAY_SVG" ]]; then
  rsvg-convert -w 22 -h 22 "$TRAY_SVG" -o "$ASSETS/tray-icon-template.png"
  rsvg-convert -w 44 -h 44 "$TRAY_SVG" -o "$ASSETS/tray-icon-template@2x.png"
fi

echo "Icons generated:"
ls -lh "$ASSETS"
