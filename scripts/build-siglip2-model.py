#!/usr/bin/env python3
"""Build the `siglip2-b16-224` catalog artefacts from google/siglip2-base-patch16-224 (Apache-2.0).

    python3 scripts/build-siglip2-model.py <work-dir> --coreml-python <py> [--skip-verify]
    python3 scripts/build-siglip2-model.py <work-dir> --upload      # additive, clip/siglip2/ only

Two interpreters, because coremltools and the torch that exports ONNX/OpenVINO
do not agree on one version: the main one needs torch + transformers + onnx +
onnxruntime + onnxconverter-common + openvino + tokenizers + huggingface_hub +
Pillow; ``--coreml-python`` needs torch + transformers + coremltools.
(The 2026-09-26 spike ran torch 2.14 / transformers 5.17 / openvino 2026.4 /
coremltools 9.0, one venv each.)

Produces, under ``<work-dir>/stage/clip/siglip2/``, everything the catalog
entries ``siglip2-b16-224`` (image) and ``siglip2-b16-224-text`` point at:

    onnx/camstack-siglip2-b16-224-vision.onnx        fp32, the verification reference
    onnx/camstack-siglip2-b16-224-text.onnx          fp16 weights, fp32 I/O (runs in the
                                                     encoder's onnxruntime text path)
    onnx/camstack-siglip2-b16-224-tokenizer.json     Gemma SentencePiece + a Lowercase normalizer
                                                     (a UNIQUE name: every model's siblings land in
                                                     ONE flat models dir, where MobileCLIP's CLIP BPE
                                                     is already `tokenizer.json`)
    openvino/camstack-siglip2-b16-224-vision.{xml,bin}   fp16
    openvino/camstack-siglip2-b16-224-text.{xml,bin}     fp16
    coreml/camstack-siglip2-b16-224-vision.mlpackage     fp16, ImageType input (scale 1/255)
    coreml/camstack-siglip2-b16-224-text.mlpackage       fp16, int32 input_ids [1,64] (the encoder
                                                     never loads it; built for completeness)
    README.md                                        model card: Apache-2.0, source, modifications

THE BAKED INPUT CONTRACT (vision)
---------------------------------
SigLIP expects ``(x - 0.5) / 0.5`` on [0,1] pixels. The CamStack pool feeds the
catalog's ``preprocessMode: 'resize'`` + ``inputNormalization: 'none'`` — a
bilinear stretch to 224×224 and ``/255`` (OpenVINO: the PPP u8 → f32 /255 fold;
CoreML: ``ImageType(scale=1/255)``). ``2x - 1`` is therefore baked ahead of the
patch embedding and every format consumes the pool tensor directly, exactly as
``build-auraface-model.py`` and ``build-yunet-model.py`` do. The output is the
single pooled ``embedding`` [N,768], un-normalised: ``postprocessors/clip.py``
takes the first output and L2-normalises it.

THE TEXT CONTRACT
-----------------
SigLIP2's text tower has **64** positions and was trained on padded-to-64,
lower-cased text. ``text_encoder_inference.py`` tokenises with the HF
``tokenizers`` library to the ``contextLength`` / ``padId`` the catalog meta
names (64 / 0 here). Two things make the artefacts safe on either side of that:

1. The graph slices ``input_ids[:, :64]`` before the embedding lookup, so an
   encoder that still pads to 77 (the MobileCLIP window, and every encoder built
   before the meta carried a context length) gets identical output for any query
   under 64 tokens. Verified below: 77-wide and 64-wide inputs agree to 1e-5.
2. The hosted tokenizer has a ``Lowercase`` normalizer prepended. The processor
   does not lowercase, but the model card says the model was trained on
   lower-cased text; the ids are verified equal to the reference processor fed
   ``text.lower()``.

NOT SHIPPED: an int8 VISION model. Dynamic int8 quantisation measured COCO
caption R@1 0.722 → 0.392 in the spike — the same failure as the retired
MobileCLIP int8 vision (D209). The int8 TEXT model is healthy (R@1 0.708) and is
the size fallback if fp16 text ever fails to convert; it is not uploaded.

VERIFICATION (the script exits non-zero on any miss — D209)
------------------------------------------------------------
  a. baked norm: ONNX vision fed x vs the HF model fed (x-0.5)/0.5, cos >= 0.9999
  b. dynamic batch: a batch of 2 equals two batches of 1 (D202 — the pool pins
     a static batch itself where a device needs one)
  c. OpenVINO fp16 through the pool's PPP u8 path vs ONNX fp32, cos >= 0.99
  d. CoreML fp16 via ImageType vs ONNX fp32, cos >= 0.99
  e. tokenizer parity: our tokenizer at 64/pad 0 == the reference processor
     on text.lower(), on 24 NVR queries (mixed case, punctuation, Italian)
  f. text: 77-wide == 64-wide (the slice), shipped fp16 vs torch fp32 cos >= 0.999,
     OpenVINO text vs torch fp32 cos >= 0.999
  g. embedding SPACE (D209): the shipped vision (OpenVINO) against the shipped text
     (ONNX fp16) on the spike's 20 COCO images and 18 hand-labelled queries:
     R@1 >= 14/18 and the matched image-text cosine inside [0.05, 0.40]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO = "google/siglip2-base-patch16-224"
# Pinned: the snapshot the 2026-09-26 spike measured.
REVISION = "75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2"
NAME = "camstack-siglip2-b16-224"
HF_REPO_ID = "camstack/camstack-models"
HF_FOLDER = "clip/siglip2"
IMGSZ = 224
TEXT_POSITIONS = 64
PAD_ID = 0
LEGACY_CONTEXT = 77  # the MobileCLIP window an older encoder still pads to

VISION_ONNX = f"onnx/{NAME}-vision.onnx"
TEXT_ONNX = f"onnx/{NAME}-text.onnx"
TOKENIZER = f"onnx/{NAME}-tokenizer.json"
VISION_OV = f"openvino/{NAME}-vision.xml"
TEXT_OV = f"openvino/{NAME}-text.xml"
VISION_ML = f"coreml/{NAME}-vision.mlpackage"
TEXT_ML = f"coreml/{NAME}-text.mlpackage"

# Acceptance gates (see the module docstring).
BAKE_MIN_COS = 0.9999
OV_VISION_MIN_COS = 0.99
COREML_VISION_MIN_COS = 0.99
TEXT_MIN_COS = 0.999
SLICE_MAX_ABS = 1e-4
SPACE_MIN_R1 = 14
SPACE_POS_COS = (0.05, 0.40)

# The spike's sanity set: 20 COCO val2017 images, 18 hand-labelled queries
# (query -> relevant image id suffixes). eval_clip.py in the spike scratch dir.
SANITY_QUERIES: dict[str, list[str]] = {
    "a bear": ["00285"], "a stop sign": ["00724"], "teddy bears": ["00776"],
    "a group of children": ["01000", "01353"], "a woman holding a phone": ["01268"],
    "a person paddle boarding on the sea": ["01490"], "a red double decker bus": ["01584"],
    "a purple bus": ["02006"], "a cat": ["01675", "39769"],
    "two cats sleeping on a pink blanket": ["39769"], "airplanes in the sky": ["01761"],
    "a zebra": ["01818"], "green apples in a bowl": ["02149"], "a bedroom": ["00632", "01993"],
    "cars on a highway": ["01532"], "a computer on a desk": ["01503"],
    "a swan near a river": ["01296"], "a plate of food": ["01425"],
}

TOKENIZER_PARITY_TEXTS = [
    "a person", "a person walking", "a car", "a white car", "a truck", "a van",
    "a bicycle", "a motorcycle", "a cat", "a dog", "a bird", "an animal",
    "A Person Walking A DOG at night", "delivery VAN at the gate",
    "a red double decker bus", "un gatto sul divano", "a man in a yellow jacket, carrying a box",
    "two cats sleeping on a pink blanket", "a photo of a ambulance.", "a photo of a taxi.",
    "someone climbing over the fence!", "Car parked in the DRIVEWAY", "  leading spaces",
    "a very long query " + " ".join(["about a car"] * 30),
]

MODEL_CARD = """\
---
license: apache-2.0
library_name: onnx
base_model: google/siglip2-base-patch16-224
tags:
  - clip
  - siglip2
  - semantic-search
  - camstack
---

# SigLIP2 B/16-224: CamStack build

Google SigLIP2 base (patch 16, 224×224) image and text encoders, re-packaged for
the CamStack inference pool and embedding encoder. 768-dimensional embeddings.
Selectable on the `clip-embedding` step as `siglip2-b16-224` (image) with the
text encoder `siglip2-b16-224-text`.

| agent-a | Format | File | Precision |
| --- | --- | --- | --- |
| vision | ONNX | `onnx/camstack-siglip2-b16-224-vision.onnx` | fp32 (reference; not in the catalog) |
| vision | OpenVINO IR | `openvino/camstack-siglip2-b16-224-vision.{xml,bin}` | fp16 |
| vision | CoreML | `coreml/camstack-siglip2-b16-224-vision.mlpackage` | fp16 |
| text | ONNX | `onnx/camstack-siglip2-b16-224-text.onnx` | fp16 weights, fp32 I/O |
| text | OpenVINO IR | `openvino/camstack-siglip2-b16-224-text.{xml,bin}` | fp16 |
| text | CoreML | `coreml/camstack-siglip2-b16-224-text.mlpackage` | fp16, `input_ids` int32 [1,64] |
| tokenizer | HF `tokenizers` | `onnx/camstack-siglip2-b16-224-tokenizer.json` | — |

## Source

- Model: `google/siglip2-base-patch16-224`,
  <https://huggingface.co/google/siglip2-base-patch16-224>, revision
  `75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2`. Licence: Apache-2.0 (model card
  `license: apache-2.0`).
- Code: <https://github.com/google-research/big_vision> (Apache-2.0).
- Paper: Tschannen et al., "SigLIP 2: Multilingual Vision-Language Encoders with
  Improved Semantic Understanding, Localization, and Dense Features", 2025,
  <https://arxiv.org/abs/2502.14786>.
- Training data: WebLI (Google internal, never released).

## Modifications

These files are a modified version of the upstream model (Apache-2.0 §4(b)):

1. **Vision input contract.** The vision graph takes RGB float in [0,1]
   (NCHW, N×3×224×224) and applies SigLIP's `(x - 0.5) / 0.5` = `2x - 1`
   inside the graph, ahead of the patch embedding. The output is the single
   pooled `embedding` [N,768], not L2-normalised.
2. **Text slice.** The text graph takes `input_ids` int64 [1,L] and slices it to
   the model's 64 positions (`input_ids[:, :64]`) before the embedding lookup, so
   a caller that pads to CLIP's 77 tokens gets the same embedding for any query
   under 64 tokens.
3. **Lower-casing tokenizer.** `camstack-siglip2-b16-224-tokenizer.json` is the upstream `tokenizer.json` with a
   `Lowercase` normalizer prepended: the model was trained on lower-cased text
   and the upstream processor does not lower-case.
4. **Format conversion and precision.** OpenVINO IR and CoreML at fp16; the text
   ONNX weights converted to fp16 (inputs and outputs stay int64/fp32).

Built and verified by `scripts/build-siglip2-model.py` in the CamStack
repository (https://github.com/camstack/server): cross-format cosine against the
fp32 reference, tokenizer ids equal to the reference processor, and the
image-text embedding space checked on reference images.

## Licence

Apache License, Version 2.0 — <https://www.apache.org/licenses/LICENSE-2.0>;
full text in [`LICENSES/Apache-2.0.txt`](../../LICENSES/Apache-2.0.txt). The
upstream model is © Google LLC. CamStack's changes are listed above. Every
model's attribution is in [`THIRD_PARTY_MODELS.md`](../../THIRD_PARTY_MODELS.md).
"""


# ───────────────────────────── helpers ──────────────────────────────────────


def _l2(x):
    import numpy as np

    v = np.asarray(x, dtype=np.float32).reshape(-1)
    return v / np.linalg.norm(v)


def _cos(a, b) -> float:
    return float(_l2(a) @ _l2(b))


def _require(ok: bool, what: str) -> None:
    print(f"  {'✓' if ok else '✗'} {what}")
    if not ok:
        raise SystemExit(f"verification failed: {what}")


def _load_model(eager: bool = False):
    import torch
    from transformers import AutoModel

    kwargs = {"torch_dtype": torch.float32, "revision": REVISION}
    if eager:
        kwargs["attn_implementation"] = "eager"
    return AutoModel.from_pretrained(REPO, **kwargs).eval()


def _features(out):
    """transformers 4.x returns a tensor from get_*_features; 5.x a ModelOutput."""
    import torch

    return out if torch.is_tensor(out) else out.pooler_output


def _snapshot_file(name: str) -> Path:
    from huggingface_hub import hf_hub_download

    return Path(hf_hub_download(REPO, name, revision=REVISION))


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _size(path: Path) -> int:
    if path.is_dir():
        return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())
    if path.suffix == ".xml":
        return path.stat().st_size + path.with_suffix(".bin").stat().st_size
    return path.stat().st_size


# ───────────────────────────── stages ───────────────────────────────────────


def _export_onnx(base: Path, work: Path) -> Path:
    """Vision fp32 (dynamic batch) and text fp32 (dynamic length, sliced to 64)."""
    import torch

    model = _load_model()
    positions = model.config.text_config.max_position_embeddings
    if positions != TEXT_POSITIONS or model.config.vision_config.image_size != IMGSZ:
        raise SystemExit(
            f"upstream changed shape: text positions {positions}, image {model.config.vision_config.image_size}"
        )

    class Vision(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, image):
            return _features(self.m.get_image_features(pixel_values=image * 2.0 - 1.0))

    class Text(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, input_ids):
            return _features(self.m.get_text_features(input_ids=input_ids[:, :TEXT_POSITIONS]))

    (base / "onnx").mkdir(parents=True, exist_ok=True)
    with torch.no_grad():
        torch.onnx.export(
            Vision(model).eval(), (torch.rand(1, 3, IMGSZ, IMGSZ),), str(base / VISION_ONNX),
            input_names=["image"], output_names=["embedding"],
            dynamic_axes={"image": {0: "batch"}, "embedding": {0: "batch"}},
            opset_version=17, dynamo=False,
        )
        text32 = work / f"{NAME}-text-fp32.onnx"
        torch.onnx.export(
            Text(model).eval(), (torch.zeros(1, LEGACY_CONTEXT, dtype=torch.long),), str(text32),
            input_names=["input_ids"], output_names=["embedding"],
            dynamic_axes={"input_ids": {1: "length"}},
            opset_version=17, dynamo=False,
        )
    print(f"  ✓ {VISION_ONNX} ({_size(base / VISION_ONNX) / 1e6:.0f} MB), text fp32 intermediate")
    return text32


def _text_fp16(text32: Path, out: Path) -> None:
    import onnx
    from onnxconverter_common import float16

    model = onnx.load(str(text32))
    half = float16.convert_float_to_float16(model, keep_io_types=True)
    onnx.save(half, str(out))
    print(f"  ✓ {TEXT_ONNX} fp16 ({_size(out) / 1e6:.0f} MB)")


def _openvino(onnx_path: Path, xml: Path) -> None:
    import openvino as ov

    xml.parent.mkdir(parents=True, exist_ok=True)
    ov.save_model(ov.convert_model(str(onnx_path)), str(xml), compress_to_fp16=True)
    print(f"  ✓ {xml.name} + .bin fp16 ({_size(xml) / 1e6:.0f} MB)")


def _tokenizer(out: Path) -> None:
    from tokenizers import Tokenizer, normalizers

    tok = Tokenizer.from_file(str(_snapshot_file("tokenizer.json")))
    upstream = tok.normalizer
    tok.normalizer = (
        normalizers.Sequence([normalizers.Lowercase(), upstream])
        if upstream is not None
        else normalizers.Lowercase()
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    tok.save(str(out))
    print(f"  ✓ {TOKENIZER} (Lowercase prepended to {upstream})")


# The files the catalog's `MLPACKAGE_FILES` fetches. The downloader fetches
# exactly these, so a package must hold exactly these.
MLPACKAGE_FILES = {
    "Manifest.json",
    "Data/com.apple.CoreML/model.mlmodel",
    "Data/com.apple.CoreML/weights/weight.bin",
}


def _strip_mlpackage(pkg: Path) -> None:
    """Drop what the Manifest does not reference. coremltools 9 via torch.export
    leaves `executorch_debug_handle_mapping.json` at the package root; nothing
    reads it, and the catalog's file list would not fetch it — the verification
    that follows loads the stripped package, so a file CoreML needed would fail
    here and not on a node."""
    for f in list(pkg.rglob("*")):
        if f.is_file() and f.relative_to(pkg).as_posix() not in MLPACKAGE_FILES:
            f.unlink()
    have = {f.relative_to(pkg).as_posix() for f in pkg.rglob("*") if f.is_file()}
    if have != MLPACKAGE_FILES:
        raise SystemExit(f"{pkg.name} holds {sorted(have)}, expected {sorted(MLPACKAGE_FILES)}")


def _stage_coreml(base: Path) -> None:
    """Runs under --coreml-python. torch.export + run_decompositions, with the
    vision pooling head written out as explicit matmuls: coremltools 9 cannot
    convert the head's `nn.MultiheadAttention` (an `int` op on a traced shape —
    the spike's two failures), and the rewrite is exact (max abs diff checked)."""
    import coremltools as ct
    import torch

    model = _load_model(eager=True)
    vm = model.vision_model

    class Vision(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.v = vm

        def forward(self, image):
            h = self.v.embeddings(image * 2.0 - 1.0)
            h = self.v.encoder(inputs_embeds=h).last_hidden_state
            h = self.v.post_layernorm(h)
            head = self.v.head
            mha = head.attention
            e, heads = mha.embed_dim, mha.num_heads
            d = e // heads
            w, b = mha.in_proj_weight, mha.in_proj_bias
            q = torch.nn.functional.linear(head.probe, w[:e], b[:e])
            k = torch.nn.functional.linear(h, w[e : 2 * e], b[e : 2 * e])
            v = torch.nn.functional.linear(h, w[2 * e :], b[2 * e :])
            n = h.shape[1]
            q = q.reshape(1, 1, heads, d).transpose(1, 2)
            k = k.reshape(1, n, heads, d).transpose(1, 2)
            v = v.reshape(1, n, heads, d).transpose(1, 2)
            a = torch.softmax((q @ k.transpose(-1, -2)) / (d**0.5), dim=-1) @ v
            a = mha.out_proj(a.transpose(1, 2).reshape(1, 1, e))
            a = a + head.mlp(head.layernorm(a))
            return a[:, 0]

    x = torch.rand(1, 3, IMGSZ, IMGSZ)
    with torch.no_grad():
        ref = _features(model.get_image_features(pixel_values=x * 2 - 1))
        diff = float((Vision()(x) - ref).abs().max())
    if diff > 1e-4:
        raise SystemExit(f"rewritten vision head differs from HF by {diff}")
    with torch.no_grad():
        exported = torch.export.export(Vision().eval(), (x,)).run_decompositions({})
    ml = ct.convert(
        exported,
        inputs=[ct.ImageType(name="image", shape=(1, 3, IMGSZ, IMGSZ), scale=1 / 255.0,
                             color_layout=ct.colorlayout.RGB)],
        outputs=[ct.TensorType(name="embedding")],
        convert_to="mlprogram",
        compute_precision=ct.precision.FLOAT16,
        minimum_deployment_target=ct.target.macOS13,
    )
    ml.short_description = "SigLIP2 B/16-224 vision encoder (Apache-2.0, Google), CamStack build"
    ml.license = "Apache-2.0"
    (base / "coreml").mkdir(parents=True, exist_ok=True)
    ml.save(str(base / VISION_ML))
    _strip_mlpackage(base / VISION_ML)
    print(f"  ✓ {VISION_ML} ({_size(base / VISION_ML) / 1e6:.0f} MB; head rewrite max diff {diff:.2e})")

    # Text: never loaded by CamStack (the encoder's text path is onnxruntime),
    # built because the format set asks for it. `torch.export` refuses the text
    # tower (`Unsupported fx node alias`); `jit.trace` converts it, and nothing
    # in it is shape-dependent at a fixed 64-token input. Verified here against
    # torch fp32 on real token ids (the tokenizer the ONNX path ships).
    import numpy as np
    from tokenizers import Tokenizer

    class Text(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.t = model.text_model

        def forward(self, input_ids):
            return self.t(input_ids=input_ids).pooler_output

    ids = torch.zeros(1, TEXT_POSITIONS, dtype=torch.int32)
    with torch.no_grad():
        traced = torch.jit.trace(Text().eval(), ids)
    ml_t = ct.convert(
        traced,
        inputs=[ct.TensorType(name="input_ids", shape=(1, TEXT_POSITIONS), dtype=np.int32)],
        outputs=[ct.TensorType(name="embedding")],
        convert_to="mlprogram",
        compute_precision=ct.precision.FLOAT16,
        minimum_deployment_target=ct.target.macOS13,
    )
    ml_t.short_description = "SigLIP2 B/16-224 text encoder (Apache-2.0, Google), CamStack build"
    ml_t.license = "Apache-2.0"
    ml_t.save(str(base / TEXT_ML))
    _strip_mlpackage(base / TEXT_ML)
    tok = Tokenizer.from_file(str(base / TOKENIZER))
    tok.enable_truncation(max_length=TEXT_POSITIONS)
    tok.enable_padding(length=TEXT_POSITIONS, pad_id=PAD_ID)
    worst = 1.0
    for q in list(SANITY_QUERIES)[:12]:
        x = np.asarray(tok.encode(q).ids, np.int32)[None]
        with torch.no_grad():
            ref = Text()(torch.from_numpy(x).long()).numpy()
        worst = min(worst, _cos(ml_t.predict({"input_ids": x})["embedding"], ref))
    if worst < TEXT_MIN_COS:
        raise SystemExit(f"CoreML text fp16 vs torch fp32 min cos {worst:.5f} < {TEXT_MIN_COS}")
    print(f"  ✓ {TEXT_ML} ({_size(base / TEXT_ML) / 1e6:.0f} MB; vs torch fp32 min cos {worst:.5f})")


# ───────────────────────────── verification ─────────────────────────────────


def _sanity_images(spike_dir: Path):
    imgs = sorted((spike_dir / "img").glob("*.jpg"))
    if len(imgs) != 20:
        raise SystemExit(f"expected the spike's 20 sanity images in {spike_dir / 'img'}, found {len(imgs)}")
    return imgs


def _pool_tensor(path: Path):
    """The pool's float path: bilinear stretch to 224, /255, NCHW."""
    import numpy as np
    from PIL import Image

    im = Image.open(path).convert("RGB").resize((IMGSZ, IMGSZ), Image.BILINEAR)
    u8 = np.asarray(im, np.uint8)
    return im, u8, (u8.astype(np.float32) / 255.0).transpose(2, 0, 1)[None]


def _verify(base: Path, text32: Path, spike_dir: Path, want_coreml_python: str | None) -> dict:
    import numpy as np
    import onnxruntime as ort
    import openvino as ov
    import torch
    from openvino import Layout, Type
    from openvino.preprocess import PrePostProcessor
    from tokenizers import Tokenizer
    from transformers import AutoProcessor

    report: dict = {}
    model = _load_model()
    proc = AutoProcessor.from_pretrained(REPO, revision=REVISION)
    imgs = _sanity_images(spike_dir)

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 4
    vis = ort.InferenceSession(str(base / VISION_ONNX), opts, providers=["CPUExecutionProvider"])

    # a. baked norm vs the HF model on its own normalisation
    worst = 1.0
    for p in imgs[:8]:
        _, _, x = _pool_tensor(p)
        with torch.no_grad():
            ref = _features(model.get_image_features(pixel_values=torch.from_numpy(x) * 2 - 1)).numpy()
        worst = min(worst, _cos(vis.run(None, {"image": x})[0], ref))
    report["bake_min_cos"] = worst
    _require(worst >= BAKE_MIN_COS, f"baked 2x-1: ONNX vs HF min cos {worst:.6f} >= {BAKE_MIN_COS}")

    # b. dynamic batch
    xs = np.concatenate([_pool_tensor(p)[2] for p in imgs[:2]])
    both = vis.run(None, {"image": xs})[0]
    one = [vis.run(None, {"image": xs[i : i + 1]})[0][0] for i in range(2)]
    bdiff = float(max(np.abs(both[i] - one[i]).max() for i in range(2)))
    _require(bdiff < 1e-3, f"dynamic batch: batch-2 == 2×batch-1 (max abs {bdiff:.2e})")

    # c. OpenVINO vision through the pool's PPP u8 → f32 /255 path
    core = ov.Core()
    m = core.read_model(str(base / VISION_OV))
    ppp = PrePostProcessor(m)
    ppp.input().tensor().set_element_type(Type.u8).set_layout(Layout("NHWC"))
    ppp.input().model().set_layout(Layout("NCHW"))
    ppp.input().preprocess().convert_element_type(Type.f32).scale([255.0, 255.0, 255.0])
    ov_vis = core.compile_model(ppp.build(), "CPU")
    ref_vecs, ov_vecs = [], []
    for p in imgs:
        _, u8, x = _pool_tensor(p)
        ref_vecs.append(_l2(vis.run(None, {"image": x})[0]))
        ov_vecs.append(_l2(ov_vis(u8[None])[0]))
    worst = min(float(a @ b) for a, b in zip(ref_vecs, ov_vecs))
    report["openvino_vision_min_cos"] = worst
    _require(worst >= OV_VISION_MIN_COS, f"OpenVINO vision fp16 vs ONNX fp32 min cos {worst:.4f} >= {OV_VISION_MIN_COS}")

    # d. CoreML vision, in the coreml interpreter (it owns coremltools)
    if want_coreml_python is not None and (base / VISION_ML).exists():
        np.save(base.parent / "_ref_vecs.npy", np.stack(ref_vecs))
        run = subprocess.run(
            [want_coreml_python, __file__, "--stage", "verify-coreml", str(base), str(spike_dir)],
            capture_output=True, text=True,
        )
        (base.parent / "_ref_vecs.npy").unlink(missing_ok=True)
        if run.returncode != 0:
            raise SystemExit(f"CoreML verification failed:\n{run.stderr[-2000:]}")
        worst = float(run.stdout.strip().splitlines()[-1])
        report["coreml_vision_min_cos"] = worst
        _require(worst >= COREML_VISION_MIN_COS, f"CoreML vision fp16 vs ONNX fp32 min cos {worst:.4f} >= {COREML_VISION_MIN_COS}")

    # e. tokenizer parity
    tok = Tokenizer.from_file(str(base / TOKENIZER))
    tok.enable_truncation(max_length=TEXT_POSITIONS)
    tok.enable_padding(length=TEXT_POSITIONS, pad_id=PAD_ID)
    mismatches = []
    for t in TOKENIZER_PARITY_TEXTS:
        want = proc(text=[t.lower()], padding="max_length", max_length=TEXT_POSITIONS,
                    truncation=True, return_tensors="np")["input_ids"][0].tolist()
        got = tok.encode(t).ids
        if got != want:
            mismatches.append(t)
    report["tokenizer_parity"] = f"{len(TOKENIZER_PARITY_TEXTS) - len(mismatches)}/{len(TOKENIZER_PARITY_TEXTS)}"
    _require(not mismatches, f"tokenizer ids == reference processor(text.lower()) on {report['tokenizer_parity']} {mismatches}")
    if proc.tokenizer.pad_token_id != PAD_ID:
        raise SystemExit(f"upstream pad id is {proc.tokenizer.pad_token_id}, the meta says {PAD_ID}")

    # f. text: slice, fp16 and OpenVINO against torch fp32
    t16 = ort.InferenceSession(str(base / TEXT_ONNX), providers=["CPUExecutionProvider"])
    tov = core.compile_model(str(base / TEXT_OV), "CPU")
    tok77 = Tokenizer.from_file(str(base / TOKENIZER))
    tok77.enable_truncation(max_length=LEGACY_CONTEXT)
    tok77.enable_padding(length=LEGACY_CONTEXT, pad_id=PAD_ID)
    worst16 = worst_ov = 1.0
    slice_diff = 0.0
    for q in list(SANITY_QUERIES)[:12]:
        ids64 = np.asarray(tok.encode(q).ids, np.int64)[None]
        ids77 = np.asarray(tok77.encode(q).ids, np.int64)[None]
        with torch.no_grad():
            ref = _features(model.get_text_features(input_ids=torch.from_numpy(ids64))).numpy()
        e64 = t16.run(None, {"input_ids": ids64})[0]
        e77 = t16.run(None, {"input_ids": ids77})[0]
        slice_diff = max(slice_diff, float(np.abs(e64 - e77).max()))
        worst16 = min(worst16, _cos(e64, ref))
        worst_ov = min(worst_ov, _cos(tov(ids64)[0], ref))
    report["text_slice_max_abs"] = slice_diff
    report["text_onnx_fp16_min_cos"] = worst16
    report["text_openvino_min_cos"] = worst_ov
    _require(slice_diff <= SLICE_MAX_ABS, f"text slice: 77-wide == 64-wide (max abs {slice_diff:.2e})")
    _require(worst16 >= TEXT_MIN_COS, f"text ONNX fp16 vs torch fp32 min cos {worst16:.5f} >= {TEXT_MIN_COS}")
    _require(worst_ov >= TEXT_MIN_COS, f"text OpenVINO vs torch fp32 min cos {worst_ov:.5f} >= {TEXT_MIN_COS}")
    del text32  # only the fp16 artefact ships

    # g. the embedding SPACE, through the shipped formats (D209)
    ids_by_img = [p.stem[-5:] for p in imgs]
    image_matrix = np.stack(ov_vecs)
    r1 = 0
    pos = []
    for q, rel in SANITY_QUERIES.items():
        qv = _l2(t16.run(None, {"input_ids": np.asarray(tok.encode(q).ids, np.int64)[None]})[0])
        sims = image_matrix @ qv
        r1 += ids_by_img[int(np.argmax(sims))] in rel
        pos += [float(sims[ids_by_img.index(r)]) for r in rel]
    report["space_r1"] = f"{r1}/{len(SANITY_QUERIES)}"
    report["space_matched_cos"] = [round(min(pos), 3), round(float(np.mean(pos)), 3), round(max(pos), 3)]
    _require(r1 >= SPACE_MIN_R1, f"space: R@1 {r1}/{len(SANITY_QUERIES)} >= {SPACE_MIN_R1} (OpenVINO vision × ONNX text)")
    lo, hi = SPACE_POS_COS
    _require(lo <= float(np.mean(pos)) <= hi, f"space: matched image-text cos mean {np.mean(pos):.3f} in [{lo}, {hi}]")
    return report


def _stage_verify_coreml(base: Path, spike_dir: Path) -> None:
    import coremltools as ct
    import numpy as np

    ref = np.load(base.parent / "_ref_vecs.npy")
    ml = ct.models.MLModel(str(base / VISION_ML), compute_units=ct.ComputeUnit.ALL)
    worst = 1.0
    for i, p in enumerate(_sanity_images(spike_dir)):
        im, _, _ = _pool_tensor(p)
        worst = min(worst, float(ref[i] @ _l2(ml.predict({"image": im})["embedding"])))
    print(worst)


# ───────────────────────────── upload (additive) ────────────────────────────


def _hf_token(root: Path) -> str:
    token = os.environ.get("HF_TOKEN", "")
    env_file = Path(os.environ.get("CAMSTACK_ENV_FILE", root / "server" / "backend" / ".env"))
    if not token and env_file.is_file():
        for line in env_file.read_text().splitlines():
            if line.startswith("HF_TOKEN="):
                token = line.split("=", 1)[1].strip().strip("\"'")
    if not token:
        raise SystemExit("no HF_TOKEN in the environment or server/backend/.env")
    return token


def _upload(base: Path) -> None:
    """ADD files under clip/siglip2/ only. Refuses when ANY staged path already
    exists on the Hub — never overwrites, never deletes."""
    from huggingface_hub import HfApi

    root = Path(__file__).resolve().parents[1]
    api = HfApi(token=_hf_token(root))
    remote = set(api.list_repo_files(HF_REPO_ID, repo_type="model"))
    files = [p for p in base.rglob("*") if p.is_file()]
    # A CoreML load writes a `.coreml-cache/` (compiled model) next to the
    # package, and macOS drops `.DS_Store`: neither is an artefact.
    hidden = [p for p in files if any(part.startswith(".") for part in p.relative_to(base).parts)]
    if hidden:
        raise SystemExit(f"refusing: hidden files in the stage (remove them first): {hidden[:3]}")
    staged = sorted(f"{HF_FOLDER}/{p.relative_to(base).as_posix()}" for p in files)
    clash = [p for p in staged if p in remote]
    if clash:
        raise SystemExit(f"refusing: {len(clash)} path(s) already on the Hub, e.g. {clash[:3]}")
    outside = [p for p in staged if not p.startswith(f"{HF_FOLDER}/")]
    if outside:
        raise SystemExit(f"refusing: paths outside {HF_FOLDER}/: {outside[:3]}")
    print(f"→ uploading {len(staged)} new files to {HF_REPO_ID}/{HF_FOLDER}/")
    commit = api.upload_folder(
        repo_id=HF_REPO_ID, repo_type="model", folder_path=str(base), path_in_repo=HF_FOLDER,
        commit_message="feat: SigLIP2 B/16-224 (Apache-2.0) vision + text builds",
        commit_description="Adds clip/siglip2/: vision (ONNX fp32 reference, OpenVINO fp16, CoreML fp16), "
        "text (ONNX fp16, OpenVINO fp16, CoreML fp16), a lower-casing tokenizer and the model card. "
        "Built by scripts/build-siglip2-model.py. No existing file is touched.",
    )
    print(f"  ✓ commit {commit.oid if hasattr(commit, 'oid') else commit}")


# ───────────────────────────── main ─────────────────────────────────────────


def main() -> None:
    sys.stdout.reconfigure(line_buffering=True)
    if len(sys.argv) > 2 and sys.argv[1] == "--stage":
        stage, rest = sys.argv[2], [Path(a) for a in sys.argv[3:]]
        if stage == "coreml":
            _stage_coreml(*rest)
        elif stage == "verify-coreml":
            _stage_verify_coreml(*rest)
        else:
            raise SystemExit(f"unknown stage {stage}")
        return

    ap = argparse.ArgumentParser()
    ap.add_argument("work", type=Path)
    ap.add_argument("--coreml-python", help="interpreter with coremltools (darwin); omit to skip CoreML")
    ap.add_argument("--spike-dir", type=Path, help="dir holding img/ (the 20 sanity images)")
    ap.add_argument("--skip-verify", action="store_true")
    ap.add_argument("--upload", action="store_true", help="upload an already-built stage, additively")
    args = ap.parse_args()

    work = args.work.resolve()
    base = work / "stage" / "clip" / "siglip2"
    if args.upload:
        _upload(base)
        return

    shutil.rmtree(base, ignore_errors=True)
    base.mkdir(parents=True)
    print("→ ONNX export (vision fp32 dynamic batch; text fp32 sliced to 64)")
    text32 = _export_onnx(base, work)
    print("→ text ONNX fp16")
    _text_fp16(text32, base / TEXT_ONNX)
    print("→ OpenVINO IR fp16")
    _openvino(base / VISION_ONNX, base / VISION_OV)
    _openvino(text32, base / TEXT_OV)
    print("→ tokenizer (lower-casing)")
    _tokenizer(base / TOKENIZER)
    if args.coreml_python:
        print("→ CoreML fp16 (torch.export, in the coreml interpreter)")
        run = subprocess.run([args.coreml_python, __file__, "--stage", "coreml", str(base)])
        if run.returncode != 0:
            raise SystemExit(f"CoreML stage failed (exit {run.returncode})")
    else:
        print("⊘ CoreML skipped — pass --coreml-python")
    (base / "README.md").write_text(MODEL_CARD)
    print("  ✓ README.md (model card)")

    report: dict = {}
    if not args.skip_verify:
        if args.spike_dir is None:
            raise SystemExit("--spike-dir is required for verification (or pass --skip-verify)")
        print("→ verification")
        report = _verify(base, text32, args.spike_dir.resolve(), args.coreml_python)

    files = {}
    for rel in [VISION_ONNX, TEXT_ONNX, TOKENIZER, VISION_OV, TEXT_OV, VISION_ML, TEXT_ML, "README.md"]:
        path = base / rel
        if not path.exists():
            continue
        entry = {"bytes": _size(path), "mb": round(_size(path) / 1e6, 1)}
        if path.is_file():
            entry["sha256"] = _sha256(path)
        if path.suffix == ".xml":
            entry["bin_sha256"] = _sha256(path.with_suffix(".bin"))
        if path.is_dir():
            entry["files"] = {
                f.relative_to(path).as_posix(): _sha256(f) for f in sorted(path.rglob("*")) if f.is_file()
            }
        files[rel] = entry
    manifest = {"repo": REPO, "revision": REVISION, "context_length": TEXT_POSITIONS, "pad_id": PAD_ID,
                "embedding_dim": 768, "input_size": IMGSZ, "verify": report, "files": files}
    (work / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps({k: v for k, v in manifest.items() if k != "files"}, indent=2))
    for rel, entry in files.items():
        print(f"  {rel}: {entry['mb']} MB {entry.get('sha256', '')}")
    print(f"\nReady to publish: {base}\n  python3 {__file__} {work} --upload")


if __name__ == "__main__":
    main()
