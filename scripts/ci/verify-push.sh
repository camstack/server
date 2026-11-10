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
#   5. "Runner and addon barrel guards (D28)" -> scripts/ci/run-barrel-guards.sh
#        the same script CI calls; source scan on any affected change, plus the
#        built-dist half when packages/types or packages/system changed.
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

# The publish's own changelog gate, graded against the newest publish tag. A
# branch cut before a publish and merged after it lands its [Unreleased] lines
# under the heading that publish released — git's merge places them there
# without a conflict — and the publish then fails at its first gate.
if [[ ",${CHANGED}," == *"CHANGELOG.md,"* || ",${CHANGED}," == *",packages/"* || ",${CHANGED}," == *",server/"* ]]; then
  echo "verify:push: changelog entries (against the last publish tag)"
  if ! npx tsx scripts/check-changelog-unreleased.ts; then
    echo "verify:push RED — changelog: fix the entries above before pushing"
    exit 1
  fi
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

# Test load knobs (env overrides). NX_DAEMON passes through untouched to every
# nx call below; it is printed so a run can be measured with it on and off.
VERIFY_VITEST_MAX_WORKERS="${VERIFY_VITEST_MAX_WORKERS:-4}"
VERIFY_LIGHT_PARALLEL="${VERIFY_LIGHT_PARALLEL:-3}"
if [[ -n "${NX_DAEMON:-}" ]]; then export NX_DAEMON; fi
echo "verify:push: NX_DAEMON=${NX_DAEMON:-<nx default>}"

TC_RESULT="skipped"
TEST_RESULT="skipped"
SCRIPTS_RESULT="skipped"
FOOTPRINT_RESULT="skipped"
GUARDS_RESULT="skipped"
RC=0

# Affected nx projects -> package directory basenames (what typecheck-tsgo takes)
# and the footprint / scripts flags. The SAME script CI's `static` job runs
# (scripts/ci/affected-scope.mjs), so the two cannot grade different sets.
# TC_DIRS: empty = nothing affected, "ALL" = a framework package changed.
SCOPE_FILE=$(mktemp)
trap 'rm -f "$SCOPE_FILE"' EXIT
node scripts/ci/affected-scope.mjs --csv "$CHANGED" > "$SCOPE_FILE"
eval "$(cat "$SCOPE_FILE")"

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

  # Through the machine-wide test slot with priority (nice 0, jumps waiting
  # agents): agents are capped at 3 workers under nice 15 there, so the batch
  # gate can take more. VERIFY_VITEST_MAX_WORKERS / VERIFY_LIGHT_PARALLEL
  # override (CI keeps its own 2/2 in ci.yml).
  echo "verify:push: tests (affected) — workers ${VERIFY_VITEST_MAX_WORKERS}, light parallel ${VERIFY_LIGHT_PARALLEL}"
  if NODE_OPTIONS="--max-old-space-size=3072" VITEST_MAX_WORKERS="$VERIFY_VITEST_MAX_WORKERS" \
    LIGHT_PARALLEL="$VERIFY_LIGHT_PARALLEL" \
    scripts/ci/test-slot.sh --priority -- scripts/ci/test-affected.sh --files "$CHANGED"; then
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
  if [[ $FOOTPRINT_ALL -eq 1 || -n "$FOOTPRINT_ADDONS" ]]; then
    FP_ARGS=()
    if [[ $FOOTPRINT_ALL -eq 0 ]]; then FP_ARGS=(--addons "$FOOTPRINT_ADDONS"); fi
    # The guard also needs the addon-runner dist; cached by nx when already built.
    NODE_OPTIONS="--max-old-space-size=4096" npx nx run @camstack/server/system:build >/dev/null || true
    echo "verify:push: addon dist footprint (D28) — ${FOOTPRINT_ADDONS:-all addons}"
    if NODE_OPTIONS="--max-old-space-size=2048" npx tsx scripts/check-addon-dist-footprint.ts ${FP_ARGS[@]+"${FP_ARGS[@]}"}; then
      FOOTPRINT_RESULT="ok"
    else
      FOOTPRINT_RESULT="RED"
      RC=1
    fi
  fi
fi

# D28 barrel guards (CI: "Runner and addon barrel guards"; the list is
# scripts/ci/run-barrel-guards.sh, shared with ci.yml). The source scan (~1 s)
# runs on any affected change; the dist half reads packages/system/dist, which
# the build above refreshed only when types or system moved (TC_DIRS=ALL), so
# it runs then.
# Test-load and single-engine guards (~1 s, no build needed): every
# vitest.config.ts takes the shared worker default, and no TS 6 type-check
# path comes back.
echo "verify:push: test-load guards"
if npx tsx scripts/check-vitest-max-workers.ts && npx tsx scripts/check-no-tsc6-typecheck.ts; then
  GUARDS_RESULT="ok"
else
  GUARDS_RESULT="RED"
  RC=1
fi

if [[ -n "$TC_DIRS" ]]; then
  if [[ "$TC_DIRS" == "ALL" ]]; then GUARD_MODE=all; else GUARD_MODE=source; fi
  echo "verify:push: barrel guards ($GUARD_MODE)"
  if scripts/ci/run-barrel-guards.sh "$GUARD_MODE"; then
    if [[ "$GUARDS_RESULT" != "RED" ]]; then GUARDS_RESULT="ok"; fi
  else
    GUARDS_RESULT="RED"
    RC=1
  fi
fi

# Do not `grep -q` this list under `pipefail`: on a long CHANGED set grep
# exits at the first hit and the writer dies with SIGPIPE (141), so the
# branch is skipped and the gate prints `scripts: skipped`.
if [[ ",${CHANGED}," == *",scripts/"* ]]; then
  echo "verify:push: repo scripts tests"
  if NODE_OPTIONS="--max-old-space-size=3072" VITEST_MAX_WORKERS="$VERIFY_VITEST_MAX_WORKERS" \
    scripts/ci/test-slot.sh --priority -- npm run test:scripts; then
    SCRIPTS_RESULT="ok"
  else
    SCRIPTS_RESULT="RED"
    RC=1
  fi
fi

if [[ $RC -eq 0 ]]; then VERDICT=GREEN; else VERDICT=RED; fi
echo "verify:push $VERDICT — typecheck: $TC_RESULT, tests: $TEST_RESULT, scripts: $SCRIPTS_RESULT, footprint: $FOOTPRINT_RESULT, guards: $GUARDS_RESULT"
exit $RC
