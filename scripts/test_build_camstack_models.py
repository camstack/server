"""check_recipes in build-camstack-models.py (D742, D743).

Run: python3 -m unittest scripts/test_build_camstack_models.py
Needs only the standard library: the build script imports no backend at module
level.
"""

from __future__ import annotations

import dataclasses
import importlib.util
import sys
import unittest
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parent / 'build-camstack-models.py'
_spec = importlib.util.spec_from_file_location('build_camstack_models', _SCRIPT)
assert _spec is not None and _spec.loader is not None
bcm = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = bcm  # dataclasses resolve annotations through it
_spec.loader.exec_module(bcm)


def _recipe(name: str, *, checkpoint: str, dynamic: bool = False, half: bool = True):
    return bcm.Recipe(
        name=name, folder='objectDetection/test', imgsz=320,
        toolchain=bcm.Toolchain('x', 'x', 'x', 'x'), checkpoint=checkpoint,
        onnx=None, coreml=bcm.CoremlExport(dynamic=dynamic, batch=16 if dynamic else 1, half=half),
    )


class CheckRecipesTest(unittest.TestCase):
    def test_the_hosted_recipes_pass(self) -> None:
        self.assertEqual(bcm.check_recipes(bcm.RECIPES), [])

    def test_every_hosted_coreml_recipe_is_fp16(self) -> None:
        fp32 = [r.name for r in bcm.RECIPES if r.coreml is not None and not r.coreml.half]
        self.assertEqual(fp32, [])

    def test_an_fp32_coreml_export_is_refused(self) -> None:
        bad = bcm.check_recipes((_recipe('camstack-yolov9m-320', checkpoint='yolov9m', half=False),))
        self.assertEqual(len(bad), 1)
        self.assertIn('camstack-yolov9m-320', bad[0])
        self.assertIn('FP16', bad[0])

    def test_an_fp32_yolo26_coreml_export_is_refused(self) -> None:
        bad = bcm.check_recipes((_recipe('camstack-yolo26n', checkpoint='yolo26n', half=False),))
        self.assertEqual(len(bad), 1)

    def test_a_flexible_yolo26_coreml_export_is_still_refused(self) -> None:
        bad = bcm.check_recipes((_recipe('camstack-yolo26n-320', checkpoint='yolo26n', dynamic=True),))
        self.assertEqual(len(bad), 1)
        self.assertIn('static', bad[0])

    def test_a_flexible_fp16_yolov9_export_passes(self) -> None:
        ok = _recipe('camstack-yolov9m-320', checkpoint='yolov9m', dynamic=True)
        self.assertEqual(bcm.check_recipes((ok,)), [])

    def test_a_recipe_without_coreml_passes(self) -> None:
        r = dataclasses.replace(_recipe('camstack-x', checkpoint='yolov9t', half=False), coreml=None)
        self.assertEqual(bcm.check_recipes((r,)), [])

    def test_an_adhoc_coreml_export_is_fp16(self) -> None:
        args = bcm.parse_args(['--model', 'yolov9t', '--imgsz', '416'])
        recipe = bcm.adhoc_recipe(args)
        self.assertTrue(recipe.coreml is not None and recipe.coreml.half)
        self.assertEqual(bcm.check_recipes((recipe,)), [])


class LocalCheckpointTest(unittest.TestCase):
    """--checkpoint: a fine-tuned local .pt goes through the same recipe path
    as an Ultralytics id, used VERBATIM (never `<id>.pt` appended)."""

    def setUp(self) -> None:
        import tempfile
        self._dir = tempfile.TemporaryDirectory()
        self.pt = Path(self._dir.name) / 'custom-yolov9m-ft.pt'
        self.pt.write_bytes(b'not really torch')

    def tearDown(self) -> None:
        self._dir.cleanup()

    def test_the_checkpoint_path_is_used_verbatim(self) -> None:
        args = bcm.parse_args(['--checkpoint', str(self.pt), '--imgsz', '640'])
        recipe = bcm.adhoc_recipe(args)
        self.assertEqual(bcm.checkpoint_path(recipe), str(self.pt.resolve()))
        self.assertEqual(recipe.name, 'camstack-custom-yolov9m-ft-640')
        self.assertEqual(bcm.check_recipes((recipe,)), [])

    def test_an_id_still_downloads_its_asset(self) -> None:
        recipe = bcm.adhoc_recipe(bcm.parse_args(['--model', 'yolov9m']))
        self.assertEqual(bcm.checkpoint_path(recipe), 'yolov9m.pt')

    def test_a_missing_checkpoint_is_refused(self) -> None:
        with self.assertRaises(SystemExit):
            bcm.adhoc_recipe(bcm.parse_args(['--checkpoint', str(self.pt) + '.missing']))

    def test_a_local_checkpoint_never_exports_a_flexible_coreml_package(self) -> None:
        # Its architecture is not in its name: a YOLO26 fine-tune would abort
        # the process that loads a flexible package (D742).
        recipe = bcm.adhoc_recipe(bcm.parse_args(['--checkpoint', str(self.pt), '--dynamic']))
        self.assertTrue(recipe.onnx is not None and recipe.onnx.dynamic)
        self.assertTrue(recipe.coreml is not None and not recipe.coreml.dynamic)

    def test_model_and_checkpoint_are_exclusive(self) -> None:
        with self.assertRaises(SystemExit):
            bcm.parse_args(['--model', 'yolov9m', '--checkpoint', str(self.pt)])

    def test_a_checkpoint_selects_the_adhoc_recipe(self) -> None:
        args = bcm.parse_args(['--checkpoint', str(self.pt)])
        self.assertEqual([r.name for r in bcm.select(args)], ['camstack-custom-yolov9m-ft-640'])


class ReuseOnnxTest(unittest.TestCase):
    """--reuse-onnx quantises from an ONNX already at its mirror path."""

    def setUp(self) -> None:
        import tempfile
        self._tmp = tempfile.TemporaryDirectory()
        self.out = Path(self._tmp.name)
        self.recipe = next(r for r in bcm.RECIPES if r.name == 'camstack-yolov9m-640')
        self.calls: list[str] = []
        self._orig = (bcm.build_onnx, bcm.build_openvino)
        bcm.build_onnx = lambda recipe, out: self.calls.append('export') or (out / 'exported.onnx')
        bcm.build_openvino = (lambda recipe, onnx, out, calib, n:
                              self.calls.append(f'openvino:{onnx.name}') or [])

    def tearDown(self) -> None:
        bcm.build_onnx, bcm.build_openvino = self._orig
        self._tmp.cleanup()

    def _build(self, reuse: bool) -> None:
        bcm.build(self.recipe, {'openvino'}, self.out, self.out, None, False, bcm.Report(),
                  reuse_onnx=reuse)

    def test_an_onnx_at_the_mirror_path_is_reused(self) -> None:
        onnx = self.out / self.recipe.folder / 'onnx' / f'{self.recipe.name}.onnx'
        onnx.parent.mkdir(parents=True)
        onnx.write_bytes(b'x')
        self._build(reuse=True)
        self.assertEqual(self.calls, [f'openvino:{onnx.name}'])

    def test_without_an_onnx_it_still_exports(self) -> None:
        self._build(reuse=True)
        self.assertEqual(self.calls, ['export', 'openvino:exported.onnx'])

    def test_without_the_flag_it_always_exports(self) -> None:
        onnx = self.out / self.recipe.folder / 'onnx' / f'{self.recipe.name}.onnx'
        onnx.parent.mkdir(parents=True)
        onnx.write_bytes(b'x')
        self._build(reuse=False)
        self.assertEqual(self.calls, ['export', 'openvino:exported.onnx'])


if __name__ == '__main__':
    unittest.main()
