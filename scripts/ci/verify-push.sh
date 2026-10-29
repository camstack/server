#!/usr/bin/env bash
# Run LOCALLY exactly what CI (.github/workflows/ci.yml) would run for the
# commits about to be pushed, so a push can never turn CI red on a gate the
# local run never saw.
#
# Why: agents used to run `nx affected -t typecheck` (tsc 6), but CI grades
# `scripts/typecheck-tsgo.ts` (tsgo / TypeScript 7) against the pins in
# scripts/ci-baseline.json and fails on "pinned-or-new error(s)" tsc never
# reported. This script runs the same three gates, scoped to what changed:
#   1. "Typecheck (TypeScript 7)"           -> scripts/typecheck-tsgo.ts <affected dirs>
#   2. "Test affected packages (push/PR)"   -> scripts/ci/test-affected.sh --files
#   3. "Test repo scripts"                  -> npm run test:scripts (if scripts/ changed)
#   4. "Addon dist footprint (D28)"         -> scripts/check-addon-dist-footprint.ts
#        only when packages/addon-*/ or packages/types/src/ changed: the touched
#        addons (--addons), or every addon when types/src moved (all bundle it).
#        It reads the dists the build step above just produced.
#
# Changed set = committed diff from the merge-base with origin/main PLUS the
# working tree (staged, unstaged, untracked), minus package-lock.json (as CI).
# If packages/types or packages/system changed, every project is affected
# (CI effectively checks everything then); the typecheck runs unrestricted.
#
# Usage:
#   npm run verify:push
#   npm run verify:push -- --base <sha>
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

BASE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      BASE="${2:-}"
      shift 2
      ;;
    *)
      echo "usage: $0 [--base <sha>]" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$BASE" ]]; then
  git fetch origin main --quiet
  BASE=$(git merge-base origin/main HEAD)
fi
echo "verify:push: base $BASE"

CHANGED=$(
  {
    git diff --name-only "$BASE" -- . ':(exclude)package-lock.json'
    git ls-files --others --exclude-standard -- . ':(exclude)package-lock.json'
  } | sort -u | paste -sd, -
)

if [[ -z "$CHANGED" ]]; then
  echo "verify:push GREEN — nothing changed since $BASE"
  exit 0
fi

# Docs-only changes affect no project.
CODE_CHANGED=$(echo "$CHANGED" | tr ',' '\n' | grep -v -E '^docs/|\.md$' || true)
if [[ -z "$CODE_CHANGED" ]]; then
  echo "verify:push GREEN — only docs/** or *.md changed, nothing affected"
  exit 0
fi

# CI builds before it typechecks/tests. nx cannot even load without the local
# nx-plugin's dist, and workspace packages resolve each other through dist/.
# A fresh checkout/worktree has neither: build once (same command as CI).
if [[ ! -f packages/nx-plugin/dist/index.js ]]; then
  echo "verify:push: nx-plugin dist missing — building it so nx can load"
  npm run build -w @camstack/nx-plugin
fi

TC_RESULT="skipped"
TEST_RESULT="skipped"
SCRIPTS_RESULT="skipped"
FOOTPRINT_RESULT="skipped"
RC=0

# Affected nx projects -> package directory basenames (what typecheck-tsgo takes).
# Empty output = nothing affected; "ALL" = a framework package changed.
TC_DIRS=$(
  CHANGED="$CHANGED" node <<'NODE'
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const changed = process.env.CHANGED
const affected = JSON.parse(
  execFileSync('npx', ['nx', 'show', 'projects', '--affected', `--files=${changed}`, '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }),
)
const readJson = (f) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null }
}
const dirs = [
  ...fs.readdirSync('packages').map((d) => path.join('packages', d)),
  path.join('server', 'backend'),
]
const byName = new Map()
for (const dir of dirs) {
  const pkg = readJson(path.join(dir, 'package.json'))
  if (!pkg) continue
  const name = readJson(path.join(dir, 'project.json'))?.name ?? pkg.name
  byName.set(name, path.basename(dir))
  byName.set(pkg.name, path.basename(dir))
}
const out = []
for (const p of affected) if (byName.has(p)) out.push(byName.get(p))
const csv = affected.join(',')
if (out.includes('types') || out.includes('system')) console.log(`ALL|${csv}`)
else console.log(`${out.join(' ')}|${csv}`)
NODE
)
AFFECTED_CSV="${TC_DIRS#*|}"
TC_DIRS="${TC_DIRS%%|*}"

if [[ -z "$TC_DIRS" ]]; then
  echo "verify:push: no project affected — skipping typecheck and project tests"
else
  # CI always builds before typechecking; a STALE dist gives phantom errors.
  # build dependsOn ^build pulls dependencies; the nx cache keeps it cheap.
  echo "verify:push: build (affected) — ${TC_DIRS}"
  if [[ "$TC_DIRS" == "ALL" ]]; then
    NODE_OPTIONS="--max-old-space-size=4096" npm run build -- --parallel=3
  else
    NODE_OPTIONS="--max-old-space-size=4096" npx nx run-many -t build \
      --projects="$AFFECTED_CSV" --parallel=3
  fi

  echo "verify:push: typecheck (tsgo) — ${TC_DIRS}"
  TC_ARGS=()
  if [[ "$TC_DIRS" != "ALL" ]]; then read -r -a TC_ARGS <<<"$TC_DIRS"; fi
  if NODE_OPTIONS="--max-old-space-size=4096" npx tsx scripts/typecheck-tsgo.ts ${TC_ARGS[@]+"${TC_ARGS[@]}"}; then
    TC_RESULT="ok"
  else
    TC_RESULT="RED"
    RC=1
  fi

  echo "verify:push: tests (affected)"
  if NODE_OPTIONS="--max-old-space-size=3072" VITEST_MAX_WORKERS=2 LIGHT_PARALLEL=2 \
    scripts/ci/test-affected.sh --files "$CHANGED"; then
    TEST_RESULT="ok"
  else
    TEST_RESULT="RED"
    RC=1
  fi
fi

# D28 footprint guard (CI: "Addon dist footprint (D28)"). A red main sat unseen
# for several runs because only CI ran it. The affected build above already
# produced the dists it reads (addons depend on types and system).
if [[ -n "$TC_DIRS" ]]; then
  FOOTPRINT_ADDONS=""
  FOOTPRINT_ALL=0
  if [[ ",${CHANGED}," == *",packages/types/src/"* ]]; then
    FOOTPRINT_ALL=1
  else
    FOOTPRINT_ADDONS=$(
      echo "$CHANGED" | tr ',' '\n' | sed -n -E 's#^packages/(addon-[^/]+)/.*#\1#p' | sort -u | paste -sd, -
    )
  fi
  if [[ $FOOTPRINT_ALL -eq 1 || -n "$FOOTPRINT_ADDONS" ]]; then
    FP_ARGS=()
    if [[ $FOOTPRINT_ALL -eq 0 ]]; then FP_ARGS=(--addons "$FOOTPRINT_ADDONS"); fi
    # The guard also needs the addon-runner dist; cached by nx when already built.
    NODE_OPTIONS="--max-old-space-size=4096" npx nx run @camstack/system:build >/dev/null || true
    echo "verify:push: addon dist footprint (D28) — ${FOOTPRINT_ADDONS:-all addons}"
    if NODE_OPTIONS="--max-old-space-size=2048" npx tsx scripts/check-addon-dist-footprint.ts ${FP_ARGS[@]+"${FP_ARGS[@]}"}; then
      FOOTPRINT_RESULT="ok"
    else
      FOOTPRINT_RESULT="RED"
      RC=1
    fi
  fi
fi

# Do not `grep -q` this list under `pipefail`: on a long CHANGED set grep
# exits at the first hit and the writer dies with SIGPIPE (141), so the
# branch is skipped and the gate prints `scripts: skipped`.
if [[ ",${CHANGED}," == *",scripts/"* ]]; then
  echo "verify:push: repo scripts tests"
  if NODE_OPTIONS="--max-old-space-size=3072" npm run test:scripts; then
    SCRIPTS_RESULT="ok"
  else
    SCRIPTS_RESULT="RED"
    RC=1
  fi
fi

if [[ $RC -eq 0 ]]; then VERDICT=GREEN; else VERDICT=RED; fi
echo "verify:push $VERDICT — typecheck: $TC_RESULT, tests: $TEST_RESULT, scripts: $SCRIPTS_RESULT, footprint: $FOOTPRINT_RESULT"
exit $RC
