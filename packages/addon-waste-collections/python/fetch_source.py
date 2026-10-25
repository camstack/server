#!/usr/bin/env python3
"""One-shot bridge: load a HACS waste source and emit JSON collections.

stdin JSON:  { "source": "<module>", "args": { ... } }
stdout JSON: { "ok": true, "entries": [ { "date": "YYYY-MM-DD", "type": "...", "icon": null|str, ... } ] }
             or { "ok": false, "error": "..." } with exit 1
"""
from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path

VENDOR_ROOT = Path(__file__).resolve().parent / "vendor"
sys.path.insert(0, str(VENDOR_ROOT))

from waste_collection_schedule.source_shell import SourceShell  # noqa: E402


def main() -> int:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as e:
        print(json.dumps({"ok": False, "error": f"invalid stdin JSON: {e}"}), flush=True)
        return 1

    source = payload.get("source")
    args = payload.get("args") or {}
    if not isinstance(source, str) or not source:
        print(json.dumps({"ok": False, "error": "missing string field 'source'"}), flush=True)
        return 1
    if not isinstance(args, dict):
        print(json.dumps({"ok": False, "error": "'args' must be an object"}), flush=True)
        return 1

    shell = SourceShell.create(
        source_name=source,
        customize={},
        source_args=args,
    )
    if shell is None:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": f"failed to load or construct source '{source}' (see stderr)",
                }
            ),
            flush=True,
        )
        return 1

    try:
        ok = shell.fetch()
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"ok": False, "error": f"fetch raised: {e}"}), flush=True)
        return 1

    if not ok:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": f"fetch failed for source '{source}' (see stderr)",
                }
            ),
            flush=True,
        )
        return 1

    entries = []
    for e in shell._entries:  # noqa: SLF001 — bridge needs the raw list
        item = {
            "date": e.date.isoformat(),
            "type": e.type,
            "icon": e.icon,
        }
        if e.location:
            item["location"] = e.location
        if e.description:
            item["description"] = e.description
        entries.append(item)

    print(json.dumps({"ok": True, "entries": entries}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
