#!/usr/bin/env bash
# Build all addon packages and copy to data/addons/ for production
#
# Each addon directory gets:
#   package.json  (copied from workspace package)
#   dist/         (copied from built workspace package)

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ADDONS_DIR="$REPO_ROOT/server/backend/data/addons"
rm -rf "$ADDONS_DIR"
mkdir -p "$ADDONS_DIR"

built=0

# Addons excluded from the default install. They stay in the workspace
# (so contributors can still build / test them) but don't get shipped
# to `camstack-data/addons/` by `build-addons.sh`. Operators who want
# them back flip the skip-list and re-run.
SKIP_ADDONS=()

skip() {
  local name="$1"
  for s in "${SKIP_ADDONS[@]}"; do
    [ "$s" = "$name" ] && return 0
  done
  return 1
}

for pkg in "$REPO_ROOT"/packages/addon-*/; do
  [ -d "$pkg" ] || continue

  base=$(basename "$pkg")
  if skip "$base"; then
    echo "Skipping $base (not in default install set)"
    continue
  fi

  name=$(node -e "console.log(require('$pkg/package.json').name)")
  dirname=$(echo "$name" | sed 's/@camstack\///')

  echo "Building $name..."
  (cd "$pkg" && npx tsup 2>&1 | tail -1) || {
    echo "  WARN: tsup failed for $name — skipping"
    continue
  }

  if [ ! -d "$pkg/dist" ]; then
    echo "  WARN: $name has no dist/ after build — skipping"
    continue
  fi

  # Copy package.json + dist/
  target="$ADDONS_DIR/$dirname"
  mkdir -p "$target"
  cp "$pkg/package.json" "$target/package.json"
  cp -r "$pkg/dist" "$target/dist"

  echo "  -> $target"
  built=$((built + 1))
done

echo "Done: $built addons built"
