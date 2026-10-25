#!/usr/bin/env bash
# Split nx test into a heavy serial lane and a light parallel lane.
#
# Heavy suites (system, pipeline, admin-ui, …) carry fake-timer / watcher
# timing tests that fail by lottery when overlapped with other large vitest
# runs — measured on ci-runner (parallel=1 forever) and again on
# agent-b (38132637960 SIGTERM grace; 38133811367 preroll settle).
# Light addons are small enough to share --parallel safely.
#
# Usage:
#   scripts/ci/test-affected.sh --files "$CHANGED"
#   scripts/ci/test-affected.sh --all
set -euo pipefail

LIGHT_PARALLEL="${LIGHT_PARALLEL:-2}"
MODE=""
FILES=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --files)
      MODE=files
      FILES="${2:-}"
      shift 2
      ;;
    --all)
      MODE=all
      shift
      ;;
    *)
      echo "usage: $0 --files <comma-separated> | --all" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$MODE" ]]; then
  echo "usage: $0 --files <comma-separated> | --all" >&2
  exit 2
fi

if [[ "$MODE" == files && -z "$FILES" ]]; then
  echo "test-affected: empty --files — nothing to test"
  exit 0
fi

# Resolve project lists (heavy vs light) in node — portable, no bash-4 maps.
# The heredoc is NOT inside $( ): macOS bash 3.2 mis-parses a backtick in a
# heredoc nested in a command substitution ("unexpected EOF").
PROJECT_LISTS="$(mktemp)"
trap 'rm -f "$PROJECT_LISTS"' EXIT
MODE="$MODE" FILES="$FILES" node > "$PROJECT_LISTS" <<'NODE'
const { execFileSync } = require('node:child_process')
const heavy = new Set([
  '@camstack/types',
  '@camstack/system',
  '@camstack/ui-library',
  '@camstack/server',
  '@camstack/addon-pipeline',
  '@camstack/addon-pipeline-orchestrator',
  '@camstack/addon-admin-ui',
  '@camstack/addon-post-analysis',
])
const mode = process.env.MODE
const files = process.env.FILES || ''
let all
if (mode === 'files') {
  all = JSON.parse(
    execFileSync(
      'npx',
      ['nx', 'show', 'projects', '--affected', `--files=${files}`, '--json'],
      { encoding: 'utf8' },
    ),
  )
} else {
  all = JSON.parse(
    execFileSync('npx', ['nx', 'show', 'projects', '--json'], { encoding: 'utf8' }),
  )
}
const H = []
const L = []
for (const p of all) (heavy.has(p) ? H : L).push(p)
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
console.log(`HEAVY_CSV=${sh(H.join(','))}`)
console.log(`LIGHT_CSV=${sh(L.join(','))}`)
NODE
eval "$(cat "$PROJECT_LISTS")"

if [[ -n "${HEAVY_CSV}" ]]; then
  echo "test-affected: heavy (parallel=1): ${HEAVY_CSV}"
  npx nx run-many -t test --projects="${HEAVY_CSV}" --parallel=1 --output-style stream
else
  echo "test-affected: heavy lane empty"
fi

if [[ -n "${LIGHT_CSV}" ]]; then
  echo "test-affected: light (parallel=${LIGHT_PARALLEL}): ${LIGHT_CSV}"
  npx nx run-many -t test --projects="${LIGHT_CSV}" --parallel="${LIGHT_PARALLEL}" --output-style stream
else
  echo "test-affected: light lane empty"
fi
