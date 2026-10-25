#!/usr/bin/env python3
"""Reference-parity test for the CLIP text tokenization done in Python.

Proves the HF `tokenizers` Rust BPE (loaded from the same hosted
CLIP BPE `tokenizer.json`, e.g. openai/clip-vit-base-patch32's) reproduces the
canonical CLIP reference ids and pads/truncates to the fixed 77-token context
window — i.e. tokenization is exact by construction, replacing the former
hand-rolled TypeScript BPE.

The SigLIP2 case (D649) pins the model's OWN window: 64 tokens, pad 0, and the
hosted tokenizer's Lowercase normalizer. Its reference ids are the upstream
`transformers` processor fed `text.lower()` with `padding='max_length',
max_length=64` (google/siglip2-base-patch16-224 @ 75de2d55), recorded
2026-09-26. `scripts/build-siglip2-model.py` checks the same parity on 24 texts
before an upload.

Run in a throwaway venv with the embedding requirements installed:

    python3 -m venv /tmp/tokv
    /tmp/tokv/bin/pip install tokenizers onnxruntime numpy
    /tmp/tokv/bin/python -m pytest packages/addon-post-analysis/python/test_text_encoder.py
"""
from __future__ import annotations

import os

import pytest

from text_encoder_inference import DEFAULT_CONTEXT_LENGTH, build_tokenizer

# A locally-staged CLIP BPE tokenizer.json (the MobileCLIP copy left the
# mirror with D703; any CLIP BPE tokenizer.json yields the same ids).
TOKENIZER_PATH = os.environ.get(
    "CLIP_TOKENIZER_JSON", "/tmp/clip/tokenizer.json"
)

# Ground-truth ids from the HF `tokenizers` reference (include SOT 49406 + EOT
# 49407, exclude padding). The Python tokenization MUST reproduce these exactly.
REFERENCE_TEXT = "a photo of a cat"
REFERENCE_IDS = [49406, 320, 1125, 539, 320, 2368, 49407]


@pytest.mark.skipif(
    not os.path.exists(TOKENIZER_PATH),
    reason=f"tokenizer.json not staged at {TOKENIZER_PATH}",
)
def test_clip_reference_parity_and_padding() -> None:
    tokenizer = build_tokenizer(TOKENIZER_PATH)
    encoded = tokenizer.encode(REFERENCE_TEXT)

    # The first 7 ids are SOT + 5 body tokens + EOT — the canonical CLIP ids.
    assert encoded.ids[:7] == REFERENCE_IDS
    # truncation + padding fixed the sequence to exactly the CLIP context window.
    assert len(encoded.ids) == DEFAULT_CONTEXT_LENGTH
    # Everything after the reference ids is pad (id 0).
    assert all(i == 0 for i in encoded.ids[7:])


# The hosted SigLIP2 tokenizer (sibling of the SigLIP2 text onnx).
SIGLIP2_TOKENIZER_PATH = os.environ.get(
    "SIGLIP2_TOKENIZER_JSON", "/tmp/siglip2/camstack-siglip2-b16-224-tokenizer.json"
)
SIGLIP2_CONTEXT_LENGTH = 64

# Reference ids WITHOUT padding (EOS = 1). Mixed case on purpose: the processor
# does not lower-case, the model was trained lower-cased, the hosted tokenizer
# does it — so the raw operator query must tokenise like its lower-cased form.
SIGLIP2_REFERENCE = {
    "a photo of a cat": [235250, 2686, 576, 476, 4401, 1],
    "A Person Walking A DOG at night": [235250, 1552, 10350, 476, 5929, 696, 3354, 1],
    "un gatto sul divano": [549, 157593, 7809, 751, 22801, 1],
}


@pytest.mark.skipif(
    not os.path.exists(SIGLIP2_TOKENIZER_PATH),
    reason=f"SigLIP2 tokenizer not staged at {SIGLIP2_TOKENIZER_PATH}",
)
def test_siglip2_reference_parity_in_its_own_window() -> None:
    tokenizer = build_tokenizer(SIGLIP2_TOKENIZER_PATH, SIGLIP2_CONTEXT_LENGTH, 0)
    for text, ref in SIGLIP2_REFERENCE.items():
        ids = tokenizer.encode(text).ids
        assert ids[: len(ref)] == ref, text
        assert len(ids) == SIGLIP2_CONTEXT_LENGTH
        assert all(i == 0 for i in ids[len(ref) :])


@pytest.mark.skipif(
    not os.path.exists(TOKENIZER_PATH),
    reason=f"tokenizer.json not staged at {TOKENIZER_PATH}",
)
def test_defaults_are_the_clip_window() -> None:
    """Called with no window, the tokenizer is byte-identical to before D649."""
    assert build_tokenizer(TOKENIZER_PATH).encode(REFERENCE_TEXT).ids == build_tokenizer(
        TOKENIZER_PATH, 77, 0
    ).encode(REFERENCE_TEXT).ids
