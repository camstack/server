#!/bin/bash
set -e

# ============================================================================
# dev-agent-only.sh — Start just an agent that connects to a running hub
#
# Usage:
#   npm run dev:agent                                      # Connect to local hub
#   npm run dev:agent -- --hub 192.168.x.x               # Connect to remote hub
#   npm run dev:agent -- --hub 192.168.x.x --token xxx   # With auth token
#   npm run dev:agent -- --name "gpu-box"                  # Custom name
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Defaults
HUB_IP="127.0.0.1"
HUB_PORT="${CAMSTACK_PORT:-4443}"
TOKEN="${CAMSTACK_HUB_TOKEN:-dev-local}"
AGENT_NAME=""
AGENT_DATA="camstack-data-agent"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub)
      HUB_IP="$2"
      shift 2
      ;;
    --port)
      HUB_PORT="$2"
      shift 2
      ;;
    --token)
      TOKEN="$2"
      shift 2
      ;;
    --name)
      AGENT_NAME="$2"
      shift 2
      ;;
    --data)
      AGENT_DATA="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: dev-agent-only.sh [--hub IP] [--port PORT] [--token TOKEN] [--name NAME] [--data PATH]"
      exit 1
      ;;
  esac
done

# Default name: hostname-arch
if [ -z "$AGENT_NAME" ]; then
  AGENT_NAME="$(hostname)-$(uname -m)"
fi

echo "[dev-agent] Connecting to hub at wss://${HUB_IP}:${HUB_PORT}/agent"
echo "[dev-agent] Agent name: ${AGENT_NAME}"
echo "[dev-agent] Data dir: ${AGENT_DATA}"
echo ""

cd "$ROOT_DIR"

# Build if needed
if [ ! -f server/backend/dist/main.js ]; then
  echo "[dev-agent] Building..."
  npm run build 2>/dev/null
fi

exec env \
  CAMSTACK_MODE=agent \
  CAMSTACK_HUB_URL="wss://${HUB_IP}:${HUB_PORT}/agent" \
  CAMSTACK_HUB_TOKEN="${TOKEN}" \
  CAMSTACK_AGENT_NAME="${AGENT_NAME}" \
  CAMSTACK_DATA="${AGENT_DATA}" \
  node server/backend/dist/main.js
