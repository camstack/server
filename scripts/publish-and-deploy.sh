#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# publish-and-deploy.sh — `publish.sh` + push the deployable subset to the
# local hub via the `camstack` CLI.
#
# Rationale: after a sprint that touches both libraries (types/core/sdk)
# and addons (admin-ui, providers, …), publishing is half the picture.
# The hub running locally won't see addon changes until they're either
# (a) re-installed from npm via the Addons page, or (b) tarball-pushed
# via the CLI. This script does (b) for every addon that was bumped, so
# the local hub picks up the new builds without a manual click.
#
# What gets published vs deployed:
#   • Published to npm: every affected, non-private workspace package.
#   • Deployed to the local hub: the subset that declares a
#     `camstack.addons` manifest (i.e. is a runtime addon, not a
#     library). `@camstack/core` is excluded — its addons are
#     hub-side builtins that require a server restart, not a deploy.
#
# Usage:
#   ./scripts/publish-and-deploy.sh                         # patch bump
#   ./scripts/publish-and-deploy.sh minor                   # minor bump
#   ./scripts/publish-and-deploy.sh --all                   # all packages
#   ./scripts/publish-and-deploy.sh --dry-run               # plan only
#   ./scripts/publish-and-deploy.sh --skip-publish          # only deploy
#   ./scripts/publish-and-deploy.sh --server <url>          # override deploy target
#   ./scripts/publish-and-deploy.sh --node <id> | --cluster # forward to camstack deploy
#
# Deploy target resolution mirrors `camstack deploy` defaults: cached
# session file (`camstack login` first), falling back to env vars
# `CAMSTACK_SERVER` / `CAMSTACK_TOKEN`.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PUBLISH_ARGS=()
SKIP_PUBLISH=false
DRY_RUN=false
DEPLOY_SERVER=""
DEPLOY_NODE=""
DEPLOY_CLUSTER=false

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-publish)  SKIP_PUBLISH=true ;;
    --server)        DEPLOY_SERVER="$2"; shift ;;
    --node)          DEPLOY_NODE="$2";   shift ;;
    --cluster)       DEPLOY_CLUSTER=true ;;
    --dry-run)       DRY_RUN=true; PUBLISH_ARGS+=("--dry-run") ;;
    -h|--help)
      sed -n '2,32p' "$0"
      exit 0
      ;;
    *) PUBLISH_ARGS+=("$1") ;;
  esac
  shift
done

# Snapshot the last publish tag BEFORE running publish.sh — that script
# creates a new tag at HEAD on success, which would clobber our affected
# baseline if we read it after the fact.
LAST_PUBLISH_TAG=$(git tag --list "publish-*" --sort=-creatordate | head -1 || true)

# ── Publish ───────────────────────────────────────────────────────────────────
if [ "$SKIP_PUBLISH" = false ]; then
  echo "[publish-and-deploy] Running publish.sh ${PUBLISH_ARGS[*]:-}"
  ./scripts/publish.sh "${PUBLISH_ARGS[@]:-}"
else
  echo "[publish-and-deploy] --skip-publish: skipping npm publish step"
fi

if [ "$DRY_RUN" = true ]; then
  echo "[publish-and-deploy] DRY RUN — stopping before local deploy"
  exit 0
fi

# ── Detect deployable packages ───────────────────────────────────────────────
# Re-run the same affected detection publish.sh uses, but filter to packages
# that ARE camstack addons (declare a `camstack.addons` manifest) and are
# NOT `@camstack/core` (whose "addons" are hub builtins, deployed via
# server restart not CLI push).
if [ -z "$LAST_PUBLISH_TAG" ]; then
  echo "[publish-and-deploy] No previous publish-* tag — defaulting to ALL deployable packages"
  AFFECTED_JSON=$(npx nx show projects --json 2>/dev/null)
else
  echo "[publish-and-deploy] Computing deployable packages affected since $LAST_PUBLISH_TAG"
  AFFECTED_JSON=$(npx nx show projects --affected --base="$LAST_PUBLISH_TAG" --head=HEAD --json 2>/dev/null)
fi

# Filter via node — pulls every affected workspace's package.json and
# keeps it iff it has a camstack.addons manifest and isn't @camstack/core.
DEPLOYABLE_DIRS=$(echo "$AFFECTED_JSON" | node -e "
  const fs = require('fs'), path = require('path');
  const data = JSON.parse(fs.readFileSync('/dev/stdin','utf-8'));
  const out = [];
  for (const nx_name of data) {
    let pkgDir = null;
    for (const d of fs.readdirSync('packages', {withFileTypes:true})) {
      if (!d.isDirectory()) continue;
      const pjPath = path.join('packages', d.name, 'package.json');
      if (!fs.existsSync(pjPath)) continue;
      const pj = JSON.parse(fs.readFileSync(pjPath,'utf-8'));
      if (pj.name === nx_name || d.name === nx_name) { pkgDir = path.join('packages', d.name); break; }
    }
    if (!pkgDir) continue;
    const pj = JSON.parse(fs.readFileSync(path.join(pkgDir,'package.json'),'utf-8'));
    if (pj.name === '@camstack/core') continue;
    if (!pj.camstack || !Array.isArray(pj.camstack.addons) || pj.camstack.addons.length === 0) continue;
    out.push(pkgDir + '\t' + pj.name);
  }
  out.forEach(l => console.log(l));
")

if [ -z "$DEPLOYABLE_DIRS" ]; then
  echo "[publish-and-deploy] No deployable addons changed — nothing to push to local hub"
  exit 0
fi

# ── Resolve `camstack` CLI binary ────────────────────────────────────────────
# Prefer a local workspace dev build (faster, picks up unpublished CLI
# changes) over the globally-installed one. Fall back to global via npx
# if the local build doesn't exist yet.
LOCAL_CLI="$REPO_ROOT/packages/cli/dist/cli.js"
if [ -f "$LOCAL_CLI" ]; then
  CAMSTACK_CMD=(node "$LOCAL_CLI")
elif command -v camstack >/dev/null 2>&1; then
  CAMSTACK_CMD=(camstack)
else
  CAMSTACK_CMD=(npx --yes -p @camstack/cli camstack)
fi

# Build the per-call target args once — they're identical across every
# package we deploy.
TARGET_ARGS=()
[ -n "$DEPLOY_SERVER" ] && TARGET_ARGS+=(--server "$DEPLOY_SERVER")
if [ "$DEPLOY_CLUSTER" = true ]; then
  TARGET_ARGS+=(--cluster)
elif [ -n "$DEPLOY_NODE" ]; then
  TARGET_ARGS+=(--node "$DEPLOY_NODE")
fi

# ── Deploy ────────────────────────────────────────────────────────────────────
echo ""
echo "[publish-and-deploy] Deploying $(echo "$DEPLOYABLE_DIRS" | wc -l | tr -d ' ') addons to the local hub..."

PUSHED=()
FAILED=()

while IFS=$'\t' read -r dir pkg; do
  [ -z "$dir" ] && continue
  echo ""
  echo "──────────────────────────────────────────────────────────────"
  echo " camstack deploy $dir ($pkg)"
  echo "──────────────────────────────────────────────────────────────"
  # `--build skip` because publish.sh already ran the build step; running
  # `npm run build` a second time wastes ~20-60s per package and risks
  # the wrong tarball going out (think of a flaky DTS emit).
  if "${CAMSTACK_CMD[@]}" deploy "$dir" --build skip "${TARGET_ARGS[@]}"; then
    PUSHED+=("$pkg")
  else
    FAILED+=("$pkg")
  fi
done <<< "$DEPLOYABLE_DIRS"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════════════"
echo " Deploy summary"
echo "══════════════════════════════════════════════════════════════"
for p in "${PUSHED[@]}"; do echo "  ✓ $p"; done
for p in "${FAILED[@]}"; do echo "  ✗ $p"; done

if [ ${#FAILED[@]} -gt 0 ]; then
  exit 1
fi
