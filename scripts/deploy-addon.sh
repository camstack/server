#!/usr/bin/env bash
# Deploy an addon to a CamStack server
# Usage: ./scripts/deploy-addon.sh [--server URL] [--token TOKEN] [path-to-addon]
#
# If no path given, builds the current directory and deploys.
# If no server/token given, reads from env vars or ~/.camstackrc.

set -e

SERVER="${CAMSTACK_SERVER:-http://localhost:4443}"
TOKEN="${CAMSTACK_TOKEN:-}"
ADDON_PATH=""

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --server) SERVER="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 [--server URL] [--token TOKEN] [path-to-addon-or-tgz]"
      echo ""
      echo "Options:"
      echo "  --server URL    CamStack server URL (default: \$CAMSTACK_SERVER or http://localhost:4443)"
      echo "  --token TOKEN   Auth token (default: \$CAMSTACK_TOKEN or from ~/.camstackrc)"
      echo ""
      echo "If path is a directory with package.json, runs 'npm pack' first."
      echo "If path is a .tgz file, uploads it directly."
      echo "If no path given, uses current directory."
      exit 0
      ;;
    *) ADDON_PATH="$1"; shift ;;
  esac
done

# Default addon path to current directory
ADDON_PATH="${ADDON_PATH:-.}"

# Read from ~/.camstackrc if no token
if [ -z "$TOKEN" ] && [ -f "$HOME/.camstackrc" ]; then
  # shellcheck source=/dev/null
  source "$HOME/.camstackrc"
fi

if [ -z "$TOKEN" ]; then
  echo "Error: No token. Set CAMSTACK_TOKEN, use --token, or create ~/.camstackrc with CAMSTACK_TOKEN=..."
  exit 1
fi

# Build tgz if path is a directory with package.json
if [ -d "$ADDON_PATH" ] && [ -f "$ADDON_PATH/package.json" ]; then
  echo "Packing addon from $ADDON_PATH..."
  (cd "$ADDON_PATH" && npm pack --quiet)
  TGZ=$(ls -t "$ADDON_PATH"/*.tgz 2>/dev/null | head -1)
  CLEANUP_TGZ=1
elif [ -f "$ADDON_PATH" ]; then
  TGZ="$ADDON_PATH"
  CLEANUP_TGZ=0
else
  echo "Error: '$ADDON_PATH' is neither a directory with package.json nor a .tgz file"
  exit 1
fi

if [ ! -f "$TGZ" ]; then
  echo "Error: No .tgz file found"
  exit 1
fi

echo "Deploying $(basename "$TGZ") to $SERVER..."

# Upload
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@$TGZ" \
  "$SERVER/api/addons/upload")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

# Cleanup tgz if we built it
if [ "$CLEANUP_TGZ" = "1" ]; then
  rm -f "$TGZ"
fi

# Pretty-print response
echo "$BODY" | python3 -m json.tool 2>/dev/null || echo "$BODY"

# Exit with error if non-2xx
if [[ "$HTTP_CODE" -lt 200 || "$HTTP_CODE" -ge 300 ]]; then
  echo "Error: Server returned HTTP $HTTP_CODE"
  exit 1
fi

echo "Done."
