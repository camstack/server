"""The libedgetpu delegate options a pool opens its Coral with.

The TS side sends an explicit ordinal (``usb:0``, ``usb:1``, ``pci:0``,
``pci:1``); libedgetpu also accepts the bare bus (first unit of that bus).
Anything else is refused: an unknown string must never fall back to
"whichever Edge TPU comes first", which on a node with a USB and a PCIe Coral
lets two pools open the same unit.
"""
from __future__ import annotations

import ctypes
import os
import tempfile
import unittest
from unittest import mock

from edgetpu_device import edgetpu_delegate_options, edgetpu_library_path, preload_libusb


class EdgetpuDelegateOptions(unittest.TestCase):
    def test_explicit_ordinals_pass_through(self) -> None:
        for dev in ("usb:0", "usb:1", "pci:0", "pci:1", "pci:12"):
            self.assertEqual(edgetpu_delegate_options(dev), {"device": dev})

    def test_bare_bus_selects_that_bus_not_any_bus(self) -> None:
        # Bare "usb" used to be dropped (no options => first Edge TPU of ANY bus).
        self.assertEqual(edgetpu_delegate_options("usb"), {"device": "usb"})
        self.assertEqual(edgetpu_delegate_options("pci"), {"device": "pci"})

    def test_no_device_means_the_library_default(self) -> None:
        for dev in (None, "", "  ", "default", "all"):
            self.assertIsNone(edgetpu_delegate_options(dev))

    def test_whitespace_is_trimmed(self) -> None:
        self.assertEqual(edgetpu_delegate_options(" pci:1 "), {"device": "pci:1"})

    def test_unknown_strings_are_refused(self) -> None:
        for dev in ("auto", "pci:x", "apex_0", "usb:-1", "cpu"):
            with self.assertRaises(ValueError):
                edgetpu_delegate_options(dev)


class PreloadLibusb(unittest.TestCase):
    """The std delegate links libusb even for a PCIe Coral; an image without
    it fails `load_delegate` with "libusb-1.0.so.0: cannot open shared object
    file". The installer drops a copy beside the delegate and the pool loads it
    GLOBALLY first, so the delegate's own dlopen resolves without any env var.
    """

    def test_no_copy_beside_the_delegate_loads_nothing(self) -> None:
        loads: list[str] = []
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(preload_libusb(d, loader=loads.append))
        self.assertEqual(loads, [])

    def test_a_copy_beside_the_delegate_is_loaded(self) -> None:
        loads: list[str] = []
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "libusb-1.0.so.0")
            open(path, "wb").close()
            self.assertEqual(preload_libusb(d, loader=loads.append), path)
        self.assertEqual(loads, [path])

    def test_the_default_loader_loads_with_rtld_global(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "libusb-1.0.so.0")
            open(path, "wb").close()
            with mock.patch.object(ctypes, "CDLL") as cdll:
                preload_libusb(d)
            cdll.assert_called_once_with(path, mode=ctypes.RTLD_GLOBAL)


class EdgetpuLibraryPath(unittest.TestCase):
    """The delegate the pool loads — the same lookup as the TS probe
    (`chooseEdgetpuDelegate` in `@camstack/types`): override, then the copy
    staged under the node data root, then the hub's historical path."""

    LEGACY = "/data/deps/edgetpu/lib/libedgetpu.so.1"

    def test_a_desktop_loads_the_dylib_staged_under_its_data_root(self) -> None:
        staged = "/Users/me/CamStack/data/deps/edgetpu/lib/libedgetpu.1.dylib"
        path = edgetpu_library_path(
            {"CAMSTACK_DATA": "/Users/me/CamStack/data"}, "darwin", lambda p: p == staged
        )
        self.assertEqual(path, staged)

    def test_a_linux_agent_with_another_data_root_loads_its_staged_copy(self) -> None:
        staged = "/srv/cs/deps/edgetpu/lib/libedgetpu.so.1"
        env = {"CAMSTACK_DATA_DIR": "/srv/cs"}
        self.assertEqual(edgetpu_library_path(env, "linux", lambda p: p in (staged, self.LEGACY)), staged)

    def test_the_override_wins_even_when_missing(self) -> None:
        # The operator named a file: loading another build instead would hide it.
        env = {"CAMSTACK_EDGETPU_LIB": "/opt/x.so", "CAMSTACK_DATA": "/d"}
        self.assertEqual(edgetpu_library_path(env, "linux", lambda p: False), "/opt/x.so")

    def test_nothing_staged_falls_back_to_the_historical_hub_path(self) -> None:
        self.assertEqual(edgetpu_library_path({}, "linux", lambda p: False), self.LEGACY)
        self.assertEqual(edgetpu_library_path({"CAMSTACK_DATA": "/d"}, "linux", lambda p: False), self.LEGACY)


if __name__ == "__main__":
    unittest.main()
