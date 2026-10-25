"""The `reconfigure` command retunes a LOADED slot without reloading it.

D214 follow-up. `nmsIouThreshold` was a dead knob end to end; now the operator's
value reaches `slot.config`, and a CHANGE to it must not cost a session reload —
`replace` is unload+load (~1.4s on coreml, an OpenVINO recompile) and stalls
every live camera routed to the pool.

Two properties are load-bearing and pinned here:
  1. the patch lands on the named index ONLY, leaving the model object and every
     other slot untouched (the postprocessor re-reads `slot.config` per frame,
     which is what makes an in-place update take effect);
  2. a key outside the allow-list is REFUSED. A `path` accepted here would be
     written into the config while the loaded session kept serving the old
     model — an undetectable lie. That caller must use `replace`.

Heavy runtime deps are stubbed exactly as the sibling pool tests do, so the
module imports on a bare interpreter.
"""
import sys
import types
import unittest

try:  # real numpy when the sandbox has it — a blind stub POISONS the whole
    import numpy  # noqa: F401  # pytest session for every sibling that needs it
except ImportError:
    _np = types.ModuleType("numpy")
    _np.array = lambda seq, dtype=None: list(seq)  # noqa: E731
    _np.float32 = "float32"
    sys.modules["numpy"] = _np
try:  # real PIL when present, for the same reason
    import PIL.Image  # noqa: F401
except ImportError:
    _pil = types.ModuleType("PIL")
    _pil_image = types.ModuleType("PIL.Image")
    _pil.Image = _pil_image
    sys.modules["PIL"] = _pil
    sys.modules["PIL.Image"] = _pil_image

from inference_pool import (  # noqa: E402
    RECONFIGURABLE_CONFIG_KEYS,
    ModelSlot,
    _handle_command,
)


def _loaded_slot(nms: float = 0.45) -> ModelSlot:
    slot = ModelSlot()
    slot.model = object()
    slot.loaded = True
    slot.config = {
        "path": "/models/camstack-yolo26n.onnx",
        "postprocessor": "yolo",
        "confidence": 0.05,
        "nmsIouThreshold": nms,
    }
    return slot


class ReconfigureCommand(unittest.TestCase):
    def test_applies_the_patch_to_the_named_slot_only(self) -> None:
        models = [_loaded_slot(0.45), _loaded_slot(0.45)]
        model_object = models[0].model

        resp = _handle_command(
            models, {"cmd": "reconfigure", "index": 0, "config": {"nmsIouThreshold": 0.7}}
        )

        self.assertEqual(resp["status"], "ok")
        self.assertEqual(models[0].config["nmsIouThreshold"], 0.7)
        # The session is NOT re-instantiated: same object, still loaded.
        self.assertIs(models[0].model, model_object)
        self.assertTrue(models[0].loaded)
        # Every other slot is untouched — the whole point of a per-pair retune.
        self.assertEqual(models[1].config["nmsIouThreshold"], 0.45)

    def test_leaves_the_rest_of_the_config_alone(self) -> None:
        models = [_loaded_slot(0.45)]
        _handle_command(
            models, {"cmd": "reconfigure", "index": 0, "config": {"nmsIouThreshold": 0.2}}
        )
        self.assertEqual(models[0].config["path"], "/models/camstack-yolo26n.onnx")
        self.assertEqual(models[0].config["postprocessor"], "yolo")
        self.assertEqual(models[0].config["confidence"], 0.05)

    def test_refuses_a_key_that_needs_a_reload(self) -> None:
        models = [_loaded_slot(0.45)]
        resp = _handle_command(
            models,
            {"cmd": "reconfigure", "index": 0, "config": {"path": "/models/other.onnx"}},
        )
        self.assertEqual(resp["status"], "error")
        self.assertIn("path", resp["error"])
        # And it did NOT half-apply.
        self.assertEqual(models[0].config["path"], "/models/camstack-yolo26n.onnx")

    def test_refuses_an_unloaded_slot_instead_of_writing_a_ghost_config(self) -> None:
        models = [ModelSlot()]
        resp = _handle_command(
            models, {"cmd": "reconfigure", "index": 0, "config": {"nmsIouThreshold": 0.7}}
        )
        self.assertEqual(resp["status"], "error")
        self.assertIn("not loaded", resp["error"])

    def test_refuses_an_index_past_the_end(self) -> None:
        models = [_loaded_slot()]
        resp = _handle_command(
            models, {"cmd": "reconfigure", "index": 9, "config": {"nmsIouThreshold": 0.7}}
        )
        self.assertEqual(resp["status"], "error")
        # A `load`/`replace` grows the slot list; `reconfigure` must not — it
        # would leave a config with no model behind it.
        self.assertEqual(len(models), 1)

    def test_the_allow_list_mirrors_the_typescript_PoolDecodeSettings(self) -> None:
        # Adding a key on one side only reintroduces the D214 dead-knob class:
        # TS would record the value as applied while Python refused it (or
        # accepted a key the decode never reads).
        self.assertEqual(RECONFIGURABLE_CONFIG_KEYS, frozenset({"nmsIouThreshold"}))


if __name__ == "__main__":
    unittest.main()
