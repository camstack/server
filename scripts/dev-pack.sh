#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# dev-pack.sh — build + `npm pack` changed @camstack packages into `dev-overlay/`
# for a TEMPORARY dev image (`Dockerfile.dev`) — NO public npm publish.
#
# This is the fast counterpart to `scripts/publish.sh`: instead of releasing 40+
# packages to public npm just to test a server-side change on the hub, you build
# ONLY the packages you touched and overlay their dist onto a published base
# image. Seconds per rebuild vs a full release.
#
# Usage:
#   ./scripts/dev-pack.sh @camstack/server @camstack/types   # by package name
#   ./scripts/dev-pack.sh server/backend packages/types      # or by workspace dir
#   ./scripts/dev-pack.sh --affected                         # nx-affected publishable pkgs since last publish tag
#   ./scripts/dev-pack.sh --all                              # COMPLETE image: every publishable workspace package
#   ./scripts/dev-pack.sh --no-build @camstack/server        # skip nx build (dist already fresh)
#
# `--all` produces a COMPLETE dev image (overlay every @camstack package + server
# + addons onto the base) — use it when you want a full, self-consistent build
# preserving volumes, not just the couple of packages you touched. `Dockerfile.dev`
# overlays whatever tarballs are present, so `--all` + Dockerfile.dev = full image.
#
# Then (on Unraid — see .claude/skills/camstack-hub-image-deploy):
#   git archive --format=tar <branch> | ssh unraid '...'          # ship tree (has Dockerfile.dev)
#   scp -r dev-overlay unraid:/tmp/B/                              # ship the packed tarballs
#   ssh unraid 'cd /tmp/B && docker build -f Dockerfile.dev \
#     --build-arg BASE=<current published image> -t camstack-server:dev-<tag> .'
#   # then swap-deploy with IMG=camstack-server:dev-<tag> (no docker pull)
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

OUT="$REPO_ROOT/dev-overlay"
BUILD=1
AFFECTED=0
ALL=0
ARGS=()

for a in "$@"; do
  case "$a" in
    --no-build) BUILD=0 ;;
    --affected) AFFECTED=1 ;;
    --all) ALL=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) ARGS+=("$a") ;;
  esac
done

# ── Resolve a package identifier (scoped name OR workspace dir) → its dir. ──────
# Scans every package.json under packages/*, server/*, agent/* for a name match;
# falls back to treating the arg as a literal directory.
resolve_dir() {
  local id="$1"
  if [ -f "$id/package.json" ]; then echo "$id"; return; fi
  node -e '
    const fs=require("fs"),path=require("path");
    const target=process.argv[1];
    const roots=["packages","server","agent"];
    for (const r of roots) {
      if (!fs.existsSync(r)) continue;
      for (const d of fs.readdirSync(r,{withFileTypes:true})) {
        if (!d.isDirectory()) continue;
        const pj=path.join(r,d.name,"package.json");
        if (!fs.existsSync(pj)) continue;
        const name=JSON.parse(fs.readFileSync(pj,"utf8")).name;
        if (name===target) { process.stdout.write(path.join(r,d.name)); process.exit(0); }
      }
    }
    process.exit(1);
  ' "$id"
}

if [ "$ALL" = 1 ]; then
  echo "[dev-pack] COMPLETE mode — every publishable workspace package"
  ARGS=( $(node -e '
    const fs=require("fs"),path=require("path");
    const out=[];
    for (const r of ["packages","server","agent"]) {
      if (!fs.existsSync(r)) continue;
      for (const d of fs.readdirSync(r,{withFileTypes:true})) {
        if (!d.isDirectory()) continue;
        const pj=path.join(r,d.name,"package.json");
        if (!fs.existsSync(pj)) continue;
        const j=JSON.parse(fs.readFileSync(pj,"utf8"));
        if (j.private===true || !j.name) continue;
        out.push(j.name);
      }
    }
    process.stdout.write(out.join(" "));
  ') )
elif [ "$AFFECTED" = 1 ]; then
  LAST_TAG=$(git tag --list "publish-*" --sort=-creatordate | head -1 || true)
  BASE_ARG=${LAST_TAG:+--base=$LAST_TAG}
  echo "[dev-pack] nx-affected since ${LAST_TAG:-<all>}"
  ARGS=( $(npx nx show projects --affected ${BASE_ARG:-} --json 2>/dev/null \
    | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).join(" ")') )
fi

if [ ${#ARGS[@]} -eq 0 ]; then
  echo "usage: dev-pack.sh <pkg-name|dir> ...   (or --affected)" >&2
  exit 1
fi

# ── Resolve dirs + collect publishable (non-private) packages. ─────────────────
DIRS=()
NAMES=()
for id in "${ARGS[@]}"; do
  dir="$(resolve_dir "$id" || true)"
  if [ -z "$dir" ]; then echo "[dev-pack] skip: cannot resolve '$id'"; continue; fi
  priv=$(node -pe "JSON.parse(require('fs').readFileSync('$dir/package.json','utf8')).private===true" 2>/dev/null || echo false)
  if [ "$priv" = true ]; then echo "[dev-pack] skip private: $dir"; continue; fi
  name=$(node -pe "JSON.parse(require('fs').readFileSync('$dir/package.json','utf8')).name")
  DIRS+=("$dir"); NAMES+=("$name")
done

[ ${#DIRS[@]} -gt 0 ] || { echo "[dev-pack] nothing to pack" >&2; exit 1; }

echo "[dev-pack] packing: ${NAMES[*]}"

# ── Build (nx) then pack each into dev-overlay/. ───────────────────────────────
if [ "$BUILD" = 1 ]; then
  echo "[dev-pack] building ${#NAMES[@]} package(s) via nx…"
  npx nx run-many -t build --projects "$(IFS=,; echo "${NAMES[*]}")"
fi

rm -rf "$OUT"; mkdir -p "$OUT"
for dir in "${DIRS[@]}"; do
  [ -d "$dir/dist" ] || { echo "[dev-pack] ERROR: $dir has no dist/ (build first)"; exit 1; }
  ( cd "$dir" && npm pack --pack-destination "$OUT" >/dev/null )
done

echo "[dev-pack] wrote:"
ls -1 "$OUT"
echo "[dev-pack] done. Ship dev-overlay/ + build Dockerfile.dev (see camstack-hub-image-deploy skill §5)."
