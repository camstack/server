"""Fixed-slot license-plate recognition postprocessor.

Used for: `cct-s-v2-global` (fast-plate-ocr), the plate-OCR default since
2026-08-20.

Input: the `plate` head, ``[1, PLATE_SLOTS, VOCAB]`` (or the flattened
``[1, PLATE_SLOTS * VOCAB]``) — an INDEPENDENT softmax per character position,
already normalised inside the graph.
Output: ``{"kind": "text", "text": "DNRO309", "confidence": 0.99,
"formatValid": true}`` — the same StepOutput shape the CTC path produces, so
nothing downstream (the label writer, the D186 per-track vote) changes.

Why this is not `ctc.py`
------------------------
The two readers fail in opposite directions and that dictates opposite gates.

A CTC recognizer fed noise collapses toward the blank: the decode comes out one
or two characters long, which is why "at least `minTextLength` alphanumerics"
was a sound plausibility gate for `vgg_english_g2`. A fixed-slot reader has no
blank. It runs `PLATE_SLOTS` classification heads and every one of them picks a
winner, on a plate, on a bumper, on an OSD weather band. Length carries no
information here — `minTextLength` would admit literally every ROI the detector
ever hands over.

What DOES separate them is calibration, and only at the weakest position. On the
39-crop cam-102 ground-truth set (21 plates, 9 vehicles, 18 junk ROIs) every
correct read has a minimum per-character probability of 0.80 or better, while no
junk ROI reaches it; the misreads that do get close are wrong in exactly one
slot, and that slot is the one that dips. The MEAN hides this — six confident
glyphs and one guess still average ~0.9 — so the gate reads the MINIMUM.

Second gate: the region grammar (`plateRegion`, shared with `ctc.py` so there is
one German plate pattern in this codebase, not two). Here a non-conforming read
is DROPPED rather than kept-and-annotated. That differs from the CTC path on
purpose: this alphabet is 36 alphanumerics plus a pad, so it cannot emit the
"obviously not a plate" shapes (`[miv4o)`, `6ou.2`) that made an annotated read
worth storing — a non-conforming read here is a confident misread, which is the
one thing that must never reach a label.

No confusable rescoring
-----------------------
`ctc.py` repairs a grammar failure by substituting 0↔O, 1↔I, 5↔S… That machinery
exists because `vgg_english_g2` decodes from a 97-glyph English charset where
case and punctuation are live classes. This alphabet has neither, so the only
surviving confusion is 0↔O — and, run over the 39-crop set at the shipped
operating point, the rescorer fires on zero crops. An unfired repair path is a
path nothing verifies, so it is not here. If a future set shows it firing, take
it from `ctc.py`: `_rescore_for_grammar` is already position/probability
indexed, and a slot index is exactly the "aligned timestep" it wants.
"""
import re

import numpy as np

from .ctc import ABSENT_PLATE_REGION, PLATE_GRAMMARS

# The `cct_s_v2_global_plate_config.yaml` contract, published beside the weights.
# Class indices are positions in this string; a drift re-maps every glyph.
PLATE_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_"
PLATE_PAD_CHAR = "_"
PLATE_SLOTS = 10

# Minimum probability the WEAKEST emitted character must carry.
#
# 0.75 is not a round number picked for taste — it is the centre of the band
# that separates the two populations on the cam-102 set WITH THE INFERENCE
# PRECISION SPREAD INCLUDED. Taking, per crop, the worst case across ONNX fp32,
# OpenVINO fp16 and CoreML: the highest-scoring junk ROI that also conforms to
# the German grammar reaches 0.728, and the lowest-scoring correct plate that
# still has to be read sits at 0.779. Anything inside (0.728, 0.779) stores
# every one of those plates and none of that junk on every engine.
#
# The band matters because a plate recognizer does not get to choose its
# arithmetic: OpenVINO's CPU default inference precision is fp16, an Intel NPU
# has no other option, and a marginal crop's weakest character moves by as much
# as 0.16 between engines. A floor chosen from one engine's numbers would be a
# different filter on the next node.
#
# The two sides of the band are not symmetric, which is why 0.75 leans up. Too
# LOW stores a wrong plate, and nothing downstream can undo that. Too HIGH
# silences a marginal read — and the step runs up to `maxPerTrack` times per
# track with the reads voted (D186), so the next frame gets another go.
#
# Config-overridable (`minCharProbability`).
DEFAULT_MIN_CHAR_PROBABILITY = 0.75

# Name of the plate head in the published graph. The region head (`region`,
# [1,66]) rides along; it is NOT consulted — at this floor every junk ROI it
# would have caught is already below the confidence gate, and a second gate
# nothing removes is a second thing to keep true.
PLATE_OUTPUT_NAME = "plate"


def _select_plate_logits(predictions: dict) -> np.ndarray:
    """Return the plate head as ``[PLATE_SLOTS, VOCAB]``.

    By NAME first — the graph has two outputs and dict ordering is not a
    contract. By SHAPE as the fallback, so an engine whose exporter dropped the
    tensor names still decodes the right head rather than the region logits.
    """
    vocab = len(PLATE_ALPHABET)
    expected = PLATE_SLOTS * vocab
    candidate = predictions.get(PLATE_OUTPUT_NAME)
    if candidate is None:
        for value in predictions.values():
            array = np.asarray(value)
            if array.size == expected:
                candidate = array
                break
    if candidate is None:
        raise ValueError(
            f"no plate head in predictions {sorted(predictions)}: "
            f"expected an output of {expected} values"
        )
    array = np.asarray(candidate, dtype=np.float32)
    if array.size != expected:
        raise ValueError(
            f"plate head has {array.size} values, expected "
            f"{PLATE_SLOTS}x{vocab}={expected}"
        )
    return array.reshape(PLATE_SLOTS, vocab)


def postprocess_plate_slots(
    predictions: dict,
    config: dict,
    orig_w: int,
    orig_h: int,
    scale: float,
    pad: tuple[int, int],
) -> dict:
    """Per-slot argmax decode + confidence floor + region grammar."""
    probs = _select_plate_logits(predictions)
    alphabet = str(config.get("plateAlphabet") or PLATE_ALPHABET)
    pad_char = str(config.get("platePadChar") or PLATE_PAD_CHAR)
    min_char_prob = float(
        config.get("minCharProbability", DEFAULT_MIN_CHAR_PROBABILITY)
    )
    region = str(config.get("plateRegion", ABSENT_PLATE_REGION))

    winners = np.argmax(probs, axis=-1)
    scores = probs[np.arange(len(winners)), winners]
    decoded = "".join(alphabet[int(i)] for i in winners)

    # Trailing pad is the model's length signal; strip it and keep the scores of
    # the glyphs that survive aligned with them.
    text = decoded.rstrip(pad_char)
    kept = [float(s) for s in scores[: len(text)]]
    confidence = round(float(np.mean(kept)), 4) if kept else 0.0

    def silent() -> dict:
        return {"kind": "text", "text": "", "confidence": confidence}

    if not text:
        return silent()
    # A pad the model placed BETWEEN glyphs is a refusal at a position it
    # believes exists — never a plate, and never something to paper over.
    if pad_char in text:
        return silent()
    if min(kept) < min_char_prob:
        return silent()

    pattern_src = PLATE_GRAMMARS.get(region) if region != "off" else None
    if pattern_src is None:
        # No grammar for this region (or rescoring disabled): the read stands on
        # the confidence gate alone, and says so.
        return {
            "kind": "text",
            "text": text,
            "confidence": confidence,
            "formatValid": False,
        }
    if re.match(pattern_src, text) is None:
        return silent()
    return {
        "kind": "text",
        "text": text,
        "confidence": confidence,
        "formatValid": True,
    }
