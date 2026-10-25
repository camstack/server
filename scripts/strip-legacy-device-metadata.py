#!/usr/bin/env python3
"""
Strip the legacy `metadata` field from every entry in the
`device-manager.deviceMeta` blob.

The hardware-identity metadata now lives in a sibling row
`device-manager.deviceMetadata` (Record<deviceKey, DeviceMetadata>),
written exclusively by `setMetadata`. The pre-separation
`PersistedDeviceMeta.metadata` field is no longer read or written by
the runtime — this script removes any leftover values so the row stays
clean and forward-compatible.

Server MUST be stopped before running.
"""
import json
import sqlite3
import sys

DB = "server/backend/camstack-data/addons-data/sqlite-settings/camstack.db"
SETTINGS_TABLE = "addon-settings"
META_KEY = "device-manager.deviceMeta"


def main() -> None:
    conn = sqlite3.connect(DB)
    conn.isolation_level = None
    conn.execute("BEGIN")
    try:
        cur = conn.execute(
            f'SELECT data FROM "{SETTINGS_TABLE}" WHERE id = ?',
            (META_KEY,),
        )
        row = cur.fetchone()
        if not row:
            print(f"no {META_KEY} row — nothing to strip")
            conn.execute("COMMIT")
            return
        wrapper = json.loads(row[0])
        meta = wrapper.get("value", {})
        if not isinstance(meta, dict):
            print(f"unexpected wrapper shape: {wrapper!r}")
            conn.execute("ROLLBACK")
            sys.exit(1)

        stripped = 0
        for key, entry in meta.items():
            if isinstance(entry, dict) and "metadata" in entry:
                del entry["metadata"]
                stripped += 1

        if stripped == 0:
            print("no legacy metadata fields to strip — already clean")
            conn.execute("COMMIT")
            return

        wrapper["value"] = meta
        conn.execute(
            f'INSERT OR REPLACE INTO "{SETTINGS_TABLE}" (id, data) VALUES (?, ?)',
            (META_KEY, json.dumps(wrapper)),
        )
        conn.execute("COMMIT")
        print(f"✓ stripped legacy `metadata` field from {stripped} entries")
    except Exception as exc:
        conn.execute("ROLLBACK")
        print(f"! rolled back: {exc}", file=sys.stderr)
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
