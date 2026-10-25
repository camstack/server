#!/bin/bash
set -e

# ============================================================================
# dev.sh — CamStack development server with optional agent(s)
#
# Usage:
#   npm run dev                       # Hub + admin UI + 2 agents (default)
#   npm run dev -- --server           # Hub + admin UI only (no agents)
#   npm run dev -- --agent            # Hub + admin UI + 1 agent
#   npm run dev -- --agent 2          # Hub + admin UI + 2 agents
#   npm run dev -- --agent --watch    # Hub + admin UI + agent + package watchers
#
# Cleaning (idempotent — runs BEFORE anything starts):
#   Default             : preserve every node's state (DB, logs, TLS, addons).
#                         Operator-installed addons survive across restarts.
#                         (Was "wipe addons/" — changed because the relink
#                         step missed addons not in the foundational set,
#                         silently dropping operator-installed providers.)
#   --clean-addons      : wipe each node's `<data>/addons/` so the launcher
#                         re-links from the workspace. Use to test the
#                         install-from-clean-slate path. Persists DB/logs/tls.
#   --clean             : wipe the entire camstack-data dir for hub AND each
#                         agent (DB, logs, TLS, config.yaml, everything).
#                         Equivalent to "fresh install".
#   --no-clean          : alias for the new default — kept for muscle-memory.
#
# Data directories configured in server/backend/.env:
#   CAMSTACK_DATA=camstack-data              (hub)
#   CAMSTACK_AGENT_1_DATA=camstack-agent-1-data  (agent 1)
# ============================================================================

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

BACKEND_DIR="server/backend"

AGENT_COUNT=2
WATCH=false
# Default is now "none" — preserve addons/ symlinks across restarts so
# operators don't lose addons they installed via the UI (the AddonRegistry
# tracks integrations in the DB; without the addon symlink in place at
# boot, those integrations show up as "missing" and disappear from the UI).
# Pass --clean-addons to restore the previous wipe-and-relink default,
# --clean for a full data-dir wipe (DB+logs+tls+addons).
CLEAN_MODE="none"   # "addons" | "full" | "none"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent)
      AGENT_COUNT=1
      if [[ "${2:-}" =~ ^[0-9]+$ ]]; then
        AGENT_COUNT="$2"
        shift
      fi
      shift
      ;;
    --server)
      AGENT_COUNT=0
      shift
      ;;
    --watch)
      WATCH=true
      shift
      ;;
    --clean)
      CLEAN_MODE="full"
      shift
      ;;
    --clean-addons)
      # Wipe each node's `addons/` so the launcher re-links from workspace.
      # Was the legacy default; now opt-in to avoid losing operator-installed
      # addons. Use when testing partial-install regressions.
      CLEAN_MODE="addons"
      shift
      ;;
    --no-clean)
      # Kept for backwards compat — same as the new default.
      CLEAN_MODE="none"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

# ----------------------------------------------------------------------------
# Kill any prior CamStack processes BEFORE we start. Stale launchers and
# forked workers hold ports (4443 HTTPS, 6000 Moleculer TCP transport, 8554
# RTSP restream) and the apple-sound-classifier binary — leaving them
# running causes `EADDRINUSE`, duplicate native-cap registrations, and
# zombie RTSP entries. This is idempotent: nothing to kill → no-op.
# ----------------------------------------------------------------------------
echo "[dev] killing any prior camstack processes (launchers, workers, sound-classifier)"
pkill -9 -f "tsx.*camstack-server.*launcher" 2>/dev/null || true
pkill -9 -f "packages/kernel/dist/process-runner" 2>/dev/null || true
pkill -9 -f "apple-sound-classifier" 2>/dev/null || true
pkill -9 -f "server/backend/dist/launcher" 2>/dev/null || true
# Give the OS a beat to release the ports.
sleep 1
# If anything is still holding the hub ports (e.g. a non-tsx process), force
# it out — better to fail loudly than confuse the next run with port reuse.
for port in 4443 6000 8554; do
  pids=$(lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "[dev]   port :${port} still held by PID(s) ${pids} — force-killing"
    kill -9 $pids 2>/dev/null || true
  fi
done

# Read .env file for data directory paths
ENV_FILE="${BACKEND_DIR}/.env"
get_env() {
  grep "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2 | tr -d '"' | tr -d "'"
}

# ----------------------------------------------------------------------------
# Clean node data dirs per --clean-mode
# ----------------------------------------------------------------------------
HUB_DATA="$(get_env CAMSTACK_DATA)"
[ -z "$HUB_DATA" ] && HUB_DATA="camstack-data"
HUB_DATA_PATH="${BACKEND_DIR}/${HUB_DATA}"

# Collect all node data paths (hub + any agent the user might spin up).
# We clean agents 0..N-1 based on AGENT_COUNT, plus wipe any lingering
# agent-*-data dirs so stale state doesn't leak between runs.
NODE_DATA_PATHS=("$HUB_DATA_PATH")
shopt -s nullglob
for lingering in "${BACKEND_DIR}"/camstack-agent-*-data; do
  NODE_DATA_PATHS+=("$lingering")
done
shopt -u nullglob
# Also include explicitly declared agent slots (even if dir not yet created)
for i in $([ "$AGENT_COUNT" -gt 0 ] && seq 0 $((AGENT_COUNT - 1))); do
  AGENT_DATA_VAR="CAMSTACK_AGENT_${i}_DATA"
  AGENT_DATA="$(get_env "$AGENT_DATA_VAR")"
  [ -z "$AGENT_DATA" ] && AGENT_DATA="camstack-agent-${i}-data"
  AGENT_PATH="${BACKEND_DIR}/${AGENT_DATA}"
  if [[ ! " ${NODE_DATA_PATHS[*]} " =~ " ${AGENT_PATH} " ]]; then
    NODE_DATA_PATHS+=("$AGENT_PATH")
  fi
done

case "$CLEAN_MODE" in
  full)
    echo "[dev] --clean: wiping entire camstack-data dir on every node"
    for p in "${NODE_DATA_PATHS[@]}"; do
      if [ -d "$p" ]; then
        echo "[dev]   rm -rf $p"
        rm -rf "$p"
      fi
    done
    ;;
  addons)
    echo "[dev] cleaning addons/ on every node + wiping agent data dirs (default)"
    for p in "${NODE_DATA_PATHS[@]}"; do
      if [ "$p" = "$HUB_DATA_PATH" ]; then
        # Hub: only remove addons/ (preserve DB/logs/tls)
        if [ -d "$p/addons" ]; then
          echo "[dev]   rm -rf $p/addons"
          rm -rf "$p/addons"
        fi
      else
        # Agent: wipe entire data dir (fresh start each run)
        if [ -d "$p" ]; then
          echo "[dev]   rm -rf $p (agent fresh start)"
          rm -rf "$p"
        fi
      fi
    done
    ;;
  none)
    echo "[dev] --no-clean: preserving all node state (addons included)"
    ;;
esac

# ----------------------------------------------------------------------------
# Fresh-dist guarantee — runs in BOTH watch and non-watch mode.
#
# The kernel and every forked runner/agent import system packages and addons
# from their built `./dist/` JS, NOT from `src/`. dev-watch-packages.sh only
# builds types+kernel and the per-addon tsup entries — it never builds core,
# sdk, ui-library, or agent, and its watchers do their initial build
# CONCURRENTLY with (not before) the server boot. So without a blocking
# pre-build the hub + agents start against whatever STALE dist is on disk —
# the root cause of the agent registerNode storm and the degraded-agent
# dispatch hangs. We force a fresh build before anything boots.
#
# Two tiers:
#   1. System packages + agent — BLOCKING. A stale/broken system package
#      corrupts the whole cluster, so a failed build aborts the boot (exit 1).
#   2. Addons — best-effort. One broken addon (e.g. addon-broken-fixture, a
#      deliberate test artifact) must not wedge the entire dev environment.
#
# NB: Nx project ids carry the `@camstack/` scope (`sdk` is the lone
# exception). The previous `'types,kernel,sdk,ui-library,addon-*'` glob
# silently matched ZERO addons and omitted core entirely.
# ----------------------------------------------------------------------------
echo "[dev] Building system packages (blocking — Nx cache, ~1-2s warm)..."
npx nx run-many -t build \
  --projects='@camstack/types,@camstack/system,sdk,@camstack/ui-library' \
  --output-style=stream \
  --parallel=4 || {
    echo "[dev] FATAL: a system package failed to build — refusing to boot on stale dist." >&2
    echo "[dev]        Fix the error above (or run 'npx nx run-many -t build' for detail) and retry." >&2
    exit 1
  }

# Agents are now the SAME @camstack/server as the hub, booted with
# CAMSTACK_ROLE=agent — `packages/agent` no longer exists. Dev agents run the
# BUILT `server/backend/dist/launcher.js` (no watch, matching the old agent
# semantics), so we must produce a fresh server dist before spawning them. The
# hub leg itself boots from src via `tsx watch` (npm run serve), so it does NOT
# build this dist — hence a blocking build here, gating agent boot on success.
if [ "$AGENT_COUNT" -gt 0 ]; then
  echo "[dev] Building server dist (blocking — agents boot from server/backend/dist/launcher.js)..."
  npm run build -w "${BACKEND_DIR}" || {
    echo "[dev] FATAL: server build failed — refusing to boot agents on stale dist." >&2
    exit 1
  }
fi

echo "[dev] Building addon dist/ (best-effort — Nx cache, ~1-2s warm)..."
npx nx run-many -t build \
  --projects='@camstack/addon-*' \
  --exclude='@camstack/addon-broken-fixture' \
  --output-style=stream \
  --parallel=4 || {
    echo "[dev] WARNING: one or more addons failed to build — server will load their last-good dist." >&2
    echo "[dev]          Run 'npx nx run-many -t build --projects=@camstack/addon-*' to see which." >&2
  }

# Base processes: server + admin UI
NAMES="server,admin"
COLORS="blue,magenta"
# No cluster secret through env (D797): a dev hub leaves System → Cluster
# empty, so its gate is off; set one there (and in each agent's agent.json)
# to exercise the gate.

# Install source is now `npm` everywhere (symlink mode removed). Local
# development pushes addons via `camstack deploy <pkg>` after build —
# no automation, no symlinks. See AddonInstaller / install-source-policy.
COMMANDS=(
  "npm run serve -w ${BACKEND_DIR}"
  "npm run dev -w packages/addon-admin-ui"
)

# Optional: package watchers
if [ "$WATCH" = true ]; then
  NAMES="watch,${NAMES}"
  COLORS="yellow,${COLORS}"
  COMMANDS=("bash scripts/dev-watch-packages.sh" "sleep 5 && ${COMMANDS[0]}" "${COMMANDS[1]}")
  COMMANDS[0]="bash scripts/dev-watch-packages.sh"
fi

# Optional: agents — the SAME @camstack/server booted with CAMSTACK_ROLE=agent.
# Last agent starts WITHOUT hub address (discovery mode) so we can
# test the autonomous boot + UI config flow. All others get explicit hub.
for i in $([ "$AGENT_COUNT" -gt 0 ] && seq 0 $((AGENT_COUNT - 1))); do
  AGENT_NAME="dev-agent-${i}"

  # Read agent data dir from .env: CAMSTACK_AGENT_{i}_DATA
  AGENT_DATA_VAR="CAMSTACK_AGENT_${i}_DATA"
  AGENT_DATA="$(get_env "$AGENT_DATA_VAR")"
  [ -z "$AGENT_DATA" ] && AGENT_DATA="camstack-agent-${i}-data"

  # Path relative to server/backend/ (same as hub's CAMSTACK_DATA)
  AGENT_DATA_PATH="${BACKEND_DIR}/${AGENT_DATA}"

  NAMES="${NAMES},agent-${i}"
  AGENT_STATUS_PORT=$((4444 + i))
  # CAMSTACK_ROLE=agent selects the agent runtime; CAMSTACK_DATA is the per-agent
  # data dir (the old CAMSTACK_DATA_DIR is dead — agent-config.ts reads CAMSTACK_DATA).
  AGENT_ENV="CAMSTACK_ROLE=agent CAMSTACK_NODE_ID=${AGENT_NAME} CAMSTACK_DATA=${AGENT_DATA_PATH} CAMSTACK_STATUS_PORT=${AGENT_STATUS_PORT}"

  LAST_AGENT_INDEX=$((AGENT_COUNT - 1))
  if [ "$i" -eq "$LAST_AGENT_INDEX" ]; then
    # Last agent: discovery mode (no hub address — must configure from UI)
    COLORS="${COLORS},yellow"
    COMMANDS+=("sleep 5 && ${AGENT_ENV} node server/backend/dist/launcher.js")
  else
    # Other agents: explicit hub connection
    COLORS="${COLORS},green"
    AGENT_ENV="${AGENT_ENV} CAMSTACK_HUB_ADDRESS=localhost"
    COMMANDS+=("sleep 5 && ${AGENT_ENV} node server/backend/dist/launcher.js")
  fi
done

# Agent UI dev server (Vite) — proxies to the LAST agent (discovery mode)
if [ "$AGENT_COUNT" -gt 0 ]; then
  DISCOVERY_AGENT_PORT=$((4444 + AGENT_COUNT - 1))
  NAMES="${NAMES},agent-ui"
  COLORS="${COLORS},cyan"
  # Override Vite proxy target to the discovery agent's port
  COMMANDS+=("sleep 8 && VITE_AGENT_PORT=${DISCOVERY_AGENT_PORT} npm run dev -w packages/addon-agent-ui")
fi

LOG_FILE="${BACKEND_DIR}/log.txt"

echo ""
echo "  CamStack Dev"
echo "  ============"
echo "  Processes: ${NAMES}"
echo "  Clean:     ${CLEAN_MODE}"
echo "  Log file:  ${LOG_FILE} (truncated)"
[ "$AGENT_COUNT" -gt 0 ] && echo "  Agents:    ${AGENT_COUNT}"
[ "$AGENT_COUNT" -gt 0 ] && echo "  Agent UI:  http://localhost:4446 (→ agent-$((AGENT_COUNT-1)) discovery mode)"
echo ""

# Truncate + ensure parent dir exists so tee always writes to a fresh file.
mkdir -p "$(dirname "$LOG_FILE")"
: > "$LOG_FILE"

# `tee` mirrors stdout+stderr to both the terminal and the log file.
# `pipefail` keeps the concurrently exit code; Ctrl-C propagates through
# the pipeline so `-k` still kills the child processes.
set -o pipefail
npx concurrently -k -n "$NAMES" -c "$COLORS" "${COMMANDS[@]}" 2>&1 | tee "$LOG_FILE"
