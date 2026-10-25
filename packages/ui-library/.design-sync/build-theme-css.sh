#!/usr/bin/env bash
# Compile the design-system preview stylesheet (Tailwind v4 utilities + @theme
# tokens + preflight) that cfg.cssEntry points at. Run before package-build.mjs.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .design-sync/.cache
node .ds-sync/node_modules/@tailwindcss/cli/dist/index.mjs \
  -i .design-sync/tailwind-input.css \
  -o .design-sync/.cache/compiled.css --minify
echo "compiled -> .design-sync/.cache/compiled.css ($(wc -c < .design-sync/.cache/compiled.css) bytes)"
