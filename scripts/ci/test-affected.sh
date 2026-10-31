#!/usr/bin/env bash
# Split nx test into a heavy serial lane and a light parallel lane.
#
# Heavy suites (system, pipeline, admin-ui, …) carry fake-timer / watcher
# timing tests that fail by lottery when overlapped with other large vitest
# runs — measured on ci-runner (parallel=1 forever) and again on
# agent-b (38132637960 SIGTERM grace; 38133811367 preroll settle).
# Light addons are small enough to share --parallel safely.
#
# Shards: CI runs one matrix job per shard (heavy package(s) alone, light addons
# in two hash-assigned groups); the default is every shard in turn, which is what
# `npm run verify:push` runs — the same projects, the same commands, so the local
# gate and CI cannot grade different sets. The shard table lives HERE only.
#
# Usage:
#   scripts/ci/test-affected.sh [--shard <name>] --files "$CHANGED"
#   scripts/ci/test-affected.sh [--shard <name>] --files-from <file>   (comma or newline list)
#   scripts/ci/test-affected.sh [--shard <name>] --all
#   scripts/ci/test-affected.sh --list-shards
set -euo pipefail

LIGHT_PARALLEL="${LIGHT_PARALLEL:-2}"
MODE=""
FILES=""
FILES_FROM=""
SHARD="all"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --files)
      MODE=files
      FILES="${2:-}"
      shift 2
      ;;
    --files-from)
      MODE=files
      FILES_FROM="${2:-}"
      shift 2
      ;;
    --shard)
      SHARD="${2:-}"
      shift 2
      ;;
    --list-shards)
      echo "system-1 system-2 pipeline-1 pipeline-2 post-analysis-1 post-analysis-2 admin-ui-1 admin-ui-2 admin-ui-3 ui-library server-1 server-2 server-3 core light-a light-b"
      exit 0
      ;;
    --all)
      MODE=all
      shift
      ;;
    *)
      echo "usage: $0 [--shard <name>] --files <comma-separated> | --files-from <file> | --all" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$MODE" ]]; then
  echo "usage: $0 [--shard <name>] --files <comma-separated> | --files-from <file> | --all" >&2
  exit 2
fi

# A list read from a file never travels through argv or the environment (each
# is capped near 128 KiB on Linux): node reads the file itself.
if [[ -n "$FILES_FROM" ]]; then
  [[ -s "$FILES_FROM" ]] && FILES="from-file"
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
MODE="$MODE" FILES="$FILES" FILES_FROM="$FILES_FROM" SHARD="$SHARD" node > "$PROJECT_LISTS" <<'NODE'
const { execFileSync } = require('node:child_process')
// Heavy packages carry the bulk of the time and run serial inside their shard.
// Measured on the 2026-10-31 nightly (4 vCPU, 2 workers): admin-ui 572 s,
// server 422, pipeline 385, post-analysis 360, system 270, ui-library 222,
// orchestrator + types 206 — most of it module import / jsdom setup per file,
// not test bodies, so it divides cleanly across files. A big package is
// therefore SPLIT with vitest's own `--shard=i/n` (files, deterministic) into n
// jobs, which is what brings a framework-wide push (everything affected) under
// the budget: wall clock = job setup + the slowest slice (~3 min). Every other
// project is light and lands in one of two groups by a hash of its NAME —
// stable whatever the affected set is, so a project can never fall between
// shards. `vitest` is the shard `v` ("i/n") handed to the package's own test
// script after `--`; an unsplit shard has none.
const SHARDS = {
  'system-1': { p: ['@camstack/system'], v: '1/2' },
  'system-2': { p: ['@camstack/system'], v: '2/2' },
  'pipeline-1': { p: ['@camstack/addon-pipeline'], v: '1/2' },
  'pipeline-2': { p: ['@camstack/addon-pipeline'], v: '2/2' },
  'post-analysis-1': { p: ['@camstack/addon-post-analysis'], v: '1/2' },
  'post-analysis-2': { p: ['@camstack/addon-post-analysis'], v: '2/2' },
  'admin-ui-1': { p: ['@camstack/addon-admin-ui'], v: '1/3' },
  'admin-ui-2': { p: ['@camstack/addon-admin-ui'], v: '2/3' },
  'admin-ui-3': { p: ['@camstack/addon-admin-ui'], v: '3/3' },
  'ui-library': { p: ['@camstack/ui-library'] },
  'server-1': { p: ['@camstack/server'], v: '1/3' },
  'server-2': { p: ['@camstack/server'], v: '2/3' },
  'server-3': { p: ['@camstack/server'], v: '3/3' },
  core: { p: ['@camstack/types', '@camstack/addon-pipeline-orchestrator'] },
}
const HEAVY_SHARDS = Object.keys(SHARDS)
const LIGHT_SHARDS = ['light-a', 'light-b']
const heavy = new Set(Object.values(SHARDS).flatMap((s) => s.p))
const hash = (name) => {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h
}
const shardsOf = (p) => (heavy.has(p) ? HEAVY_SHARDS.filter((s) => SHARDS[s].p.includes(p)) : [LIGHT_SHARDS[hash(p) % LIGHT_SHARDS.length]])
const wanted = process.env.SHARD
if (wanted !== 'all' && !HEAVY_SHARDS.includes(wanted) && !LIGHT_SHARDS.includes(wanted)) {
  console.error(`test-affected: unknown shard "${wanted}"`)
  process.exit(2)
}
const mode = process.env.MODE
const files = process.env.FILES_FROM
  ? require('node:fs').readFileSync(process.env.FILES_FROM, 'utf8').split(/[\n,]/).filter(Boolean).join(',')
  : process.env.FILES || ''
const nxJson = (args) => JSON.parse(execFileSync('npx', ['nx', 'show', 'projects', ...args, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
let all
if (mode === 'files') {
  // Affected is monotone per file (project graph + dependent cascade), so the
  // affected set of a list is the UNION of the affected sets of its slices:
  // slicing under the argv limit is exact. A stale base used to push the
  // list past it and fall back to testing every project.
  const SLICE = 60000
  const slices = []
  let cur = ''
  for (const f of files.split(',').filter(Boolean)) {
    if (cur && cur.length + f.length + 1 > SLICE) {
      slices.push(cur)
      cur = ''
    }
    cur = cur ? `${cur},${f}` : f
  }
  if (cur) slices.push(cur)
  const set = new Set()
  for (const sl of slices) for (const p of nxJson(['--affected', `--files=${sl}`])) set.add(p)
  all = [...set]
} else {
  all = nxJson([])
}
all = all.filter((p) => wanted === 'all' || shardsOf(p).includes(wanted))
const H = []
const L = []
for (const p of all) (heavy.has(p) ? H : L).push(p)
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
console.log(`HEAVY_CSV=${sh(H.join(','))}`)
console.log(`LIGHT_CSV=${sh(L.join(','))}`)
console.log(`VITEST_SHARD=${sh(SHARDS[wanted]?.v ?? '')}`)
NODE
eval "$(cat "$PROJECT_LISTS")"

if [[ -n "${HEAVY_CSV}" ]]; then
  echo "test-affected: heavy (parallel=1): ${HEAVY_CSV}"
  # A split shard hands vitest its slice after `--`; `all` (verify:push) runs whole.
  npx nx run-many -t test --projects="${HEAVY_CSV}" --parallel=1 --output-style stream \
    ${VITEST_SHARD:+-- "--shard=${VITEST_SHARD}"}
else
  echo "test-affected: heavy lane empty"
fi

if [[ -n "${LIGHT_CSV}" ]]; then
  echo "test-affected: light (parallel=${LIGHT_PARALLEL}): ${LIGHT_CSV}"
  npx nx run-many -t test --projects="${LIGHT_CSV}" --parallel="${LIGHT_PARALLEL}" --output-style stream
else
  echo "test-affected: light lane empty"
fi
