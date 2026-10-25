#!/usr/bin/env python3
"""
One-shot stableId backfill for existing Reolink devices.

Renames every Reolink camera/hub from the timestamp-based stableId
(`reolink-1777874716804`) to the uniform `mac → host(IP)` chain that
matches `ReolinkProviderAddon.generateStableId` in `addon.ts`.

Accessory children (siren / floodlight / pir) inherit the new prefix
automatically — their stableIds are `<parentStableId>-acc-<kind>`.
Hub-adopted cameras follow the same `<parentStableId>-<childNativeId>`
suffix rule.

The script touches only `device-manager.deviceMeta` +
`device-manager.deviceIndex` rows in the `addon-settings` table.
Per-device runtime/config rows in `addon-device-settings` are keyed
by NUMERIC id, not stableId, so they don't need to move.

Server MUST be stopped before running.
"""
import json
import sqlite3
import re
import sys

DB = 'server/backend/camstack-data/addons-data/sqlite-settings/camstack.db'
ADDON_ID = 'provider-reolink'


def compute_stable_id(mac: str | None, host: str | None) -> str | None:
    """Mirror of `ReolinkProviderAddon.generateStableId`.

    Priority:
      1. mac  — hardware MAC from autodetect/post-login probe.
      2. host — operator-typed IP/hostname (DHCP-reservable).

    No `{ADDON_ID}-` prefix — the deviceMeta row key already namespaces
    by addon (`<addonId>:<stableId>`).
    """
    if mac:
        normalized = re.sub(r'[^a-zA-Z0-9]', '', mac).lower()
        if len(normalized) >= 6:
            return f'mac-{normalized}'
    if host:
        slug = re.sub(r'[^a-z0-9]+', '-', host.strip().lower()).strip('-')
        if slug:
            return f'host-{slug}'
    return None


def kv_get(conn: sqlite3.Connection, table: str, row_id: str) -> dict | None:
    cur = conn.execute(f'SELECT data FROM "{table}" WHERE id = ?', (row_id,))
    row = cur.fetchone()
    if not row:
        return None
    return json.loads(row[0])


def kv_set(conn: sqlite3.Connection, table: str, row_id: str, blob: dict) -> None:
    conn.execute(
        f'INSERT OR REPLACE INTO "{table}" (id, data) VALUES (?, ?)',
        (row_id, json.dumps(blob)),
    )


def lookup_kv_value(conn: sqlite3.Connection, key: str) -> any:
    cur = conn.execute(
        'SELECT data FROM "addon-device-settings" WHERE id = ?',
        (key,),
    )
    row = cur.fetchone()
    if not row:
        return None
    return json.loads(row[0]).get('value')


def main():
    conn = sqlite3.connect(DB)
    conn.isolation_level = None  # autocommit off; we manage tx
    conn.execute('BEGIN')

    try:
        meta_blob = kv_get(conn, 'addon-settings', 'device-manager.deviceMeta')
        index_blob = kv_get(conn, 'addon-settings', 'device-manager.deviceIndex')
        if not meta_blob or not index_blob:
            print('no deviceMeta / deviceIndex blobs — nothing to do')
            return
        meta = meta_blob['value']
        index = index_blob['value']

        # ── Pass 0: drop orphans (parentDeviceId points at a row that's
        # been deleted). Iterates EVERY meta row to build the live id
        # set — accessory grand-children whose parent is itself a hub-
        # adopted child must NOT be flagged as orphans.
        all_ids = {v['id'] for v in meta.values()}
        orphan_keys = [k for k, v in meta.items()
                       if v.get('parentDeviceId') is not None
                       and v['parentDeviceId'] not in all_ids]
        for ok in orphan_keys:
            pid = meta[ok]['parentDeviceId']
            print(f'DROP orphan {ok} (parentId {pid} missing)')
            del meta[ok]
            sid = ok.split(':', 1)[1]
            for arr in index.values():
                while sid in arr:
                    arr.remove(sid)

        # Pass 1: compute renames for parent devices.
        renames: list[tuple[str, str, int]] = []  # (oldKey, newKey, deviceId)
        # Track new keys to detect intra-batch collisions (multiple
        # parents resolve to the same identity-derived stableId — e.g.
        # two cameras under the same hub IP without uid).
        claimed: set[str] = set()
        for key, val in list(meta.items()):
            if not key.startswith(f'{ADDON_ID}:'):
                continue
            stable_id = key[len(ADDON_ID) + 1:]
            if val.get('parentDeviceId') is not None:
                # Children/accessories handled in pass 2 along with parent.
                continue
            device_id = val['id']
            cache = lookup_kv_value(conn, f'device-manager:{device_id}.deviceCache') or {}
            mac = cache.get('mac') if isinstance(cache, dict) else None
            host = lookup_kv_value(conn, f'device-manager:{device_id}.host')
            base = compute_stable_id(mac, host)
            if not base or base == stable_id:
                continue
            # Uniqueness guard: when multiple devices resolve to the same
            # base id (e.g. two NVR rows sharing a host without mac),
            # suffix with the numeric deviceId so each row keeps a unique
            # key. Mac-derived ids are unique by construction; host-only
            # ids are the typical collision case.
            new_stable = base
            if new_stable in claimed or f'{ADDON_ID}:{new_stable}' in meta:
                new_stable = f'{base}-{device_id}'
            new_key = f'{ADDON_ID}:{new_stable}'
            if new_key in meta and new_key != key:
                print(f'SKIP {key}: target {new_key} already exists post-suffix')
                continue
            renames.append((key, new_key, device_id))
            claimed.add(new_stable)
            print(f'RENAME parent {stable_id} → {new_stable} (id={device_id}, mac={mac}, host={host})')

        if not renames:
            print('no parent renames needed')
            return

        # Pass 2: also rename every child whose stableId is built as
        # `<oldParentStableId>-<anything>`. Two patterns in flight:
        #   - accessory children (siren/floodlight/pir):  `-acc-<kind>`
        #   - hub-adopted cameras under an NVR/Hub:        `-<childNativeId>`
        #     (e.g. `-cam-9527000MSU931AUT`)
        # Both follow the same `<parentStableId>-<suffix>` rule, so a
        # single dash-prefixed match captures both.
        all_replacements: list[tuple[str, str]] = []  # (oldKey, newKey)
        for old_key, new_key, _device_id in renames:
            old_stable = old_key[len(ADDON_ID) + 1:]
            new_stable = new_key[len(ADDON_ID) + 1:]
            all_replacements.append((old_key, new_key))
            for k in list(meta.keys()):
                if not k.startswith(f'{ADDON_ID}:'):
                    continue
                child_stable = k[len(ADDON_ID) + 1:]
                if child_stable.startswith(old_stable + '-'):
                    new_child_stable = new_stable + child_stable[len(old_stable):]
                    all_replacements.append((k, f'{ADDON_ID}:{new_child_stable}'))

        # Apply: rewrite deviceMeta keys.
        for old_key, new_key in all_replacements:
            if old_key not in meta:
                continue
            meta[new_key] = meta.pop(old_key)
            print(f'  meta key: {old_key} → {new_key}')

        # Apply: rewrite deviceIndex array. The format is
        # `{ "<addonId>": ["stableId1", "stableId2", ...] }`.
        addon_list = index.get(ADDON_ID, [])
        new_addon_list = []
        rename_stable_map = {old.split(':', 1)[1]: new.split(':', 1)[1] for old, new in all_replacements}
        for sid in addon_list:
            new_addon_list.append(rename_stable_map.get(sid, sid))
        index[ADDON_ID] = new_addon_list

        # Persist.
        kv_set(conn, 'addon-settings', 'device-manager.deviceMeta', meta_blob)
        kv_set(conn, 'addon-settings', 'device-manager.deviceIndex', index_blob)
        conn.execute('COMMIT')
        print(f'\n✓ committed {len(all_replacements)} key rewrites')

    except Exception as e:
        conn.execute('ROLLBACK')
        print(f'! rolled back: {e}', file=sys.stderr)
        raise
    finally:
        conn.close()


if __name__ == '__main__':
    main()
