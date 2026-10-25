#!/usr/bin/env bash
# Watch all packages for hot-reload development.
#
# Usage:
#   npm run dev:watch       # watch all packages
#   npm run dev:full        # watch + server + admin-ui (all-in-one)
#
# For each addon package:
# - Starts tsup --watch for the server entry (index.js)
# - Starts vite build --watch for packages with addon-page MF remotes
#   (dist/remoteEntry.js) — declared via `pages[].bundle` in
#   package.json. Widget MF remotes use a separate
#   `vite.widgets.config.ts` and are watched by their own per-package
#   build script (see addon-stream-broker etc.).

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIDS=()

cleanup() {
  echo "[dev-watch] Stopping all watchers..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null
}
trap cleanup EXIT INT TERM

# Build types + kernel first (other packages depend on them)
echo "[dev-watch] Building types + kernel..."
(cd "$REPO_ROOT/packages/types" && npm run build 2>&1 | tail -2) || true
(cd "$REPO_ROOT/packages/kernel" && npm run build 2>&1 | tail -2) || true

# Start watchers for each addon package
for pkg in "$REPO_ROOT"/packages/addon-*/; do
  [ -d "$pkg" ] || continue
  name=$(basename "$pkg")

  # Skip packages without tsup config
  if [ ! -f "$pkg/tsup.config.ts" ] && ! grep -q '"build".*tsup' "$pkg/package.json" 2>/dev/null; then
    continue
  fi

  # tsup --watch for server entry
  echo "[dev-watch] Starting tsup watcher: $name"
  (cd "$pkg" && npx tsup --watch --silent 2>&1 | sed "s/^/[$name:tsup] /") &
  PIDS+=($!)

  # vite build --watch for page bundles (if package has pages declared)
  if grep -q '"pages"' "$pkg/package.json" 2>/dev/null && grep -q '"bundle"' "$pkg/package.json" 2>/dev/null; then
    # Initial page build (vite watch doesn't do an initial build)
    echo "[dev-watch] Building page bundle: $name"
    (cd "$pkg" && npx vite build 2>&1 | tail -1) || true

    echo "[dev-watch] Starting vite watcher: $name"
    (cd "$pkg" && npx vite build --watch 2>&1 | sed "s/^/[$name:vite] /") &
    PIDS+=($!)
  fi
done

# Also watch core
if [ -d "$REPO_ROOT/packages/core" ] && [ -f "$REPO_ROOT/packages/core/tsup.config.ts" ]; then
  echo "[dev-watch] Starting watcher: core"
  (cd "$REPO_ROOT/packages/core" && npx tsup --watch --silent 2>&1 | sed "s/^/[core] /") &
  PIDS+=($!)
fi

echo "[dev-watch] ${#PIDS[@]} watchers started. Ctrl+C to stop."
wait
