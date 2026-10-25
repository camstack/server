#!/usr/bin/env bash
# hunt-zombies.sh — detect (and optionally kill) leaked camstack process trees.
#
# A camstack tree is "leaked" when its top-level ancestor (npm run serve /
# tsx watch src/launcher.ts) has PPID=1 (reparented to init), meaning the
# terminal/shell died without cleanly shutting down the server.
#
# Usage:
#   scripts/hunt-zombies.sh              # dry-run: list leaks
#   scripts/hunt-zombies.sh --kill       # SIGTERM leaks, SIGKILL survivors after 3s
#   scripts/hunt-zombies.sh --wide       # also flag duplicate chroma-mcp / inference_pool instances
#   scripts/hunt-zombies.sh --kill --wide
#
# Exit codes:
#   0 — no leaks
#   1 — leaks found (dry-run) or kill failed
set -euo pipefail

KILL=0
WIDE=0
for arg in "$@"; do
  case "$arg" in
    --kill) KILL=1 ;;
    --wide) WIDE=1 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# Find camstack launcher roots (tsx watch src/launcher.ts, npm run serve for camstack).
# A leak = top ancestor with PPID=1 (orphaned).
LEAK_PGIDS=()
while IFS= read -r line; do
  [ -n "$line" ] && LEAK_PGIDS+=("$line")
done < <(
  ps -eo pid,ppid,pgid,command | \
    awk '/tsx watch .*src\/launcher\.ts/ && !/awk/ {
      pid=$1; ppid=$2; pgid=$3;
      print pid" "ppid" "pgid
    }' | \
    while read -r pid ppid pgid; do
      # Walk up to top ancestor
      cur=$pid
      while :; do
        parent=$(ps -p "$cur" -o ppid= 2>/dev/null | tr -d ' ')
        [ -z "$parent" ] && break
        [ "$parent" = "1" ] && { echo "$pgid"; break; }
        cur=$parent
      done
    done | sort -u
)

ACTIVE_PGID=""
# Preserve the newest (highest PID in each PGID group) as "active" only if its
# root has a non-init parent — skip this; if we got here, all are orphans.

if [ ${#LEAK_PGIDS[@]} -eq 0 ]; then
  echo "[hunt-zombies] No orphaned camstack trees found."
else
  echo "[hunt-zombies] Found ${#LEAK_PGIDS[@]} orphaned camstack tree(s):"
  for pgid in "${LEAK_PGIDS[@]}"; do
    echo "  --- PGID $pgid ---"
    ps -eo pid,ppid,pgid,etime,pcpu,pmem,command | awk -v p="$pgid" '$3==p' | sed 's/^/    /'
  done
fi

if [ "$WIDE" = "1" ]; then
  # Chroma-MCP duplicates — flag if more than 1 pair under same parent.
  CHROMA_PAIRS=$(ps -eo pid,ppid,command | awk '/chroma-mcp/ && /uv tool uvx/ && !/awk/ {print $2}' | sort | uniq -c | awk '$1>1')
  if [ -n "$CHROMA_PAIRS" ]; then
    echo ""
    echo "[hunt-zombies --wide] Duplicate chroma-mcp under same parent (claude-mem plugin leak):"
    echo "$CHROMA_PAIRS"
  fi
  # inference_pool.py duplicates — each camstack tree should have at most 1.
  INFPOOL_PER_TREE=$(ps -eo ppid,command | awk '/inference_pool\.py/ && !/awk/ {print $1}' | sort | uniq -c | awk '$1>1')
  if [ -n "$INFPOOL_PER_TREE" ]; then
    echo ""
    echo "[hunt-zombies --wide] Multiple inference_pool.py under same parent (detection-pipeline leak):"
    echo "$INFPOOL_PER_TREE"
  fi
fi

if [ ${#LEAK_PGIDS[@]} -eq 0 ]; then
  exit 0
fi

if [ "$KILL" != "1" ]; then
  echo ""
  echo "[hunt-zombies] Dry-run. Re-run with --kill to terminate."
  exit 1
fi

echo ""
echo "[hunt-zombies] Sending SIGTERM to leaked groups..."
for pgid in "${LEAK_PGIDS[@]}"; do
  kill -TERM "-$pgid" 2>/dev/null || true
done
sleep 3
echo "[hunt-zombies] Escalating to SIGKILL for survivors..."
for pgid in "${LEAK_PGIDS[@]}"; do
  if ps -eo pgid= | awk -v p="$pgid" '$1==p' | grep -q .; then
    kill -KILL "-$pgid" 2>/dev/null || true
  fi
done
sleep 1
REMAINING=0
for pgid in "${LEAK_PGIDS[@]}"; do
  if ps -eo pgid= | awk -v p="$pgid" '$1==p' | grep -q .; then
    echo "[hunt-zombies] WARNING: PGID $pgid still has survivors"
    REMAINING=$((REMAINING + 1))
  fi
done
[ "$REMAINING" -eq 0 ] && { echo "[hunt-zombies] Clean."; exit 0; } || exit 1
