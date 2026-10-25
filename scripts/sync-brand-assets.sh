#!/usr/bin/env bash
# sync-brand-assets.sh
#
# Single-source-of-truth sync for the CamStack brand mark. The
# canonical SVG lives at:
#
#   packages/addon-admin-ui/public/favicon.svg
#
# Every other location is a *copy* (different filesystem boundaries:
# Electron .app bundle, Electron-agent .app bundle, Next.js docs).
# This script propagates the source to all of them, then re-rasters
# the .png/.icns variants the Electron installers ship.
#
# Run after editing favicon.svg, or as a pre-build step.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$ROOT/packages/addon-admin-ui/public/favicon.svg"

if [ ! -f "$SOURCE" ]; then
  echo "::error:: source SVG missing: $SOURCE" >&2
  exit 1
fi

DESTS=(
  "$ROOT/packages/desktop/assets/icon.svg"
)

# The docs repo (camstack/docs) lives outside this tree at a sibling
# clone. Sync only when the path exists locally — CI / fresh clones
# without the sibling repo silently skip.
DOCS_DEST="$ROOT/../docs/app/icon.svg"
if [ -d "$(dirname "$DOCS_DEST")" ]; then
  DESTS+=("$DOCS_DEST")
fi

for dest in "${DESTS[@]}"; do
  cp "$SOURCE" "$dest"
  echo "  ✓ $(realpath --relative-to="$ROOT" "$dest" 2>/dev/null || echo "$dest")"
done

# Re-rasterise the Electron .png/.icns. The docs site only needs the
# .svg (Next.js handles the rest).
"$ROOT/scripts/regen-electron-icons.sh"
