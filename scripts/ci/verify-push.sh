#!/usr/bin/env bash
# Run LOCALLY exactly what CI (.github/workflows/ci.yml) would run for the
# commits about to be pushed, so a push can never turn CI red on a gate the
# local run never saw.
#
# Why: agents used to run `nx affected -t typecheck` (tsc 6), but CI grades
# `scripts/typecheck-tsgo.ts` (tsgo / TypeScript 7) against the pins in
# scripts/ci-baseline.json and fails on "pinned-or-new error(s)" tsc never
# reported. This script runs the same gates, scoped to what changed:
#   - "Typecheck (TypeScript 7)"           -> scripts/typecheck-tsgo.ts <affected dirs>
#   - "Test affected packages (push/PR)"   -> scripts/ci/test-affected.sh --files
#   - "Test repo scripts"                  -> npm run test:scripts (if scripts/ changed)
#   - "Addon dist footprint (D28)"         -> scripts/check-addon-dist-footprint.ts
#        only when packages/addon-*/ or packages/types/src/ changed: the touched
#        addons (--addons), or every addon when types/src moved (all bundle it).
#        It reads the dists the build step produced.
#   - "Runner and addon barrel guards (D28)" -> scripts/ci/run-barrel-guards.sh
#        the same script CI calls; the source scan on any affected change, plus
#        the built-dist half when packages/types or packages/system changed.
#
# STAGE ORDER: cheap and decisive first, the long test stage last, and the run
# STOPS at the first red stage with one line naming it:
#   changelog -> test-load guards -> barrel guards (source) -> [codegen,
#   opt-in] -> build -> tsgo -> footprint -> barrel guards (dist) -> repo
#   script tests -> canary (the @camstack/types project and the admin-ui
#   api-method-groups specs, where a capability change is first seen red) ->
#   the affected test lanes.
# `VERIFY_FULL=1` keeps the older behaviour: every stage runs whatever failed
# before it, for one complete verdict. The SET of gates is the same either way;
# only the order and the early exit differ. `VERIFY_CODEGEN_CHECK=1` adds
# `npm run codegen:check` after the source guards (not a CI gate today).
#
# Each run appends one JSON line to ~/.cache/camstack/verify-timings.jsonl
# (VERIFY_TIMINGS_FILE overrides the path) and prints a stage summary: `stages`
# (seconds per stage that ran), `stageResults` (pass | fail | skipped per
# stage) and `failedStage`. Outside CI the test stage runs the heavy and light
# lanes together (scripts/ci/run-test-lanes.mjs), starting the projects that
# failed in the previous run of this base first; CI's own jobs call
# test-affected.sh --shard and stay on the serial heavy lane.
#
# Changed set = committed diff from the merge-base with origin/main PLUS the
# working tree (staged, unstaged, untracked), minus package-lock.json (as CI).
# If packages/types or packages/system changed, every project is affected
# (CI effectively checks everything then); the typecheck runs unrestricted.
#
# Usage:
#   npm run verify:push
#   npm run verify:push -- --base <sha>
#   VERIFY_FULL=1 npm run verify:push
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
# The test stage reads the previous run of this base from the timings log.
export VERIFY_BASE="$BASE"
# CI's tsgo pool size (ci.yml): the projects overlap, one native checker each.
export TSGO_JOBS="${TSGO_JOBS:-3}"

FULL=0
if [[ "${VERIFY_FULL:-}" == "1" || "${VERIFY_FULL:-}" == "true" ]]; then FULL=1; fi
if [[ $FULL -eq 1 ]]; then
  echo "verify:push: VERIFY_FULL — every stage runs, a red one does not stop the run"
fi

# Stage timings. The EXIT trap appends one JSON line even when a stage exits
# early, then deletes the temp files (including the affected-scope file).
# A stage line is `name<TAB>seconds<TAB>pass|fail`; a stage that never ran is
# written as `name<TAB>-<TAB>skipped` by the trap, in STAGE_ORDER.
STAGE_ORDER="changelog testLoadGuards barrelGuards codegen build tsgo footprint barrelDist scripts canary tests"
now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time()*1000'; }
stage_begin() { STAGE_MARK=$(now_ms); }
stage_end() {
  local end_ms
  end_ms=$(now_ms)
  perl -e 'printf "%s\t%.3f\t%s\n", $ARGV[0], ($ARGV[2] - $ARGV[1]) / 1000.0, $ARGV[3]' \
    "$1" "$STAGE_MARK" "$end_ms" "${2:-pass}" >>"$STAGES_FILE"
}
START_MS=$(now_ms)
STAGES_FILE=$(mktemp)
PROJECTS_FILE=$(mktemp)
SCOPE_FILE=""
TC_DIRS=""
finish_timing() {
  local rc=$? end_ms verdict timings name
  end_ms=$(now_ms)
  if [[ $rc -eq 0 ]]; then verdict=GREEN; else verdict=RED; fi
  timings="${VERIFY_TIMINGS_FILE:-${HOME}/.cache/camstack/verify-timings.jsonl}"
  if [[ -n "${STAGES_FILE:-}" && -f "$STAGES_FILE" ]]; then
    for name in $STAGE_ORDER; do
      if ! grep -q "^${name}	" "$STAGES_FILE"; then
        printf '%s\t-\tskipped\n' "$name" >>"$STAGES_FILE"
      fi
    done
    node scripts/ci/verify-timing.mjs \
      --append "$timings" \
      --start-ms "$START_MS" \
      --end-ms "$end_ms" \
      --scope "${TC_DIRS:-}" \
      --base "${BASE:-}" \
      --result "$verdict" \
      --stages "$STAGES_FILE" \
      --projects "$PROJECTS_FILE" || true
    rm -f "$STAGES_FILE" "$PROJECTS_FILE"
    STAGES_FILE=""
  fi
  if [[ -n "${SCOPE_FILE:-}" ]]; then rm -f "$SCOPE_FILE"; fi
}
trap finish_timing EXIT

RC=0
# run_stage <name> <result-var> <label> <command...>
# Runs the command as one timed stage. Green: the result variable is `ok`.
# Red: the variable is `RED`; the run stops here with a line naming the stage,
# unless VERIFY_FULL=1, which records it and goes on.
run_stage() {
  local name="$1" var="$2" label="$3"
  shift 3
  echo "verify:push: ${label}"
  stage_begin
  if "$@"; then
    stage_end "$name" pass
    printf -v "$var" '%s' ok
    return 0
  fi
  stage_end "$name" fail
  printf -v "$var" '%s' RED
  RC=1
  # A broken build or changelog leaves nothing meaningful to grade after it,
  # so those two stop the run even under VERIFY_FULL (as they always did).
  if [[ $FULL -eq 0 || "$name" == build || "$name" == changelog ]]; then
    echo "verify:push RED — stage '${name}' (${label}) failed; later stages did not run (VERIFY_FULL=1 runs the rest after a red stage)"
    exit 1
  fi
  return 0
}

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
CHANGELOG_RESULT="skipped"
if [[ ",${CHANGED}," == *"CHANGELOG.md,"* || ",${CHANGED}," == *",packages/"* || ",${CHANGED}," == *",server/"* ]]; then
  run_stage changelog CHANGELOG_RESULT "changelog entries (against the last publish tag)" \
    npx tsx scripts/check-changelog-unreleased.ts
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

# NX_DAEMON passes through untouched to every nx call below; it is printed so a
# run can be measured with it on and off. Worker counts for the local lanes are
# decided in scripts/ci/lane-budget.mjs (a 12-core machine is heavy 2×4 and
# light 2×2). Exporting LIGHT_PARALLEL=3 here used to be right when the light
# lane ran alone; together with the heavy lane it oversubscribes.
if [[ -n "${NX_DAEMON:-}" ]]; then export NX_DAEMON; fi
echo "verify:push: NX_DAEMON=${NX_DAEMON:-<nx default>}"
if node scripts/ci/lane-budget.mjs --enabled; then
  LOCAL_LANES=1
  echo "verify:push: local test lanes — heavy and light together, sized from the CPU count"
else
  LOCAL_LANES=0
  export VITEST_MAX_WORKERS="${VERIFY_VITEST_MAX_WORKERS:-4}"
  export LIGHT_PARALLEL="${VERIFY_LIGHT_PARALLEL:-3}"
  echo "verify:push: serial test lanes — workers ${VITEST_MAX_WORKERS}, light parallel ${LIGHT_PARALLEL}"
fi

TC_RESULT="skipped"
TEST_RESULT="skipped"
SCRIPTS_RESULT="skipped"
FOOTPRINT_RESULT="skipped"
GUARDS_RESULT="skipped"
LOAD_GUARDS_RESULT="skipped"
CODEGEN_RESULT="skipped"
BUILD_RESULT="skipped"
CANARY_RESULT="skipped"

# Affected nx projects -> package directory basenames (what typecheck-tsgo takes)
# and the footprint / scripts flags. The SAME script CI's `static` job runs
# (scripts/ci/affected-scope.mjs), so the two cannot grade different sets.
# TC_DIRS: empty = nothing affected, "ALL" = a framework package changed.
SCOPE_FILE=$(mktemp)
node scripts/ci/affected-scope.mjs --csv "$CHANGED" > "$SCOPE_FILE"
eval "$(cat "$SCOPE_FILE")"

# --- 1. Source guards: seconds, no build needed. -----------------------------
# Test-load and single-engine guards: every vitest.config.ts takes the shared
# worker default, and no TS 6 type-check path comes back. The admin UI's
# one-action-block guard (D983, a ~1 s source scan) rides here too: it sat red
# on main unseen because no stage ran it. So does the undeclared-secret-field
# guard (D783, a ~5 s source scan): it sat red on main for the same reason
# (planning#591).
run_stage testLoadGuards LOAD_GUARDS_RESULT "test-load guards" \
  bash -c 'npx tsx scripts/check-vitest-max-workers.ts \
    && npx tsx scripts/check-no-tsc6-typecheck.ts \
    && npx tsx scripts/check-action-block-importers.ts \
    && npx tsx scripts/check-secret-fields-declared.ts \
    && npx tsx scripts/check-no-hand-set-features.ts'

# D28 barrel guards, source half (CI: "Runner and addon barrel guards"; the list
# is scripts/ci/run-barrel-guards.sh, shared with ci.yml). ~1 s.
if [[ -n "$TC_DIRS" ]]; then
  run_stage barrelGuards GUARDS_RESULT "barrel guards (source)" scripts/ci/run-barrel-guards.sh source
fi

# Generated files drifted from the caps: opt-in, it rebuilds the framework dist.
if [[ -n "$TC_DIRS" && "${VERIFY_CODEGEN_CHECK:-}" == "1" ]]; then
  run_stage codegen CODEGEN_RESULT "codegen:check" npm run codegen:check
fi

if [[ -z "$TC_DIRS" ]]; then
  echo "verify:push: no project affected — skipping build, typecheck and project tests"
else
  # --- 2. Build and typecheck: minutes, decisive. ----------------------------
  # CI always builds before typechecking; a STALE dist gives phantom errors.
  # build dependsOn ^build pulls dependencies; the nx cache keeps it cheap.
  if [[ "$TC_DIRS" == "ALL" ]]; then
    run_stage build BUILD_RESULT "build (affected) — ${TC_DIRS}" \
      env NODE_OPTIONS="--max-old-space-size=4096" npm run build -- --parallel=3
  else
    run_stage build BUILD_RESULT "build (affected) — ${TC_DIRS}" \
      env NODE_OPTIONS="--max-old-space-size=4096" npx nx run-many -t build \
      --projects="$AFFECTED_CSV" --parallel=3
  fi

  TC_ARGS=()
  if [[ "$TC_DIRS" != "ALL" ]]; then read -r -a TC_ARGS <<<"$TC_DIRS"; fi
  run_stage tsgo TC_RESULT "typecheck (tsgo, ${TSGO_JOBS} jobs) — ${TC_DIRS}" \
    env NODE_OPTIONS="--max-old-space-size=4096" npx tsx scripts/typecheck-tsgo.ts ${TC_ARGS[@]+"${TC_ARGS[@]}"}

  # D28 footprint guard (CI: "Addon dist footprint (D28)"). A red main sat
  # unseen for several runs because only CI ran it. The build above already
  # produced the dists it reads (addons depend on types and system).
  if [[ $FOOTPRINT_ALL -eq 1 || -n "$FOOTPRINT_ADDONS" ]]; then
    FP_ARGS=()
    if [[ $FOOTPRINT_ALL -eq 0 ]]; then FP_ARGS=(--addons "$FOOTPRINT_ADDONS"); fi
    # The guard also needs the addon-runner dist; cached by nx when already built.
    NODE_OPTIONS="--max-old-space-size=4096" npx nx run @camstack/server-framework:build >/dev/null || true
    run_stage footprint FOOTPRINT_RESULT "addon dist footprint (D28) — ${FOOTPRINT_ADDONS:-all addons}" \
      env NODE_OPTIONS="--max-old-space-size=2048" npx tsx scripts/check-addon-dist-footprint.ts ${FP_ARGS[@]+"${FP_ARGS[@]}"}
  fi

  # Dist half of the barrel guards: it reads packages/system/dist, which the
  # build above refreshed only when types or system moved (TC_DIRS=ALL).
  if [[ "$TC_DIRS" == "ALL" ]]; then
    run_stage barrelDist GUARDS_DIST_RESULT "barrel guards (dist)" scripts/ci/run-barrel-guards.sh dist
    if [[ "${GUARDS_DIST_RESULT:-}" == "RED" ]]; then GUARDS_RESULT="RED"; fi
  fi
fi

# --- 3. Repo script tests, then the canary, then the long test stage. --------
# Do not `grep -q` this list under `pipefail`: on a long CHANGED set grep
# exits at the first hit and the writer dies with SIGPIPE (141), so the
# branch is skipped and the gate prints `scripts: skipped`.
if [[ ",${CHANGED}," == *",scripts/"* ]]; then
  run_stage scripts SCRIPTS_RESULT "repo scripts tests" \
    env NODE_OPTIONS="--max-old-space-size=3072" VITEST_MAX_WORKERS="${VERIFY_VITEST_MAX_WORKERS:-4}" \
    scripts/ci/test-slot.sh --priority -- npm run test:scripts
fi

if [[ -n "$TC_DIRS" ]]; then
  # The canary is a subset of the full lanes below; under VERIFY_FULL those
  # already report it, so it is not run twice.
  if [[ $FULL -eq 0 && ( ",${AFFECTED_CSV}," == *",@camstack/types,"* || ",${AFFECTED_CSV}," == *",@camstack/addon-admin-ui,"* ) ]]; then
    run_stage canary CANARY_RESULT "canary (@camstack/types tests, admin-ui api-method-groups)" \
      env AFFECTED_CSV="$AFFECTED_CSV" scripts/ci/test-slot.sh --priority -- scripts/ci/verify-canary.sh
  fi

  # Through the machine-wide test slot with priority (nice 0, jumps waiting
  # agents). Locally the lanes share the cores (lane-budget.mjs). With CI set,
  # this is the old serial schedule and its worker env.
  export VERIFY_PROJECT_TIMING="$PROJECTS_FILE"
  if [[ "$LOCAL_LANES" == 1 ]]; then
    run_stage tests TEST_RESULT "tests (affected) — local lanes" \
      env NODE_OPTIONS="--max-old-space-size=3072" \
      scripts/ci/test-slot.sh --priority -- scripts/ci/test-affected.sh --files "$CHANGED"
  else
    run_stage tests TEST_RESULT "tests (affected) — workers ${VITEST_MAX_WORKERS}, light parallel ${LIGHT_PARALLEL}" \
      env NODE_OPTIONS="--max-old-space-size=3072" VITEST_MAX_WORKERS="$VITEST_MAX_WORKERS" \
      LIGHT_PARALLEL="$LIGHT_PARALLEL" \
      scripts/ci/test-slot.sh --priority -- scripts/ci/test-affected.sh --files "$CHANGED"
  fi
fi

if [[ $RC -eq 0 ]]; then VERDICT=GREEN; else VERDICT=RED; fi
echo "verify:push $VERDICT — typecheck: $TC_RESULT, tests: $TEST_RESULT, scripts: $SCRIPTS_RESULT, footprint: $FOOTPRINT_RESULT, guards: $GUARDS_RESULT, test-load guards: $LOAD_GUARDS_RESULT, canary: $CANARY_RESULT, codegen: $CODEGEN_RESULT"
exit $RC
