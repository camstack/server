#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# publish.sh — Detect changed packages via nx, bump, build, and publish to npm
#
# Usage:
#   ./scripts/publish.sh              # patch bump changed packages since last publish tag
#   ./scripts/publish.sh minor        # minor bump
#   ./scripts/publish.sh major        # major bump
#   ./scripts/publish.sh patch --all  # force ALL packages (ignore nx affected)
#   ./scripts/publish.sh --all        # patch bump ALL packages
#   ./scripts/publish.sh --dry-run    # show what would be published, don't actually do it
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Map a package `name` (scoped or unscoped) to its workspace directory by
# reading each candidate `package.json`. Strips the assumption that the
# directory name matches the package name minus `@camstack/`. The
# unscoped `camstack` CLI lives at `packages/cli/` and breaks that
# heuristic; future renames will too.
#
# `server/backend` is searched too, and that omission was not cosmetic: it
# holds `@camstack/server`, the package the RELEASE depends on. Both the Docker
# image and the Electron app are assembled by `npm install
# @camstack/server@${VERSION}` from public npm, so a tag whose version was
# never published fails ~20 minutes in with `notarget No matching version
# found` — which is exactly how v1.2.32 failed on 2026-08-02. The workflow
# states the contract ("publish → tag → build"); nothing enforced it because
# this scan could not even SEE the package.
pkg_dir() {
  local name="$1"
  node -e "
    const fs = require('fs'), path = require('path');
    const target = process.argv[1];
    const roots = ['packages', 'server'];
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      for (const d of fs.readdirSync(root, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        const pj = path.join(root, d.name, 'package.json');
        if (!fs.existsSync(pj)) continue;
        try {
          const j = JSON.parse(fs.readFileSync(pj, 'utf-8'));
          if (j.name === target) { console.log(path.join(root, d.name)); process.exit(0); }
        } catch {}
      }
    }
  " "$name"
}

TAG_PREFIX="publish"
BUMP="patch"
FORCE_ALL=false
DRY_RUN=false

# ── Parse args ────────────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    patch|minor|major) BUMP="$arg" ;;
    --all)             FORCE_ALL=true ;;
    --dry-run)         DRY_RUN=true ;;
    -h|--help)
      echo "Usage: $0 [patch|minor|major] [--all] [--dry-run]"
      echo ""
      echo "  patch|minor|major  Version bump type (default: patch)"
      echo "  --all              Publish ALL packages, not just changed ones"
      echo "  --dry-run          Show what would happen without publishing"
      exit 0
      ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

# ── Find base tag ─────────────────────────────────────────────────────────────
LAST_TAG=$(git tag --list "${TAG_PREFIX}-*" --sort=-creatordate | head -1 || true)

if [ -z "$LAST_TAG" ]; then
  echo "[publish] No previous ${TAG_PREFIX}-* tag found — will publish all packages"
  FORCE_ALL=true
else
  echo "[publish] Last publish tag: $LAST_TAG"
fi

# ── Determine nx base args ───────────────────────────────────────────────────
if [ "$FORCE_ALL" = true ]; then
  echo "[publish] Mode: ALL packages"
  NX_SELECT="run-many"
  NX_BASE_ARGS=""
else
  echo "[publish] Mode: affected since $LAST_TAG"
  NX_SELECT="affected"
  NX_BASE_ARGS="--base=$LAST_TAG --head=HEAD"
fi

# ── Show affected packages ───────────────────────────────────────────────────
if [ "$FORCE_ALL" = true ]; then
  AFFECTED_JSON=$(npx nx show projects --json 2>/dev/null)
else
  AFFECTED_JSON=$(npx nx show projects --affected $NX_BASE_ARGS --json 2>/dev/null)
fi

# Parse JSON → list of publishable packages (skip private ones)
#
# `server/` is scanned alongside `packages/`. It was excluded, and that is why
# a release could tag a version of `@camstack/server` that npm had never seen —
# the image and the Electron app both `npm install @camstack/server@${VERSION}`
# from the public registry.
PUBLISHABLE=($(echo "$AFFECTED_JSON" | node -e "
  const fs = require('fs'), path = require('path');
  const data = JSON.parse(fs.readFileSync('/dev/stdin','utf-8'));
  const roots = ['packages', 'server'];
  for (const nx_name of data) {
    // Find package dir
    let pkgDir = null;
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      for (const d of fs.readdirSync(root, {withFileTypes:true})) {
        if (!d.isDirectory()) continue;
        const pjPath = path.join(root, d.name, 'package.json');
        if (!fs.existsSync(pjPath)) continue;
        const pj = JSON.parse(fs.readFileSync(pjPath,'utf-8'));
        if (pj.name === nx_name || d.name === nx_name) { pkgDir = path.join(root, d.name); break; }
      }
      if (pkgDir) break;
    }
    if (!pkgDir) continue;
    const pj = JSON.parse(fs.readFileSync(path.join(pkgDir,'package.json'),'utf-8'));
    if (pj.private) continue;
    console.log(pj.name);
  }
"))

if [ ${#PUBLISHABLE[@]} -eq 0 ]; then
  echo "[publish] No publishable packages — nothing to do"
  exit 0
fi

echo "[publish] Will $BUMP bump ${#PUBLISHABLE[@]} packages:"
for p in "${PUBLISHABLE[@]}"; do echo "  - $p"; done

if [ "$DRY_RUN" = true ]; then
  echo ""
  echo "[publish] DRY RUN — stopping here"
  exit 0
fi

# ── Bump versions ─────────────────────────────────────────────────────────────
echo ""
echo "[publish] Bumping versions..."

for p in "${PUBLISHABLE[@]}"; do
  dir="$(pkg_dir "$p")"
  if [ -z "$dir" ]; then
    echo "  $p — could not locate workspace dir, skipping"
    continue
  fi
  (cd "$dir" && npm version "$BUMP" --no-git-tag-version > /dev/null 2>&1)
  new_ver=$(node -e "console.log(require('./$dir/package.json').version)")
  echo "  $p → $new_ver"
done

# ── Build + Publish via nx ────────────────────────────────────────────────────
# Build first (with retry for flaky tasks), then publish
echo ""
echo "[publish] Building all packages..."

export NODE_OPTIONS="--max-old-space-size=8192"

# Full build output goes to a logfile. Previously the build was piped
# through `| tail -3`, which discarded the actual error — a genuine
# deterministic break was indistinguishable from a flaky one. Capture
# everything; surface a generous tail only on failure.
BUILD_LOG="$(mktemp -t camstack-publish-build.XXXXXX.log)"
echo "[publish] Build log: $BUILD_LOG"

BUILD_ATTEMPTS=3
for attempt in $(seq 1 $BUILD_ATTEMPTS); do
  echo "[publish] Build attempt $attempt/$BUILD_ATTEMPTS..."
  if npx nx run-many -t build --exclude=@camstack/server > "$BUILD_LOG" 2>&1; then
    echo "[publish] Build succeeded"
    break
  fi
  if [ "$attempt" -eq "$BUILD_ATTEMPTS" ]; then
    echo "[publish] Build failed after $BUILD_ATTEMPTS attempts. Last 40 lines:"
    tail -40 "$BUILD_LOG"
    echo "[publish] Full build log: $BUILD_LOG"
    exit 1
  fi
  echo "[publish] Build attempt failed — last 20 lines:"
  tail -20 "$BUILD_LOG"
  echo "[publish] Retrying build..."
  npx nx reset 2>/dev/null || true
done

echo ""
echo "[publish] Publishing..."

PUBLISHED=()
SKIPPED=()
FAILED=()

for p in "${PUBLISHABLE[@]}"; do
  dir="$(pkg_dir "$p")"
  if [ -z "$dir" ]; then
    FAILED+=("$p (workspace dir not found)")
    continue
  fi
  ver=$(node -e "console.log(require('./$dir/package.json').version)")

  # Skip if version already exists on npm
  npm_ver=$(npm view "$p@$ver" version 2>/dev/null || echo "")
  if [ "$npm_ver" = "$ver" ]; then
    SKIPPED+=("$p@$ver")
    continue
  fi

  # Throttle: a 2s gap before each PUT (skipped on the first publish) lets the
  # registry CDN propagate the previous publish, cutting the flaky-403
  # "cannot publish over previously published" misreport rate. Mirrors the
  # GitHub publish workflow so local and CI dispatch identically.
  if [ ${#PUBLISHED[@]} -gt 0 ] || [ ${#FAILED[@]} -gt 0 ]; then
    sleep 2
  fi

  echo -n "  $p@$ver... "
  # `npm publish` exits 0 on success. On failure we must disambiguate
  # three cases:
  #   (a) the version is ALREADY on the registry — npm replies 403
  #       "cannot publish over the previously published versions".
  #       That's an idempotent re-run, NOT a failure.
  #   (b) a genuine failure (auth, network, bad package).
  #   (c) a transient hiccup — and the post-publish `npm view` probe is
  #       itself unreliable during a many-package burst (the registry
  #       rate-limits metadata reads, and a freshly-published version
  #       lags a few seconds before it's queryable). A single probe
  #       flips genuine successes to ✗.
  # So: read the publish output to catch (a) directly, and retry the
  # registry probe before declaring a real failure.
  if publish_out=$(cd "$dir" && npm publish --access public 2>&1); then
    PUBLISHED+=("$p@$ver")
    echo "✓"
  elif echo "$publish_out" | grep -qiE "cannot publish over|previously published|EPUBLISHCONFLICT"; then
    SKIPPED+=("$p@$ver (already on registry)")
    echo "✓ (already on registry)"
  else
    # Poll up to ~180s. Brand-new package names propagate to the registry's
    # read-replicas far slower than a new version of an existing package, so a
    # short poll can flag a freshly-published NEW package as failed even though
    # it landed. Early break keeps the common case fast. Matches the CI poll.
    npm_ver=""
    for _probe in $(seq 1 18); do
      npm_ver=$(npm view "$p@$ver" version 2>/dev/null || echo "")
      [ "$npm_ver" = "$ver" ] && break
      sleep 10
    done
    if [ "$npm_ver" = "$ver" ]; then
      SKIPPED+=("$p@$ver (already on registry)")
      echo "✓ (already on registry)"
    else
      FAILED+=("$p@$ver — ${publish_out##*npm error }")
      echo "✗"
    fi
  fi
done

# ── Summary ───────────────────────────────────────────────────────────────────
# Reflects the REAL published / skipped / failed arrays — the previous
# version just re-listed every PUBLISHABLE package with a ✓, so a
# partial failure looked like a clean release.
echo ""
echo "══════════════════════════════════════════════════════════════"
echo " Release result — published: ${#PUBLISHED[@]}   already-on-npm: ${#SKIPPED[@]}   failed: ${#FAILED[@]}"
echo "══════════════════════════════════════════════════════════════"
if [ ${#PUBLISHED[@]} -gt 0 ]; then
  for p in "${PUBLISHED[@]}"; do echo "  ✓ $p"; done
fi
if [ ${#SKIPPED[@]} -gt 0 ]; then
  for p in "${SKIPPED[@]}"; do echo "  • $p"; done
fi
if [ ${#FAILED[@]} -gt 0 ]; then
  for p in "${FAILED[@]}"; do echo "  ✗ $p"; done
  echo ""
  echo "[publish] ${#FAILED[@]} package(s) FAILED — NOT creating a publish tag."
  echo "[publish] Fix the cause and re-run; packages already on the registry are skipped idempotently."
  exit 1
fi

# ── Commit version bumps + tag ────────────────────────────────────────────────
# Created ONLY on a fully-clean run. A tag after a partial publish would
# make the next `nx affected --base=<tag>` skip the packages that never
# published — they'd silently never get released.
#
# The version bumps MUST be committed BEFORE the tag is placed. The bump
# loop above edited every published package's `package.json` (+ the
# lockfile) but left them uncommitted. If the tag is placed on the
# pre-bump commit, the next run's `nx affected --base=<tag>` sees every
# one of those `package.json` files as "changed" and re-publishes the
# ENTIRE workspace. Committing first means the tag points at a tree
# where each version already matches the registry.
NEW_TAG="${TAG_PREFIX}-$(date +%Y%m%d-%H%M%S)"
echo ""
echo "[publish] All packages on the registry."
if ! git diff --quiet -- 'packages/*/package.json' 'server/*/package.json' package-lock.json; then
  echo "[publish] Committing version bumps..."
  git add -- 'packages/*/package.json' 'server/*/package.json' package-lock.json
  git commit -m "chore(release): publish ${#PUBLISHED[@]} package(s)"
fi
echo "[publish] Creating tag: $NEW_TAG"
git tag "$NEW_TAG"
# Push the tag — the bump commit's objects ride along, so the next
# `nx affected --base=<tag>` resolves even before the branch is pushed.
git push origin "$NEW_TAG"
echo "[publish] Done. Push the branch to publish the release commit."
