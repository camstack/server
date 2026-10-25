#!/usr/bin/env bash
# redeploy.sh — rebuild changed workspace packages and sync them into the
# copies the RUNNING hub actually loads, then reboot the hub once.
#
# WHY THIS EXISTS
# ---------------
# `dev:full` runs `tsup --watch` on every package → it keeps
# `packages/<pkg>/dist` fresh, but it does NOT propagate that build to the
# copies the hub loads from. Two distinct load models exist:
#
#   • @camstack/core + every addon-*  → loaded from a REAL COPY under
#       <data>/addons/@camstack/<name>/   (core builtins via the addon
#       loader; forked addon runners via their deployed dir). The watcher
#       never touches these → they go stale silently. This is the bug class
#       that made local-network's mesh endpoint never appear.
#
#   • kernel / types / sdk / ui-library → resolved via
#       node_modules symlinks back to packages/*. A rebuild is live on the
#       next hub reboot; there is no copy to sync.
#
# Either way the running process must reboot to reload in-process builtins
# and re-spawn forked addon runners — so this script touches main.ts once at
# the end (tsx-watch picks it up).
#
# This is the on-demand counterpart to `camstack deploy` (which builds →
# npm-pack → uploads a tarball the server unpacks). `camstack deploy` needs
# the server up + an admin token and is discouraged for in-process system
# packages; this script is offline, uniform, and idempotent.
#
# USAGE
# -----
#   npm run redeploy                  # rebuild+sync every CHANGED package, reboot
#   npm run redeploy core tailscale   # only matching packages (folder / pkg / deployed name)
#   npm run redeploy --all            # force every package that has a deployed copy
#   npm run redeploy --no-build       # skip rebuild, sync existing dist only (watcher already built)
#   npm run redeploy --no-reboot      # sync but do not touch main.ts
#   npm run redeploy --dry-run        # report what would change, touch nothing
#
# A package is "changed" when its src is newer than its dist (needs a
# rebuild) OR its deployed copy differs from its dist (needs a sync).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# The hub's data dir. Override with CAMSTACK_DEPLOY_ROOT for non-default layouts.
DEPLOY_ROOT="${CAMSTACK_DEPLOY_ROOT:-$REPO_ROOT/server/backend/camstack-data/addons/@camstack}"
MAIN_TS="$REPO_ROOT/server/backend/src/main.ts"

DO_BUILD=1
DO_REBOOT=1
FORCE_ALL=0
DRY_RUN=0
SELECTED=()

for arg in "$@"; do
  case "$arg" in
    --no-build)  DO_BUILD=0 ;;
    --no-reboot) DO_REBOOT=0 ;;
    --all)       FORCE_ALL=1 ;;
    --dry-run)   DRY_RUN=1 ;;
    -h|--help)   sed -n '2,40p' "$0"; exit 0 ;;
    --*)         echo "[redeploy] unknown flag: $arg" >&2; exit 2 ;;
    *)           SELECTED+=("$arg") ;;
  esac
done

# Newest file mtime (epoch) under a dir, or 0 if missing/empty. macOS `find`
# has no -printf, so we stat each file.
newest_mtime() {
  local dir="$1"
  [ -d "$dir" ] || { echo 0; return; }
  find "$dir" -type f -exec stat -f '%m' {} + 2>/dev/null | sort -nr | head -1 | grep -E '^[0-9]+$' || echo 0
}

# pkg dir → package name (from package.json "name"), or empty on failure.
pkg_name() {
  python3 -c "import json,sys; print(json.load(open('$1/package.json')).get('name',''))" 2>/dev/null
}

# Does this package declare a `build` npm script?
has_build_script() {
  python3 -c "import json,sys; print('yes' if json.load(open('$1/package.json')).get('scripts',{}).get('build') else '')" 2>/dev/null
}

# Match a user-supplied selector against a package's folder / name / deployed name.
matches_selector() {
  local folder="$1" name="$2" deployed="$3" sel
  for sel in "${SELECTED[@]}"; do
    # exact or suffix match on any identity, tolerant of the addon- prefix
    if [ "$sel" = "$folder" ] || [ "$sel" = "$name" ] || [ "$sel" = "$deployed" ] \
       || [ "addon-$sel" = "$folder" ] || [ "addon-$sel" = "$deployed" ] \
       || [ "@camstack/$sel" = "$name" ]; then
      return 0
    fi
  done
  return 1
}

declare -a REDEPLOYED=()
declare -a BUILT=()
NEED_REBOOT=0
NEED_REBOOT_REASON=""

echo "[redeploy] deploy root: $DEPLOY_ROOT"
[ "$DRY_RUN" = 1 ] && echo "[redeploy] DRY RUN — no files written, hub not rebooted"

for pkg_dir in packages/*/; do
  pkg_dir="${pkg_dir%/}"
  [ -f "$pkg_dir/package.json" ] || continue
  folder="$(basename "$pkg_dir")"
  name="$(pkg_name "$pkg_dir")"
  [ -n "$name" ] || continue
  deployed="$(basename "$name")"
  deployed_path="$DEPLOY_ROOT/$deployed"
  has_copy=0; [ -d "$deployed_path" ] && has_copy=1

  # Honor explicit selection first.
  if [ ${#SELECTED[@]} -gt 0 ]; then
    matches_selector "$folder" "$name" "$deployed" || continue
  fi

  # Decide whether this package needs work.
  src_m="$(newest_mtime "$pkg_dir/src")"
  dist_m="$(newest_mtime "$pkg_dir/dist")"
  needs_build=0
  if [ "$(has_build_script "$pkg_dir")" = "yes" ] && { [ ! -d "$pkg_dir/dist" ] || [ "$src_m" -gt "$dist_m" ]; }; then
    needs_build=1
  fi

  # Sync needed? Compare built dist against the deployed copy by CONTENT
  # (rsync -c / checksum). Deployed copies are extracted at install time so
  # their mtimes always differ — without -c rsync flags every file as changed.
  # Drop directory-only entries (trailing /) which carry mtime metadata only.
  needs_sync=0
  if [ "$has_copy" = 1 ]; then
    local_changes="$(rsync -anc --delete --out-format='%n' "$pkg_dir/dist/" "$deployed_path/dist/" 2>/dev/null | grep -v '/$')"
    [ -n "$local_changes" ] && needs_sync=1
  fi

  # Selection logic: explicit/--all force; otherwise only changed packages.
  if [ ${#SELECTED[@]} -eq 0 ] && [ "$FORCE_ALL" = 0 ]; then
    [ "$needs_build" = 1 ] || [ "$needs_sync" = 1 ] || continue
  fi

  echo "──────────────────────────────────────────────"
  echo "[redeploy] $name  (folder=$folder, deployed=$([ $has_copy = 1 ] && echo "$deployed" || echo "none — node_modules symlink"))"

  # 1) Build if stale (or forced via selection/--all when a build script exists).
  did_build=0
  if [ "$DO_BUILD" = 1 ] && [ "$(has_build_script "$pkg_dir")" = "yes" ]; then
    if [ "$needs_build" = 1 ] || [ "$FORCE_ALL" = 1 ] || [ ${#SELECTED[@]} -gt 0 ]; then
      echo "[redeploy]   building (npm run build -w $name)…"
      if [ "$DRY_RUN" = 1 ]; then
        echo "[redeploy]   (dry-run: skipped build)"
      elif npm run build -w "$name" >/tmp/redeploy-build.log 2>&1; then
        did_build=1; BUILT+=("$name")
        echo "[redeploy]   build ✓"
      else
        echo "[redeploy]   build ✗ — see /tmp/redeploy-build.log" >&2
        tail -15 /tmp/redeploy-build.log >&2
        exit 1
      fi
    fi
  fi

  # 2) Sync into the deployed copy (only packages that have one).
  did_sync=0
  if [ "$has_copy" = 1 ]; then
    # Re-evaluate after a build — dist may have changed. Content-based (-c),
    # directory-mtime entries filtered out.
    # Content-based (-c), directory-mtime entries filtered out. With checksum
    # there is no point "forcing" a sync of identical bytes — a forced BUILD
    # already drives the reboot via did_build — so we sync iff content differs.
    changes="$(rsync -anc --delete --out-format='%n' "$pkg_dir/dist/" "$deployed_path/dist/" 2>/dev/null | grep -v '/$')"
    if [ -n "$changes" ]; then
      echo "[redeploy]   syncing dist → $deployed_path/dist/"
      if [ "$DRY_RUN" = 1 ]; then
        echo "$changes" | sed 's/^/[redeploy]     would update: /' | head -20
      else
        # -c so identical files aren't re-stamped (keeps the deployed copy quiet).
        rsync -ac --delete "$pkg_dir/dist/" "$deployed_path/dist/"
        # package.json (manifest / capability changes) — install keeps it verbatim.
        if ! diff -q "$pkg_dir/package.json" "$deployed_path/package.json" >/dev/null 2>&1; then
          cp "$pkg_dir/package.json" "$deployed_path/package.json"
          echo "[redeploy]     package.json updated (manifest change)"
        fi
        # assets/ (icons etc.) when the source ships them.
        if [ -d "$pkg_dir/assets" ]; then
          rsync -ac --delete "$pkg_dir/assets/" "$deployed_path/assets/" 2>/dev/null || true
        fi
      fi
      did_sync=1
    else
      echo "[redeploy]   deployed copy already up to date"
    fi
  fi

  if [ "$did_build" = 1 ] || [ "$did_sync" = 1 ]; then
    REDEPLOYED+=("$name")
    NEED_REBOOT=1
    NEED_REBOOT_REASON="$NEED_REBOOT_REASON $name"
  fi
done

echo "══════════════════════════════════════════════"
if [ ${#REDEPLOYED[@]} -eq 0 ]; then
  echo "[redeploy] nothing to redeploy — everything already in sync"
  exit 0
fi
echo "[redeploy] redeployed: ${REDEPLOYED[*]}"

if [ "$DO_REBOOT" = 1 ] && [ "$DRY_RUN" = 0 ]; then
  touch "$MAIN_TS"
  echo "[redeploy] rebooting hub (touched main.ts) — tsx-watch will restart, ~15-20s"
else
  echo "[redeploy] reboot skipped — restart the hub manually to load:${NEED_REBOOT_REASON}"
fi
