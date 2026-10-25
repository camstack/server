#!/usr/bin/env bash
#
# Run the inference pool's Python tests.
#
# WHY THIS EXISTS: `npm run test` is `nx run-many -t test`, and nx only knows
# workspace packages with a `test` target — the pool's Python suite is neither.
# So `packages/addon-pipeline/python/test_*.py` had NEVER run in CI: not
# failing, never collected. Same leftover class as `scripts/__tests__` before
# the "Test repo scripts" step; a test nobody runs reads as verification and is
# exactly how this repo keeps getting bitten. The load-time static-batch
# derivation (D202) is defended by these tests and by nothing else.
#
# The suite is pytest-oriented but most modules are `unittest.TestCase` and run
# on a bare interpreter. When pytest is present we run everything; when it is
# not we run the unittest-style modules — classified by CONTENT, so a new test
# file needs no edit here — and NAME the ones left uncovered instead of passing
# in silence.
#
# The bare-interpreter fallback covers `postprocessors/test_*.py` too (fix
# round 1, 2026-09-26): it used to classify+run ONLY this directory's own
# `test_*.py`, so a unittest.TestCase-style postprocessor test (e.g.
# `postprocessors/test_scrfd.py`, pinning the SCRFD anchor-center fix) was
# silently never even LISTED, let alone run, on the no-pytest CI path
# (`.github/workflows/ci.yml`'s `Test the inference pool (python)` step) —
# exactly the "reads as verification, isn't" failure mode this script exists
# to close. Classified the same way, by CONTENT; run as a SEPARATE `unittest`
# invocation cd'd into `postprocessors/`, because those modules import each
# other by bare name and only resolve with that directory as the working
# directory (same reason the pytest branch above splits in two).
set -euo pipefail

cd "$(dirname "$0")/../packages/addon-pipeline/python"

if python3 -c 'import pytest' >/dev/null 2>&1; then
  echo "pytest present — running the full pool suite"
  python3 -m pytest . --ignore=postprocessors -q
  # The postprocessors import each other by bare module name, so they only
  # resolve with that directory as the working directory.
  (cd postprocessors && python3 -m pytest . -q)
  exit 0
fi

echo "pytest not installed — running the unittest-style modules on the bare interpreter"

top_unittest_mods=""
top_pytest_only=""
for f in test_*.py; do
  mod="${f%.py}"
  if grep -q 'unittest\.TestCase' "$f"; then
    top_unittest_mods="$top_unittest_mods $mod"
  else
    top_pytest_only="$top_pytest_only $f"
  fi
done

pp_unittest_mods=""
pp_pytest_only=""
for f in postprocessors/test_*.py; do
  [ -e "$f" ] || continue
  mod="$(basename "${f%.py}")"
  if grep -q 'unittest\.TestCase' "$f"; then
    pp_unittest_mods="$pp_unittest_mods $mod"
  else
    pp_pytest_only="$pp_pytest_only $(basename "$f")"
  fi
done

pytest_only_report="$top_pytest_only $pp_pytest_only"
if [ -n "${pytest_only_report// /}" ]; then
  echo "NOT COVERED without pytest (pytest-style modules):$pytest_only_report"
fi

if [ -z "$top_unittest_mods" ] && [ -z "$pp_unittest_mods" ]; then
  echo "no unittest-style modules found — refusing to report success" >&2
  exit 1
fi

status=0
if [ -n "$top_unittest_mods" ]; then
  # shellcheck disable=SC2086
  python3 -m unittest $top_unittest_mods || status=$?
fi
if [ -n "$pp_unittest_mods" ]; then
  # shellcheck disable=SC2086
  (cd postprocessors && python3 -m unittest $pp_unittest_mods) || status=$?
fi
exit "$status"
