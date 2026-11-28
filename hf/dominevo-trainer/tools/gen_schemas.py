#!/usr/bin/env python3
"""Regenerate schemas/job.schema.json and schemas/result.schema.json from the
pydantic models. Run after changing spec.py or result_model.py:

    python tools/gen_schemas.py          # write
    python tools/gen_schemas.py --check  # exit 1 when a checked-in schema is stale
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from camstack_train.result_model import TrainingResult  # noqa: E402
from camstack_train.spec import JobSpec  # noqa: E402

TARGETS = {
    "job.schema.json": (JobSpec, "camstack.training/v1"),
    "result.schema.json": (TrainingResult, "camstack.training-result/v1"),
}


def render(model, schema_id: str) -> str:
    schema = model.model_json_schema(by_alias=True)
    schema = {"$id": schema_id, "$schema": "https://json-schema.org/draft/2020-12/schema", **schema}
    return json.dumps(schema, indent=2, sort_keys=True) + "\n"


def main(argv: list[str]) -> int:
    check = "--check" in argv
    stale = []
    for name, (model, schema_id) in TARGETS.items():
        path = ROOT / "schemas" / name
        text = render(model, schema_id)
        if check:
            if not path.is_file() or path.read_text("utf-8") != text:
                stale.append(name)
        else:
            path.write_text(text, "utf-8")
    if stale:
        print(f"stale: {', '.join(stale)} — run python tools/gen_schemas.py")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
