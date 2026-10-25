#!/bin/bash
# rollout.sh <serverVersion> <pubListFile|-> [--skip-dev50]
# .50 is a hard gate: unconfirmed or fallen over → stop before the hub.
# Operator script (2026-10-18). ROLLOUT_HUB / ROLLOUT_DEV are required. After each
# node: caps registered AND every runner up on the expected version
# (scripts/hub/check-node-runners.ts). The dev gate retries the apply 3x: the npm
# registry often lags a fresh publish by 5+ minutes.
cd "$(git rev-parse --show-toplevel)" || exit 1
SV="$1"; PUBFILE="$2"; SKIP50="$3"
: "${ROLLOUT_HUB:?set ROLLOUT_HUB=https://<hub>:<port>}" "${ROLLOUT_DEV:?set ROLLOUT_DEV=https://<dev-hub>:<port>}"
HUB=(node scripts/hub/hub.mjs --server "$ROLLOUT_HUB")
DEV=(node scripts/hub/hub.mjs --server "$ROLLOUT_DEV")

ver() { # ver <hub|dev50|nodeId>
  local out
  case "$1" in
    dev50) out=$("${DEV[@]}" GET serverManagement.getServerPackageStatus 2>/dev/null) ;;
    hub)   out=$("${HUB[@]}" GET serverManagement.getServerPackageStatus 2>/dev/null) ;;
    *)     out=$("${HUB[@]}" GET serverManagement.getServerPackageStatus "{\"nodeId\":\"$1\"}" 2>/dev/null) ;;
  esac
  printf '%s' "$out" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('runningVersion'),d.get('rolledBack'))" 2>/dev/null
}
waitv() { local v; for _ in $(seq 1 90); do v=$(ver "$1"); case "$v" in "$SV "*) echo "$v"; return 0;; esac; sleep 20; done; echo "last=$v"; return 1; }
capsok() { "${HUB[@]}" GET capabilities.getCapability '{"name":"pipeline-runner"}' 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin); have={p['nodeId'] for p in d.get('perNode',[])}
miss=sorted({'hub','agent-a','agent-mac.localdomain','agent-b'}-have); print('caps missing:',miss if miss else 'none'); sys.exit(1 if miss else 0)"; }

if [ "$SKIP50" != "--skip-dev50" ]; then
  for t in 1 2 3; do
    a=$("${DEV[@]}" POST serverManagement.applyServerUpdate "{\"version\":\"$SV\"}" 2>&1 | tr -d "\n" | head -c 300)
    echo "dev50 apply #$t: $a" | cut -c1-200
    case "$a" in *'"accepted": true'*|*'"accepted":true'*) break;; esac; sleep 60
  done
  r=$(waitv dev50) && echo "dev50 -> $r" || { echo "dev50 NOT CONFIRMED ($r) — stopping before the hub"; exit 1; }
fi
sleep 60; r=$(ver dev50); case "$r" in "$SV "*) echo "dev50 still $r";; *) echo "dev50 fell over ($r) — stopping"; exit 1;; esac

for n in hub agent-a agent-mac.localdomain agent-b; do
  if [ "$n" = hub ]; then body="{\"version\":\"$SV\"}"; else body="{\"version\":\"$SV\",\"nodeId\":\"$n\"}"; fi
  "${HUB[@]}" POST serverManagement.applyServerUpdate "$body" >/dev/null 2>&1
  if r=$(waitv "$n"); then echo "$n -> $r"; else
    echo "$n retry"; sleep 30; "${HUB[@]}" POST serverManagement.applyServerUpdate "$body" >/dev/null 2>&1
    r=$(waitv "$n") && echo "$n -> $r (retry)" || { echo "$n FAILED ($r) — stopping"; exit 1; }
  fi
  sleep 90; capsok || { sleep 150; capsok || { echo "CAPLESS after $n — stopping"; exit 1; }; }
  if [ "$n" = hub ]; then na=(); else na=(--node "$n"); fi
  ok=0; for t in 1 2 3 4 5 6; do
    if out=$(npx tsx scripts/hub/check-node-runners.ts --server "$ROLLOUT_HUB" "${na[@]}" --expect-version "$SV" 2>&1); then ok=1; break; fi
    case "$out" in *"not run yet"*|*pending*) sleep 30;; *) break;; esac
  done
  echo "$out" | tail -3
  [ $ok = 1 ] || { echo "RUNNERS NOT ALL UP on $n — stopping"; exit 1; }
done

if [ "$PUBFILE" != "-" ] && [ -f "$PUBFILE" ]; then
  for line in $(grep -oE "@camstack/addon-[a-z0-9-]+@[0-9.]+" "$PUBFILE" | grep -v device-history); do
    n=$(echo "$line" | cut -d@ -f2 | cut -d/ -f2); v=$(echo "$line" | cut -d@ -f3)
    "${DEV[@]}" POST addons.updatePackage "{\"name\":\"@camstack/$n\",\"version\":\"$v\"}" >/dev/null 2>&1
    "${HUB[@]}" POST addons.updatePackage "{\"name\":\"@camstack/$n\",\"version\":\"$v\"}" >/dev/null 2>&1
    echo "updatePackage $n $v"
  done
  sleep 120; capsok
fi
echo "rollout $SV done"
