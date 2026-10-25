#!/usr/bin/env bash
# Copy a restored Nx 23 task database onto THIS machine's id.
#
# Nx names the file `.nx/workspace-data/<machine-id>-v3.db` (the machine-uid
# crate: /var/lib/dbus/machine-id, else /etc/machine-id; on macOS the
# IOPlatformUUID). actions/cache restores the previous runner's file under
# the previous id, and the new VM opens an empty database — the cache
# artifacts are then "unrecognized" and every task misses (D548).
#
# CAMSTACK_NX_MACHINE_ID overrides the id. CI leaves it unset. The spec sets it.
set -u

root="${1:-.}"
data="$root/.nx/workspace-data"
if [ ! -d "$data" ]; then
  echo "align-nx-db: no $data — cold cache"
  exit 0
fi

mid="${CAMSTACK_NX_MACHINE_ID:-}"
if [ -z "$mid" ]; then
  if [ "$(uname -s)" = "Darwin" ]; then
    mid=$(ioreg -rd1 -c IOPlatformExpertDevice | awk -F'"' '/IOPlatformUUID/{print $4; exit}')
  else
    if [ -r /var/lib/dbus/machine-id ]; then
      mid=$(tr -d '[:space:]' < /var/lib/dbus/machine-id)
    elif [ -r /etc/machine-id ]; then
      mid=$(tr -d '[:space:]' < /etc/machine-id)
    fi
  fi
fi
if [ -z "$mid" ]; then
  echo "align-nx-db: machine id unavailable — leaving the cache as restored"
  exit 0
fi

dest="$data/${mid}-v3.db"
if [ -f "$dest" ]; then
  echo "align-nx-db: $dest already present"
  exit 0
fi

shopt -s nullglob
candidates=("$data"/*-v*.db)
shopt -u nullglob
if [ "${#candidates[@]}" -eq 0 ]; then
  echo "align-nx-db: no restored *-v*.db"
  exit 0
fi

src="${candidates[0]}"
best_size=0
for c in "${candidates[@]}"; do
  size=$(wc -c < "$c" | tr -d ' ')
  if [ "$size" -gt "$best_size" ]; then
    best_size=$size
    src=$c
  fi
done

base=$(basename "$src" .db)
cp -a "$src" "$dest"
if [ -f "$data/${base}.db-wal" ]; then
  cp -a "$data/${base}.db-wal" "$data/${mid}-v3.db-wal"
fi
if [ -f "$data/${base}.db-shm" ]; then
  cp -a "$data/${base}.db-shm" "$data/${mid}-v3.db-shm"
fi
echo "align-nx-db: copied ${base}.db -> ${mid}-v3.db"
