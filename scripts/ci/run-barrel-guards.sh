#!/usr/bin/env bash
# The D28 barrel guards of CI's `guards` lane: the ONE list, called by
# .github/workflows/ci.yml and by scripts/ci/verify-push.sh so the two cannot
# diverge (planning#379: a value import from the @camstack/types barrel in
# packages/system passed verify:push and went red in CI).
#
#   source  no bare '@camstack/types' VALUE import reachable from the
#           addon-runner / addon-utils (pure source scan, ~1 s)
#   dist    the BUILT addon-runner and addon-utils carry no schema barrel
#           (reads packages/system/dist: build it first, ~2 s)
#   all     both (CI)
#
# Usage: scripts/ci/run-barrel-guards.sh [source|dist|all]
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
MODE="${1:-all}"
RC=0
if [[ "$MODE" == "source" || "$MODE" == "all" ]]; then
  echo "guards: runner and addon sources are barrel-free (D28)"
  npx tsx scripts/check-runner-barrel-free.ts || RC=1
fi
if [[ "$MODE" == "dist" || "$MODE" == "all" ]]; then
  echo "guards: runner dist is barrel-free (D28)"
  npx tsx scripts/check-runner-dist-barrel-free.ts || RC=1
fi
exit $RC
