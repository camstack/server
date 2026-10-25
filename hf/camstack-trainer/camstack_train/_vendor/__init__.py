"""Byte-identical copies of CamStack code the trainer reuses, never edited here.

- ``camstack_eval/`` is ``scripts/eval/camstack_eval/`` (the P5 evaluation
  harness): the letterbox + decode + metrics + D739 floor rule the hub's own
  measurements use.
- ``pipeline_python/`` is ``packages/addon-pipeline/python/`` (the inference
  pool and its postprocessors, tests excluded): the harness imports the pool's
  preprocess and decode from it, so the trainer evaluates exactly as a node runs.

``scripts/check-trainer-vendor.ts`` in camstack/server fails when either copy
drifts from its source. Change the source, then re-copy.
"""
from __future__ import annotations

import sys
from pathlib import Path

#: The folder holding ``inference_pool.py`` and ``postprocessors/``.
PIPELINE_PYTHON = Path(__file__).resolve().parent / "pipeline_python"


def ensure_pipeline_on_path() -> None:
    """Put the vendored pool first on ``sys.path``.

    The harness's ``pipeline._pipeline()`` imports ``inference_pool`` and
    ``postprocessors`` as top-level modules from the repository path; with this
    folder already on the path those imports resolve to the vendored copy.
    """
    entry = str(PIPELINE_PYTHON)
    if entry not in sys.path:
        sys.path.insert(0, entry)
