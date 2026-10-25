#!/bin/bash
set -e

# =============================================================================
# dev-agent-ui.sh — Start agent + agent-ui for local development
#
# The agent is the SAME @camstack/server booted with CAMSTACK_ROLE=agent
# (packages/agent no longer exists). This runs the launcher from src via tsx —
# mirroring the hub's `npm run serve` leg — plus the agent-ui Vite dev server.
#
# Usage:
#   npm run dev:agent-ui                              # discovery mode (no hub)
#   npm run dev:agent-ui -- --hub 192.168.x.x        # connect to hub
#   npm run dev:agent-ui -- --name test-agent         # custom name
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

HUB_IP=""
AGENT_NAME="dev-agent-ui"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hub)  HUB_IP="$2"; shift 2 ;;
    --name) AGENT_NAME="$2"; shift 2 ;;
    *)      shift ;;
  esac
done

cd "$ROOT_DIR"

# The tsx launcher imports the BUILT `@camstack/*` system-package dist. Build it
# once if missing so the first-run launcher doesn't crash on stale/absent dist.
if [ ! -d "packages/kernel/dist" ]; then
  echo "[dev-agent-ui] Building system packages..."
  npx nx run-many -t build \
    --projects='@camstack/types,@camstack/system,sdk,@camstack/ui-library' \
    --parallel=4
fi

# Hub connection is now env-driven (CAMSTACK_HUB_ADDRESS), not a --hub flag.
HUB_ENV=""
MODE="discovery"
if [ -n "$HUB_IP" ]; then
  HUB_ENV="CAMSTACK_HUB_ADDRESS=$HUB_IP"
  MODE="connected to $HUB_IP"
fi

echo ""
echo "  Agent UI Dev Mode"
echo "  ================="
echo "  Agent:    http://localhost:4444 (REST API)"
echo "  UI:       http://localhost:4446 (Vite dev)"
echo "  Mode:     $MODE"
echo "  Name:     $AGENT_NAME"
echo ""

npx concurrently \
  --kill-others \
  --names "agent,ui" \
  --prefix "[{name}]" \
  --prefix-colors "green,blue" \
  "CAMSTACK_ROLE=agent CAMSTACK_AGENT_NAME=$AGENT_NAME CAMSTACK_STATUS_PORT=4444 ${HUB_ENV} npx tsx server/backend/src/launcher.ts" \
  "npm run dev -w packages/addon-agent-ui"
