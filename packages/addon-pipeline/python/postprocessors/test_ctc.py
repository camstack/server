"""Tests for the CTC (plate-OCR) postprocessor.

Locks in the two properties that keep license-plate recognition correct:

1. **Decode + charset calibration** — greedy argmax → collapse consecutive
   duplicates → drop the CTC blank → map through the `vgg_english_g2`
   ``VGG_G2_CHARSET`` (index 0 blank, digits 1–10, symbols 11–43, one extra
   symbol slot at 44, letters A–Z/a–z at 45–96). This charset alignment is the
   empirically-calibrated off-by-one fix (commit fe5f34b4c). A regression here
   silently returns systematically wrong letters (e.g. "DWRO" → "EXSP").

2. **Plausibility gate** — a too-low-resolution / blurred plate collapses the
   logit map toward the blank and greedy decode emits a spurious 1–2 char read;
   the gate returns empty text so noise is never stored as a plate label. The
   charset/decode are proven correct via captured REAL logits from the ONNX
   model on crisp synthetic text (no model needed at test time).
"""
import base64
import gzip
import io
import os

import numpy as np

from ctc import (
    DEFAULT_MIN_TEXT_LENGTH,
    MAX_SUBST_POSITIONS,
    postprocess_ctc,
)

# ---------------------------------------------------------------------------
# VGG_G2_CHARSET — mirrors packages/.../registry/step-definitions.ts. The TS
# copy is the runtime source of truth (passed in via config); this local build
# lets the decode be tested hermetically. `test_charset_structure` locks the
# exact index→glyph contract so the two can't silently drift.
# ---------------------------------------------------------------------------
VGG_G2_CHARSET = (
    [""]
    + list("0123456789")
    + list("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~ ")
    + [" "]
    + list("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")
)

TESTDATA = os.path.join(os.path.dirname(__file__), "testdata")


def _one_hot_logits(indices, num_chars=97, peak=10.0):
    """Build a [T, C] logit map whose per-timestep argmax is `indices`."""
    num_chars = max(num_chars, max(indices) + 1)
    seq = np.full((len(indices), num_chars), -peak, dtype=np.float32)
    for t, idx in enumerate(indices):
        seq[t, idx] = peak
    return seq[np.newaxis]  # [1, T, C]


def _decode(indices, config=None):
    cfg = {"charset": VGG_G2_CHARSET}
    if config:
        cfg.update(config)
    return postprocess_ctc({"o": _one_hot_logits(indices)}, cfg, 110, 70, 1.0, (0, 0))


def _indices(text):
    """Map a plate string to its VGG_G2_CHARSET argmax index sequence.

    A CTC blank (index 0) is interleaved between consecutive identical glyphs so
    a true repeat (the BB in "DNBB722", the 22 in "…722") survives the
    duplicate-collapse instead of merging into one character.
    """
    out = []
    prev = None
    for c in text:
        idx = VGG_G2_CHARSET.index(c)
        if idx == prev:
            out.append(0)  # blank separates a genuine repeat
        out.append(idx)
        prev = idx
    return out


def _read(text, config=None):
    """Decode the one-hot logits for `text` with the DE grammar active.

    (`_decode` leaves `plateRegion` absent → 'off'; `_read` opts the DE grammar
    in so the rescoring tests exercise the product default.)
    """
    cfg = {"plateRegion": "DE"}
    if config:
        cfg.update(config)
    return _decode(_indices(text), cfg)


def _load_logits(name):
    raw = gzip.decompress(base64.b64decode(open(os.path.join(TESTDATA, name)).read()))
    return np.load(io.BytesIO(raw)).astype(np.float32)  # [T, C] float16→float32


# ---------------------------------------------------------------------------
# Charset structure (the off-by-one calibration)
# ---------------------------------------------------------------------------
def test_charset_structure():
    assert len(VGG_G2_CHARSET) == 97  # 1 blank + 10 digits + 33 symbols + 1 + 52
    assert VGG_G2_CHARSET[0] == ""  # CTC blank
    assert "".join(VGG_G2_CHARSET[1:11]) == "0123456789"
    assert VGG_G2_CHARSET[44] == " "  # the extra symbol slot that realigns letters
    # Letters start at 45 — this is the calibration that fixes "DWRO"→"EXSP".
    assert VGG_G2_CHARSET[45] == "A"
    assert VGG_G2_CHARSET[48] == "D"
    assert VGG_G2_CHARSET[70] == "Z"
    assert VGG_G2_CHARSET[71] == "a"


# ---------------------------------------------------------------------------
# Greedy CTC decode mechanics
# ---------------------------------------------------------------------------
def test_collapses_consecutive_duplicates():
    # D D W  R R O -> DWRO (D=48, W=67, R=62, O=59).
    assert _decode([48, 48, 67, 62, 62, 59])["text"] == "DWRO"


def test_removes_blank_token():
    # blanks (index 0) interleaved must be dropped AND allow a true repeat:
    # A blank A B C → the blank breaks the collapse so both A's survive → "AABC".
    assert _decode([45, 0, 45, 46, 47])["text"] == "AABC"


def test_dwro309_index_sequence_decodes_exactly():
    # D W R O 3 0 9  → the calibration acceptance string, mechanically.
    idx = [48, 45 + 22, 45 + 17, 45 + 14, 1 + 3, 1, 1 + 9]
    assert _decode(idx)["text"] == "DWRO309"


def test_alphabet_maps_one_to_one():
    idx = [45 + i for i in range(26)]  # A..Z
    assert _decode(idx)["text"] == "ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def test_out_of_range_index_falls_back_to_chr():
    # Defensive path: an index beyond the charset uses chr(idx) rather than crash.
    # (The real model never emits this; guards against a charset/model mismatch.)
    out = _decode([200, 201, 202])
    assert out["kind"] == "text"
    assert out["text"] == "".join(chr(i) for i in (200, 201, 202))


# ---------------------------------------------------------------------------
# Captured REAL logits (ONNX vgg_english_g2 on crisp synthetic text)
# ---------------------------------------------------------------------------
def test_real_model_logits_read_dwro309():
    logits = _load_logits("ctc_dwro309_logits.npy.gz.b64")
    out = postprocess_ctc({"o": logits}, {"charset": VGG_G2_CHARSET}, 110, 70, 1.0, (0, 0))
    # The model reads 0 as O on this font; letters D W R O and the digits are
    # correct with NO off-by-one — that is the calibration guarantee.
    assert out["text"] == "DWRO3O9"
    assert out["confidence"] > 0.9


# ---------------------------------------------------------------------------
# Plausibility gate
# ---------------------------------------------------------------------------
def test_gate_suppresses_single_char_noise():
    # A lone high-confidence "A" (the reported degenerate) is NOT a plate.
    assert _decode([45])["text"] == ""


def test_gate_suppresses_real_lowres_collapse():
    # Real ONNX logits from a too-low-resolution plate crop → spurious short read.
    logits = _load_logits("ctc_degenerate_lowres_logits.npy.gz.b64")
    out = postprocess_ctc({"o": logits}, {"charset": VGG_G2_CHARSET}, 110, 70, 1.0, (0, 0))
    assert out["text"] == ""


def test_gate_allows_plausible_plate():
    # Exactly the default minimum length passes.
    assert len("ABC") == DEFAULT_MIN_TEXT_LENGTH
    assert _decode([45, 46, 47])["text"] == "ABC"


def test_gate_length_is_configurable():
    # Lowering the floor lets a 1-char read through (per-camera override).
    assert _decode([45], {"minTextLength": 1})["text"] == "A"


def test_gate_min_length_counts_alnum_only():
    # "AB." decodes to 3 non-space glyphs but only 2 ALPHANUMERIC ones — the
    # min-length check must count alnum only, so the read is suppressed even
    # with the grammar off (symbols never count toward "long enough").
    idx = _indices("AB.")
    assert _decode(idx)["text"] == ""


def test_gate_rejects_symbol_glyphs_when_region_active():
    # Live-observed junk labels (2026-07-22): the charset carries bracket /
    # punctuation glyphs and the length-only gate let them through. With a
    # plate grammar/region ACTIVE, ANY non-alphanumeric glyph (spaces excluded)
    # rejects the read exactly like the other implausible reads.
    for junk in ("[MIV4O)", "6OU.2X", "AB123CD!"):
        out = _read(junk)
        assert out["text"] == "", junk
        assert "formatValid" not in out, junk


def test_gate_symbol_rejection_allows_spaces():
    # Word gaps are real ("DW RO 309") — a space is NOT a symbol glyph.
    out = _read("DWRO309")
    assert out["text"] == "DWRO309"
    idx = _indices("DW RO 309")
    out_spaced = _decode(idx, {"plateRegion": "DE"})
    assert out_spaced["text"] != ""


def test_gate_symbol_glyphs_kept_when_region_off():
    # Region 'off' (or absent) preserves the historical decode byte-for-byte:
    # symbol glyphs pass through un-gated.
    idx = _indices("AB[12")
    assert _decode(idx)["text"] == "AB[12"


def test_gate_confidence_floor():
    # Weak (low-peak) logits: mean confidence below the floor → suppressed.
    seq = _one_hot_logits([45, 46, 47], peak=0.05)  # near-uniform → low softmax conf
    out = postprocess_ctc(
        {"o": seq}, {"charset": VGG_G2_CHARSET, "minTextConfidence": 0.5}, 110, 70, 1.0, (0, 0)
    )
    assert out["text"] == ""


# ---------------------------------------------------------------------------
# Format-aware rescoring — GERMANY ('DE') grammar
# ---------------------------------------------------------------------------
def test_de_grammar_accepts_conforming_reads():
    # Well-formed German plates: district(1-3) + letters(1-2) + digits(1-4) [+E/H].
    for plate in ("DNBB722", "DNSJ162", "BHKH2294"):
        out = _read(plate)
        assert out["text"] == plate, plate
        assert out["formatValid"] is True, plate


def test_de_grammar_accepts_ev_and_historic_suffix():
    # Optional E (electric) / H (historic) suffix glyph.
    assert _read("MAB1234E")["formatValid"] is True
    assert _read("MAB1234H")["formatValid"] is True


def test_de_rescores_digit_in_letter_block_via_confusable():
    # OCR misread the letter B as digit 8 ("DN8B722"). The raw read fails the
    # grammar (a digit sits in the trailing-letter block); confusable rescoring
    # 8↔B yields "DNBB722", the unique grammar-conforming candidate.
    out = _read("DN8B722")
    assert out["text"] == "DNBB722"
    assert out["formatValid"] is True


def test_de_rescores_zero_for_o_in_letter_block():
    # "B0DE123": the 0 in the second glyph is a misread O → "BODE123".
    out = _read("B0DE123")
    assert out["text"] == "BODE123"
    assert out["formatValid"] is True


def test_de_keeps_original_when_no_candidate_matches():
    # A read with no confusable path to a valid plate is kept verbatim and
    # annotated formatValid=false — validation never DROPS a plausible read.
    out = _read("XYZW")  # all letters, no digits → cannot become a valid plate
    assert out["text"] == "XYZW"
    assert out["formatValid"] is False


def test_de_conforming_read_is_never_altered():
    # A grammar-conforming read containing confusable glyphs (0, 2) must NOT be
    # "corrected" — rescoring only runs on a NON-matching read.
    out = _read("BB2034")  # BB(letters) 2034(digits) — valid, has 0/2
    assert out["text"] == "BB2034"
    assert out["formatValid"] is True


def test_rescoring_prefers_higher_probability_candidate():
    # TWO grammar-valid repairs exist for "8B123" (digit-first → invalid):
    #   - "BB123"  (one swap  8→B; letters BB + digits 123)
    #   - "BBI23"  (two swaps 8→B AND 1→I; letters BBI + digits 23)
    # With one-hot logits every swapped glyph carries ~0 softmax mass, so the
    # FEWER-substitution candidate has the higher mean per-char probability and
    # must win. Verifies the probability-weighted selection, not just "a match".
    out = _read("8B123")
    assert out["text"] == "BB123"
    assert out["formatValid"] is True


def test_probability_weighted_selection_uses_aligned_timestep_mass():
    # Hand-built logits: read "8B12" is digit-first → invalid. The ONLY valid
    # repair is "BB12"; the substituted 'B' at pos0 draws its score from the
    # softmax mass at that aligned timestep. A confident runner-up on 'B' should
    # yield a high formatValid repair regardless of the exact prob value.
    charset = VGG_G2_CHARSET
    b_idx = charset.index("B")
    eight_idx = charset.index("8")
    one_idx = charset.index("1")
    two_idx = charset.index("2")
    seq = np.full((4, 97), -10.0, dtype=np.float32)
    seq[0, eight_idx] = 3.0
    seq[0, b_idx] = 2.9  # strong runner-up → B is a confident repair
    seq[1, b_idx] = 10.0
    seq[2, one_idx] = 10.0
    seq[3, two_idx] = 10.0
    out = postprocess_ctc(
        {"o": seq[np.newaxis]},
        {"charset": charset, "plateRegion": "DE"},
        110,
        70,
        1.0,
        (0, 0),
    )
    assert out["text"] == "BB12"
    assert out["formatValid"] is True


def test_off_region_bypasses_rescoring():
    # region 'off' → no grammar lookup, no formatValid, raw read returned as-is.
    out = _read("DN8B722", {"plateRegion": "off"})
    assert out["text"] == "DN8B722"
    assert "formatValid" not in out


def test_unknown_region_bypasses_rescoring():
    # A region with no grammar entry leaves the read untouched (no annotation).
    out = _read("DN8B722", {"plateRegion": "IT"})
    assert out["text"] == "DN8B722"
    assert "formatValid" not in out


def test_gate_suppression_skips_rescoring():
    # A gate-suppressed (empty) read carries no formatValid annotation.
    out = _decode([45])  # single 'A' → suppressed by length gate
    assert out["text"] == ""
    assert "formatValid" not in out


def test_substitution_position_cap_is_bounded():
    # The candidate search is bounded even when many positions are confusable.
    # A long all-confusable read must not explode; it returns (kept or repaired)
    # within the MAX_SUBST_POSITIONS bound without error.
    assert MAX_SUBST_POSITIONS == 8
    out = _read("0000000000000")  # 13 confusable digits, all substitutable
    # No grammar-valid repair exists (would need a letter block) → kept verbatim.
    assert out["text"] == "0000000000000"
    assert out["formatValid"] is False


# ---------------------------------------------------------------------------
# Normalisation before the grammar (case + separators)
# ---------------------------------------------------------------------------
def test_de_grammar_runs_on_the_normalised_read():
    # The recognizer's charset carries lowercase letters and a space, and the
    # live reads use them: "dn Ro 3o9" is the SAME plate as "DNRO309". Matching
    # the grammar (and enumerating confusables) on the raw string made both the
    # match and the 0↔O repair impossible — the lowercase 'o' is not even a
    # CONFUSABLES key. Upper + alnum-only FIRST, then grammar.
    out = _read("dn Ro 3o9")
    assert out["text"] == "DNRO309"
    assert out["formatValid"] is True


def test_normalised_read_is_returned_even_without_a_repair():
    # Already conforming once normalised — no substitution needed, but the
    # stored text is still the normalised form.
    out = _read("dnbb722")
    assert out["text"] == "DNBB722"
    assert out["formatValid"] is True


def test_normalisation_never_launders_symbol_junk():
    # The symbol gate reads the RAW text, so stripping separators can never turn
    # hallucinated punctuation into a conforming plate.
    out = _read("D[N]R-O309")
    assert out["text"] == ""
    assert "formatValid" not in out


def test_region_off_still_returns_the_raw_read():
    # 'off' stays byte-identical to the historical decode — no normalisation.
    out = _read("dn Ro 3o9", {"plateRegion": "off"})
    assert out["text"] == "dn Ro 3o9"
    assert "formatValid" not in out


# ---------------------------------------------------------------------------
# Seal tolerance (2026-08-20)
# ---------------------------------------------------------------------------
def test_seal_glyph_between_district_and_letters_is_not_junk():
    """A German plate carries a physical SEAL between the district code and the
    letter group, and the recognizer transcribes it as a punctuation glyph.

    Measured on the 2026-08-20 cam-102 ground-truth set (21 crops, 9 vehicles):
    with the quad warp in front of the reader, the correct decodes are
    ``DN.D7578``, ``DN-P 1091``, ``DN:HF 974`` — the plate, exactly, plus the
    seal. The blanket symbol gate returned '' for every one of them, which is
    why the warp alone scored 1/21 instead of 4/21. ONE interior seal glyph is
    dropped, and the read is accepted only if what remains CONFORMS to the
    region grammar — so it can never launder noise.
    """
    for raw, expected in (("DN.D7578", "DND7578"), ("DN-P1091", "DNP1091"), ("DN:HF974", "DNHF974")):
        out = _read(raw)
        assert out["text"] == expected, raw
        assert out["formatValid"] is True, raw


def test_seal_tolerance_does_not_rescue_non_conforming_noise():
    """The rescue is grammar-gated: the live junk of 2026-07-22 stays rejected."""
    for junk in ("6OU.2X", "[MIV4O)", "A.B", "12.34"):
        assert _read(junk)["text"] == "", junk


def test_seal_tolerance_needs_exactly_one_interior_symbol():
    # Two symbols, or a symbol at either end, is hallucination — not a seal.
    for junk in ("DN.D.7578", ".DND7578", "DND7578."):
        assert _read(junk)["text"] == "", junk


def test_seal_tolerance_is_off_when_region_is_off():
    # 'off' preserves the historical decode byte-for-byte.
    idx = _indices("DN.D7578")
    assert _decode(idx, {"plateRegion": "off"})["text"] == "DN.D7578"
