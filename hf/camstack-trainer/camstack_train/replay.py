"""COCO replay: public images mixed into a detector fine-tune.

A fine-tune on a few thousand frames of ~10 cameras forgets what the COCO head
knew about everything those cameras never show. Mixing a fixed slice of COCO
val2017 back in keeps the 80 classes alive. The slice is pinned: the images of
val2017 that hold at least one person / vehicle / animal, in file-name order,
the first ``count`` of them — the same images on every run.

Nothing here is uploaded by the hub: the container fetches the public files
once into the provider's cache volume (``/cache/coco``) and reuses them. All
80 COCO classes are labelled (the head is kept whole).

``fetch`` is injectable: tests never touch the network.
"""
from __future__ import annotations

import io
import json
import urllib.request
import zipfile
from pathlib import Path
from typing import Callable

from ._vendor.camstack_eval.classes import DETECTOR_CLASSES, macro_of

ANNOTATIONS_URL = "http://images.cocodataset.org/annotations/annotations_trainval2017.zip"
ANNOTATIONS_MEMBER = "annotations/instances_val2017.json"
IMAGE_URL = "http://images.cocodataset.org/val2017/{file}"

Fetch = Callable[[str], bytes]


def http_fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as response:  # noqa: S310 (fixed public URLs)
        return response.read()


def load_annotations(cache: Path, fetch: Fetch) -> dict:
    """``instances_val2017.json``, fetched once into ``cache``."""
    target = cache / "instances_val2017.json"
    if not target.is_file():
        cache.mkdir(parents=True, exist_ok=True)
        archive = zipfile.ZipFile(io.BytesIO(fetch(ANNOTATIONS_URL)))
        target.write_bytes(archive.read(ANNOTATIONS_MEMBER))
    return json.loads(target.read_text("utf-8"))


def select_images(annotations: dict, count: int) -> list[dict]:
    """The pinned slice: images with a detector-class object, file-name order."""
    names = {c["id"]: c["name"] for c in annotations["categories"]}
    wanted: set[int] = set()
    for a in annotations["annotations"]:
        if not a.get("iscrowd") and macro_of(names[a["category_id"]]) in DETECTOR_CLASSES:
            wanted.add(a["image_id"])
    images = sorted((im for im in annotations["images"] if im["id"] in wanted), key=lambda im: im["file_name"])
    return images[:count]


def yolo_lines(annotations: dict, image: dict, coco80: list[str]) -> list[str]:
    names = {c["id"]: c["name"] for c in annotations["categories"]}
    w, h = float(image["width"]), float(image["height"])
    lines = []
    for a in annotations["annotations"]:
        if a["image_id"] != image["id"] or a.get("iscrowd"):
            continue
        name = names[a["category_id"]]
        if name not in coco80:
            continue
        x, y, bw, bh = a["bbox"]
        if bw <= 0 or bh <= 0:
            continue
        lines.append(
            f"{coco80.index(name)} {(x + bw / 2) / w:.6f} {(y + bh / 2) / h:.6f} {bw / w:.6f} {bh / h:.6f}"
        )
    return lines


def prepare_replay(count: int, cache: Path, out_root: Path, coco80: list[str], fetch: Fetch = http_fetch) -> int:
    """Write ``count`` replay images + labels under ``out_root/images|labels/replay``."""
    if count <= 0:
        return 0
    annotations = load_annotations(cache, fetch)
    images_dir = out_root / "images" / "replay"
    labels_dir = out_root / "labels" / "replay"
    images_dir.mkdir(parents=True, exist_ok=True)
    labels_dir.mkdir(parents=True, exist_ok=True)
    by_image: dict[int, list[dict]] = {}
    for a in annotations["annotations"]:
        by_image.setdefault(a["image_id"], []).append(a)
    indexed = {**annotations, "annotations": []}
    written = 0
    for image in select_images(annotations, count):
        cached = cache / "val2017" / image["file_name"]
        if not cached.is_file():
            cached.parent.mkdir(parents=True, exist_ok=True)
            cached.write_bytes(fetch(IMAGE_URL.format(file=image["file_name"])))
        stem = Path(image["file_name"]).stem
        (images_dir / f"{stem}.jpg").write_bytes(cached.read_bytes())
        lines = yolo_lines({**indexed, "annotations": by_image.get(image["id"], [])}, image, coco80)
        (labels_dir / f"{stem}.txt").write_text("".join(line + "\n" for line in lines), "utf-8")
        written += 1
    return written
