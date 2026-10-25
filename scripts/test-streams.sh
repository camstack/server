#!/bin/bash
# Test stream options and restreamer registration.
# Usage: ./scripts/test-streams.sh

set -euo pipefail

BASE="http://localhost:4000"

echo "=== Authenticating ==="
TOKEN=$(curl -s "$BASE/trpc/admin.login" \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"json":{"username":"admin","password":"admin"}}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['data']['json']['token'])")
echo "OK"

echo ""
echo "=== Providers ==="
curl -s "$BASE/trpc/admin.listProviders" -H "Authorization: Bearer $TOKEN" \
  | python3 -c "
import json,sys
for p in json.load(sys.stdin)['result']['data']['json']:
    print(f\"  {p['id'][:8]}... {p['type']:15} {p['name']}\")
"

echo ""
echo "=== restreamer streams (unique names) ==="
curl -s "$BASE/trpc/streaming.status" -H "Authorization: Bearer $TOKEN" \
  | python3 -c "
import json,sys
data=json.load(sys.stdin)['result']['data']['json']
names=set()
dupes=[]
for s in data['streams']:
    n=s.get('restreamerName','?')
    if n in names: dupes.append(n)
    names.add(n)
print(f'  Total: {data[\"totalStreams\"]} | Unique restreamer names: {len(names)} | Duplicates: {len(dupes)}')
if dupes:
    print(f'  ⚠️  DUPLICATE NAMES: {dupes[:5]}')
"

# Test cameras for each provider
for PROVIDER_ID in $(curl -s "$BASE/trpc/admin.listProviders" -H "Authorization: Bearer $TOKEN" \
  | python3 -c "import json,sys; [print(p['id']) for p in json.load(sys.stdin)['result']['data']['json'] if p.get('enabled') and p['type'] in ('frigate','scrypted')]"); do

  PROVIDER_TYPE=$(curl -s "$BASE/trpc/admin.listProviders" -H "Authorization: Bearer $TOKEN" \
    | python3 -c "import json,sys; p=next(x for x in json.load(sys.stdin)['result']['data']['json'] if x['id']=='$PROVIDER_ID'); print(p['type'])")

  echo ""
  echo "=== $PROVIDER_TYPE (${PROVIDER_ID:0:8}...) — Camera stream options ==="
  
  curl -s "$BASE/trpc/cameras.list?input=$(python3 -c "import json,urllib.parse; print(urllib.parse.quote(json.dumps({'json':{'providerId':'$PROVIDER_ID'}})))")" \
    -H "Authorization: Bearer $TOKEN" \
    | python3 -c "
import json,sys
data=json.load(sys.stdin)['result']['data']['json']
for cam in data[:5]:
    opts=cam.get('streamOptions',[])
    print(f'  {cam[\"label\"] or cam[\"name\"]:35} ({len(opts)} options)')
    for o in opts:
        sn=o.get('streamName','(none)')
        print(f'    {o[\"id\"]:35} {o[\"method\"]:8} {sn}')
if len(data) > 5:
    print(f'  ... and {len(data)-5} more cameras')
"
done

echo ""
echo "=== Snapshot test ==="
for ENTRY in "ec2674aa-eae5-457d-9b22-2ca0701ceaba:dispensa" "69137f02-79aa-4825-9bc4-e300f7146ea8:298"; do
  IFS=":" read -r PID CAM <<< "$ENTRY"
  HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/snapshot/$PID/$CAM/latest.jpg" -H "Authorization: Bearer $TOKEN")
  echo "  $CAM: HTTP $HTTP"
done

echo ""
echo "=== Done ==="
