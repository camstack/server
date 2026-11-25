#!/usr/bin/env bash
# Deploy an addon to a CamStack server: a thin wrapper over `camstack deploy`.
# Usage: ./scripts/deploy-addon.sh [--server URL] [path-to-addon]
#
# The credential is the `camstack login` session (D1101): run
# `camstack login <host>` once, interactively. There is no token flag, no
# $CAMSTACK_TOKEN and no ~/.camstackrc.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_ARGS=()
ADDON_PATH=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --server) SERVER_ARGS=(--server "$2"); shift 2 ;;
    --token|--token-file)
      echo "Error: $1 was removed. Run 'camstack login <host>' once, interactively; every tool then uses that session." >&2
      exit 1
      ;;
    --help|-h)
      echo "Usage: $0 [--server URL] [path-to-addon]"
      echo ""
      echo "  --server URL   Hub address (default: the cached login session)"
      echo ""
      echo "Runs 'camstack deploy <path>' (build, pack, upload). Path defaults to the"
      echo "current directory. Authentication is the 'camstack login' session."
      exit 0
      ;;
    *) ADDON_PATH="$1"; shift ;;
  esac
done

ADDON_PATH="${ADDON_PATH:-.}"

LOCAL_CLI="$REPO_ROOT/packages/cli/dist/cli.js"
if [ -f "$LOCAL_CLI" ]; then
  CAMSTACK_CMD=(node "$LOCAL_CLI")
elif command -v camstack >/dev/null 2>&1; then
  CAMSTACK_CMD=(camstack)
else
  echo "Error: no camstack CLI. Build it (npm run build -w packages/cli) or install it." >&2
  exit 1
fi

exec "${CAMSTACK_CMD[@]}" deploy "$ADDON_PATH" ${SERVER_ARGS[@]+"${SERVER_ARGS[@]}"}
