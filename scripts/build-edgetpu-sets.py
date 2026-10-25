#!/usr/bin/env python3
"""Build the co-compiled Edge TPU sets a Coral pool loads (D724).

    python3 scripts/build-edgetpu-sets.py --work <dir> [--compiler docker|lima:<instance>]

produces, per set, under ``<work>/stage/edgetpuSets/<set>/``:

    <set>__<member>_edgetpu.tflite     one file per member, compiled TOGETHER
    README.md                          what the set is, its members, measured cost, licences
    NOTICE-open-lpr.txt                when the set carries the open-lpr plate detector
                                       (Apache-2.0 §4(d): the NOTICE travels with the weights)

and ``<work>/report.json`` with the compiler's per-member on-chip / streamed
figures — the numbers ``EDGETPU_COCOMPILED_SETS``
(packages/addon-pipeline/src/detection-pipeline/registry/edgetpu-cocompiled-sets.ts)
carries. Upload with ``hf upload camstack/camstack-models <work>/stage/edgetpuSets edgetpuSets``.

WHY A SET
---------
``edgetpu_compiler`` given several models at once allocates the ~6.9 MiB
parameter cache between them in command-line order and stamps them with ONE
cache token. Loaded on the same Coral — in separate interpreters, as the pool
does — they no longer evict each other; whatever a member could not keep on
chip is streamed on every invoke of that member instead. Separately compiled
files carry different tokens, and each switch re-streams the incoming model
(the root SSD alone: 6.39 MiB).

The set is a pool-level artifact, never a model: each member is the same int8
graph as its catalog entry's ``formats.tflite`` (D710). The members are compiled
from the pinned CPU graphs below — Google's for the root SSD and the bird
classifier, CamStack's published int8 graphs for YuNet and YOLOX (built by
build-yunet-edgetpu.py / build-yolox-plate-edgetpu.py, which also report the
parity of those graphs).

A set is published only when its cost is acceptable. Root + YuNet is NOT a set:
at 640 YuNet's activations leave the cache 3.34 MiB, so the root would stream
2.93 MiB on every frame. The script refuses to build a set whose root member
streams anything.

The member list here and in the TypeScript registry must agree (set ids, member
models, file names, order); the script refuses to run when they do not.

Compilation is the only stage: no ML runtime is imported.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from hashlib import sha256
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import edgetpu_toolchain as tc  # noqa: E402

_REPO = Path(__file__).resolve().parents[1]
_REGISTRY = (_REPO / "packages" / "addon-pipeline" / "src" / "detection-pipeline" / "registry"
             / "edgetpu-cocompiled-sets.ts")
_NOTICE = _REPO / "licenses" / "models" / "NOTICE-open-lpr.txt"
_HF = "https://huggingface.co/camstack/camstack-models/resolve/main"

# (url, file name, sha256, bytes) of each member's CPU int8 graph.
SRC_YUNET_INT8 = (f"{_HF}/faceDetection/yunet/tflite/camstack-yunet-2023mar_int8.tflite",
                  "camstack-yunet-2023mar_int8.tflite",
                  "a369663e42539a7dc2b4152a53e7e5b6386215335d5cb979b81c44ab50b258e6", 128_640)
SRC_YOLOX_INT8 = (f"{_HF}/plateDetection/yolox-tiny-plate/tflite/camstack-yolox-tiny-plate_int8.tflite",
                  "camstack-yolox-tiny-plate_int8.tflite",
                  "cca36a2f81d8788685fa9374a849783e9bc6a3aaea96fa85531a7e6bb3310f09", 5_331_536)
SRC_SSD = tc.SRC_SSD_QUANT
SRC_BIRD = tc.SRC_BIRD_QUANT

# member key -> (step id, model id, source, stem of the set file, licence line)
MEMBERS = {
    "root": ("object-detection", "ssd-mobilenet-v2-coco-edgetpu", SRC_SSD,
             "ssd_mobilenet_v2_coco_quant_postprocess",
             "SSD MobileNet V2 COCO, Google Coral test_data, Apache-2.0 (training data: COCO)"),
    "face": ("face-detection", "yunet-2023mar", SRC_YUNET_INT8, "camstack-yunet-2023mar_int8",
             "YuNet 2023mar, weights MIT (Copyright (c) 2020 Shiqi Yu); training data WIDER FACE (CC BY-NC-ND images)"),
    "plate": ("plate-detection", "yolox-tiny-plate", SRC_YOLOX_INT8, "camstack-yolox-tiny-plate_int8",
              "YOLOX-tiny plate detector by the open-lpr project, Apache-2.0 (NOTICE in this folder; "
              "training data terms UNKNOWN)"),
    "bird": ("bird-classifier", "bird-classifier", SRC_BIRD, "mobilenet_v2_1.0_224_inat_bird_quant",
             "Google AIY Vision Birds V1, Apache-2.0"),
}

# set id -> members in compile order (= cache priority)
SETS = {
    "root-plate-bird": ["root", "plate", "bird"],
    "face-plate-bird": ["face", "plate", "bird"],
    "plate-bird": ["plate", "bird"],
}

CARD = """\
---
license: other
tags:
  - edge-tpu
  - coral
  - camstack
---

# Co-compiled Edge TPU set `{set_id}` — CamStack

Files for ONE Coral, compiled together by `edgetpu_compiler` 14.1 so they share
the Edge TPU parameter cache instead of evicting each other (CamStack D724). A
CamStack Coral pool loads this set when the models placed on it are covered by
it; load the files of one set on one Coral, never mixed with other sets or with
the separately compiled builds. Built by `scripts/build-edgetpu-sets.py`.

| Member (compile order = cache priority) | Catalog model | On chip | Streamed per invoke |
| --- | --- | --- | --- |
{rows}

Each member is the same integer graph as its catalog model's own `tflite`
build; only the compilation differs.

## Licences

{licences}
"""


def _registry_sets() -> dict[str, list[tuple[str, str, str]]]:
    """Set id -> [(step, model, file name)] as the TypeScript registry declares them."""
    text = _REGISTRY.read_text()
    sets: dict[str, list[tuple[str, str, str]]] = {}
    consts = dict(re.findall(r"^const (\w+) = '([^']+)'", text, re.M))
    for block in re.split(r"\n  \{\n", text)[1:]:
        set_id = re.search(r"id: '([^']+)'", block)
        if set_id is None:
            continue
        members = re.findall(r"stepId: '([^']+)',\s*modelId: (\w+),\s*url: setFile\('[^']+', '([^']+)'\)", block)
        sets[set_id.group(1)] = [(step, consts.get(model, model), file) for step, model, file in members]
    return sets


def _expected_sets() -> dict[str, list[tuple[str, str, str]]]:
    return {set_id: [(MEMBERS[k][0], MEMBERS[k][1], f"{MEMBERS[k][3]}_edgetpu.tflite") for k in keys]
            for set_id, keys in SETS.items()}


def main() -> None:
    sys.stdout.reconfigure(line_buffering=True)
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--work", type=Path, required=True)
    ap.add_argument("--compiler", default="docker", help="docker | lima:<instance>")
    a = ap.parse_args()

    if _registry_sets() != _expected_sets():
        raise SystemExit(f"the TypeScript registry and this script disagree:\n  registry {_registry_sets()}\n"
                         f"  script   {_expected_sets()}")
    work = a.work.absolute()
    work.mkdir(parents=True, exist_ok=True)
    print("1/3 fetch the members' CPU graphs (pinned)")
    sources = {k: tc.fetch(m[2], work) for k, m in MEMBERS.items()}

    print("2/3 compile every set")
    inputs, jobs = [], []
    for set_id, keys in SETS.items():
        names = []
        for k in keys:
            named = work / f"{set_id}__{MEMBERS[k][3]}.tflite"
            shutil.copyfile(sources[k], named)
            inputs.append(named)
            names.append(named.name)
        jobs.append((f"set-{set_id}", names))
    tc.compile_jobs(a.compiler, work, inputs, jobs)

    print("3/3 report + stage")
    report = {}
    for set_id, keys in SETS.items():
        rows = tc.parse_compiler_output((work / f"set-{set_id}" / "compiler.txt").read_text())
        report[set_id] = rows
        for r in rows:
            print(f"  {set_id:16s} {r['model']:60s} on-chip {tc.mib(r['on_chip_bytes'])}, "
                  f"streamed {tc.mib(r['streamed_bytes'])}, ops {r['ops_tpu']}/{r['ops_total']} on TPU")
        if MEMBERS[keys[0]][0] == "object-detection" and rows[0]["streamed_bytes"] != 0:
            raise SystemExit(f"{set_id}: the root streams parameters — not a set CamStack publishes")
        dest = work / "stage" / "edgetpuSets" / set_id
        shutil.rmtree(dest, ignore_errors=True)
        dest.mkdir(parents=True)
        table = []
        for k, r in zip(keys, rows):
            out = f"{set_id}__{MEMBERS[k][3]}_edgetpu.tflite"
            shutil.copyfile(work / f"set-{set_id}" / out, dest / out)
            table.append(f"| `{out}` | `{MEMBERS[k][1]}` | {tc.mib(r['on_chip_bytes'])} | {tc.mib(r['streamed_bytes'])} |")
        if "plate" in keys:
            shutil.copyfile(_NOTICE, dest / "NOTICE-open-lpr.txt")
        (dest / "README.md").write_text(CARD.format(
            set_id=set_id, rows="\n".join(table), licences="\n".join(f"- {MEMBERS[k][4]}" for k in keys)))
        for p in sorted(dest.iterdir()):
            print(f"    {p.name}  {p.stat().st_size} bytes  sha256 {sha256(p.read_bytes()).hexdigest()}")
    (work / "report.json").write_text(json.dumps(report, indent=1))
    print(f"  hf upload camstack/camstack-models {work / 'stage' / 'edgetpuSets'} edgetpuSets")


if __name__ == "__main__":
    main()
