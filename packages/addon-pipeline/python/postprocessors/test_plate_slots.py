"""Tests for the fixed-slot plate-OCR postprocessor (`cct-s-v2-global`).

The properties that make this reader safe are DIFFERENT from the CTC one's, and
that difference is the whole point of the file:

1. **A fixed-slot reader is never silent on its own.** CTC collapses toward the
   blank on noise, so "the string is too short" was a usable plausibility gate.
   This model emits `max_plate_slots` softmax heads on EVERY input, so a wall,
   a bumper and an OSD band all decode to some 7-character string. The gate
   here is therefore a per-character CONFIDENCE FLOOR plus the region grammar —
   `minTextLength` would pass literally everything.

2. **The floor is on the WEAKEST character, not the mean.** A plate misread in
   one position still averages ~0.9; it is the single bad slot that gives it
   away. Measured on the 39-crop cam-102 set: every correct read has min-char
   probability >= 0.75 or is silenced, and no junk ROI clears it on any engine.

3. **Trailing pad is the length signal; interior pad is a refusal.** `_` is a
   real class the model picks when a slot has no glyph. Trailing pads are
   stripped (a 6-glyph plate in 10 slots); a pad in the MIDDLE means the model
   declined a position it thinks exists, and that read is never a plate.
"""
import numpy as np
import pytest

# Package-qualified, unlike the flat `from ctc import` of the sibling suites:
# `plate_slots` imports the shared plate grammar from `ctc`, so it has to be
# loaded AS a package member or the relative import has no parent. Same
# invocation as every other python suite here — `python -m pytest` from this
# directory, which puts both this directory and its parent on sys.path.
from postprocessors.plate_slots import (
    DEFAULT_MIN_CHAR_PROBABILITY,
    PLATE_ALPHABET,
    PLATE_PAD_CHAR,
    PLATE_SLOTS,
    postprocess_plate_slots,
)

VOCAB = len(PLATE_ALPHABET)


def _slots(text: str, prob: float = 0.99, per_slot: "dict[int, float] | None" = None):
    """Build a ``[1, SLOTS, VOCAB]`` softmax whose per-slot argmax spells `text`.

    Slots beyond `text` take the pad class. `per_slot` overrides the winning
    probability at individual positions so a single weak character can be
    tested without weakening the rest.
    """
    padded = text.ljust(PLATE_SLOTS, PLATE_PAD_CHAR)[:PLATE_SLOTS]
    out = np.zeros((PLATE_SLOTS, VOCAB), dtype=np.float32)
    for slot, char in enumerate(padded):
        winner = PLATE_ALPHABET.index(char)
        p = (per_slot or {}).get(slot, prob)
        out[slot] = (1.0 - p) / (VOCAB - 1)
        out[slot, winner] = p
        # A softmax over 37 classes cannot put its argmax below ~1/37, so a
        # fixture asking for less would silently spell a DIFFERENT string and
        # the test would be measuring nothing.
        assert int(np.argmax(out[slot])) == winner, f"slot {slot}: p={p} does not win"
    return out[np.newaxis]


def _read(text: str, config: "dict | None" = None, **kwargs) -> dict:
    cfg = {"plateRegion": "DE"}
    cfg.update(config or {})
    return postprocess_plate_slots({"plate": _slots(text, **kwargs)}, cfg, 128, 64, 1.0, (0, 0))


# --- decode ------------------------------------------------------------------


def test_alphabet_matches_the_published_plate_config():
    """The published `cct_s_v2_global_plate_config.yaml` contract. A drift here
    shifts every class index and the model reads a different alphabet."""
    assert PLATE_ALPHABET == "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_"
    assert PLATE_PAD_CHAR == "_"
    assert PLATE_SLOTS == 10
    assert VOCAB == 37


def test_decodes_the_per_slot_argmax():
    assert _read("DNRO309")["text"] == "DNRO309"


def test_strips_trailing_pad_only():
    assert _read("DNLL78")["text"] == "DNLL78"


def test_interior_pad_is_refused():
    """`DN_RO309` is the model declining slot 2, not a plate with an underscore."""
    assert _read("DN_RO309")["text"] == ""


def test_all_pad_reads_empty():
    assert _read("")["text"] == ""


def test_confidence_is_the_mean_over_kept_characters_only():
    """The pad slots the model is trivially sure about must not inflate it."""
    result = _read("DNLL78", prob=0.8)
    assert result["confidence"] == pytest.approx(0.8, abs=1e-3)


def test_reads_the_plate_output_by_name_not_by_position():
    """The graph emits `plate` AND `region`; dict order is not a contract."""
    predictions = {"region": np.zeros((1, 66), np.float32), "plate": _slots("DNRO309")}
    result = postprocess_plate_slots(predictions, {"plateRegion": "DE"}, 128, 64, 1.0, (0, 0))
    assert result["text"] == "DNRO309"


def test_flat_output_is_reshaped():
    """A [1, slots*vocab] export decodes identically to the [1, slots, vocab] one."""
    flat = _slots("DNRO309").reshape(1, PLATE_SLOTS * VOCAB)
    result = postprocess_plate_slots({"plate": flat}, {"plateRegion": "DE"}, 128, 64, 1.0, (0, 0))
    assert result["text"] == "DNRO309"


def test_wrong_sized_output_is_refused_not_guessed():
    with pytest.raises(ValueError):
        postprocess_plate_slots(
            {"plate": np.zeros((1, 9, VOCAB), np.float32)},
            {"plateRegion": "DE"},
            128,
            64,
            1.0,
            (0, 0),
        )


# --- the confidence gate -----------------------------------------------------


def test_default_floor_is_the_measured_one():
    assert DEFAULT_MIN_CHAR_PROBABILITY == 0.75


def test_one_weak_character_silences_the_whole_read():
    """The failure this gate exists for: six confident glyphs and one guess."""
    result = _read("DNRO309", per_slot={3: 0.42})
    assert result["text"] == ""


def test_a_read_whose_weakest_character_clears_the_floor_survives():
    result = _read("DNRO309", per_slot={3: 0.81})
    assert result["text"] == "DNRO309"


def test_the_mean_cannot_rescue_a_weak_character():
    """Six slots at 1.0 and one at 0.3 average 0.9 — the gate must still refuse."""
    result = _read("DNRO309", prob=1.0, per_slot={0: 0.3})
    assert result["text"] == ""


def test_floor_is_configurable():
    result = _read("DNRO309", config={"minCharProbability": 0.4}, per_slot={3: 0.42})
    assert result["text"] == "DNRO309"


def test_floor_of_zero_disables_the_gate():
    result = _read("DNRO309", config={"minCharProbability": 0.0}, per_slot={3: 0.05})
    assert result["text"] == "DNRO309"


def test_pad_slot_confidence_is_not_part_of_the_floor():
    """Only the emitted glyphs are gated; a hesitant trailing pad is irrelevant."""
    weak_pad = {slot: 0.3 for slot in range(6, PLATE_SLOTS)}
    result = _read("DNLL78", per_slot=weak_pad)
    assert result["text"] == "DNLL78"


# --- the grammar -------------------------------------------------------------


def test_non_conforming_read_is_silenced_when_a_region_is_active():
    """Unlike the CTC path, a read that fails the grammar is DROPPED, not kept
    with formatValid False: this reader's alphabet cannot produce the
    'obviously junk' shapes that made an annotated-but-kept read useful."""
    assert _read("3JU511X")["text"] == ""


def test_conforming_read_is_marked_valid():
    result = _read("DNRO309")
    assert result["formatValid"] is True


def test_region_off_returns_the_raw_read():
    result = _read("3JU511X", config={"plateRegion": "off"})
    assert result["text"] == "3JU511X"
    assert result["formatValid"] is False


def test_absent_region_defaults_to_off():
    """A bare call (no config plumbing) must not silently apply a German
    grammar to a plate photographed in another country."""
    result = postprocess_plate_slots({"plate": _slots("3JU511X")}, {}, 128, 64, 1.0, (0, 0))
    assert result["text"] == "3JU511X"


def test_unknown_region_does_not_crash_and_does_not_gate():
    result = _read("3JU511X", config={"plateRegion": "ZZ"})
    assert result["text"] == "3JU511X"
    assert result["formatValid"] is False


def test_grammar_accepts_the_electric_suffix():
    assert _read("DNRO309E")["text"] == "DNRO309E"


def test_kind_is_text():
    assert _read("DNRO309")["kind"] == "text"


def test_silenced_read_still_reports_its_confidence():
    """A dropped read must remain diagnosable in the logs."""
    result = _read("3JU511X")
    assert result["text"] == ""
    assert result["confidence"] > 0
