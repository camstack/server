#!/usr/bin/env bash
# The "canary" of `verify:push`: the few specs where a capability or API change
# is first seen red, run BEFORE the long test stage so a red run costs minutes.
#   - the @camstack/types project (CAPS_ADDED_SINCE_FIXTURE and the vocabulary
#     snapshots live there);
#   - the admin-ui api-method-groups specs (every new tRPC method must be grouped).
# Both are part of the full lanes that follow, so the gate set does not change.
#
# AFFECTED_CSV (from scripts/ci/affected-scope.mjs) says which of the two the
# change can reach; an empty list or one without either runs nothing.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

AFFECTED_CSV="${AFFECTED_CSV:-}"
ran=0

if [[ ",${AFFECTED_CSV}," == *",@camstack/types,"* ]]; then
  echo "canary: @camstack/types project tests"
  npx nx run @camstack/types:test
  ran=1
fi

if [[ ",${AFFECTED_CSV}," == *",@camstack/addon-admin-ui,"* ]]; then
  echo "canary: admin-ui api-method-groups specs"
  npx nx run @camstack/addon-admin-ui:test -- api-method-groups
  ran=1
fi

if [[ $ran -eq 0 ]]; then
  echo "canary: neither @camstack/types nor admin-ui is affected — nothing to run"
fi
