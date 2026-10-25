#!/usr/bin/env python3
"""
One-shot re-key of the device-manager persisted stores from the composite
`"<addonId>:<stableId>"` key to the numeric device `id`.

After this runs:
  device-manager.deviceMeta      : { "<id>": { ...meta, addonId, stableId, id } }
  device-manager.deviceMetadata  : { "<id>": { ...hardwareMetadata } }

`deviceIndex` (addonId -> stableId[]) and `deviceBindings` (already keyed by id)
are LEFT UNCHANGED — they are legit secondary indexes.

The composite key splits on the FIRST ':' only (stableId itself may contain
colons, e.g. "ecowitt_001-8E:0x02"). addonId = before the first ':', stableId =
everything after.

Idempotent: if every deviceMeta key is already numeric and its value carries
`addonId`/`stableId` fields, the script reports "already re-keyed" and exits 0.

Server MUST be stopped before running.

Usage:
    python3 scripts/rekey-device-meta-to-id.py [DB_PATH]

DB_PATH defaults to the local dev DB. On unraid the container path is
/data/addons-data/sqlite-settings/camstack.db (run inside the container, or
point at the bind-mount on the host).
"""
import json
import sqlite3
import sys

DEFAULT_DB = "server/backend/camstack-data/addons-data/sqlite-settings/camstack.db"
SETTINGS_TABLE = "addon-settings"
META_KEY = "device-manager.deviceMeta"
METADATA_KEY = "device-manager.deviceMetadata"


def _load(conn, row_id):
    cur = conn.execute(
        f'SELECT data FROM "{SETTINGS_TABLE}" WHERE id = ?',
        (row_id,),
    )
    row = cur.fetchone()
    if not row:
        return None, None
    wrapper = json.loads(row[0])
    return wrapper, wrapper.get("value", {})


def _save(conn, row_id, wrapper, new_value):
    wrapper["value"] = new_value
    conn.execute(
        f'UPDATE "{SETTINGS_TABLE}" SET data = ? WHERE id = ?',
        (json.dumps(wrapper), row_id),
    )


def _split_composite(key):
    """addonId = before first ':', stableId = after. None if not composite."""
    sep = key.find(":")
    if sep < 0:
        return None, None
    return key[:sep], key[sep + 1 :]


def main() -> None:
    db = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DB
    conn = sqlite3.connect(db)
    conn.isolation_level = None
    conn.execute("BEGIN")
    try:
        meta_wrapper, meta = _load(conn, META_KEY)
        if meta_wrapper is None or not isinstance(meta, dict):
            print(f"no {META_KEY} row — nothing to re-key")
            conn.execute("COMMIT")
            return

        # Idempotency: already keyed by id?
        already = meta and all(
            k.isdigit() and isinstance(v, dict) and "addonId" in v and "stableId" in v
            for k, v in meta.items()
        )
        if already:
            print(f"deviceMeta already re-keyed by id ({len(meta)} rows) — skipping")
            conn.execute("COMMIT")
            return

        # ── Re-key deviceMeta: composite -> String(id), inject addonId/stableId ──
        composite_to_id = {}
        new_meta = {}
        skipped = []
        for key, value in meta.items():
            if not isinstance(value, dict):
                skipped.append((key, "value not an object"))
                continue
            dev_id = value.get("id")
            if not isinstance(dev_id, int):
                skipped.append((key, f"no numeric id (got {dev_id!r})"))
                continue
            addon_id, stable_id = _split_composite(key)
            if addon_id is None:
                # Already an id-key or malformed — keep addonId/stableId if present.
                addon_id = value.get("addonId")
                stable_id = value.get("stableId")
            id_key = str(dev_id)
            new_meta[id_key] = {**value, "addonId": addon_id, "stableId": stable_id, "id": dev_id}
            composite_to_id[key] = id_key

        _save(conn, META_KEY, meta_wrapper, new_meta)
        print(f"deviceMeta: re-keyed {len(new_meta)} rows by id")
        for k, why in skipped:
            print(f"  SKIPPED meta '{k}': {why}")

        # ── Re-key deviceMetadata: composite -> String(id) via composite_to_id ──
        md_wrapper, md = _load(conn, METADATA_KEY)
        if md_wrapper is not None and isinstance(md, dict) and md:
            new_md = {}
            md_dropped = []
            for key, value in md.items():
                id_key = composite_to_id.get(key)
                if id_key is None:
                    # Maybe already an id key (idempotent partial), or orphan.
                    if key.isdigit():
                        new_md[key] = value
                    else:
                        md_dropped.append(key)
                    continue
                new_md[id_key] = value
            _save(conn, METADATA_KEY, md_wrapper, new_md)
            print(f"deviceMetadata: re-keyed {len(new_md)} rows by id")
            for k in md_dropped:
                print(f"  DROPPED metadata '{k}': no matching device (orphan)")
        else:
            print("deviceMetadata: empty/absent — nothing to re-key")

        conn.execute("COMMIT")
        print("DONE — committed")
    except Exception as exc:  # noqa: BLE001
        conn.execute("ROLLBACK")
        print(f"ROLLED BACK due to error: {exc}", file=sys.stderr)
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
