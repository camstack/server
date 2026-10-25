#!/usr/bin/env bash
# mem-step.sh — run one CI step and report how much memory it really used.
#
#   scripts/ci/mem-step.sh <label> <budget-MB> -- <command...>
#
# Why: the caller passes a budget sized for GitHub-hosted ubuntu-latest
# (4 vCPU, 16 GB). A warning over 12000 MB means the step is close to that
# machine. The wrapper makes the real numbers visible on every run, one row
# per step, without changing what the step does. Cgroup counters are read
# when the kernel exposes them and omitted when it does not.
#
# What it measures
#   - largest single process: GNU `/usr/bin/time -v` "Maximum resident set size"
#     (falls back to the biggest single process the sampler saw when the `time`
#     package is missing or is not GNU time);
#   - peak process-tree RSS: a 1 Hz sampler sums the RSS of every descendant of
#     the command (`ps`) — "how much did the step hold at once";
#   - peak cgroup memory: `memory.current` of the container (cgroup v2), which
#     includes the page cache, plus the lifetime `memory.peak` when it exists;
#   - the top-5 processes (command lines) at the tree-RSS peak, which shows
#     WHICH nx tasks overlapped.
#
# Budget
#   Peak tree RSS over <budget-MB> emits `::warning::`. With MEM_BUDGET_ENFORCE=1
#   it emits `::error::` and the step fails (only when the command itself
#   succeeded: a command failure keeps its own exit code). Unset, this wrapper
#   never fails a run — it is transparent: the command's exit code passes through.
#
# Output: one markdown row appended to $GITHUB_STEP_SUMMARY (stdout when unset).

set -u

usage() {
  echo "usage: mem-step.sh <label> <budget-MB> -- <command...>" >&2
  exit 2
}

[ "$#" -ge 4 ] || usage
LABEL=$1
BUDGET_MB=$2
shift 2
[ "$1" = "--" ] || usage
shift
[ "$#" -ge 1 ] || usage
case "$BUDGET_MB" in
  '' | *[!0-9]*) echo "mem-step.sh: budget-MB must be a whole number, got '$BUDGET_MB'" >&2; exit 2 ;;
esac

STATE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/mem-step.XXXXXX")
TIME_OUT="$STATE_DIR/time.out"
CGROUP_CURRENT=/sys/fs/cgroup/memory.current
CGROUP_PEAK=/sys/fs/cgroup/memory.peak

# GNU time is required for the largest-single-process figure; probe it, never
# assume it (the runner image may lack the `time` package, and macOS ships BSD time).
USE_GNU_TIME=0
if [ -x /usr/bin/time ] && /usr/bin/time -v true >/dev/null 2>&1; then
  USE_GNU_TIME=1
else
  echo "mem-step.sh: GNU /usr/bin/time -v unavailable — largest-process figure comes from the sampler" >&2
fi

read_cgroup_current() {
  if [ -r "$CGROUP_CURRENT" ]; then cat "$CGROUP_CURRENT" 2>/dev/null; else echo 0; fi
}

# tree_snapshot <root-pid>: one line per descendant of root (root included):
#   <rss-kb>\t<pid>\t<command line, 120 chars>
tree_snapshot() {
  ps -eo pid=,ppid=,rss=,args= 2>/dev/null | awk -v root="$1" '
    {
      pid = $1; parent[pid] = $2; rss[pid] = $3
      $1 = ""; $2 = ""; $3 = ""; sub(/^ +/, "")
      gsub(/\t/, " "); gsub(/\|/, "/")
      cmd[pid] = substr($0, 1, 120)
    }
    END {
      inTree[root] = 1
      do {
        grew = 0
        for (p in parent) if (!(p in inTree) && (parent[p] in inTree)) { inTree[p] = 1; grew = 1 }
      } while (grew)
      for (p in inTree) if (p in rss) printf "%d\t%s\t%s\n", rss[p], p, cmd[p]
    }'
}

# The sampler keeps its running maxima in files so the parent can read them
# after the command ends, whatever order things die in.
sampler() {
  local root=$1 snap total maxproc cg
  local peak_tree=0 peak_proc=0 peak_cg=0
  while :; do
    snap=$(tree_snapshot "$root")
    if [ -n "$snap" ]; then
      read -r total maxproc < <(printf '%s\n' "$snap" | awk -F'\t' '{ t += $1; if ($1 > m) m = $1 } END { print t + 0, m + 0 }')
      if [ "$total" -gt "$peak_tree" ]; then
        peak_tree=$total
        echo "$peak_tree" >"$STATE_DIR/peak_tree_kb"
        printf '%s\n' "$snap" | sort -t "$(printf '\t')" -k1,1 -rn | head -5 >"$STATE_DIR/peak_top5"
      fi
      if [ "$maxproc" -gt "$peak_proc" ]; then
        peak_proc=$maxproc
        echo "$peak_proc" >"$STATE_DIR/peak_proc_kb"
      fi
    fi
    cg=$(read_cgroup_current)
    if [ "${cg:-0}" -gt "$peak_cg" ]; then
      peak_cg=$cg
      echo "$peak_cg" >"$STATE_DIR/peak_cgroup_bytes"
    fi
    sleep 1
  done
}

START=$(date +%s)

# Run the command in the background so the sampler can anchor on its pid, and
# forward termination signals so a cancelled job does not orphan the step.
if [ "$USE_GNU_TIME" = 1 ]; then
  /usr/bin/time -v -o "$TIME_OUT" "$@" &
else
  "$@" &
fi
CMD_PID=$!

sampler "$CMD_PID" &
SAMPLER_PID=$!

forward() {
  kill -TERM "$CMD_PID" 2>/dev/null
}
trap forward INT TERM

wait "$CMD_PID"
RC=$?
# A trapped signal interrupts the first wait; reap the real exit status.
if kill -0 "$CMD_PID" 2>/dev/null; then
  wait "$CMD_PID"
  RC=$?
fi
trap - INT TERM

kill "$SAMPLER_PID" 2>/dev/null
wait "$SAMPLER_PID" 2>/dev/null

END=$(date +%s)
WALL=$((END - START))

read_file() { if [ -r "$1" ]; then cat "$1"; else echo "$2"; fi; }

PEAK_TREE_KB=$(read_file "$STATE_DIR/peak_tree_kb" 0)
PEAK_PROC_KB=$(read_file "$STATE_DIR/peak_proc_kb" 0)
PEAK_CG_BYTES=$(read_file "$STATE_DIR/peak_cgroup_bytes" 0)

# GNU time's figure is the authority for the largest single process; the
# sampler's is only the fallback (it can miss a process that lives < 1 s).
LARGEST_KB=$PEAK_PROC_KB
LARGEST_SRC="sampled"
if [ -r "$TIME_OUT" ]; then
  GNU_KB=$(awk -F': ' '/Maximum resident set size/ { print $2 + 0 }' "$TIME_OUT")
  if [ -n "$GNU_KB" ] && [ "$GNU_KB" -gt 0 ]; then
    LARGEST_KB=$GNU_KB
    LARGEST_SRC="time -v"
  fi
fi

PEAK_TREE_MB=$((PEAK_TREE_KB / 1024))
LARGEST_MB=$((LARGEST_KB / 1024))
if [ "$PEAK_CG_BYTES" -gt 0 ] 2>/dev/null; then
  PEAK_CG_MB=$((PEAK_CG_BYTES / 1048576))
  CG_CELL="${PEAK_CG_MB} MB"
else
  CG_CELL="n/a (no cgroup v2)"
fi
if [ -r "$CGROUP_PEAK" ]; then
  LIFETIME_MB=$(($(cat "$CGROUP_PEAK" 2>/dev/null || echo 0) / 1048576))
  CG_CELL="${CG_CELL} (container lifetime peak ${LIFETIME_MB} MB)"
fi

TOP5="n/a"
if [ -s "$STATE_DIR/peak_top5" ]; then
  TOP5=$(awk -F'\t' '{ printf "%s%d MB `%s`", (NR > 1 ? "<br>" : ""), $1 / 1024, $3 }' "$STATE_DIR/peak_top5")
fi

STATUS="ok"
if [ "$RC" -ne 0 ]; then STATUS="exit $RC"; fi
if [ "$PEAK_TREE_MB" -gt "$BUDGET_MB" ]; then STATUS="$STATUS, OVER BUDGET"; fi

ROW="| ${LABEL} | ${WALL} s | ${CG_CELL} | ${PEAK_TREE_MB} MB (budget ${BUDGET_MB}) | ${LARGEST_MB} MB (${LARGEST_SRC}) | ${TOP5} | ${STATUS} |"
HEADER="| step | wall | peak cgroup | peak tree RSS | largest process | top 5 at peak | status |"
SEP="| --- | ---: | --- | ---: | ---: | --- | --- |"

emit_summary() {
  printf '\n%s\n%s\n%s\n' "$HEADER" "$SEP" "$ROW"
}
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  emit_summary >>"$GITHUB_STEP_SUMMARY"
else
  emit_summary
fi
echo "mem-step: ${LABEL}: wall ${WALL}s, peak tree ${PEAK_TREE_MB} MB (budget ${BUDGET_MB}), largest process ${LARGEST_MB} MB, cgroup ${CG_CELL}, exit ${RC}"
# Top-5 must also land in the job log (not only GITHUB_STEP_SUMMARY): install
# attribution and overlapping nx tasks are diagnosed from log grep, and summary
# rows are easy to miss on cancelled/superseded runs.
if [ -s "$STATE_DIR/peak_top5" ]; then
  echo "mem-step: ${LABEL}: top-5 at peak:"
  awk -F'\t' '{ printf "mem-step:   %d MB  pid=%s  %s\n", $1 / 1024, $2, $3 }' "$STATE_DIR/peak_top5"
fi

rm -rf "$STATE_DIR"

if [ "$PEAK_TREE_MB" -gt "$BUDGET_MB" ]; then
  if [ "${MEM_BUDGET_ENFORCE:-0}" = "1" ]; then
    echo "::error::${LABEL}: peak tree RSS ${PEAK_TREE_MB} MB is over the ${BUDGET_MB} MB budget (MEM_BUDGET_ENFORCE=1)"
    if [ "$RC" -eq 0 ]; then exit 1; fi
  else
    echo "::warning::${LABEL}: peak tree RSS ${PEAK_TREE_MB} MB is over the ${BUDGET_MB} MB budget"
  fi
fi

exit "$RC"
