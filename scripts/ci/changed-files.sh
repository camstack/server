#!/usr/bin/env bash
# The change set a push / pull request is graded on, written to a file.
#
# Usage: scripts/ci/changed-files.sh <out-file>
# Env:   GITHUB_TOKEN, GITHUB_API_URL, GITHUB_REPOSITORY, EVENT_BEFORE (CI)
#
# The base is the last commit main was VERIFIED at, not the previous push.
# `github.event.before` is the previous push's head, and under cancel-in-progress
# most previous runs never finish (20 of the last 30 were cancelled, 2026-09-20):
# their commits' packages were diffed past by the next push and tested by nobody
# until the nightly — which had not been green either. Ask the Actions API for
# the newest successful run on main (any event: a green nightly counts) and diff
# from there; the previous push is the fallback only while no green run exists
# yet, and HEAD~1 only when even that is unknown.
#
# package-lock.json is excluded: nx treats ANY lockfile change as globally
# affecting and cannot be tuned off via namedInputs, which would turn "test
# affected" back into "test everything" on a routine bump. An explicit file list
# keeps the same affected algorithm with a precise input.
#
# One line per path. An empty file means nothing to test. Runs BEFORE install
# (git + curl + node only), so every later step can read the same file.
set -euo pipefail

OUT="${1:?usage: changed-files.sh <out-file>}"

LAST_GREEN=""
if [ -n "${GITHUB_TOKEN:-}" ] && [ -n "${GITHUB_API_URL:-}" ]; then
  LAST_GREEN=$(curl -sf -H "Authorization: Bearer $GITHUB_TOKEN" \
    "$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/actions/workflows/ci.yml/runs?branch=main&status=success&per_page=1" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).workflow_runs?.[0];process.stdout.write(r?r.head_sha:"")})' \
    2>/dev/null || true)
fi
BASE="$LAST_GREEN"
if [ -z "$BASE" ] || ! git cat-file -e "$BASE" 2>/dev/null || ! git merge-base --is-ancestor "$BASE" HEAD; then
  echo "no verified ancestor of HEAD on main yet — diffing from the previous push"
  BASE="${EVENT_BEFORE:-}"
fi
if [ -z "$BASE" ] || [ "$BASE" = "0000000000000000000000000000000000000000" ] \
   || ! git cat-file -e "$BASE" 2>/dev/null; then
  BASE=$(git rev-parse HEAD~1)
fi
echo "affected base: $BASE (last green: ${LAST_GREEN:-none})"
git diff --name-only "$BASE" HEAD -- . ':(exclude)package-lock.json' > "$OUT"
echo "changed files (excl. lockfile): $(grep -c . "$OUT" || true)"
