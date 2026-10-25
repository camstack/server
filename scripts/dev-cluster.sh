#!/bin/bash
set -e

# ============================================================================
# dev-cluster.sh — Start a CamStack hub + local agent in one terminal
#
# Usage:
#   npm run dev:cluster                    # Hub + 1 agent
#   npm run dev:cluster -- --agents 2      # Hub + 2 agents
#   npm run dev:cluster -- --no-agent      # Hub only (same as dev:server)
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Defaults
HUB_PORT="${CAMSTACK_PORT:-4443}"
HUB_DATA="${CAMSTACK_DATA:-camstack-data}"
AGENT_COUNT=1
NO_AGENT=false
DEV_TOKEN="dev-local-$(date +%s | shasum | head -c 12)"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --agents)
      AGENT_COUNT="$2"
      shift 2
      ;;
    --no-agent)
      NO_AGENT=true
      shift
      ;;
    --port)
      HUB_PORT="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: dev-cluster.sh [--agents N] [--no-agent] [--port PORT]"
      exit 1
      ;;
  esac
done

echo ""
echo "  CamStack Dev Cluster"
echo "  ===================="
echo "  Hub:    https://localhost:${HUB_PORT}"
echo "  Agents: ${AGENT_COUNT}"
echo "  Token:  ${DEV_TOKEN}"
echo ""

cd "$ROOT_DIR"

# Build everything first
echo "[dev-cluster] Building packages..."
npm run build 2>/dev/null || {
  echo "[dev-cluster] Build failed — run 'npm run build' manually to see errors"
  exit 1
}

if [ "$NO_AGENT" = true ]; then
  # Hub only
  exec node server/backend/dist/main.js
fi

# Build concurrently arguments as an array
CONCURRENTLY_ARGS=(
  --kill-others
  --prefix "[{name}]"
  --prefix-colors "blue"
)

NAMES="hub"

# Hub command
COMMANDS=("CAMSTACK_PORT=${HUB_PORT} CAMSTACK_DATA=${HUB_DATA} node server/backend/dist/main.js")

# Agent commands
for i in $(seq 1 "$AGENT_COUNT"); do
  AGENT_NAME="dev-agent-${i}"
  AGENT_DATA="${HUB_DATA}-agent-${i}"

  COMMANDS+=("sleep 3 && CAMSTACK_MODE=agent CAMSTACK_HUB_URL=wss://127.0.0.1:${HUB_PORT}/agent CAMSTACK_HUB_TOKEN=${DEV_TOKEN} CAMSTACK_AGENT_NAME=${AGENT_NAME} CAMSTACK_DATA=${AGENT_DATA} node server/backend/dist/main.js")
  NAMES="${NAMES},agent-${i}"
  CONCURRENTLY_ARGS+=(--prefix-colors "green")
done

CONCURRENTLY_ARGS+=(--names "$NAMES")

# Execute concurrently with each command as a separate positional argument
exec npx concurrently "${CONCURRENTLY_ARGS[@]}" "${COMMANDS[@]}"
