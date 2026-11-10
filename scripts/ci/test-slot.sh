#!/usr/bin/env bash
# Machine-wide test slot: at most CAMSTACK_TEST_SLOTS (default 2) vitest runs
# at once on this machine, whatever worktree or agent starts them.
#
# Parallel agents each started a full vitest run (12 forks by default) and the
# Mac swapped itself to a stop: 22 workers alive at once, 12 of 13 GB of swap.
# A slot is a directory made with `mkdir` (atomic), holding the pid of the
# wrapper that owns it. The wrapper waits for a free slot, runs the command,
# and removes the slot on exit (trap).
#
# Stale recovery: a slot whose pid is no longer alive (`kill -0` fails) is
# reclaimed under a small reap lock, re-checked inside it. Nothing is ever
# killed — a live owner keeps its slot however long it runs.
#
# Priority (`--priority`, verify:push): runs at nice 0 and keeps the caller's
# VITEST_MAX_WORKERS. While a priority caller waits, normal callers do not take
# a free slot, so the batch gate goes next.
#
# A normal caller runs under `nice -n 15` with VITEST_MAX_WORKERS=3 (vitest
# reads that variable itself; every vitest.config.ts defaults to it too).
#
# Usage:
#   scripts/ci/test-slot.sh [--priority] -- <command> [args…]
#
# Env:
#   CAMSTACK_TEST_SLOTS     number of slots (default 2)
#   CAMSTACK_TEST_SLOT_DIR  slot directory (default /tmp/camstack-test-slots)
#   CAMSTACK_TEST_SLOT_POLL seconds between attempts (default 2)
set -uo pipefail

SLOT_DIR="${CAMSTACK_TEST_SLOT_DIR:-/tmp/camstack-test-slots}"
SLOTS="${CAMSTACK_TEST_SLOTS:-2}"
POLL="${CAMSTACK_TEST_SLOT_POLL:-2}"
AGENT_MAX_WORKERS=3
AGENT_NICE=15
# A slot directory without a pid file is being created; only after this many
# seconds is it treated as abandoned.
UNOWNED_GRACE_S=10

PRIORITY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --priority)
      PRIORITY=1
      shift
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done

if [[ $# -eq 0 ]]; then
  echo "usage: $0 [--priority] -- <command> [args…]" >&2
  exit 2
fi
if ! [[ "$SLOTS" =~ ^[1-9][0-9]*$ ]]; then
  echo "test-slot: CAMSTACK_TEST_SLOTS must be a positive integer (got '$SLOTS')" >&2
  exit 2
fi

mkdir -p "$SLOT_DIR"

MY_SLOT=""
PRIO_MARK=""

alive() {
  [[ -n "$1" ]] && kill -0 "$1" 2>/dev/null
}

age_s() {
  local mtime
  mtime=$(stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0)
  echo $(($(date +%s) - mtime))
}

# Reclaim a slot whose owner is gone. The reap lock makes the check-and-remove
# one step: a waiter that read the same dead pid re-reads it under the lock and
# finds either no slot or a NEW owner, and leaves it alone.
reap_if_stale() {
  local slot="$1" pid lock="$SLOT_DIR/.reap.lock"
  if ! mkdir "$lock" 2>/dev/null; then
    # A reaper that died inside the lock: its lock is tiny-lived, so an old one is abandoned.
    if [[ $(age_s "$lock") -gt $UNOWNED_GRACE_S ]]; then rmdir "$lock" 2>/dev/null; fi
    return
  fi
  if [[ -d "$slot" ]]; then
    pid=$(cat "$slot/pid" 2>/dev/null || true)
    if [[ -n "$pid" ]] && ! alive "$pid"; then
      echo "test-slot: reclaiming $(basename "$slot") (owner pid $pid is gone)" >&2
      rm -rf "$slot"
    elif [[ -z "$pid" && $(age_s "$slot") -gt $UNOWNED_GRACE_S ]]; then
      echo "test-slot: reclaiming $(basename "$slot") (no owner recorded)" >&2
      rm -rf "$slot"
    fi
  fi
  rmdir "$lock" 2>/dev/null
}

# A live priority waiter other than this process.
priority_waiting() {
  local mark pid
  for mark in "$SLOT_DIR"/priority-*; do
    [[ -e "$mark" ]] || continue
    pid="${mark##*/priority-}"
    if [[ "$pid" == "$$" ]]; then continue; fi
    if alive "$pid"; then return 0; fi
    rm -f "$mark"
  done
  return 1
}

try_acquire() {
  local i slot
  for ((i = 0; i < SLOTS; i++)); do
    slot="$SLOT_DIR/slot-$i"
    if mkdir "$slot" 2>/dev/null; then
      echo "$$" >"$slot/pid"
      MY_SLOT="$slot"
      return 0
    fi
    reap_if_stale "$slot"
  done
  return 1
}

release() {
  if [[ -n "$MY_SLOT" ]]; then rm -rf "$MY_SLOT"; fi
  if [[ -n "$PRIO_MARK" ]]; then rm -f "$PRIO_MARK"; fi
}
trap release EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ $PRIORITY -eq 1 ]]; then
  PRIO_MARK="$SLOT_DIR/priority-$$"
  : >"$PRIO_MARK"
fi

WAITED=0
while true; do
  if [[ $PRIORITY -eq 1 ]] || ! priority_waiting; then
    if try_acquire; then break; fi
  fi
  if [[ $WAITED -eq 0 ]]; then
    echo "test-slot: all $SLOTS test slots busy — waiting (slots in $SLOT_DIR)" >&2
    WAITED=1
  fi
  sleep "$POLL"
done
if [[ -n "$PRIO_MARK" ]]; then
  rm -f "$PRIO_MARK"
  PRIO_MARK=""
fi
echo "test-slot: holding $(basename "$MY_SLOT")$([[ $PRIORITY -eq 1 ]] && echo ' (priority)')" >&2

if [[ $PRIORITY -eq 1 ]]; then
  "$@"
else
  VITEST_MAX_WORKERS="$AGENT_MAX_WORKERS" nice -n "$AGENT_NICE" "$@"
fi
